import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source';
import { ChatMessagePayload, ChatProviderAdapter, ChatSession, ChatStreamEvent, ProviderDescriptor, SendMessageResult } from '../types';

export type FlowiseAdapterConfig = {
  /** Base URL of the Flowise instance or the proxy/BFF */
  apiHost: string;
  /** Optional headers appended to every request */
  headers?: Record<string, string>;
  /** Default override configuration merged with every request */
  defaultOverrides?: Record<string, unknown>;
  /** Flag used to disable streaming when the upstream chatflow does not support it */
  disableStreaming?: boolean;
  /** Allows clients to inspect or mutate outgoing fetch requests before they are executed */
  onRequest?: (request: RequestInit) => Promise<void>;
};

const normalizeUrl = (baseUrl: string) => baseUrl.replace(/\/$/, '');

const createRequestInit = async (
  config: FlowiseAdapterConfig,
  body: Record<string, unknown>,
  additionalHeaders?: Record<string, string>
): Promise<RequestInit> => {
  const request: RequestInit = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
      ...(additionalHeaders ?? {}),
    },
  };

  if (config.onRequest) {
    await config.onRequest(request);
  }

  return request;
};

const toFlowiseUploads = (files: ChatMessagePayload['files']) =>
  files?.map((file) => ({
    name: file.name,
    type: file.metadata?.type ?? 'file',
    mime: file.mimeType,
    data: file.data,
    url: file.url,
  }));

const ensureSessionMetadata = (session: ChatSession) => {
  if (!session.metadata) session.metadata = {};
  if (!session.metadata.chatId) {
    session.metadata.chatId = `${session.sessionId}-${session.destinationId}`;
  }
  return session.metadata;
};

const streamFromFlowise = (
  url: string,
  body: Record<string, unknown>,
  config: FlowiseAdapterConfig,
  session: ChatSession
): AsyncGenerator<ChatStreamEvent> => {
  const metadata = ensureSessionMetadata(session);
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
    const request = await createRequestInit(config, { ...body, streaming: true });
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
      let message = 'Unable to open Flowise stream';
      if (response.status === 429) message = 'Too many requests. Please try again later.';
      if (response.status === 403) message = (await response.text()) || 'Unauthorized';
      if (response.status === 401) message = (await response.text()) || 'Unauthenticated';
      const error = new Error(message);
      enqueue({ kind: 'error', error, recoverable: response.status === 429 });
      throw error;
    },
    onmessage(event) {
      if (!event.data) return;
      const payload = JSON.parse(event.data);
      switch (payload.event) {
        case 'token':
          enqueue({ kind: 'chunk', value: payload.data });
          break;
        case 'metadata': {
          if (payload.data?.chatId) {
            metadata.chatId = payload.data.chatId;
          }
          enqueue({ kind: 'metadata', channel: 'metadata', data: payload.data });
          break;
        }
        case 'sourceDocuments':
        case 'usedTools':
        case 'fileAnnotations':
        case 'agentReasoning':
        case 'agentFlowEvent':
        case 'agentFlowExecutedData':
        case 'action':
        case 'artifacts':
        case 'tts_start':
        case 'tts_data':
        case 'tts_end':
        case 'tts_abort':
        case 'abort':
          enqueue({ kind: 'metadata', channel: payload.event, data: payload.data });
          break;
        case 'error': {
          const error = payload.data instanceof Error ? payload.data : new Error(payload.data?.message ?? 'Unknown error');
          enqueue({ kind: 'error', error });
          break;
        }
        case 'end':
          enqueue({ kind: 'metadata', channel: 'end', data: payload.data });
          enqueue({ kind: 'lifecycle', phase: 'complete' });
          break;
        case 'start':
          enqueue({ kind: 'lifecycle', phase: 'start' });
          break;
        default:
          enqueue({ kind: 'metadata', channel: payload.event, data: payload.data });
      }
    },
    onclose() {
      if (!isClosed) {
        enqueue({ kind: 'lifecycle', phase: 'complete' });
      }
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
  config: FlowiseAdapterConfig
): Promise<SendMessageResult> => {
  const request = await createRequestInit(config, body);
  const response = await fetch(url, request);
  if (!response.ok) {
    throw new Error(`Flowise request failed with status ${response.status}`);
  }
  const data = await response.json();
  let message = '';
  if (data?.text) message = data.text;
  else if (data?.json) message = JSON.stringify(data.json, null, 2);
  else if (typeof data === 'string') message = data;
  else message = JSON.stringify(data);
  return {
    message,
    metadata: data,
    raw: data,
  };
};

export const createFlowiseAdapter = (descriptor: ProviderDescriptor<FlowiseAdapterConfig>): ChatProviderAdapter => {
  const config = descriptor.config;
  const baseUrl = normalizeUrl(config.apiHost);

  return {
    id: descriptor.id,
    type: 'flowise',
    label: descriptor.label,
    supportsStreaming: !config.disableStreaming,
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
        throw new Error(`Flowise destination ${session.destinationId} not found`);
      }
      const chatflowId = (destination.metadata?.chatflowId as string) ?? destination.metadata?.id ?? destination.id;
      const overrides = {
        ...(config.defaultOverrides ?? {}),
        ...(destination.metadata?.overrideConfig as Record<string, unknown> | undefined),
      };
      if (payload.variables) {
        overrides.vars = {
          ...(overrides.vars as Record<string, unknown> | undefined),
          ...payload.variables,
        };
      }
      const metadata = ensureSessionMetadata(session);
      const body = {
        question: payload.message,
        chatId: metadata.chatId,
        overrideConfig: overrides,
        uploads: toFlowiseUploads(payload.files),
        humanInput: payload.toolInvocation?.arguments,
      };
      const url = `${baseUrl}/api/v1/prediction/${chatflowId}`;
      if (config.disableStreaming) {
        return sendWithoutStreaming(url, body, config);
      }
      return streamFromFlowise(url, body, config, session);
    },
  };
};
