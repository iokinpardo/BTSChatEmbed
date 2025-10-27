import { v4 as uuidv4 } from 'uuid';
import {
  ChatMessagePayload,
  ChatProviderAdapter,
  ChatSession,
  ChatStreamEvent,
  OrchestratorOptions,
  ProviderDescriptor,
  ProviderMap,
  SendMessageResult,
} from './types';

const sessionKey = (providerId: string, destinationId: string) => `${providerId}::${destinationId}`;

export class ChatOrchestrator {
  private readonly providers: ProviderMap;
  private readonly adapters: Map<string, ChatProviderAdapter> = new Map();
  private readonly sessions: Map<string, ChatSession> = new Map();
  private activeProviderId: string;
  private activeDestinationId: string;
  private readonly context?: Record<string, unknown>;
  private readonly baseSessionId: string;

  constructor(descriptors: ProviderDescriptor[], adapterFactory: (descriptor: ProviderDescriptor) => ChatProviderAdapter, options?: OrchestratorOptions) {
    if (!descriptors.length) {
      throw new Error('At least one provider descriptor is required');
    }

    this.providers = descriptors.reduce<ProviderMap>((acc, descriptor) => {
      acc[descriptor.id] = descriptor;
      return acc;
    }, {});

    for (const descriptor of descriptors) {
      const adapter = adapterFactory(descriptor);
      this.adapters.set(descriptor.id, adapter);
    }

    this.context = options?.context;
    this.baseSessionId = options?.sessionId ?? uuidv4();
    this.activeProviderId = options?.defaultProviderId ?? descriptors[0].id;
    const defaultDestination = options?.defaultDestinationId ?? descriptors[0].destinations[0]?.id;
    if (!defaultDestination) {
      throw new Error(`Provider ${descriptors[0].id} does not expose destinations.`);
    }
    this.activeDestinationId = defaultDestination;
  }

  public getActiveProvider() {
    return this.providers[this.activeProviderId];
  }

  public getActiveDestination() {
    const provider = this.getActiveProvider();
    return provider.destinations.find((destination) => destination.id === this.activeDestinationId);
  }

  public getActiveSession() {
    return this.sessions.get(sessionKey(this.activeProviderId, this.activeDestinationId));
  }

  public async setActive(providerId: string, destinationId: string) {
    if (!this.providers[providerId]) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const descriptor = this.providers[providerId];
    if (!descriptor.destinations.length) {
      throw new Error(`Provider ${providerId} does not expose destinations.`);
    }
    const destinationExists = descriptor.destinations.some((destination) => destination.id === destinationId);
    if (!destinationExists) {
      throw new Error(`Destination ${destinationId} not found for provider ${providerId}`);
    }
    this.activeProviderId = providerId;
    this.activeDestinationId = destinationId;
    await this.ensureSession();
  }

  public async sendMessage(payload: ChatMessagePayload): Promise<AsyncGenerator<ChatStreamEvent> | SendMessageResult> {
    const session = await this.ensureSession();
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter) {
      throw new Error(`Adapter not registered for provider ${this.activeProviderId}`);
    }
    return adapter.sendMessage(session, payload);
  }

  public async listTools() {
    const session = await this.ensureSession();
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter?.listTools) return [];
    return adapter.listTools(session);
  }

  public async invokeTool(name: string, args?: Record<string, unknown>) {
    const session = await this.ensureSession();
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter?.invokeTool) {
      throw new Error('Active provider does not support tool invocation');
    }
    return adapter.invokeTool(session, { name, arguments: args });
  }

  public async uploadFiles(files: ChatMessagePayload['files']) {
    if (!files?.length) return [];
    const session = await this.ensureSession();
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter?.uploadFiles) return [];
    return adapter.uploadFiles(session, files);
  }

  public async endActiveSession() {
    const key = sessionKey(this.activeProviderId, this.activeDestinationId);
    const session = this.sessions.get(key);
    if (!session) return;
    const adapter = this.adapters.get(this.activeProviderId);
    if (adapter?.endSession) {
      await adapter.endSession(session);
    }
    this.sessions.delete(key);
  }

  private async ensureSession() {
    const key = sessionKey(this.activeProviderId, this.activeDestinationId);
    const cached = this.sessions.get(key);
    if (cached) return cached;

    const descriptor = this.providers[this.activeProviderId];
    const adapter = this.adapters.get(this.activeProviderId);
    if (!adapter) {
      throw new Error(`Adapter not registered for provider ${this.activeProviderId}`);
    }

    const session = await adapter.startSession({
      sessionId: this.baseSessionId,
      destinationId: this.activeDestinationId,
      config: descriptor.config,
      context: this.context,
    });
    this.sessions.set(key, session);
    return session;
  }
}
