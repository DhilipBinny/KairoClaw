import { describe, it, expect } from 'vitest';
import { getModelCapabilities, estimateCost } from '../models.js';
import type { GatewayConfig } from '@agw/types';

describe('built-in pricing table (#187)', () => {
  it('resolves cost for known models without any config', () => {
    expect(getModelCapabilities('anthropic/claude-sonnet-4-6').costPer1M).toEqual({ input: 3, output: 15 });
    expect(getModelCapabilities('anthropic/claude-opus-4-8').costPer1M).toEqual({ input: 5, output: 25 });
    expect(getModelCapabilities('anthropic/claude-haiku-4-5').costPer1M).toEqual({ input: 1, output: 5 });
    expect(getModelCapabilities('anthropic/claude-fable-5').costPer1M).toEqual({ input: 10, output: 50 });
    expect(getModelCapabilities('openai/gpt-4o-mini').costPer1M).toEqual({ input: 0.15, output: 0.6 });
  });

  it('prefers the most specific match', () => {
    expect(getModelCapabilities('openai/gpt-4o').costPer1M).toEqual({ input: 2.5, output: 10 });
    expect(getModelCapabilities('openai/gpt-4o-mini').costPer1M).toEqual({ input: 0.15, output: 0.6 });
    expect(getModelCapabilities('anthropic/claude-3-5-haiku-latest').costPer1M).toEqual({ input: 0.8, output: 4 });
    // Opus 4.x (5/25), not the retired Claude 3 Opus (15/75).
    expect(getModelCapabilities('anthropic/claude-opus-4-6').costPer1M).toEqual({ input: 5, output: 25 });
    expect(getModelCapabilities('anthropic/claude-3-opus-20240229').costPer1M).toEqual({ input: 15, output: 75 });
  });

  it('does not over-match unrelated model ids (token-boundary only)', () => {
    // Local/aliased models that merely contain a family word or "o1" must not
    // pick up a hosted-model rate.
    for (const id of ['ollama/opus-mt-en-de', 'ollama/llama3-sonnet-merge', 'ollama/studio1', 'ollama/haiku-writer-gpt2']) {
      expect(getModelCapabilities(id).costPer1M).toBeNull();
    }
  });

  it('estimateCost returns a non-zero cost for a known model', () => {
    const est = estimateCost('anthropic/claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(est).not.toBeNull();
    expect(est!.total).toBeCloseTo(18); // $3 in + $15 out
  });

  it('admin-configured cost overrides the built-in table', () => {
    const config = { models: { capabilities: { 'claude-sonnet-4-6': { costPer1M: { input: 99, output: 199 } } } } } as unknown as GatewayConfig;
    expect(getModelCapabilities('anthropic/claude-sonnet-4-6', config).costPer1M).toEqual({ input: 99, output: 199 });
  });

  it('returns null cost (and estimateCost null) for an unknown model', () => {
    expect(getModelCapabilities('someprovider/totally-unknown-model').costPer1M).toBeNull();
    expect(estimateCost('someprovider/totally-unknown-model', 1000, 1000)).toBeNull();
  });
});
