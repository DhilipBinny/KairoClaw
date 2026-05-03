/**
 * Background-task registry (Phase 10).
 *
 * Unlike `SubAgentRegistry` — which is per-parent-turn and blocks the
 * parent's ReAct loop until children finish — this registry lives for
 * the lifetime of the process and lets the agent fire off work that
 * outlives its own turn.
 *
 * Use cases:
 *   - "Kick off a 10-minute research task and check back on it later"
 *   - Parallel builds / long web searches the parent doesn't want to
 *     block on
 *   - Anything the user says "run this in the background and tell me
 *     when you're done"
 *
 * Per-scope isolation is enforced: `list` / `get` / `stop` only ever
 * see tasks whose `scopeKey` matches the caller's. Admins see every
 * scope.
 *
 * Persistence: hybrid. Tasks are tracked in-memory with optional SQLite
 * durability via `attachDb()`. On restart, running tasks are marked
 * `orphaned` (their promises are gone) and historical rows are hydrated
 * back into memory so `list()` / `get()` still work.
 */

import crypto from 'node:crypto';
import type { AgentResult } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('tool');

export type BackgroundTaskStatus = 'running' | 'completed' | 'error' | 'killed' | 'orphaned';

export interface BackgroundTask {
  id: string;
  scopeKey: string | null;
  /**
   * User who spawned this task. Used to address push notifications when
   * the task completes. Distinct from scopeKey because group-chat scopes
   * don't map to a single user, but background tasks are always owned
   * by an individual.
   */
  userId: string | null;
  task: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  completedAt?: number;
  resultText?: string;
  /**
   * Live, accumulating text from the running child agent — assistant
   * text deltas + tool activity markers piped here in real time. Lets
   * `task_output` show progress while the task is still running instead
   * of "[no output yet]". Reset to undefined once the task completes
   * (resultText is the canonical final answer).
   */
  partialOutput?: string;
  error?: string;
  abort: AbortController;
  /** Full background promise — retained so we never leak a floating one. */
  promise: Promise<AgentResult>;
}

/** Optional sink for completion / error notifications (FCM, etc.). */
export interface CompletionNotifier {
  notifyTaskComplete(userId: string, task: BackgroundTask): Promise<void> | void;
}

interface BackgroundTaskRow {
  id: string;
  session_id: string | null;
  scope_key: string | null;
  task: string;
  status: string;
  started_at: number;
  completed_at: number | null;
  result_text: string | null;
  error: string | null;
  tenant_id: string | null;
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();
  /**
   * Durable backing store (TB-5). Set via `attachDb(db)` at bootstrap.
   * When null (pre-Phase-10-TB-5 behaviour) the registry is purely
   * in-memory — used by tests that don't want to touch the DB.
   */
  private db: DatabaseAdapter | null = null;
  /**
   * Optional listener fired on every terminal status transition. Wired
   * by index.ts to the FCM notifier so a completed background task
   * pushes a notification to the user's phone.
   */
  private notifier: CompletionNotifier | null = null;

  attachNotifier(n: CompletionNotifier): void {
    this.notifier = n;
  }

