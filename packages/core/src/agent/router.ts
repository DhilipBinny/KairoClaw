/**
 * Model Router — hybrid intelligent model selection.
 *
 * Two-stage classification:
 *   Stage 1 (rules): Instant, free — catches ~70% of messages
 *   Stage 2 (Haiku LLM): ~200ms, ~$0.00008 — classifies the ambiguous ~30%
 *
 * Picks the cheapest model that can handle each message well:
 *   - fast (Haiku): greetings, acknowledgments, simple questions
 *   - standard (Sonnet): tool use, analysis, drafting
 *   - powerful (Opus): deep reasoning, architecture, complex planning
 */

import type { InboundMessage, GatewayConfig, ChatArgs, ProviderResponse, RoutingConfig, ProvidersConfig } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

// ─── Types ─────────────────────────────────────────────────

export type RoutingTier = 'fast' | 'standard' | 'powerful' | 'forced';

export interface RoutingResult {
  /** Selected model ID (e.g., "anthropic/claude-haiku-4-5-20251001"). */
  model: string;
  /** Tier classification. */
  tier: RoutingTier;
  /** Human-readable reason for the routing decision. */
  reason: string;
  /** Which stage decided: 'rule', 'llm', 'force', or 'default'. */
  stage: 'rule' | 'llm' | 'force' | 'default';
}

// ─── Constants ─────────────────────────────────────────────

/** Greeting / acknowledgment patterns — instant Haiku routing. */
const GREETING_PATTERN = /^(hi|hello|hey|hola|salaam|marhaba|good\s*(morning|afternoon|evening|night)|thanks|thank\s*you|ok|okay|sure|yes|no|yep|nope|bye|goodbye|see\s*ya|cheers|👋|👍|🙏|❤️|😊|🎉|💯)\s*[!.?]*$/i;

/** User model override prefix pattern. */
const MODEL_OVERRIDE_PATTERN = /^@(haiku|sonnet|opus)\s+/i;

// ─── Stage 1: Rule-Based Classification ────────────────────

/**
 * Classify a message using deterministic rules.
 * Returns null if no rule matched (ambiguous → needs Stage 2).
 */
export function classifyByRules(
  text: string,
  inbound: InboundMessage,
  routing: RoutingConfig,
): { tier: 'fast' | 'standard' | 'powerful'; reason: string } | null {
  // ── User overrides (@haiku, @sonnet, @opus prefix) ──
  const overrideMatch = text.match(MODEL_OVERRIDE_PATTERN);
  if (overrideMatch) {
    const tier = overrideMatch[1]!.toLowerCase();
    if (tier === 'opus') return { tier: 'powerful', reason: 'user override @opus' };
    if (tier === 'haiku') return { tier: 'fast', reason: 'user override @haiku' };
    return { tier: 'standard', reason: 'user override @sonnet' };
  }

  // ── Images → standard (vision quality matters) ──
  if (inbound.images && inbound.images.length > 0) {
    return { tier: 'standard', reason: 'has images' };
  }

  // ── Admin opus patterns ──
  if (routing.opusPatterns) {
    for (const pattern of routing.opusPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(text)) {
          return { tier: 'powerful', reason: `opus pattern: ${pattern}` };
        }
      } catch { /* skip invalid regex */ }
    }
  }

  // ── Admin haiku patterns ──
  if (routing.haikuPatterns) {
    for (const pattern of routing.haikuPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(text)) {
          return { tier: 'fast', reason: `haiku pattern: ${pattern}` };
        }
      } catch { /* skip invalid regex */ }
    }
  }

  // ── Greetings and acknowledgments → fast ──
  if (GREETING_PATTERN.test(text)) {
    return { tier: 'fast', reason: 'greeting/acknowledgment' };
  }

  // ── Short messages without question marks → fast ──
  const threshold = routing.shortMessageThreshold ?? 50;
  if (text.length < threshold && !text.includes('?')) {
    return { tier: 'fast', reason: 'short message' };
  }

  // No rule matched → ambiguous
  return null;
}

// ─── Stage 2: LLM Classifier ──────────────────────────────

/**
 * Ask Haiku to classify a message as SIMPLE, STANDARD, or COMPLEX.
 * Returns null if classification failed (caller falls back to default).
 */
