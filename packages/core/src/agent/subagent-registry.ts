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
export class SubAgentRegistry {
  private children = new Map<string, SubAgentEntry>();

  /** Register a new child. Called by spawn_agent tool. */
  register(
    childId: string,
    task: string,
    runFn: (signal: AbortSignal) => Promise<AgentResult>,
  ): SubAgentEntry {
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

  /** Check if there are any running children. */
  hasPending(): boolean {
    for (const entry of this.children.values()) {
      if (entry.status === 'running') return true;
    }
    return false;
  }

  /** Wait for all running children to complete. Returns their results. */
  async waitForAll(): Promise<Map<string, SubAgentEntry>> {
    const pending = [...this.children.values()].filter(e => e.status === 'running');
    if (pending.length === 0) return this.children;

    log.info({ count: pending.length }, 'Waiting for sub-agents to complete');
    // Wait for all promises — they never reject (errors are caught internally)
    await Promise.all(pending.map(e => e.promise));
    return this.children;
  }

  /** Wait for ALL promises (including killed) to prevent floating promises. */
  async drainAll(): Promise<void> {
    const unresolved = [...this.children.values()].filter(e => !e.completedAt);
    if (unresolved.length === 0) return;
    log.info({ count: unresolved.length }, 'Draining all sub-agent promises');
    await Promise.all(unresolved.map(e => e.promise));
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
