import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source';
import {
  ChatAttachment,
  ChatMessagePayload,
  ChatProviderAdapter,
  ChatSession,
  ChatStreamEvent,
  ProviderDescriptor,
  SendMessageResult,
} from '../types';

export type OpenAIAgentAdapterConfig = {
  /** Base URL of the BFF that proxies the OpenAI Agents API */
  apiHost: string;
  /** Optional headers appended to every request */
  headers?: Record<string, string>;
  /** Enables SSE streaming (Responses API events) */
  enableStreaming?: boolean;
  /** Optional hook to customize outgoing requests */
  onRequest?: (request: RequestInit) => Promise<void>;
};

const normalizeUrl = (baseUrl: string) => baseUrl.replace(/\/$/, '');

const toSerializableFile = (file: ChatAttachment) => ({
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  data: file.data,
  url: file.url,
  metadata: file.metadata,
});

const buildBody = (session: ChatSession, payload: ChatMessagePayload) => ({
  sessionId: session.sessionId,
  destinationId: session.destinationId,
  message: payload.message,
  variables: payload.variables ?? {},
  files: payload.files?.map(toSerializableFile) ?? [],
  toolInvocation: payload.toolInvocation,
});

const createRequestInit = async (
  config: OpenAIAgentAdapterConfig,
  body: Record<string, unknown>
): Promise<RequestInit> => {
  const request: RequestInit = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    },
  };

  if (config.onRequest) {
    await config.onRequest(request);
  }

  return request;
};

const streamFromOpenAI = (
  url: string,
  body: Record<string, unknown>,
  config: OpenAIAgentAdapterConfig
): AsyncGenerator<ChatStreamEvent> => {
  const queue: Array<ChatStreamEvent | null> = [];
  let notify: (() => void) | undefined;
  let isClosed = false;

  const enqueue = (event: ChatStreamEvent | null) => {
    queue.push(event);
    if (notify) {
      notify();
      notify = undefined;
    }
  };

  const generator = async function* () {
    const request = await createRequestInit(config, body);
    const { headers, ...rest } = request;

    void fetchEventSource(url, {
      ...rest,
      headers: headers as Record<string, string> | undefined,
      openWhenHidden: true,
      async onopen(response) {
      if (response.ok && response.headers.get('content-type')?.startsWith(EventStreamContentType)) {
        enqueue({ kind: 'lifecycle', phase: 'start' });
        return;
      }
      const error = new Error(`Unable to open OpenAI agent stream (${response.status})`);
      enqueue({ kind: 'error', error });
      throw error;
    },
    onmessage(event) {
      if (!event.data) return;
      const payload = JSON.parse(event.data);
      switch (payload.event) {
        case 'response.output_text.delta':
        case 'token':
          enqueue({ kind: 'chunk', value: payload.data });
          break;
        case 'response.completed':
        case 'complete':
          enqueue({ kind: 'metadata', channel: 'result', data: payload.data });
          enqueue({ kind: 'lifecycle', phase: 'complete' });
          break;
        case 'error': {
          const error = payload.data instanceof Error ? payload.data : new Error(payload.data?.message ?? 'Agent error');
          enqueue({ kind: 'error', error });
          break;
        }
        default:
          enqueue({ kind: 'metadata', channel: payload.event, data: payload.data });
      }
    },
    onclose() {
      if (!isClosed) enqueue({ kind: 'lifecycle', phase: 'complete' });
      isClosed = true;
      enqueue(null);
    },
    onerror(error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      enqueue({ kind: 'error', error: normalized });
      enqueue(null);
      throw normalized;
      },
    });

    while (!isClosed || queue.length) {
      if (!queue.length) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      const next = queue.shift();
      if (!next) break;
      yield next;
    }
  };

  return generator();
};

const sendWithoutStreaming = async (
  url: string,
  body: Record<string, unknown>,
  config: OpenAIAgentAdapterConfig
): Promise<SendMessageResult> => {
  const request = await createRequestInit(config, body);
  const response = await fetch(url, request);
  if (!response.ok) {
    throw new Error(`OpenAI Agent request failed with status ${response.status}`);
  }
  const data = await response.json();
  let message = '';
  if (typeof data === 'string') message = data;
  else if (data?.reply) message = data.reply;
  else if (data?.text) message = data.text;
  else message = JSON.stringify(data);
  return {
    message,
    metadata: data,
    raw: data,
  };
};

export const createOpenAIAgentAdapter = (
  descriptor: ProviderDescriptor<OpenAIAgentAdapterConfig>
): ChatProviderAdapter => {
  const config = descriptor.config;
  const baseUrl = normalizeUrl(config.apiHost);

  return {
    id: descriptor.id,
    type: 'openai-agent-builder',
    label: descriptor.label,
    supportsStreaming: config.enableStreaming !== false,
    async startSession({ sessionId, destinationId, context }) {
      return {
        sessionId,
        providerId: descriptor.id,
        destinationId,
        metadata: {
          context,
        },
      };
    },
    sendMessage(session, payload) {
      const destination = descriptor.destinations.find((item) => item.id === session.destinationId);
      if (!destination) {
        throw new Error(`OpenAI destination ${session.destinationId} not found`);
      }
      const path = (destination.metadata?.path as string | undefined) ?? `/providers/openai/${destination.id}/messages`;
      const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      const body = buildBody(session, payload);
      if (config.enableStreaming === false) {
        return sendWithoutStreaming(url, body, config);
      }
      return streamFromOpenAI(url, body, config);
    },
  };
};
