/**
 * Sub-agent tools — `spawn_agent` and `kill_agent`.
 *
 * spawn_agent fires a child agent in the background (non-blocking).
 * The agent loop detects pending children, waits for all to complete,
 * and injects lightweight result summaries back into the conversation.
 *
 * Sub-agents are flat (depth 1) — children cannot spawn further children.
 * This prevents runaway nesting and token explosion.
 */

import crypto from 'node:crypto';
import type { ToolRegistration } from '../types.js';
import type { InboundMessage } from '@agw/types';
import type { SubAgentRegistry } from '../../agent/subagent-registry.js';
import { backgroundTaskRegistry, type BackgroundTaskRegistry } from '../../agent/background-task-registry.js';
import { createModuleLogger } from '../../observability/logger.js';
import { textEnvelope } from '../envelope.js';

const log = createModuleLogger('tool');

/** Marker on tool results that tells the agent loop children are pending. */
export const SUBAGENT_PENDING_MARKER = '_subagentPending';

/** Format a short human-readable duration like "12.3s" or "1m 04s". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export const subagentTools: ToolRegistration[] = [
  // ── spawn_agent ─────────────────────────────────────────
  {
    definition: {
      name: 'spawn_agent',
      searchHint: 'spawn subagent parallel task delegate',
      alwaysLoad: true,
      description:
        'Spawn a sub-agent to handle a task. Two modes:\n' +
        '- Default (run_in_background=false): blocks the current turn until the ' +
        'sub-agent finishes, then injects a result summary. Use multiple concurrent ' +
        'spawn_agent calls in one turn for parallel work.\n' +
        '- Background (run_in_background=true): returns a task_id immediately ' +
        'without waiting. The task keeps running after this turn ends; check on ' +
        'it later with task_list / task_output / task_stop.\n' +
        'Sub-agents have their own context and can use all tools except spawn_agent.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Detailed task description for the sub-agent',
          },
          model: {
            type: 'string',
            description: 'Optional model override (e.g. "anthropic/claude-sonnet-4-6")',
          },
          run_in_background: {
            type: 'boolean',
            description: 'When true, return a task_id immediately without blocking the current turn. The background task outlives this turn and is queryable via task_list / task_output / task_stop. Default false.',
          },
        },
        required: ['task'],
      },
    },
    executor: async (args, context) => {
      const task = args.task as string;
      if (!task || typeof task !== 'string') {
        return { error: 'task is required and must be a string' };
      }
      if (task.length > 50_000) {
        return { error: 'Task description too long (max 50000 chars)' };
      }

      const ctx = context as Record<string, unknown>;
      const registry = ctx.subagentRegistry as SubAgentRegistry | undefined;
      const callLLM = ctx.callLLM as ((...a: unknown[]) => Promise<unknown>) | undefined;
      const db = ctx.db as import('../../db/index.js').DatabaseAdapter | undefined;
      const config = ctx.config as import('@agw/types').GatewayConfig | undefined;
      const executeTool = ctx.executeTool as ((name: string, toolArgs: Record<string, unknown>, toolCtx: unknown) => Promise<unknown>) | undefined;
      const tools = ctx.tools as import('@agw/types').ToolDefinition[] | undefined;
      const tenantId = (ctx.tenantId as string) || 'default';

      if (!registry) {
        return { error: 'Sub-agent registry not available' };
      }
      if (!callLLM || !db || !config) {
        return { error: 'Sub-agent context incomplete — callLLM, db, and config are required' };
      }

      const childId = `sub-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const parentSessionId = (ctx.session as { id?: string })?.id || 'unknown';
      const modelOverride = (args.model as string) || undefined;
      const runInBackground = args.run_in_background === true;

      // Exclude spawn_agent and kill_agent from child's toolset (flat depth).
      // Also strip task_* tools from background children — a background task
      // managing its own task list would be confusing and pointless.
      const childTools = tools?.filter(
        (t) => t.name !== 'spawn_agent' && t.name !== 'kill_agent' && !t.name.startsWith('task_'),
      );

      log.info({ parentSession: parentSessionId, childId, taskLen: task.length, runInBackground }, 'Spawning sub-agent');

      // Shared child-run body — used by both in-turn and background paths.
      // Background-mode children receive an extra `taskId` so their stream
      // deltas can be piped into the registry's live partialOutput buffer.
      const runChild = async (_signal: AbortSignal, bgTaskId?: string) => {
        // Lazy import to avoid circular dependency
        const { runAgent } = await import('../../agent/loop.js');

        // Create a virtual session object (not persisted to DB)
        const virtualSession = {
          id: childId,
          tenant_id: tenantId,
          user_id: null,
          channel: 'internal',
          chat_id: `subagent:${childId}`,
          model: modelOverride || config.model.primary,
          input_tokens: 0,
          output_tokens: 0,
          turns: 0,
          metadata: '{}',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          expires_at: null,
        };

        const inbound: InboundMessage = {
          text: task,
          channel: 'internal',
          chatId: `subagent:${childId}`,
          chatType: 'private',
          userId: 'subagent',
          senderName: 'Parent Agent',
        };

        // Live progress — only populated for background tasks. For in-turn
        // children the parent loop already sees the result inline.
        const onDelta = bgTaskId
          ? (chunk: string) => backgroundTaskRegistry.appendOutput(bgTaskId, chunk)
          : () => {};
        const onToolStart = bgTaskId
          ? (name: string, _args: Record<string, unknown>) => {
              backgroundTaskRegistry.appendOutput(bgTaskId, `\n→ ${name}\n`);
            }
          : () => {};

        return await runAgent(
          inbound,
          { onDelta, onToolStart, onRoundStart: () => {}, onRoundEnd: () => {} },
          {
            db,
            config,
            session: virtualSession,
            tenantId,
            callLLM: callLLM as any,
            tools: childTools,
            executeTool: executeTool as any,
            model: modelOverride,
            subagentDepth: 1,
            scopeKey: (ctx.scopeKey as string | null) ?? null,
            ephemeral: true, // no DB persistence — in-memory only
          },
        );
      };

      // Background mode: register with the process-lifetime registry and
      // return the task_id immediately. The current turn is not blocked,
      // and the task keeps running even after this turn ends. The
      // registry hands the freshly-minted task id back to runChild so
      // its live deltas land in the right partialOutput buffer.
      if (runInBackground) {
        const scopeKey = (ctx.scopeKey as string | null) ?? null;
        const userId = context.user?.id && context.user.id !== 'anonymous' && context.user.id !== 'system'
          ? context.user.id
          : null;
        const entry = backgroundTaskRegistry.register(
          scopeKey,
          task,
          (signal, bgId) => runChild(signal, bgId),
          { userId },
        );
        return textEnvelope(
          `Background task spawned.\n` +
          `task_id: ${entry.id}\n` +
          `status:  running\n\n` +
          `Check progress with task_output(task_id="${entry.id}"), ` +
          `list active tasks with task_list, or cancel with task_stop(task_id="${entry.id}").`,
        );
      }

      // In-turn mode: hand off to the per-turn SubAgentRegistry and
      // tell the loop to wait for pending children via the marker.
      registry.register(childId, task, runChild);

      return {
        [SUBAGENT_PENDING_MARKER]: true,
        childId,
        task: task.slice(0, 200),
        message: 'Sub-agent spawned — results will be available after all sub-agents complete.',
      };
    },
    source: 'builtin',
    category: 'execute',
  },

  // ── task_list ───────────────────────────────────────────
  {
    definition: {
      name: 'task_list',
      searchHint: 'list background tasks running jobs',
      alwaysLoad: true,
      description:
        'List background tasks visible to the current scope. Returns id, ' +
        'status (running/completed/error/killed), duration, and a one-line ' +
        'task preview for each. Admins see all tasks across all scopes; ' +
        'regular users only see their own. Use task_output for full text.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async (_args, context) => {
      const ctx = context as Record<string, unknown>;
      const bgReg = (ctx.backgroundTasks as BackgroundTaskRegistry | undefined) ?? backgroundTaskRegistry;
      const scopeKey = (ctx.scopeKey as string | null) ?? null;
      const isAdmin = context.user?.role === 'admin';
      const tasks = bgReg.list(scopeKey, isAdmin);

      if (tasks.length === 0) {
        return textEnvelope('No background tasks.');
      }

      const now = Date.now();
      const lines: string[] = [`Background tasks (${tasks.length}):`, ''];
      for (const t of tasks) {
        const dur = fmtDuration((t.completedAt ?? now) - t.startedAt);
        const preview = t.task.replace(/\s+/g, ' ').slice(0, 80);
        const scopeSuffix = isAdmin && t.scopeKey ? ` [scope:${t.scopeKey}]` : '';
        lines.push(`- ${t.id}  ${t.status.padEnd(9)}  ${dur.padStart(7)}${scopeSuffix}`);
        lines.push(`    ${preview}${t.task.length > 80 ? '...' : ''}`);
      }
      return textEnvelope(lines.join('\n'));
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    getActivityDescription: () => 'task_list',
  },

  // ── task_output ─────────────────────────────────────────
  {
    definition: {
      name: 'task_output',
      searchHint: 'read background task result output wait',
      alwaysLoad: true,
      description:
        'Return the current status and output of a background task. ' +
        'If still running, returns whatever output has been emitted so far ' +
        '(streamed text + tool activity markers). If finished, returns the ' +
        'final answer.\n\n' +
        'Set block=true to wait for completion within this single tool call ' +
        '(default false; saves polling round-trips). timeout_ms caps the wait ' +
        '(default 30000, max 300000). When block times out the task keeps ' +
        'running — call task_output again later, or task_stop to cancel.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The background task id (returned by spawn_agent with run_in_background=true).',
          },
          block: {
            type: 'boolean',
            description: 'When true, wait for the task to leave running status before returning. Default false.',
          },
          timeout_ms: {
            type: 'number',
            description: 'Max wait when block=true, in milliseconds. Default 30000, max 300000.',
          },
        },
        required: ['task_id'],
      },
    },
    executor: async (args, context) => {
      const taskId = (args.task_id as string || '').trim();
      if (!taskId) return { error: 'task_id is required' };
      const block = args.block === true;
      const rawTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000;
      const timeoutMs = Math.max(0, Math.min(rawTimeout, 300_000));
      const ctx = context as Record<string, unknown>;
      const bgReg = (ctx.backgroundTasks as BackgroundTaskRegistry | undefined) ?? backgroundTaskRegistry;
      const scopeKey = (ctx.scopeKey as string | null) ?? null;
      const isAdmin = context.user?.role === 'admin';

      // TC-1 / TC-11: use the structured `resolve()` so we can tell
      // the agent WHY the lookup failed — "id doesn't exist at all"
      // vs "id belongs to a scope you can't see" vs "prefix matches
      // multiple visible tasks and we don't want to guess which".
      const r = bgReg.resolve(taskId, scopeKey, isAdmin);
      if (r.kind === 'not-found') {
        return {
          error:
            `No background task with id "${taskId}" exists. It may be a typo, a ` +
            `truncated paste, or the task may have been garbage-collected on a ` +
            `kairobm restart (the registry is in-memory only).`,
        };
      }
      if (r.kind === 'wrong-scope') {
        return {
          error:
            `Background task "${taskId}" exists but belongs to a scope you cannot ` +
            `see. Use task_list to list tasks visible in your own scope.`,
        };
      }
      if (r.kind === 'ambiguous-prefix') {
        return {
          error:
            `Prefix "${taskId}" matches ${r.candidates.length} tasks: ` +
            `${r.candidates.join(', ')}. Pass a longer prefix or the full id.`,
        };
      }
      let t = r.task;

      // Blocking wait — poll the registry until the task settles or we
      // hit the timeout. The registry caps wait at 5 min via the clamp
      // above, well under the agent loop's per-tool budget.
      if (block && t.status === 'running') {
        const updated = await bgReg.waitFor(t.id, timeoutMs);
        if (updated) t = updated;
      }

      const now = Date.now();
      const dur = fmtDuration((t.completedAt ?? now) - t.startedAt);
      const header = [
        `task_id: ${t.id}`,
        `status:  ${t.status}`,
        `elapsed: ${dur}`,
        `task:    ${t.task.replace(/\s+/g, ' ').slice(0, 200)}`,
        '',
      ].join('\n');

      if (t.status === 'running') {
        const partial = (t.partialOutput ?? '').trim();
        const body = partial.length > 0
          ? `[still running — partial output below]\n\n${partial}`
          : '[still running — no output yet]';
        return textEnvelope(`${header}${body}`);
      }
      if (t.status === 'error') {
        return textEnvelope(`${header}error: ${t.error ?? 'unknown'}`);
      }
      if (t.status === 'killed') {
        return textEnvelope(`${header}[cancelled]`);
      }
      // completed
      const body = (t.resultText ?? '').trim() || '[no text output]';
      return textEnvelope(`${header}${body}`);
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    getActivityDescription: (input) => {
      const id = (input as { task_id?: string })?.task_id ?? '';
      return `task_output: ${id}`;
    },
  },

  // ── task_stop ───────────────────────────────────────────
  {
    definition: {
      name: 'task_stop',
      searchHint: 'stop cancel background task kill',
      alwaysLoad: true,
      description:
        'Abort a running background task by its id. No-op if the task is ' +
        'already finished. Returns the reason (killed / already-completed / ' +
        'already-error / already-killed / not-found).',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The background task id to stop.',
          },
        },
        required: ['task_id'],
      },
    },
    executor: async (args, context) => {
      const taskId = (args.task_id as string || '').trim();
      if (!taskId) return { error: 'task_id is required' };
      const ctx = context as Record<string, unknown>;
      const bgReg = (ctx.backgroundTasks as BackgroundTaskRegistry | undefined) ?? backgroundTaskRegistry;
      const scopeKey = (ctx.scopeKey as string | null) ?? null;
      const isAdmin = context.user?.role === 'admin';
      const reason = bgReg.stop(taskId, scopeKey, isAdmin);
      if (reason === 'not-found') {
        return {
          error:
            `No background task with id "${taskId}" exists. It may be a typo, a ` +
            `truncated paste, or already garbage-collected on a kairobm restart.`,
        };
      }
      if (reason === 'wrong-scope') {
        return {
          error:
            `Background task "${taskId}" belongs to a scope you cannot see. Use ` +
            `task_list to list tasks visible in your own scope.`,
        };
      }
      if (reason === 'ambiguous-prefix') {
        return {
          error:
            `Prefix "${taskId}" matches multiple tasks — pass a longer prefix or the full id.`,
        };
      }
      return textEnvelope(`task_stop(${taskId}): ${reason}`);
    },
    source: 'builtin',
    category: 'execute',
    getActivityDescription: (input) => {
      const id = (input as { task_id?: string })?.task_id ?? '';
      return `task_stop: ${id}`;
    },
  },

  // ── kill_agent ──────────────────────────────────────────
  {
    definition: {
      name: 'kill_agent',
      description: 'Cancel a running sub-agent by its child ID.',
      parameters: {
        type: 'object',
        properties: {
          childId: {
            type: 'string',
            description: 'The childId returned by spawn_agent',
          },
        },
        required: ['childId'],
      },
    },
    executor: async (args, context) => {
      const childId = args.childId as string;
      if (!childId) return { error: 'childId is required' };

      const ctx = context as Record<string, unknown>;
      const registry = ctx.subagentRegistry as SubAgentRegistry | undefined;
      if (!registry) return { error: 'Sub-agent registry not available' };

      const killed = registry.kill(childId);
      if (killed) {
        return { success: true, childId, message: 'Sub-agent cancelled.' };
      }

      const entry = registry.get(childId);
      if (!entry) return { error: `Sub-agent "${childId}" not found` };
      return { error: `Sub-agent "${childId}" is already ${entry.status}` };
    },
    source: 'builtin',
    category: 'execute',
  },
];
