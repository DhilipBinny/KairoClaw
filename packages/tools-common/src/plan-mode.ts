/**
 * `enter_plan_mode` / `exit_plan_mode` — agent behavioural state
 * machine (Phase 9).
 *
 * Plan mode is NOT a permission gate — it's a behavioural shaping
 * that tells the agent "think before acting". When a session is in
 * plan mode:
 *   1. Write-category tools (edit_file, write_file, exec, apply_patch,
 *      send_*, etc.) are short-circuited by the registry with a clean
 *      "plan mode active" message instead of actually running.
 *   2. Read-category tools (read_file, grep, glob, memory_search,
 *      todo_write, etc.) still run so the agent can explore + plan.
 *   3. The system prompt gets a "you are in plan mode" banner (via
 *      the agent loop — for now that's a TODO; the registry-level
 *      short-circuit is the enforcement).
 *
 * Storage: per-session flag in a Set on the registry. In-memory only
 * — lost on process restart. In practice plan mode is used inside a
 * single turn (enter → plan → exit → execute) and occasionally
 * across 2-3 turns, so volatility is fine. A durable version could
 * persist to sessions.metadata later.
 *
 * The registry's gate check lives in ToolRegistry.execute and is
 * wired via ToolRegistry.isInPlanMode / setPlanMode.
 */

import type { ToolRegistration } from '@agw/tool-platform';
import type { ToolRegistry } from '@agw/tool-platform';
import type { Session } from '@agw/types';
import { textEnvelope } from '@agw/tool-platform';

function getSessionId(context: { session?: Session | { id?: string } }): string | undefined {
  const s = context.session;
  return (s as { id?: string })?.id ?? (s as Session | undefined)?.sessionId;
}

export const planModeTools: ToolRegistration[] = [
  {
    definition: {
      name: 'enter_plan_mode',
      searchHint: 'plan mode think before acting',
      alwaysLoad: true,
      description:
        'Enter plan mode for the current session. While in plan mode, ' +
        'write-category tools (edit_file, write_file, exec, apply_patch, ' +
        'send_*) are blocked with a "plan mode active" message so you ' +
        'think the approach through before touching state. Read-category ' +
        'tools (read_file, grep, glob, memory_search, todo_write) still ' +
        'run normally so you can explore and draft a plan. ' +
        'Call exit_plan_mode when you have a plan and the user approves.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Optional short note explaining why you\'re entering plan mode (shown in the envelope).',
          },
        },
        required: [],
      },
    },
    executor: async (args, context) => {
      const ctx = context as unknown as { toolRegistry?: ToolRegistry };
      const registry = ctx.toolRegistry;
      if (!registry) {
        return { error: 'enter_plan_mode: registry not available in context' };
      }
      const sessionId = getSessionId(context);
      if (!sessionId) {
        return { error: 'enter_plan_mode: no session id in context' };
      }

      registry.setPlanMode(sessionId, true);

      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      const reasonSuffix = reason ? `\nReason: ${reason}` : '';
      return textEnvelope(
        `Plan mode: ON for session ${sessionId.slice(0, 8)}.\n` +
        `Write-category tools are now blocked. Read-category tools still work. ` +
        `Explore, draft your plan (consider using todo_write), ` +
        `then call exit_plan_mode when ready to execute.${reasonSuffix}`,
      );
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    getActivityDescription: () => 'enter_plan_mode',
  },
  {
    definition: {
      name: 'exit_plan_mode',
      searchHint: 'exit plan mode ready to execute',
      alwaysLoad: true,
      description:
        'Exit plan mode for the current session. Write-category tools ' +
        'become callable again. Call this after you have explored, ' +
        'drafted a plan (usually via todo_write), and the user has ' +
        'seen and approved it.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'Optional summary of the plan you\'re about to execute (shown in the envelope for the user).',
          },
        },
        required: [],
      },
    },
    executor: async (args, context) => {
      const ctx = context as unknown as { toolRegistry?: ToolRegistry };
      const registry = ctx.toolRegistry;
      if (!registry) {
        return { error: 'exit_plan_mode: registry not available in context' };
      }
      const sessionId = getSessionId(context);
      if (!sessionId) {
        return { error: 'exit_plan_mode: no session id in context' };
      }

      const wasActive = registry.isInPlanMode(sessionId);
      registry.setPlanMode(sessionId, false);

      const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
      const planSection = plan ? `\n\nPlan to execute:\n${plan}` : '';
      const preface = wasActive
        ? `Plan mode: OFF for session ${sessionId.slice(0, 8)}. Write-category tools are now callable again.`
        : `Plan mode was already off for session ${sessionId.slice(0, 8)}.`;
      return textEnvelope(`${preface}${planSection}`);
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    getActivityDescription: () => 'exit_plan_mode',
  },
];
