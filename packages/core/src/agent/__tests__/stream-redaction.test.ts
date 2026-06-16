import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runAgent, type AgentContext } from '../loop.js';
import type { InboundMessage, GatewayConfig, ProviderResponse } from '@agw/types';

function makeConfig(): GatewayConfig {
  return {
    model: { primary: 'anthropic/claude-sonnet-4-20250514', fallback: '', fallbackChain: [] },
    agent: {
      name: 'Test', workspace: os.tmpdir(), maxToolRounds: 10,
      compactionThreshold: 0.75, softCompactionThreshold: 0.5, keepRecentMessages: 10,
      routing: { enabled: false }, sessionMemory: { enabled: false },
    },
    gateway: { port: 3000, host: '0.0.0.0', token: '' },
    providers: {} as any,
  } as unknown as GatewayConfig;
}

function makeSession(): AgentContext['session'] {
  return {
    id: 'sess-test', tenant_id: 'default', user_id: null, channel: 'web', chat_id: 'web:test:main',
    model: 'anthropic/claude-sonnet-4-20250514', input_tokens: 0, output_tokens: 0, turns: 0, metadata: '{}',
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), expires_at: null,
  } as unknown as AgentContext['session'];
}

function baseContext(overrides: Partial<AgentContext>): AgentContext {
  return {
    db: {} as any, config: makeConfig(), session: makeSession(), tenantId: 'default',
    model: 'anthropic/claude-sonnet-4-20250514', ephemeral: true, tools: [],
    callLLM: async () => ({ text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse),
    ...overrides,
  };
}

const inbound: InboundMessage = { text: 'hello', channel: 'web', chatId: 'web:test:main', chatType: 'private' } as InboundMessage;
const SECRET = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

describe('streamed-output redaction (#185)', () => {
  it('redacts a secret echoed in streamed answer deltas', async () => {
    const streamed: string[] = [];
    await runAgent(inbound, { onDelta: (d) => streamed.push(d) }, baseContext({
      callLLM: async (args: any) => {
        // Stream the secret split across deltas, as a real token stream would.
        args.onDelta?.('your key is ');
        args.onDelta?.('sk-ABCDEFGHIJ');
        args.onDelta?.('KLMNOPQRSTUVWXYZ012345');
        args.onDelta?.(' ok');
        return { text: `your key is ${SECRET} ok`, usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse;
      },
    }));
    expect(streamed.join('')).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(streamed.join('')).toContain('REDACTED');
  });

  it('redacts a secret echoed in streamed thinking deltas', async () => {
    const thoughts: string[] = [];
    await runAgent(inbound, { onThinkingDelta: (d) => thoughts.push(d) }, baseContext({
      callLLM: async (args: any) => {
        args.onThinkingDelta?.('let me use ');
        args.onThinkingDelta?.('sk-ABCDEFGHIJ');
        args.onThinkingDelta?.('KLMNOPQRSTUVWXYZ012345');
        return { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse;
      },
    }));
    expect(thoughts.join('')).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(thoughts.join('')).toContain('REDACTED');
  });

  it('redacts the final thinking trace returned to non-streaming consumers', async () => {
    const result = await runAgent(inbound, {}, baseContext({
      callLLM: async () => ({
        text: 'done',
        thinkingText: `I will call the API with ${SECRET} now`,
        usage: { inputTokens: 1, outputTokens: 1 },
      } as unknown as ProviderResponse),
    }));
    expect(result.thinkingText).not.toContain('sk-ABCDEFGHIJKLMNOP');
    expect(result.thinkingText).toContain('REDACTED');
  });
});
