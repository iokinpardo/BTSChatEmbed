import { strict as assert } from 'node:assert';
import test from 'node:test';
import { ChatOrchestrator } from '../src/sdk/orchestrator.js';
import { ChatStreamEvent, ProviderDescriptor } from '../src/sdk/types.js';

type SessionRecord = {
  providerId: string;
  destinationId: string;
  sessionId: string;
};

test('ChatOrchestrator reuses base session id and supports streaming adapters', async () => {
  const descriptors: ProviderDescriptor[] = [
    {
      id: 'flowise-provider',
      label: 'Flowise',
      type: 'flowise',
      destinations: [
        {
          id: 'flowise-chat',
          label: 'Support Bot',
        },
      ],
      config: {},
    },
    {
      id: 'n8n-provider',
      label: 'n8n',
      type: 'n8n',
      destinations: [
        {
          id: 'n8n-workflow',
          label: 'Workflow',
        },
      ],
      config: {},
    },
  ];

  const sessions: SessionRecord[] = [];
  const messageLog: Array<{ providerId: string; payload: unknown }> = [];

  const orchestrator = new ChatOrchestrator(
    descriptors,
    (descriptor) => ({
      id: descriptor.id,
      type: descriptor.type,
      label: descriptor.label,
      supportsStreaming: descriptor.type === 'flowise',
      async startSession({ sessionId, destinationId }) {
        sessions.push({ providerId: descriptor.id, destinationId, sessionId });
        return {
          sessionId,
          providerId: descriptor.id,
          destinationId,
          metadata: {},
        };
      },
      sendMessage(session, payload) {
        messageLog.push({ providerId: descriptor.id, payload });
        if (descriptor.type === 'flowise') {
          async function* stream(): AsyncGenerator<ChatStreamEvent> {
            yield { kind: 'lifecycle', phase: 'start' };
            yield { kind: 'chunk', value: 'hello' };
            yield { kind: 'lifecycle', phase: 'complete' };
          }
          return stream();
        }
        return Promise.resolve({ message: 'ok', metadata: { providerId: descriptor.id, session } });
      },
    }),
    { sessionId: 'shared-session' }
  );

  const firstResponse = await orchestrator.sendMessage({ message: 'ping' });
  assert.equal(typeof (firstResponse as AsyncGenerator)[Symbol.asyncIterator], 'function');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'shared-session');
  assert.equal(sessions[0].providerId, 'flowise-provider');

  // Reusing the same provider should not create a new session
  await orchestrator.sendMessage({ message: 'pong' });
  assert.equal(sessions.length, 1, 'subsequent sends reuse the same Flowise session');

  await orchestrator.setActive('n8n-provider', 'n8n-workflow');
  const secondResponse = await orchestrator.sendMessage({ message: 'n8n ping' });
  assert.equal(typeof secondResponse, 'object');
  assert.equal('message' in (secondResponse as Record<string, unknown>), true);
  assert.equal(sessions.length, 2, 'switching providers creates a new session');
  assert.equal(sessions[1].sessionId, 'shared-session', 'global session id is reused across providers');
  assert.equal(sessions[1].providerId, 'n8n-provider');

  assert.equal(messageLog.length >= 3, true);
  assert.equal(messageLog[0].providerId, 'flowise-provider');
  assert.equal(messageLog[messageLog.length - 1].providerId, 'n8n-provider');
});
