/**
 * `sleep` — deliberate wait tool (Phase 11, only Phase 11 tool kept
 * from the original reach-tools set).
 *
 * Blocks for a bounded number of milliseconds, then returns how long
 * the sleep actually took. Useful for:
 *
 *   - Polling loops where an external resource needs a moment to
 *     settle (e.g. "wait 10 s then call web_fetch again")
 *   - Rate-limit backoff between consecutive calls to the same tool
 *   - "Check back in 30 seconds" patterns where the agent wants to
 *     yield control briefly without ending the turn
 *
 * Capped at 5 minutes — longer waits should use cron or a background
 * task instead. Anything under 100 ms is clamped up to 100 ms because
 * sleeping for single-digit millis is almost always a confused intent.
 *
 * Not destructive, concurrency-safe, and always-loaded so the agent
 * can reach for it without a `tool_search` round.
 */

import type { ToolRegistration } from '@agw/tool-platform';
import { textEnvelope } from '@agw/tool-platform';

const MIN_SLEEP_MS = 100;
const MAX_SLEEP_MS = 5 * 60 * 1_000; // 5 minutes

export const sleepTools: ToolRegistration[] = [
  {
    definition: {
      name: 'sleep',
      searchHint: 'sleep wait delay pause backoff poll',
      alwaysLoad: true,
      description:
        'Pause for a bounded number of milliseconds, then resume. Use ' +
        'for rate-limit backoff, poll intervals, or brief "wait and ' +
        'retry" patterns. Clamped to [100, 300000] ms (5 min max). ' +
        'For longer waits use cron or a background task instead.',
      parameters: {
        type: 'object',
        properties: {
          duration_ms: {
            type: 'number',
            description: 'Milliseconds to sleep. Clamped to [100, 300000]. Default 1000.',
          },
        },
        required: [],
      },
    },
    executor: async (args, _context) => {
      const raw = typeof args.duration_ms === 'number' ? args.duration_ms : 1_000;
      const clamped = Math.max(MIN_SLEEP_MS, Math.min(raw, MAX_SLEEP_MS));
      const start = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, clamped));
      const elapsed = Date.now() - start;
      return textEnvelope(
        `Slept ${elapsed} ms (requested ${raw}, clamped to ${clamped}).`,
      );
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    concurrencySafe: true,
    getActivityDescription: (input) => {
      const ms = (input as { duration_ms?: number })?.duration_ms ?? 1000;
      return `Sleeping ${ms} ms`;
    },
  },
];
