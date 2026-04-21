import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyByRules,
  classifyByLLM,
  routeModel,
  stripModelOverride,
} from '../router.js';
import type { InboundMessage, GatewayConfig, RoutingConfig } from '@agw/types';

// ── Helpers ────────────────────────────────────────────────

function makeInbound(text: string, images?: Array<{ data: string; mimeType: string }>): InboundMessage {
  return { text, channel: 'api', chatId: 'test', images } as InboundMessage;
}

function makeRouting(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    enabled: true,
    fastModel: 'anthropic/claude-haiku-4-5-20251001',
    powerfulModel: 'anthropic/claude-opus-4-6',
    llmClassifier: true,
    shortMessageThreshold: 50,
    ...overrides,
  };
}

function makeConfig(routing?: Partial<RoutingConfig>): GatewayConfig {
  return {
    model: { primary: 'anthropic/claude-sonnet-4-20250514', fallback: '', fallbackChain: [] },
    agent: {
      name: 'Test',
      workspace: '/tmp/test',
      maxToolRounds: 10,
      compactionThreshold: 0.75,
      softCompactionThreshold: 0.5,
      keepRecentMessages: 10,
      routing: routing ? makeRouting(routing) : { enabled: false },
    },
    gateway: { port: 3000, host: '0.0.0.0', token: '' },
    providers: {} as any,
    channels: {} as any,
    session: { resetHour: 4, idleMinutes: 240 },
    tools: {} as any,
    models: { capabilities: {} },
    mcp: { servers: {} },
  } as GatewayConfig;
}

/** Simulate ProviderRegistry with Anthropic available. */
const anthropicAvailable = (prefix: string) => prefix === 'anthropic';
/** Simulate ProviderRegistry with no providers available. */
const noProvidersAvailable = (_prefix: string) => false;

// ── classifyByRules ────────────────────────────────────────

describe('classifyByRules', () => {
  const routing = makeRouting();

  describe('user overrides', () => {
    it('@opus → powerful', () => {
      const result = classifyByRules('@opus design an architecture', makeInbound('@opus design an architecture'), routing);
      expect(result).toEqual({ tier: 'powerful', reason: 'user override @opus' });
    });

    it('@sonnet → standard', () => {
      const result = classifyByRules('@sonnet analyze this', makeInbound('@sonnet analyze this'), routing);
      expect(result).toEqual({ tier: 'standard', reason: 'user override @sonnet' });
    });

    it('@haiku → fast', () => {
      const result = classifyByRules('@haiku translate hello', makeInbound('@haiku translate hello'), routing);
      expect(result).toEqual({ tier: 'fast', reason: 'user override @haiku' });
    });

    it('case insensitive', () => {
      const result = classifyByRules('@OPUS do something', makeInbound('@OPUS do something'), routing);
      expect(result).toEqual({ tier: 'powerful', reason: 'user override @opus' });
    });
  });

  describe('images', () => {
    it('images → standard', () => {
      const inbound = makeInbound('what is this?', [{ data: 'abc', mimeType: 'image/png' }]);
      const result = classifyByRules('what is this?', inbound, routing);
      expect(result).toEqual({ tier: 'standard', reason: 'has images' });
    });
  });

  describe('admin patterns', () => {
    it('opus pattern match', () => {
      const r = makeRouting({ opusPatterns: ['design.*architecture', 'compare all'] });
      const result = classifyByRules('design the system architecture', makeInbound('design the system architecture'), r);
      expect(result?.tier).toBe('powerful');
    });

    it('haiku pattern match', () => {
      const r = makeRouting({ haikuPatterns: ['translate.*to'] });
      const result = classifyByRules('translate hello to Arabic', makeInbound('translate hello to Arabic'), r);
      expect(result?.tier).toBe('fast');
    });

    it('invalid regex is skipped without throwing', () => {
      const r = makeRouting({ opusPatterns: ['[invalid'] });
      // Use a long-enough message so it doesn't match 'short message' rule
      const text = 'Can you please analyze the market trends for real estate?';
      const result = classifyByRules(text, makeInbound(text), r);
      // Should not throw, invalid pattern just skipped, message is ambiguous
      expect(result).toBeNull();
    });
  });

  describe('greetings', () => {
    const greetings = ['hello', 'Hi', 'hey', 'thanks', 'Thank you', 'ok', 'sure', 'yes', 'no', 'bye', 'goodbye', '👋', '👍', 'Good morning'];
    for (const g of greetings) {
      it(`"${g}" → fast`, () => {
        const result = classifyByRules(g, makeInbound(g), routing);
        expect(result?.tier).toBe('fast');
        expect(result?.reason).toBe('greeting/acknowledgment');
      });
    }

    it('greeting with punctuation', () => {
      expect(classifyByRules('hello!', makeInbound('hello!'), routing)?.tier).toBe('fast');
      expect(classifyByRules('thanks.', makeInbound('thanks.'), routing)?.tier).toBe('fast');
    });

    it('not a greeting if more text follows', () => {
      expect(classifyByRules('hello can you help me with something?', makeInbound('hello can you help me with something?'), routing)).toBeNull();
    });
  });

  describe('short messages', () => {
    it('short without question → fast', () => {
      const result = classifyByRules('got it', makeInbound('got it'), routing);
      expect(result?.tier).toBe('fast');
      expect(result?.reason).toBe('short message');
    });

    it('short WITH question mark → null (ambiguous)', () => {
      const result = classifyByRules('really?', makeInbound('really?'), routing);
      // 'really?' is 7 chars < 50, but has ? so not auto-Haiku
      expect(result).toBeNull();
    });

    it('long message → null (ambiguous)', () => {
      const text = 'Can you help me analyze the market trends for Dubai real estate properties in the Marina area?';
      const result = classifyByRules(text, makeInbound(text), routing);
      expect(result).toBeNull();
    });

    it('custom threshold', () => {
      const r = makeRouting({ shortMessageThreshold: 10 });
      expect(classifyByRules('got it folks', makeInbound('got it folks'), r)).toBeNull(); // 12 chars > 10
      expect(classifyByRules('got it', makeInbound('got it'), r)?.tier).toBe('fast'); // 6 chars < 10
    });
  });

  describe('ambiguous messages', () => {
    it('normal question → null', () => {
      expect(classifyByRules('What are the best villas in Dubai Marina?', makeInbound('What are the best villas in Dubai Marina?'), routing)).toBeNull();
    });

    it('tool-like request → null', () => {
      expect(classifyByRules('Read the file config.json and show me the contents', makeInbound('Read the file config.json'), routing)).toBeNull();
    });
  });
});

