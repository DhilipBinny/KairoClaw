/**
 * Sub-Agent Registry — tracks spawned child agents and their lifecycle.
 *
 * In-memory registry scoped per parent session. Children run as background
 * promises; the parent's agent loop waits for all pending children after
 * each tool-execution round.
 *
 * No persistence — sub-agent state lives only for the duration of the
 * parent's request. Sub-agent DB sessions and messages are cleaned up
 * after each child completes. Parent receives lightweight result summaries.
 */

import type { AgentResult } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';
import { SUBAGENT_TIMEOUT_MS } from '../constants.js';

const log = createModuleLogger('tool');

export type SubAgentStatus = 'running' | 'completed' | 'error' | 'killed';

export interface SubAgentEntry {
  childId: string;
  task: string;
  status: SubAgentStatus;
  /** The background promise — resolved when the child finishes. */
  promise: Promise<AgentResult>;
  /** Populated when status is 'completed'. */
  result?: AgentResult;
  /** Populated when status is 'error'. */
  error?: string;
  /** Abort controller to cancel a running child. */
  abort: AbortController;
  startedAt: number;
  completedAt?: number;
  /** True after result has been injected into parent's context. */
  resultInjected?: boolean;
}

/**
 * Per-parent-session registry of spawned sub-agents.
 *
 * Created at the start of `runAgent()` and passed into the tool
 * execution context. Garbage-collected when the parent request ends
 * (the registry is a local variable, not a global singleton).
 */
const MAX_IN_TURN_SUBAGENTS = 10;

export class SubAgentRegistry {
  private children = new Map<string, SubAgentEntry>();

  /** Register a new child. Called by spawn_agent tool. Throws if at capacity. */
  register(
    childId: string,
    task: string,
    runFn: (signal: AbortSignal) => Promise<AgentResult>,
  ): SubAgentEntry {
    const running = [...this.children.values()].filter(e => e.status === 'running').length;
    if (running >= MAX_IN_TURN_SUBAGENTS) {
      throw new Error(`Sub-agent limit reached (${MAX_IN_TURN_SUBAGENTS} concurrent). Wait for existing agents to complete or kill one.`);
    }

    const abort = new AbortController();

    const promise = runFn(abort.signal)
      .then((result) => {
        const entry = this.children.get(childId);
        if (entry && entry.status === 'running') {
          entry.status = 'completed';
          entry.result = result;
          entry.completedAt = Date.now();
          log.info({ childId, responseLen: result.text?.length ?? 0, durationMs: Date.now() - entry.startedAt }, 'Sub-agent completed');
        }
        return result;
      })
      .catch((err) => {
        const entry = this.children.get(childId);
        if (entry && entry.status === 'running') {
          entry.status = 'error';
          entry.error = err instanceof Error ? err.message : String(err);
          entry.completedAt = Date.now();
          log.error({ childId, err: entry.error, durationMs: Date.now() - entry.startedAt }, 'Sub-agent failed');
        }
        // Return a synthetic error result so Promise.all doesn't reject
        return { text: null, error: true } as AgentResult;
      });

    const entry: SubAgentEntry = {
      childId,
      task,
      status: 'running',
      promise,
      abort,
      startedAt: Date.now(),
    };

    this.children.set(childId, entry);
    log.info({ childId, taskLen: task.length }, 'Sub-agent registered');
    return entry;
  }

  /** Kill a running sub-agent. */
  kill(childId: string): boolean {
    const entry = this.children.get(childId);
    if (!entry) return false;
    if (entry.status !== 'running') return false;
    entry.abort.abort();
    entry.status = 'killed';
    entry.completedAt = Date.now();
    log.info({ childId, durationMs: Date.now() - entry.startedAt }, 'Sub-agent killed');
    return true;
  }

  /** Kill every running sub-agent (e.g. when the parent turn is cancelled). */
  abortAll(): number {
    let killed = 0;
    for (const childId of this.children.keys()) {
      if (this.kill(childId)) killed++;
    }
    return killed;
  }

  /** Check if there are any running children. */
  hasPending(): boolean {
    for (const entry of this.children.values()) {
      if (entry.status === 'running') return true;
    }
    return false;
  }

  /** Wait for all running children to complete (max 5 minutes per child). */
  async waitForAll(): Promise<Map<string, SubAgentEntry>> {
    const pending = [...this.children.values()].filter(e => e.status === 'running');
    if (pending.length === 0) return this.children;

    log.info({ count: pending.length }, 'Waiting for sub-agents to complete');
    const TIMEOUT_MS = SUBAGENT_TIMEOUT_MS;
    const withTimeout = pending.map(e =>
      Promise.race([
        e.promise,
        new Promise<void>(resolve => setTimeout(() => {
          if (e.status === 'running') {
            log.warn({ childId: e.childId, task: e.task }, 'Sub-agent timed out after 5 minutes');
            e.status = 'error';
            e.error = 'Sub-agent timed out';
            e.completedAt = Date.now();
            e.abort.abort();
          }
          resolve();
        }, TIMEOUT_MS)),
      ]),
    );
    await Promise.all(withTimeout);
    return this.children;
  }

  /**
   * Wait for ALL child promises (including killed ones) to settle, to prevent
   * floating promises outliving the turn. We await on promise settlement, NOT
   * on `completedAt`: kill() sets completedAt synchronously while the child's
   * run promise is still unwinding (e.g. aborting its in-flight LLM call), so
   * filtering by completedAt would skip exactly the just-killed children we
   * most need to await (#181). The promises never reject (errors are caught
   * internally), so allSettled is belt-and-suspenders.
   */
  async drainAll(): Promise<void> {
    const all = [...this.children.values()];
    if (all.length === 0) return;
    log.info({ count: all.length }, 'Draining all sub-agent promises');
    await Promise.allSettled(all.map(e => e.promise));
  }

  /** Get all entries (for result injection). */
  getAll(): Map<string, SubAgentEntry> {
    return this.children;
  }

  /** Get a specific entry. */
  get(childId: string): SubAgentEntry | undefined {
    return this.children.get(childId);
  }

  /** Number of children. */
  get size(): number {
    return this.children.size;
  }

  /**
   * Build lightweight result summaries for injection into parent's context.
   * Called after waitForAll().
   */
  buildResultSummaries(): Array<{ childId: string; toolCallId: string; result: Record<string, unknown> }> {
    const summaries: Array<{ childId: string; toolCallId: string; result: Record<string, unknown> }> = [];
    // Note: toolCallId mapping is handled by the caller (agent loop)
    // This just builds the result objects
    for (const [childId, entry] of this.children) {
      if (entry.resultInjected) continue;
      if (entry.status === 'completed' && entry.result) {
        entry.resultInjected = true;
        const fullText = entry.result.text || '';
        summaries.push({
          childId,
          toolCallId: '', // filled by caller
          result: {
            status: 'completed',
            childId,
            summary: fullText.slice(0, 500) + (fullText.length > 500 ? '...' : ''),
            sessionId: childId,
            usage: entry.result.usage,
            fullResponseChars: fullText.length,
          },
        });
      } else if (entry.status === 'error') {
        entry.resultInjected = true;
        summaries.push({
          childId,
          toolCallId: '',
          result: {
            status: 'error',
            childId,
            error: entry.error || 'Unknown error',
            sessionId: childId,
          },
        });
      } else if (entry.status === 'killed') {
        entry.resultInjected = true;
        summaries.push({
          childId,
          toolCallId: '',
          result: {
            status: 'killed',
            childId,
            message: 'Sub-agent was cancelled.',
            sessionId: childId,
          },
        });
      }
    }
    return summaries;
  }
}
