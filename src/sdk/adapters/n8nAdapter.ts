import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source';
import { ChatAttachment, ChatMessagePayload, ChatProviderAdapter, ChatSession, ChatStreamEvent, ProviderDescriptor, SendMessageResult } from '../types';

export type N8nAdapterConfig = {
  /** Base URL of the BFF that proxies N8n workflows */
  apiHost: string;
  /** Optional headers appended to the outbound request */
  headers?: Record<string, string>;
  /** Set to true when the upstream workflow exposes an SSE stream */
  enableStreaming?: boolean;
  /** Optional hook to inspect the outgoing request */
  onRequest?: (request: RequestInit) => Promise<void>;
};

const normalizeUrl = (baseUrl: string) => baseUrl.replace(/\/$/, '');

const buildBody = (session: ChatSession, payload: ChatMessagePayload) => ({
  sessionId: session.sessionId,
  destinationId: session.destinationId,
  message: payload.message,
  variables: payload.variables ?? {},
  files: payload.files?.map((file) => toSerializableFile(file)) ?? [],
  toolInvocation: payload.toolInvocation,
});

const toSerializableFile = (file: ChatAttachment) => ({
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  data: file.data,
  url: file.url,
  metadata: file.metadata,
});

const createRequestInit = async (
  config: N8nAdapterConfig,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT' = 'POST'
): Promise<RequestInit> => {
  const request: RequestInit = {
    method,
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

const streamFromN8n = (
  url: string,
  body: Record<string, unknown>,
  config: N8nAdapterConfig
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
      const error = new Error(`Unable to open stream (${response.status})`);
      enqueue({ kind: 'error', error });
      throw error;
    },
    onmessage(event) {
      if (!event.data) return;
      const payload = JSON.parse(event.data);
      switch (payload.event) {
        case 'token':
          enqueue({ kind: 'chunk', value: payload.data });
          break;
        case 'complete':
          enqueue({ kind: 'metadata', channel: 'result', data: payload.data });
          enqueue({ kind: 'lifecycle', phase: 'complete' });
          break;
        case 'error': {
          const error = payload.data instanceof Error ? payload.data : new Error(payload.data?.message ?? 'Workflow error');
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
  config: N8nAdapterConfig
): Promise<SendMessageResult> => {
  const request = await createRequestInit(config, body);
  const response = await fetch(url, request);
  if (!response.ok) {
    throw new Error(`n8n request failed with status ${response.status}`);
  }
  const data = await response.json();
  let message = '';
  if (typeof data === 'string') message = data;
  else if (data?.reply) message = data.reply;
  else message = JSON.stringify(data);
  return {
    message,
    metadata: data,
    raw: data,
  };
};

export const createN8nAdapter = (descriptor: ProviderDescriptor<N8nAdapterConfig>): ChatProviderAdapter => {
  const config = descriptor.config;
  const baseUrl = normalizeUrl(config.apiHost);

  return {
    id: descriptor.id,
    type: 'n8n',
    label: descriptor.label,
    supportsStreaming: !!config.enableStreaming,
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
        throw new Error(`n8n destination ${session.destinationId} not found`);
      }
      const path = (destination.metadata?.path as string | undefined) ?? `/providers/n8n/${destination.id}/messages`;
      const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      const body = buildBody(session, payload);
      if (config.enableStreaming) {
        return streamFromN8n(url, body, config);
      }
      return sendWithoutStreaming(url, body, config);
    },
  };
};
