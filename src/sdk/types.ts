export type ProviderType = 'flowise' | 'n8n' | 'openai-agent-builder';

export type ProviderDestination = {
  /** Identifier used by the provider/BFF to locate the downstream agent or workflow */
  id: string;
  /** User friendly name surfaced in the UI */
  label: string;
  /** Optional description displayed in provider selector */
  description?: string;
  /** Optional opaque metadata returned by destination discovery */
  metadata?: Record<string, unknown>;
};

export type ProviderDescriptor<TConfig = Record<string, unknown>> = {
  /** Unique provider identifier used internally */
  id: string;
  /** Label shown to end users */
  label: string;
  /** Provider implementation discriminator */
  type: ProviderType;
  /** Destinations that can be targeted for this provider */
  destinations: ProviderDestination[];
  /** Adapter specific configuration */
  config: TConfig;
};

export type ProviderMap = Record<string, ProviderDescriptor>;

export type ChatAttachment = {
  name: string;
  mimeType: string;
  size?: number;
  /** Base64 payload when uploaded through the UI. */
  data?: string;
  /** Optional remote URL already persisted by the BFF */
  url?: string;
  /** Additional provider specific metadata. */
  metadata?: Record<string, unknown>;
};

export type ChatMessagePayload = {
  message?: string;
  files?: ChatAttachment[];
  variables?: Record<string, unknown>;
  /** Explicit tool invocation metadata */
  toolInvocation?: {
    name: string;
    arguments?: Record<string, unknown>;
  };
};

export type ChatSession = {
  sessionId: string;
  providerId: string;
  destinationId: string;
  /** Provider specific metadata returned during session creation. */
  metadata?: Record<string, unknown>;
};

export type ChatStreamLifecycle = 'start' | 'token' | 'metadata' | 'complete' | 'error';

export type ChatStreamEvent =
  | { kind: 'lifecycle'; phase: Exclude<ChatStreamLifecycle, 'metadata'>; data?: Record<string, unknown> }
  | { kind: 'metadata'; channel: string; data: unknown }
  | { kind: 'chunk'; value: string }
  | { kind: 'error'; error: Error; recoverable?: boolean };

export type SendMessageResult = {
  /** Final assistant message */
  message?: string;
  /** Metadata emitted during streaming */
  metadata?: Record<string, unknown>;
  /** When provider does not support streaming, the entire response is populated. */
  raw?: unknown;
};

export interface ChatProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly label: string;
  /** Whether provider natively supports streaming */
  readonly supportsStreaming: boolean;
  /** Optional tool listing support */
  listTools?: (session: ChatSession) => Promise<ProviderTool[]>;
  /**
   * Optional explicit tool invocation. When absent the SDK will surface an error when
   * the UI attempts to trigger a tool call.
   */
  invokeTool?: (
    session: ChatSession,
    payload: ProviderToolInvocation
  ) => AsyncGenerator<ChatStreamEvent> | Promise<SendMessageResult>;
  startSession: (params: StartSessionInput) => Promise<ChatSession>;
  /**
   * Sends a message to the provider. The adapter can either return an AsyncGenerator emitting
   * {@link ChatStreamEvent} or resolve with the final {@link SendMessageResult} when streaming
   * is not supported by the backend.
   */
  sendMessage: (
    session: ChatSession,
    payload: ChatMessagePayload
  ) => AsyncGenerator<ChatStreamEvent> | Promise<SendMessageResult>;
  /** Optional file upload implementation when the provider exposes a dedicated API */
  uploadFiles?: (session: ChatSession, files: ChatAttachment[]) => Promise<UploadResult[]>;
  endSession?: (session: ChatSession) => Promise<void>;
}

export type UploadResult = {
  name: string;
  url: string;
  metadata?: Record<string, unknown>;
};

export type StartSessionInput = {
  sessionId: string;
  destinationId: string;
  /** Adapter level configuration */
  config: ProviderDescriptor['config'];
  /** Additional options provided by the UI */
  context?: Record<string, unknown>;
};

export type ProviderTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type ProviderToolInvocation = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type OrchestratorOptions = {
  /** Optional default provider id */
  defaultProviderId?: string;
  /** Optional default destination id */
  defaultDestinationId?: string;
  /** Fallback session id to reuse across providers */
  sessionId?: string;
  /** Additional context forwarded to adapters */
  context?: Record<string, unknown>;
};