// ── classifyByLLM ──────────────────────────────────────────

describe('classifyByLLM', () => {
  it('SIMPLE → fast', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'SIMPLE' });
    const result = await classifyByLLM('hello there', mockLLM, 'haiku');
    expect(result).toEqual({ tier: 'fast', reason: 'LLM classified as SIMPLE' });
  });

  it('STANDARD → standard', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'STANDARD' });
    const result = await classifyByLLM('analyze this report', mockLLM, 'haiku');
    expect(result).toEqual({ tier: 'standard', reason: 'LLM classified as STANDARD' });
  });

  it('COMPLEX → powerful', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'COMPLEX' });
    const result = await classifyByLLM('design the architecture', mockLLM, 'haiku');
    expect(result).toEqual({ tier: 'powerful', reason: 'LLM classified as COMPLEX' });
  });

  it('handles whitespace/case in response', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: '  simple  ' });
    const result = await classifyByLLM('hi', mockLLM, 'haiku');
    expect(result?.tier).toBe('fast');
  });

  it('handles response with extra text', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'SIMPLE - this is a greeting' });
    const result = await classifyByLLM('hello', mockLLM, 'haiku');
    expect(result?.tier).toBe('fast');
  });

  it('returns null on unexpected response', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'I think this is moderate' });
    const result = await classifyByLLM('some text', mockLLM, 'haiku');
    expect(result).toBeNull();
  });

  it('returns null on empty response', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: '' });
    const result = await classifyByLLM('some text', mockLLM, 'haiku');
    expect(result).toBeNull();
  });

  it('returns null on LLM error', async () => {
    const mockLLM = vi.fn().mockRejectedValue(new Error('API error'));
    const result = await classifyByLLM('some text', mockLLM, 'haiku');
    expect(result).toBeNull();
  });

  it('sends correct prompt structure', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'STANDARD' });
    await classifyByLLM('test message', mockLLM, 'my-model');
    expect(mockLLM).toHaveBeenCalledWith(expect.objectContaining({
      model: 'my-model',
      systemPrompt: expect.stringContaining('one word'),
      messages: [expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('test message'),
      })],
    }));
  });

  it('truncates long messages to 500 chars in the message block', async () => {
    const mockLLM = vi.fn().mockResolvedValue({ text: 'STANDARD' });
    const longText = 'x'.repeat(1000);
    await classifyByLLM(longText, mockLLM, 'haiku');
    const sentContent = mockLLM.mock.calls[0][0].messages[0].content as string;
    // The <message> block should contain at most 500 chars of user text
    const messageBlock = sentContent.match(/<message>\n([\s\S]*?)\n<\/message>/)?.[1] || '';
    expect(messageBlock.length).toBeLessThanOrEqual(500);
  });
});

// ── routeModel ─────────────────────────────────────────────

