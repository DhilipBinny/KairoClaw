import type { GatewayConfig, ModelCapabilities, CostEstimate } from '@agw/types';

// ══════════════════════════════════════════════
// Built-in model capabilities
// ══════════════════════════════════════════════
// These are defaults for known models. Users can override
// any value via config.models.catalog in config.json.

const MODEL_CAPABILITIES: Record<string, Partial<ModelCapabilities>> = {
  // ── Anthropic ──
  'claude-opus-4-6': {
    contextWindow: 200000,
    maxOutputTokens: 16384,
    timeoutMs: 180000,
    costPer1M: { input: 15, output: 75 },
    provider: 'anthropic',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
  },
  'claude-sonnet-4-6': {
    contextWindow: 200000,
    maxOutputTokens: 8192,
    timeoutMs: 120000,
    costPer1M: { input: 3, output: 15 },
    provider: 'anthropic',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
    supportsThinking: true,
  },
  'claude-haiku-4-5-20251001': {
    contextWindow: 200000,
    maxOutputTokens: 8192,
    timeoutMs: 60000,
    costPer1M: { input: 0.8, output: 4 },
    provider: 'anthropic',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
  },

  // ── OpenAI ──
  'gpt-4.1': {
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    timeoutMs: 120000,
    costPer1M: { input: 2, output: 8 },
    provider: 'openai',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
  },
  'gpt-4o': {
    contextWindow: 128000,
    maxOutputTokens: 16384,
    timeoutMs: 120000,
    costPer1M: { input: 2.5, output: 10 },
    provider: 'openai',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
  },
  'gpt-4o-mini': {
    contextWindow: 128000,
    maxOutputTokens: 16384,
    timeoutMs: 60000,
    costPer1M: { input: 0.15, output: 0.6 },
    provider: 'openai',
    supportsVision: true,
    supportsToolCalling: true,
    supportsStreaming: true,
  },
  'o3-mini': {
    contextWindow: 200000,
    maxOutputTokens: 100000,
    timeoutMs: 120000,
    costPer1M: { input: 1.1, output: 4.4 },
    provider: 'openai',
    supportsVision: false,
    supportsToolCalling: true,
    supportsStreaming: true,
  },
};

const MODEL_DEFAULTS: ModelCapabilities = {
  contextWindow: 128000,
  maxOutputTokens: 8192,
  timeoutMs: 120000,
  costPer1M: null,
  provider: 'unknown',
  supportsVision: false,
  supportsToolCalling: true,
  supportsStreaming: true,
  supportsThinking: false,
};

/**
 * Look up capabilities for a model ID.
 * Priority: config.models.catalog > built-in exact > built-in substring > defaults
 */
function getModelCapabilities(
  modelId: string | undefined,
  config?: GatewayConfig,
): ModelCapabilities {
  if (!modelId) return { ...MODEL_DEFAULTS };

  // 1. User overrides in config.models.catalog (exact match)
  const catalog = config?.models?.catalog;
  if (catalog?.[modelId]) {
    return { ...MODEL_DEFAULTS, ...catalog[modelId] };
  }

  // 2. Exact match in built-in table
  if (MODEL_CAPABILITIES[modelId]) {
    return { ...MODEL_DEFAULTS, ...MODEL_CAPABILITIES[modelId] };
  }

  // 3. Substring match (e.g. "anthropic/claude-opus-4-6" contains "claude-opus-4-6")
  // Sort by length descending so longer (more specific) matches win first
  const key = Object.keys(MODEL_CAPABILITIES)
    .filter(k => modelId.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (key) {
    return { ...MODEL_DEFAULTS, ...MODEL_CAPABILITIES[key] };
  }

  // 4. Check catalog with substring match too
  if (catalog) {
    const catKey = Object.keys(catalog)
      .filter(k => modelId.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (catKey) {
      return { ...MODEL_DEFAULTS, ...catalog[catKey] };
    }
  }

  return { ...MODEL_DEFAULTS };
}

/**
 * Estimate cost for token usage on a given model.
 * Returns { input, output, total } in dollars, or null if unknown.
 */
function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  config?: GatewayConfig,
): CostEstimate | null {
  const caps = getModelCapabilities(modelId, config);
  const rates = caps.costPer1M;
  if (!rates) return null;
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return { input: inputCost, output: outputCost, total: inputCost + outputCost };
}

export { MODEL_CAPABILITIES, MODEL_DEFAULTS, getModelCapabilities, estimateCost };
