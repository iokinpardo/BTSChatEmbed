import { ChatProviderAdapter, ProviderDescriptor } from './types';
import { createFlowiseAdapter, FlowiseAdapterConfig } from './adapters/flowiseAdapter';
import { createN8nAdapter, N8nAdapterConfig } from './adapters/n8nAdapter';
import { createOpenAIAgentAdapter, OpenAIAgentAdapterConfig } from './adapters/openAIAgentAdapter';

export const createAdapter = (descriptor: ProviderDescriptor): ChatProviderAdapter => {
  switch (descriptor.type) {
    case 'flowise':
      return createFlowiseAdapter(descriptor as ProviderDescriptor<FlowiseAdapterConfig>);
    case 'n8n':
      return createN8nAdapter(descriptor as ProviderDescriptor<N8nAdapterConfig>);
    case 'openai-agent-builder':
      return createOpenAIAgentAdapter(descriptor as ProviderDescriptor<OpenAIAgentAdapterConfig>);
    default:
      throw new Error(`Unsupported provider type ${(descriptor as ProviderDescriptor).type}`);
  }
};