describe('routeModel', () => {
  let mockLLM: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLLM = vi.fn();
  });

  it('returns primary when routing disabled', async () => {
    const config = makeConfig();
    const result = await routeModel(makeInbound('hello'), mockLLM, config);
    expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.tier).toBe('standard');
    expect(result.stage).toBe('default');
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('returns forced model when forceModel is set', async () => {
    const config = makeConfig({ enabled: true, forceModel: 'anthropic/claude-opus-4-6' });
    const result = await routeModel(makeInbound('hello'), mockLLM, config);
    expect(result.model).toBe('anthropic/claude-opus-4-6');
    expect(result.tier).toBe('forced');
    expect(result.stage).toBe('force');
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('routes greeting to Haiku via rules (no LLM call)', async () => {
    const config = makeConfig({ enabled: true });
    const result = await routeModel(makeInbound('hello'), mockLLM, config, anthropicAvailable);
    expect(result.model).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(result.tier).toBe('fast');
    expect(result.stage).toBe('rule');
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('routes ambiguous message through LLM classifier', async () => {
    mockLLM.mockResolvedValueOnce({ text: 'STANDARD' });
    const config = makeConfig({ enabled: true });
    const result = await routeModel(makeInbound('Can you analyze the market trends for Dubai Marina?'), mockLLM, config, anthropicAvailable);
    expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.tier).toBe('standard');
    expect(result.stage).toBe('llm');
    expect(mockLLM).toHaveBeenCalledOnce();
  });

  it('falls back to default when LLM classifier fails', async () => {
    mockLLM.mockRejectedValueOnce(new Error('API error'));
    const config = makeConfig({ enabled: true });
    const result = await routeModel(makeInbound('Can you analyze something?'), mockLLM, config, anthropicAvailable);
    expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.tier).toBe('standard');
    expect(result.stage).toBe('default');
  });

  it('skips LLM classifier when llmClassifier is false', async () => {
    const config = makeConfig({ enabled: true, llmClassifier: false });
    const result = await routeModel(makeInbound('Can you analyze something?'), mockLLM, config, anthropicAvailable);
    expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(result.stage).toBe('default');
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('LLM classifies as COMPLEX → Opus', async () => {
    mockLLM.mockResolvedValueOnce({ text: 'COMPLEX' });
    const config = makeConfig({ enabled: true });
    const result = await routeModel(makeInbound('Design a complete microservices architecture for our platform'), mockLLM, config, anthropicAvailable);
    expect(result.model).toBe('anthropic/claude-opus-4-6');
    expect(result.tier).toBe('powerful');
    expect(result.stage).toBe('llm');
  });

  describe('provider validation — unconfigured provider falls back to primary', () => {
    it('fast tier falls back to primary when provider not available (via ProviderRegistry)', async () => {
      const config = makeConfig({ enabled: true });
      const result = await routeModel(makeInbound('hello'), mockLLM, config, noProvidersAvailable);
      expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
      expect(result.tier).toBe('fast');
      expect(result.stage).toBe('rule');
    });

    it('powerful tier falls back to primary when provider not available', async () => {
      mockLLM.mockResolvedValueOnce({ text: 'COMPLEX' });
      const config = makeConfig({ enabled: true });
      const result = await routeModel(makeInbound('Can you design a complete microservices architecture for our new platform?'), mockLLM, config, noProvidersAvailable);
      expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
      expect(result.tier).toBe('powerful');
    });

    it('no fastModel/powerfulModel configured → falls back to primary (not hardcoded Haiku/Opus)', async () => {
      mockLLM.mockResolvedValueOnce({ text: 'SIMPLE' });
      const config = makeConfig({ enabled: true, fastModel: undefined, powerfulModel: undefined });
      const result = await routeModel(makeInbound('hello world this is a longer message for LLM classification'), mockLLM, config, anthropicAvailable);
      expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
    });

    it('classifier uses primary model when provider not available', async () => {
      mockLLM.mockResolvedValueOnce({ text: 'STANDARD' });
      const config = makeConfig({ enabled: true });
      await routeModel(makeInbound('Can you analyze the market trends for Dubai Marina?'), mockLLM, config, noProvidersAvailable);
      expect(mockLLM).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'anthropic/claude-sonnet-4-20250514' }),
      );
    });

    it('isProviderAvailable not provided → falls back to config-based check', async () => {
      const config = makeConfig({ enabled: true });
      // No isProviderAvailable passed — falls back to checking config.providers (empty → false → primary)
      const result = await routeModel(makeInbound('hello'), mockLLM, config);
      expect(result.model).toBe('anthropic/claude-sonnet-4-20250514');
      expect(result.tier).toBe('fast');
    });
  });
});

// ── stripModelOverride ─────────────────────────────────────

describe('stripModelOverride', () => {
  it('strips @haiku prefix', () => {
    expect(stripModelOverride('@haiku translate hello to Arabic')).toBe('translate hello to Arabic');
  });

  it('strips @sonnet prefix', () => {
    expect(stripModelOverride('@sonnet analyze this')).toBe('analyze this');
  });

  it('strips @opus prefix', () => {
    expect(stripModelOverride('@opus design architecture')).toBe('design architecture');
  });

  it('case insensitive', () => {
    expect(stripModelOverride('@HAIKU translate')).toBe('translate');
  });

  it('leaves text without prefix unchanged', () => {
    expect(stripModelOverride('hello world')).toBe('hello world');
  });

  it('does not strip @model in the middle of text', () => {
    expect(stripModelOverride('please use @haiku for this')).toBe('please use @haiku for this');
  });
});