  /**
   * Attach a DatabaseAdapter for durable persistence. Call once at
   * bootstrap. After this, every state transition (register /
   * complete / error / killed) is mirrored to the `background_tasks`
   * table. Also re-hydrates any running rows from disk, marking
   * them `orphaned` since the original promise is gone.
   */
  async attachDb(db: DatabaseAdapter): Promise<void> {
    this.db = db;
    try {
      // Mark any row that was 'running' at the last restart as
      // orphaned. We can't resume the promise — it died with the
      // previous process — but we preserve the row so the admin UI
      // shows the history.
      const orphanedNow = Date.now();
      const orphaned = await db.query<BackgroundTaskRow>(
        "SELECT * FROM background_tasks WHERE status = 'running'",
      );
      for (const row of orphaned) {
        await db.run(
          'UPDATE background_tasks SET status = ?, completed_at = ? WHERE id = ?',
          ['orphaned', orphanedNow, row.id],
        );
      }
      if (orphaned.length > 0) {
        log.info({ count: orphaned.length }, 'Marked orphaned background tasks from previous process');
      }

      // Load every still-visible row back into memory. We rebuild
      // the in-memory entry so list()/get()/stop() work on the
      // re-hydrated rows too. No promise + no abort controller for
      // non-running rows — they're historical.
      const rows = await db.query<BackgroundTaskRow>(
        "SELECT * FROM background_tasks WHERE status != 'running' ORDER BY started_at DESC LIMIT 500",
      );
      for (const row of rows) {
        this.tasks.set(row.id, {
          id: row.id,
          scopeKey: row.scope_key,
          userId: null, // historical rows pre-date user tracking
          task: row.task,
          status: row.status as BackgroundTaskStatus,
          startedAt: row.started_at,
          completedAt: row.completed_at ?? undefined,
          resultText: row.result_text ?? undefined,
          error: row.error ?? undefined,
          abort: new AbortController(), // no-op for historical rows
          promise: Promise.resolve({ text: row.result_text ?? null } as AgentResult),
        });
      }
      if (rows.length > 0) {
        log.info({ count: rows.length }, 'Hydrated background task history from DB');
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, 'Failed to attach background_tasks DB');
    }
  }