export async function classifyByLLM(
  text: string,
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>,
  classifierModel: string,
): Promise<{ tier: 'fast' | 'standard' | 'powerful'; reason: string } | null> {
  try {
    const response = await callLLM({
      messages: [{
        role: 'user',
        content: `Classify this user message for an AI assistant:

<message>
${text.slice(0, 500)}
</message>

Guidelines:
- SIMPLE: greetings, yes/no, short factual questions, translations, acknowledgments, simple lookups, anything a fast cheap model handles well
- STANDARD: needs tool usage (file operations, web search, calculations), multi-step tasks, document drafting, data analysis, moderate reasoning
- COMPLEX: requires deep reasoning, architecture design, comparing multiple documents, long-form strategic planning, novel problem-solving

Reply with ONE word only: SIMPLE, STANDARD, or COMPLEX.`,
      }],
      model: classifierModel,
      systemPrompt: 'You are a message complexity classifier. Respond with exactly one word: SIMPLE, STANDARD, or COMPLEX. Nothing else.',
    });

    const word = (response.text || '').trim().toUpperCase();
    if (word === 'SIMPLE' || word.startsWith('SIMPLE')) {
      return { tier: 'fast', reason: 'LLM classified as SIMPLE' };
    }
    if (word === 'COMPLEX' || word.startsWith('COMPLEX')) {
      return { tier: 'powerful', reason: 'LLM classified as COMPLEX' };
    }
    if (word === 'STANDARD' || word.startsWith('STANDARD')) {
      return { tier: 'standard', reason: 'LLM classified as STANDARD' };
    }

    // Unexpected response → null (fall through to default)
    log.debug({ response: word, classifierModel }, 'Router: unexpected LLM classifier response');
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, classifierModel }, 'Router: LLM classifier failed');
    return null;
  }
}

// ─── Model Resolution ──────────────────────────────────────

/**
 * Check if the provider for a model ID is actually configured.
 * Model IDs follow the "provider/model-name" convention.
 * Returns true for unknown providers — let callWithFailover handle them.
 */
function isProviderConfigured(modelId: string, providers: ProvidersConfig): boolean {
  const provider = modelId.split('/')[0];
  if (!provider) return true;
  switch (provider) {
    case 'anthropic':
      return !!(providers.anthropic?.apiKey?.trim() || providers.anthropic?.apiKeyFile?.trim());
    case 'openai':
      return !!(providers.openai?.apiKey?.trim() || providers.openai?.apiKeyFile?.trim());
    case 'ollama':
      return !!(providers.ollama?.baseUrl?.trim());
    default:
      return true;
  }
}

/**
 * Resolve model ID for a tier.
 * Uses the configured fast/powerful model if set AND its provider is available.
 * Falls back to primary model in all other cases — no hardcoded Anthropic defaults.
 */
function resolveModelForTier(
  tier: 'fast' | 'standard' | 'powerful',
  routing: RoutingConfig,
  config: GatewayConfig,
): string {
  const primary = config.model.primary;
  switch (tier) {
    case 'fast': {
      const fast = routing.fastModel?.trim();
      if (fast && isProviderConfigured(fast, config.providers)) return fast;
      return primary;
    }
    case 'powerful': {
      const powerful = routing.powerfulModel?.trim();
      if (powerful && isProviderConfigured(powerful, config.providers)) return powerful;
      return primary;
    }
    case 'standard':
    default:
      return primary;
  }
}

// ─── Main Router ───────────────────────────────────────────

/**
 * Strip the @model override prefix from message text.
 * Returns the cleaned text (without the prefix).
 */
export function stripModelOverride(text: string): string {
  return text.replace(MODEL_OVERRIDE_PATTERN, '');
}

/**
 * Route an incoming message to the appropriate model tier.
 *
 * Flow:
 *   1. Routing disabled? → primary model
 *   2. Force model set? → that model
 *   3. Stage 1: rules → instant, free
 *   4. Stage 2: Haiku classifier → 200ms, ~$0.00008 (if enabled + ambiguous)
 *   5. Default → primary model (Sonnet)
 */
export async function routeModel(
  inbound: InboundMessage,
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>,
  config: GatewayConfig,
): Promise<RoutingResult> {
  const routing = config.agent?.routing;
  const primaryModel = config.model.primary;

  // ── Not enabled → always primary ──
  if (!routing?.enabled) {
    return { model: primaryModel, tier: 'standard', reason: 'routing disabled', stage: 'default' };
  }

  // ── Force model override → bypass all routing ──
  const forceModel = routing.forceModel;
  if (forceModel && forceModel.trim()) {
    return { model: forceModel, tier: 'forced', reason: 'force override', stage: 'force' };
  }

  const text = inbound.text.trim();

  // ── Stage 1: Rules ──
  const ruleResult = classifyByRules(text, inbound, routing);
  if (ruleResult) {
    const model = resolveModelForTier(ruleResult.tier, routing, config);
    return { model, tier: ruleResult.tier, reason: ruleResult.reason, stage: 'rule' };
  }

  // ── Stage 2: LLM Classifier (if enabled) ──
  if (routing.llmClassifier !== false) {
    // Use fast model if configured and its provider is available; otherwise primary
    const fast = routing.fastModel?.trim();
    const classifierModel = (fast && isProviderConfigured(fast, config.providers))
      ? fast
      : primaryModel;

    const llmResult = await classifyByLLM(text, callLLM, classifierModel);
    if (llmResult) {
      const model = resolveModelForTier(llmResult.tier, routing, config);
      return { model, tier: llmResult.tier, reason: llmResult.reason, stage: 'llm' };
    }
  }

  // ── Default → standard ──
  return { model: primaryModel, tier: 'standard', reason: 'no rule matched, classifier skipped or failed', stage: 'default' };
}
