/**
 * `todo_write` — session-scoped structured task state.
 *
 * The agent calls this with the CURRENT FULL list of todos each time
 * — it's a full replace, not an append. That matches Claude Code's
 * TodoWrite semantics: "here is the complete todo list as of now,
 * replace what you have with this". Simpler than managing diffs and
 * easier for the LLM to reason about.
 *
 * Storage: plain JSON file at
 *   workspace/scopes/<scope>/todos/<sessionId>.json
 * (or workspace/scopes/global/todos/<sessionId>.json when the session
 * has no scope). No DB migration, no schema coupling — state survives
 * restarts, works with the backup-via-cp workflow, and is easy to
 * inspect from the admin UI in the future.
 *
 * Rendered in the event envelope as a human-readable checklist so the
 * agent sees exactly what it just wrote, which reinforces the
 * "current plan" model.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import type { Session } from '@agw/types';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '../envelope.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
}

/**
 * Resolve the on-disk JSON path for a session's todo state.
 *
 * Uses the per-scope tool-results layout under `workspace/scopes/`.
 * Sessions without a scopeKey fall back to the `global` bucket so
 * cron / internal sessions can also track todos.
 */
function todoPath(workspace: string, scopeKey: string | null | undefined, sessionId: string): string {
  const scopeSeg = scopeKey || 'global';
  return path.join(workspace, 'scopes', scopeSeg, 'todos', `${sessionId}.json`);
}

/** Read the current todo list for a session. Returns [] if not set. */
export function readTodos(workspace: string, scopeKey: string | null | undefined, sessionId: string): Todo[] {
  const p = todoPath(workspace, scopeKey, sessionId);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive — coerce any malformed entries into the expected shape
    return parsed.map((t, i): Todo => ({
      id: typeof t?.id === 'string' && t.id.length > 0 ? t.id : `todo-${i + 1}`,
      content: typeof t?.content === 'string' ? t.content : String(t?.content ?? ''),
      status: (['pending', 'in_progress', 'completed'] as const).includes(t?.status) ? t.status : 'pending',
    }));
  } catch {
    return [];
  }
}

/** Write the todo list for a session. Creates the dir if needed. */
export function writeTodos(workspace: string, scopeKey: string | null | undefined, sessionId: string, todos: Todo[]): void {
  const p = todoPath(workspace, scopeKey, sessionId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(todos, null, 2), 'utf8');
}

/** Render the list as a human-readable checklist for the LLM / admin UI. */
function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return '(no todos)';
  const lines: string[] = [];
  for (const t of todos) {
    const box =
      t.status === 'completed' ? '[x]' :
      t.status === 'in_progress' ? '[~]' :
      '[ ]';
    lines.push(`${box} ${t.content}`);
  }
  return lines.join('\n');
}

export const todoTools: ToolRegistration[] = [
  {
    definition: {
      name: 'todo_write',
      searchHint: 'track tasks checklist plan todo',
      alwaysLoad: true,
      description:
        'Update the session-scoped todo list. Pass the COMPLETE current list each call — this is a full replace, not an append. ' +
        'Use for any task with 3+ steps: write out the plan once, then update statuses as you progress. ' +
        'Status must be "pending", "in_progress", or "completed". ' +
        'Reading back the todo list happens automatically by calling this tool with the same list (acts as an idempotent read). ' +
        'State persists across LLM rounds within the same session and survives server restarts.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'Complete list of todos as of now. Each item: { id?: string, content: string, status: "pending" | "in_progress" | "completed" }. content and status are required on every item.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable identifier; if omitted, auto-generated.' },
                content: { type: 'string', description: 'What the step does (required).' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status (required).' },
              },
            },
          },
        },
        required: ['todos'],
      },
    },
    executor: async (args, context) => {
      const raw = args.todos;
      if (!Array.isArray(raw)) {
        return { error: 'todos must be an array of {content, status} objects' };
      }

      // Normalise + validate each entry
      const normalised: Todo[] = [];
      for (let i = 0; i < raw.length; i++) {
        const t = raw[i] as Record<string, unknown>;
        if (!t || typeof t !== 'object') {
          return { error: `todos[${i}]: must be an object with content and status` };
        }
        const content = typeof t.content === 'string' ? t.content : null;
        if (!content || content.trim().length === 0) {
          return { error: `todos[${i}]: content is required and must be a non-empty string` };
        }
        const status = t.status;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          return { error: `todos[${i}]: status must be "pending", "in_progress", or "completed"` };
        }
        const id = typeof t.id === 'string' && t.id.length > 0 ? t.id : `todo-${i + 1}`;
        normalised.push({ id, content: content.trim(), status });
      }

      // Enforce one-in-progress rule — the canonical "what am I working
      // on right now" discipline. Warn without erroring so the agent
      // can self-correct.
      const inProgressCount = normalised.filter((t) => t.status === 'in_progress').length;
      const warning = inProgressCount > 1
        ? `\n\n[warning: ${inProgressCount} todos are in_progress — convention is to keep exactly one "in_progress" at a time so the current step is unambiguous]`
        : '';

      const workspace = getWorkspace(context as Record<string, unknown>);
      const session = context.session as Session | { id?: string } | undefined;
      // The runtime Session object is the DB row (has `id`); the typed
      // interface declares `sessionId`. Handle both.
      const sessionId =
        (session as { id?: string })?.id
        ?? (session as Session | undefined)?.sessionId;
      if (!sessionId) {
        return { error: 'todo_write requires an active session id in context' };
      }

      try {
        writeTodos(workspace, context.scopeKey ?? null, sessionId, normalised);
      } catch (e) {
        return { error: `Failed to write todos: ${e instanceof Error ? e.message : String(e)}` };
      }

      const pending = normalised.filter((t) => t.status === 'pending').length;
      const doing = normalised.filter((t) => t.status === 'in_progress').length;
      const done = normalised.filter((t) => t.status === 'completed').length;
      const header = `Todo list (${normalised.length} item${normalised.length === 1 ? '' : 's'}: ${done} done, ${doing} in progress, ${pending} pending):`;

      return textEnvelope(`${header}\n\n${renderTodos(normalised)}${warning}`);
    },
    source: 'builtin',
    category: 'write',
    // Writes to disk, not concurrency-safe with other writes to the
    // same file. Reads of unrelated state are fine — this tool is so
    // cheap it doesn't matter.
    concurrencySafe: false,
    isDestructive: false,
    getActivityDescription: (input) => {
      const todos = (input as { todos?: unknown[] })?.todos;
      return `todo_write (${Array.isArray(todos) ? todos.length : '?'} items)`;
    },
  },
];
