import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../registry.js';
import type { ChatArgs, GatewayConfig, ProviderResponse, ProviderInterface } from '@agw/types';

function fakeProvider(text: string): ProviderInterface {
  return {
    chat: async (_args: ChatArgs): Promise<ProviderResponse> => ({
      text, toolCalls: null, usage: { inputTokens: 1, outputTokens: 1 },
    }),
  } as unknown as ProviderInterface;
}

function throwingProvider(message: string): ProviderInterface {
  return { chat: async (): Promise<ProviderResponse> => { throw new Error(message); } } as unknown as ProviderInterface;
}

function makeConfig(model: GatewayConfig['model']): GatewayConfig {
  return { providers: {}, model } as unknown as GatewayConfig;
}

const ARGS = (m: string): ChatArgs => ({ model: m, messages: [], systemPrompt: '' } as unknown as ChatArgs);

describe('provider failover (#183)', () => {
  it('fails over to the configured fallback when the primary is UNCONFIGURED', async () => {
    const reg = new ProviderRegistry(makeConfig({ primary: 'openai/gpt-4o', fallback: 'anthropic/claude-sonnet-4-6', fallbackChain: [] } as any));
    reg.addProvider('anthropic', fakeProvider('from-anthropic'));
    const resp = await reg.callWithFailover(ARGS('openai/gpt-4o'));
    expect(resp.text).toBe('from-anthropic');
    expect(resp.servedModel).toBe('anthropic/claude-sonnet-4-6');
  });

  it('walks the fallbackChain in order when the primary is unconfigured', async () => {
    const reg = new ProviderRegistry(makeConfig({
      primary: 'openai/gpt-4o', fallback: '',
      fallbackChain: ['cohere/x', 'anthropic/claude-sonnet-4-6'],
    } as any));
    // Only the second chain entry is configured.
    reg.addProvider('anthropic', fakeProvider('from-anthropic'));
    const resp = await reg.callWithFailover(ARGS('openai/gpt-4o'));
    expect(resp.text).toBe('from-anthropic');
    expect(resp.servedModel).toBe('anthropic/claude-sonnet-4-6');
  });

  it('stamps servedModel with the primary when the primary serves the response', async () => {
    const reg = new ProviderRegistry(makeConfig({ primary: 'anthropic/claude-sonnet-4-6', fallback: '', fallbackChain: [] } as any));
    reg.addProvider('anthropic', fakeProvider('from-primary'));
    const resp = await reg.callWithFailover(ARGS('anthropic/claude-sonnet-4-6'));
    expect(resp.text).toBe('from-primary');
    expect(resp.servedModel).toBe('anthropic/claude-sonnet-4-6');
  });

  it('throws a clear error when primary is unconfigured and no fallback is available', async () => {
    const reg = new ProviderRegistry(makeConfig({ primary: 'openai/gpt-4o', fallback: '', fallbackChain: [] } as any));
    await expect(reg.callWithFailover(ARGS('openai/gpt-4o'))).rejects.toThrow(/No provider available/);
  });

  it('surfaces the actionable primary auth error when the primary and all fallbacks fail', async () => {
    const reg = new ProviderRegistry(makeConfig({ primary: 'openai/gpt-4o', fallback: 'anthropic/claude-sonnet-4-6', fallbackChain: [] } as any));
    reg.addProvider('openai', throwingProvider('unauthorized')); // auth_error (non-retriable)
    reg.addProvider('anthropic', throwingProvider('generic boom')); // unknown (non-retriable)
    await expect(reg.callWithFailover(ARGS('openai/gpt-4o'))).rejects.toThrow(/unauthorized/);
  });

  it('surfaces the last error when neither primary nor fallback is actionable', async () => {
    const reg = new ProviderRegistry(makeConfig({ primary: 'openai/gpt-4o', fallback: 'anthropic/claude-sonnet-4-6', fallbackChain: [] } as any));
    reg.addProvider('openai', throwingProvider('primary boom')); // unknown
    reg.addProvider('anthropic', throwingProvider('fallback boom')); // unknown
    await expect(reg.callWithFailover(ARGS('openai/gpt-4o'))).rejects.toThrow(/fallback boom/);
  });

  it('does not fail over to the same (unconfigured) provider listed in the chain', async () => {
    const reg = new ProviderRegistry(makeConfig({
      primary: 'openai/gpt-4o', fallback: '',
      fallbackChain: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-6'],
    } as any));
    reg.addProvider('anthropic', fakeProvider('from-anthropic'));
    const resp = await reg.callWithFailover(ARGS('openai/gpt-4o'));
    expect(resp.servedModel).toBe('anthropic/claude-sonnet-4-6');
  });
});
