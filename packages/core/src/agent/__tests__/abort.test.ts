import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runAgent, type AgentContext } from '../loop.js';
import { SubAgentRegistry } from '../subagent-registry.js';
import type { InboundMessage, GatewayConfig, ProviderResponse } from '@agw/types';

// Minimal config — routing disabled, model pinned via context so resolveModel
// never calls the LLM.
function makeConfig(): GatewayConfig {
  return {
    model: { primary: 'anthropic/claude-sonnet-4-20250514', fallback: '', fallbackChain: [] },
    agent: {
      name: 'Test',
      workspace: os.tmpdir(),
      maxToolRounds: 10,
      compactionThreshold: 0.75,
      softCompactionThreshold: 0.5,
      keepRecentMessages: 10,
      routing: { enabled: false },
      sessionMemory: { enabled: false },
    },
    gateway: { port: 3000, host: '0.0.0.0', token: '' },
    providers: {} as any,
  } as unknown as GatewayConfig;
}

function makeSession(): AgentContext['session'] {
  return {
    id: 'sess-test', tenant_id: 'default', user_id: null,
    channel: 'web', chat_id: 'web:test:main',
    model: 'anthropic/claude-sonnet-4-20250514',
    input_tokens: 0, output_tokens: 0, turns: 0, metadata: '{}',
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), expires_at: null,
  } as unknown as AgentContext['session'];
}

function baseContext(overrides: Partial<AgentContext>): AgentContext {
  return {
    db: {} as any,
    config: makeConfig(),
    session: makeSession(),
    tenantId: 'default',
    model: 'anthropic/claude-sonnet-4-20250514',
    ephemeral: true, // skip all DB persistence
    tools: [],
    callLLM: async () => ({ text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse),
    ...overrides,
  };
}

const inbound: InboundMessage = { text: 'do something', channel: 'web', chatId: 'web:test:main', chatType: 'private' } as InboundMessage;

describe('runAgent cancellation (#181)', () => {
  it('returns immediately without calling the LLM when the signal is already aborted', async () => {
    let llmCalls = 0;
    const ac = new AbortController();
    ac.abort();
    const result = await runAgent(inbound, {}, baseContext({
      signal: ac.signal,
      callLLM: async () => { llmCalls++; return { text: 'should not happen', usage: { inputTokens: 0, outputTokens: 0 } } as unknown as ProviderResponse; },
    }));
    expect(llmCalls).toBe(0);
    expect(result.aborted).toBe(true);
  });

  it('stops after the current round and does NOT execute tools when aborted mid-LLM-call', async () => {
    let llmCalls = 0;
    let toolExecuted = false;
    const ac = new AbortController();
    const result = await runAgent(inbound, {}, baseContext({
      signal: ac.signal,
      // First round returns a tool call but aborts before the loop can run it.
      callLLM: async () => {
        llmCalls++;
        ac.abort();
        return {
          text: '', usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [{ id: 't1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        } as unknown as ProviderResponse;
      },
      executeTool: async () => { toolExecuted = true; return 'ok'; },
    }));
    expect(llmCalls).toBe(1);       // only one round happened
    expect(toolExecuted).toBe(false); // tools were NOT run after abort
    expect(result.aborted).toBe(true);
  });

  it('runs normally to completion when never aborted', async () => {
    const result = await runAgent(inbound, {}, baseContext({
      callLLM: async () => ({ text: 'final answer', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse),
    }));
    expect(result.aborted).toBeUndefined();
    expect(result.text).toBe('final answer');
  });

  it('preserves partial streamed text when cancelled mid-stream', async () => {
    const ac = new AbortController();
    const result = await runAgent(inbound, {}, baseContext({
      signal: ac.signal,
      callLLM: async (args: any) => {
        args.onDelta?.('partial ');
        args.onDelta?.('answer');
        ac.abort();
        throw new Error('Request aborted'); // provider surfaces abort
      },
    }));
    expect(result.aborted).toBe(true);
    expect(result.text).toBe('partial answer'); // not null
  });
});

describe('SubAgentRegistry.abortAll + drainAll (#181)', () => {
  it('aborts every running child so they stop work', async () => {
    const reg = new SubAgentRegistry();
    let childSawAbort = false;
    reg.register('c1', 'task', (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { childSawAbort = true; resolve({ text: 'stopped' } as any); });
    }));
    const killed = reg.abortAll();
    expect(killed).toBe(1);
    await reg.drainAll();
    expect(childSawAbort).toBe(true);
  });

  it('drainAll awaits a killed child whose promise is still pending', async () => {
    // kill() sets completedAt synchronously while the run promise is still
    // unwinding. drainAll must still await it (not skip by completedAt), or the
    // child becomes a floating promise outliving the turn.
    const reg = new SubAgentRegistry();
    let settled = false;
    reg.register('c1', 'task', (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        // Resolve asynchronously AFTER kill() returns — simulates the child
        // loop unwinding its in-flight LLM abort.
        setTimeout(() => { settled = true; resolve({ text: 'stopped' } as any); }, 20);
      });
    }));
    reg.abortAll();
    expect(settled).toBe(false); // not yet — still pending right after kill
    await reg.drainAll();
    expect(settled).toBe(true);  // drainAll waited for the pending promise
  });
});
