/**
 * Built-in model pricing — USD per 1,000,000 tokens.
 *
 * WHY THIS EXISTS: no provider API returns pricing, so a cost estimate needs a
 * static source. Anthropic rates below are the published list prices; OpenAI
 * rates are public list-price estimates and drift over time. Treat them as
 * defaults only. Precedence at runtime:
 *   1. admin config  (models.capabilities[*].costPer1M)  — always wins
 *   2. this table     (matched by longest token-boundary substring of the id)
 *   3. null           (unknown model → cost not estimated, never fabricated)
 *
 * MATCHING: a key matches only on token boundaries (start/end or a non-alphanumeric
 * separator on each side), so "o1" doesn't match "studio1" and "sonnet" doesn't
 * match "llama3-sonnet". Keys are intentionally specific (e.g. "claude-opus-4",
 * "gpt-4o-mini") rather than bare family words, so a locally-hosted model named
 * after a family word isn't billed at a hosted-model rate.
 *
 * MAINTENANCE: update the table and bump PRICING_AS_OF.
 * Sources: https://www.anthropic.com/pricing  ·  https://openai.com/api/pricing
 */
export const PRICING_AS_OF = '2026-06-14';

export interface TokenRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

export const MODEL_PRICING: Record<string, TokenRate> = {
  // ── Anthropic (published list prices) ──
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-4': { input: 5, output: 25 },      // Opus 4.6/4.7/4.8
  'claude-sonnet-4': { input: 3, output: 15 },    // Sonnet 4.x
  'claude-haiku-4': { input: 1, output: 5 },      // Haiku 4.x
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },     // retired Claude 3 Opus
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // ── OpenAI (public list-price estimates) ──
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o1-mini': { input: 1.1, output: 4.4 },
};

const ALNUM = /[A-Za-z0-9]/;

/** True if `key` appears in `bareId` delimited by non-alphanumeric chars (or ends). */
function tokenBoundaryMatch(bareId: string, key: string): boolean {
  let from = 0;
  for (;;) {
    const idx = bareId.indexOf(key, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : bareId[idx - 1];
    const afterIdx = idx + key.length;
    const after = afterIdx >= bareId.length ? '' : bareId[afterIdx];
    if ((before === '' || !ALNUM.test(before)) && (after === '' || !ALNUM.test(after))) return true;
    from = idx + 1;
  }
}

/** Resolve built-in pricing for a bare model id by longest token-boundary match. */
export function lookupModelPricing(bareId: string): TokenRate | null {
  const key = Object.keys(MODEL_PRICING)
    .filter(k => tokenBoundaryMatch(bareId, k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? MODEL_PRICING[key] : null;
}
