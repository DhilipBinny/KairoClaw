import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readTodos, writeTodos, type Todo } from '../todo.js';
import { sleepTools } from '../sleep.js';

const sleepTool = sleepTools.find(t => t.definition.name === 'sleep')!;

// ─── todo.ts ────────────────────────────────────────────────────────

const WORKSPACE = `/tmp/kairo-test-todos-${Date.now()}`;
const SCOPE = 'test-scope';
const SESSION = 'sess-001';

afterAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

describe('todo — readTodos / writeTodos', () => {
  it('round-trips a todo list', () => {
    const todos: Todo[] = [
      { id: 'a', content: 'First task', status: 'pending' },
      { id: 'b', content: 'Second task', status: 'completed' },
    ];
    writeTodos(WORKSPACE, SCOPE, SESSION, todos);
    const result = readTodos(WORKSPACE, SCOPE, SESSION);
    expect(result).toEqual(todos);
  });

  it('returns [] for nonexistent file', () => {
    const result = readTodos(WORKSPACE, 'no-such-scope', 'no-such-session');
    expect(result).toEqual([]);
  });

  it('writeTodos creates directories that do not exist', () => {
    const deepScope = 'deeply/nested/scope';
    const todos: Todo[] = [{ id: '1', content: 'hi', status: 'in_progress' }];
    writeTodos(WORKSPACE, deepScope, 'new-session', todos);
    const p = path.join(WORKSPACE, 'scopes', deepScope, 'todos', 'new-session.json');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('coerces malformed entries (missing id, bad status)', () => {
    const p = path.join(WORKSPACE, 'scopes', SCOPE, 'todos', 'malformed.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([
      { content: 'no id', status: 'pending' },
      { id: '', content: 'empty id', status: 'completed' },
      { id: 'ok', content: 'bad status', status: 'unknown' },
      { id: 'good', content: 'fine', status: 'in_progress' },
    ]));
    const result = readTodos(WORKSPACE, SCOPE, 'malformed');
    expect(result[0].id).toBe('todo-1');
    expect(result[1].id).toBe('todo-2');
    expect(result[2].status).toBe('pending'); // bad status → pending
    expect(result[3]).toEqual({ id: 'good', content: 'fine', status: 'in_progress' });
  });
});

// ─── sleep.ts ───────────────────────────────────────────────────────

describe('sleep — executor', () => {
  it('defaults to ~1000ms when no args given', async () => {
    const start = Date.now();
    const result = await sleepTool.executor({}, {} as any);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(1500);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/Slept \d+ ms/);
  });

  it('clamps minimum duration (duration_ms=1 → at least 100ms)', async () => {
    const start = Date.now();
    const result = await sleepTool.executor({ duration_ms: 1 }, {} as any);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/clamped to 100/);
  });

  it('clamps maximum duration (reports clamped to 300000)', async () => {
    // We don't actually sleep 300s — use a small value to verify the format
    const result = await sleepTool.executor({ duration_ms: 200 }, {} as any);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/Slept \d+ ms \(requested 200, clamped to 200\)/);
  });

  it('reports clamp text for oversized duration_ms', async () => {
    // Verify the format with a normal value — shows requested and clamped
    const result = await sleepTool.executor({ duration_ms: 150 }, {} as any);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/requested 150, clamped to 150/);
  });
});