  private persistInsert(entry: BackgroundTask): void {
    if (!this.db) return;
    void this.db
      .run(
        `INSERT INTO background_tasks (id, scope_key, task, status, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [entry.id, entry.scopeKey, entry.task, entry.status, entry.startedAt],
      )
      .catch((e) => log.warn({ err: (e as Error).message, id: entry.id }, 'background_tasks insert failed'));
  }

  private persistUpdate(entry: BackgroundTask): void {
    if (!this.db) return;
    void this.db
      .run(
        `UPDATE background_tasks
           SET status = ?, completed_at = ?, result_text = ?, error = ?
         WHERE id = ?`,
        [entry.status, entry.completedAt ?? null, entry.resultText ?? null, entry.error ?? null, entry.id],
      )
      .catch((e) => log.warn({ err: (e as Error).message, id: entry.id }, 'background_tasks update failed'));
  }

  /**
   * Register and start a new background task. `runFn` receives the
   * abort signal and should return an `AgentResult`. The promise is
   * stored and tracked — callers never need to await it.
   */
  runningCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') n++;
    }
    return n;
  }

  register(
    scopeKey: string | null,
    task: string,
    runFn: (signal: AbortSignal, taskId: string) => Promise<AgentResult>,
    opts?: { userId?: string | null },
  ): BackgroundTask {
    const id = `bg-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const abort = new AbortController();
    const userId = opts?.userId ?? null;

    const promise = runFn(abort.signal, id)
      .then((result) => {
        const t = this.tasks.get(id);
        if (t && t.status === 'running') {
          t.status = 'completed';
          t.resultText = result.text ?? '';
          t.completedAt = Date.now();
          this.persistUpdate(t);
          log.info(
            { id, scopeKey, durationMs: t.completedAt - t.startedAt, resultLen: (t.resultText ?? '').length },
            'Background task completed',
          );
          this.fireCompletion(t);
        }
        return result;
      })
      .catch((err) => {
        const t = this.tasks.get(id);
        if (t && t.status === 'running') {
          t.status = 'error';
          t.error = err instanceof Error ? err.message : String(err);
          t.completedAt = Date.now();
          this.persistUpdate(t);
          log.error(
            { id, scopeKey, err: t.error, durationMs: t.completedAt - t.startedAt },
            'Background task failed',
          );
          this.fireCompletion(t);
        }
        return { text: null } as AgentResult;
      });

    const entry: BackgroundTask = {
      id,
      scopeKey,
      userId,
      task,
      status: 'running',
      startedAt: Date.now(),
      abort,
      promise,
    };
    this.tasks.set(id, entry);
    this.persistInsert(entry);
    log.info({ id, scopeKey, userId, taskLen: task.length }, 'Background task registered');
    return entry;
  }

  /**
   * Fire-and-forget the notifier hook. Errors swallowed so a flaky
   * push doesn't take down the agent loop.
   */
  private fireCompletion(t: BackgroundTask): void {
    if (!this.notifier || !t.userId) return;
    Promise.resolve(this.notifier.notifyTaskComplete(t.userId, t)).catch((e) => {
      log.warn({ err: (e as Error).message, id: t.id }, 'Completion notifier threw');
    });
  }

  /**
   * List tasks visible to the caller. Non-admins only see tasks from
   * their own scope; admins see all.
   */
  list(scopeKey: string | null, isAdmin: boolean): BackgroundTask[] {
    const out: BackgroundTask[] = [];
    for (const t of this.tasks.values()) {
      if (isAdmin || t.scopeKey === scopeKey) out.push(t);
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Result of a lookup that distinguishes "id doesn't exist at all"
   * from "id exists but belongs to a scope the caller can't see".
   * TC-1 / TC-11 — the earlier combined `undefined` return wasted a
   * troubleshooting step when a user typed a truncated bg-id.
   */
  private lookup(
    id: string,
    scopeKey: string | null,
    isAdmin: boolean,
  ): { task: BackgroundTask } | { error: 'not-found' | 'wrong-scope' | 'ambiguous-prefix'; candidates?: string[] } {
    // Exact-id match wins first.
    const exact = this.tasks.get(id);
    if (exact) {
      if (!isAdmin && exact.scopeKey !== scopeKey) return { error: 'wrong-scope' };
      return { task: exact };
    }

    // TC-11 prefix match: accept a unique prefix of a registered id.
    // Only triggers when the caller's id looks like a partial bg-id
    // (at least 6 chars, starting with 'bg-') and uniquely identifies
    // one visible task. Matches are scope-filtered before uniqueness
    // so non-admins can't use this to probe other scopes.
    if (id.startsWith('bg-') && id.length >= 6) {
      const visible: BackgroundTask[] = [];
      for (const t of this.tasks.values()) {
        if (!isAdmin && t.scopeKey !== scopeKey) continue;
        if (t.id.startsWith(id)) visible.push(t);
      }
      if (visible.length === 1) return { task: visible[0] };
      if (visible.length > 1) {
        return { error: 'ambiguous-prefix', candidates: visible.map((t) => t.id) };
      }
    }
    return { error: 'not-found' };
  }

  /**
   * Fetch a single task if it exists AND the caller is allowed to see
   * it. Returns undefined when the id is unknown or belongs to another
   * scope (for non-admins). Kept for backwards compatibility with
   * call sites that only care about presence/absence.
   */
  get(id: string, scopeKey: string | null, isAdmin: boolean): BackgroundTask | undefined {
    const r = this.lookup(id, scopeKey, isAdmin);
    return 'task' in r ? r.task : undefined;
  }

  /**
   * Structured lookup surfacing the specific failure reason. Use
   * this in tool executors so you can tell the LLM whether it
   * mistyped an id, typed an ambiguous prefix, or referenced a task
   * in a scope it can't see.
   */
  resolve(id: string, scopeKey: string | null, isAdmin: boolean):
    | { kind: 'found'; task: BackgroundTask }
    | { kind: 'not-found' }
    | { kind: 'wrong-scope' }
    | { kind: 'ambiguous-prefix'; candidates: string[] }
  {
    const r = this.lookup(id, scopeKey, isAdmin);
    if ('task' in r) return { kind: 'found', task: r.task };
    if (r.error === 'ambiguous-prefix') {
      return { kind: 'ambiguous-prefix', candidates: r.candidates ?? [] };
    }
    return { kind: r.error };
  }

  /**
   * Abort a running task. Returns the reason string, now distinguishing
   * not-found from wrong-scope and honoring prefix matches via `lookup`.
   */
  stop(id: string, scopeKey: string | null, isAdmin: boolean):
    | 'killed'
    | 'not-found'
    | 'wrong-scope'
    | 'ambiguous-prefix'
    | `already-${Exclude<BackgroundTaskStatus, 'running'>}` {
    const r = this.resolve(id, scopeKey, isAdmin);
    if (r.kind === 'not-found') return 'not-found';
    if (r.kind === 'wrong-scope') return 'wrong-scope';
    if (r.kind === 'ambiguous-prefix') return 'ambiguous-prefix';
    const t = r.task;
    if (t.status !== 'running') return `already-${t.status}` as const;
    t.abort.abort();
    t.status = 'killed';
    t.completedAt = Date.now();
    this.persistUpdate(t);
    log.info({ id: t.id, scopeKey, durationMs: t.completedAt - t.startedAt }, 'Background task killed');
    return 'killed';
  }

  /**
   * Remove all non-running tasks from memory and DB.
   * Returns the number of tasks cleared.
   */
  async clearCompleted(): Promise<number> {
    const toRemove: string[] = [];
    for (const [id, t] of this.tasks) {
      if (t.status !== 'running') toRemove.push(id);
    }
    for (const id of toRemove) this.tasks.delete(id);
    if (this.db && toRemove.length > 0) {
      try {
        await this.db.run(
          "DELETE FROM background_tasks WHERE status != 'running'",
        );
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'Failed to clear completed tasks from DB');
      }
    }
    if (toRemove.length > 0) {
      log.info({ count: toRemove.length }, 'Cleared completed background tasks');
    }
    return toRemove.length;
  }

  /**
   * Auto-purge completed tasks older than `maxAgeDays` from memory and DB.
   * Called once at startup after `attachDb()`.
   */
  async purgeOlderThan(maxAgeDays: number): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const toRemove: string[] = [];
    for (const [id, t] of this.tasks) {
      if (t.status !== 'running' && (t.completedAt ?? t.startedAt) < cutoff) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) this.tasks.delete(id);
    if (this.db && toRemove.length > 0) {
      try {
        await this.db.run(
          "DELETE FROM background_tasks WHERE status != 'running' AND COALESCE(completed_at, started_at) < ?",
          [cutoff],
        );
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'Failed to purge old tasks from DB');
      }
    }
    if (toRemove.length > 0) {
      log.info({ count: toRemove.length, maxAgeDays }, 'Auto-purged old background tasks');
    }
    return toRemove.length;
  }

