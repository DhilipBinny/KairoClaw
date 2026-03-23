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
import { createModuleLogger } from '../../observability/logger.js';

const log = createModuleLogger('tool');

/** Marker on tool results that tells the agent loop children are pending. */
export const SUBAGENT_PENDING_MARKER = '_subagentPending';

export const subagentTools: ToolRegistration[] = [
  // ── spawn_agent ─────────────────────────────────────────
  {
    definition: {
      name: 'spawn_agent',
      description:
        'Spawn a sub-agent to handle a task in parallel. Returns immediately — ' +
        'results arrive after all spawned agents complete. Use multiple spawn_agent ' +
        'calls in one turn to run tasks concurrently. Sub-agents have their own ' +
        'context and can use all tools except spawn_agent.',
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

      // Exclude spawn_agent and kill_agent from child's toolset (flat depth)
      const childTools = tools?.filter(t => t.name !== 'spawn_agent' && t.name !== 'kill_agent');

      log.info({ parentSession: parentSessionId, childId, taskLen: task.length }, 'Spawning sub-agent (async)');

      // Register the child — fires runAgent in the background
      // Uses ephemeral mode: no DB session, no persistence, zero orphan risk
      registry.register(childId, task, async (_signal) => {
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

        return await runAgent(
          inbound,
          { onDelta: () => {}, onRoundStart: () => {}, onRoundEnd: () => {} },
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
      });

      // Return immediately — the agent loop will detect the pending marker
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
