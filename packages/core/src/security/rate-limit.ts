/**
 * Rate limit configuration helpers.
 *
 * Provides route-aware rate limit settings that can be passed
 * to @fastify/rate-limit or similar plugins.
 */

export interface RateLimitConfig {
  /** Max chat requests per window. */
  chatMax: number;
  /** Max admin requests per window. */
  adminMax: number;
  /** Time window in milliseconds. */
  windowMs: number;
}

export const defaultRateLimits: RateLimitConfig = {
  chatMax: 30,
  adminMax: 120,
  windowMs: 60_000,
};

/**
 * Apply route-specific rate limits.
 * Chat endpoints get tighter limits than admin endpoints.
 */
export function getRateLimitConfig(
  path: string,
  config?: Partial<RateLimitConfig>,
): { max: number; timeWindow: string } {
  const limits = { ...defaultRateLimits, ...config };
  const isChat = path.includes('/chat');
  return {
    max: isChat ? limits.chatMax : limits.adminMax,
    timeWindow: `${limits.windowMs} milliseconds`,
  };
}