  /**
   * Append live progress text to a running task. Caps at 100 KB so
   * runaway children can't blow up memory. Once the task completes,
   * `resultText` becomes the canonical answer and partialOutput is
   * preserved (callers can still inspect it).
   */
  appendOutput(id: string, chunk: string): void {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return;
    const next = (t.partialOutput ?? '') + chunk;
    t.partialOutput = next.length > 100_000
      ? '…[earlier output truncated]…\n' + next.slice(-90_000)
      : next;
  }

  /**
   * Wait for a task to leave `running` status, polling every 100ms.
   * Returns the (possibly updated) task entry. If the task does not
   * settle within `timeoutMs`, returns the entry as-is — caller should
   * inspect `status` to distinguish "still running" from "completed".
   * Aborts immediately if the supplied signal fires.
   */
  async waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<BackgroundTask | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.status !== 'running') return t;
    const deadline = Date.now() + timeoutMs;
    while (t.status === 'running' && Date.now() < deadline) {
      if (signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return t;
  }

  /** Total number of tracked tasks (for diagnostics only). */
  size(): number {
    return this.tasks.size;
  }
}

/**
 * Module-level singleton. `index.ts` imports this and injects it into
 * every `AgentContext` via `createRunner`, so tools reach it through
 * `context.backgroundTasks`.
 */
export const backgroundTaskRegistry = new BackgroundTaskRegistry();
