import { describe, it, expect, beforeEach } from 'vitest';
import { BackgroundTaskRegistry } from '../background-task-registry.js';

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

describe('BackgroundTaskRegistry', () => {
  let registry: BackgroundTaskRegistry;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
  });

  it('register() creates a running task and list() returns it', () => {
    const entry = registry.register('scope-1', 'do stuff', async () => ({ text: 'done' } as any));
    expect(entry.id).toMatch(/^bg-/);
    expect(entry.status).toBe('running');
    expect(entry.task).toBe('do stuff');
    const listed = registry.list('scope-1', false);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(entry.id);
  });

  it('complete() sets status + resultText when promise resolves', async () => {
    const entry = registry.register('s', 'task', async () => ({ text: 'result-42' } as any));
    await entry.promise;
    const t = registry.get(entry.id, 's', false)!;
    expect(t.status).toBe('completed');
    expect(t.resultText).toBe('result-42');
    expect(t.completedAt).toBeGreaterThan(0);
  });

  it('error sets status + error when promise rejects', async () => {
    const entry = registry.register('s', 'fail', async () => { throw new Error('boom'); });
    await entry.promise;
    const t = registry.get(entry.id, 's', false)!;
    expect(t.status).toBe('error');
    expect(t.error).toBe('boom');
  });

  it('kill() aborts the AbortController signal', () => {
    let signalRef: AbortSignal | undefined;
    registry.register('s', 'long', async (signal) => {
      signalRef = signal;
      await delay(10000);
      return { text: null } as any;
    });
    const listed = registry.list('s', false);
    const result = registry.stop(listed[0].id, 's', false);
    expect(result).toBe('killed');
    expect(signalRef!.aborted).toBe(true);
    expect(listed[0].status).toBe('killed');
  });

  it('scope isolation: non-admin list() only sees own scope', () => {
    registry.register('scope-a', 'a1', async () => ({ text: '' } as any));
    registry.register('scope-b', 'b1', async () => ({ text: '' } as any));
    expect(registry.list('scope-a', false)).toHaveLength(1);
    expect(registry.list('scope-b', false)).toHaveLength(1);
    expect(registry.list(null, true)).toHaveLength(2);
  });

  it('scope isolation: non-admin get() returns undefined for wrong scope', () => {
    const entry = registry.register('scope-a', 'task', async () => ({ text: '' } as any));
    expect(registry.get(entry.id, 'scope-a', false)).toBeDefined();
    expect(registry.get(entry.id, 'scope-b', false)).toBeUndefined();
    expect(registry.get(entry.id, 'scope-b', true)).toBeDefined();
  });

  it('clearCompleted() removes non-running tasks', async () => {
    const e1 = registry.register('s', 'done', async () => ({ text: '' } as any));
    registry.register('s', 'still-going', async () => { await delay(60000); return { text: '' } as any; });
    await e1.promise;
    const cleared = await registry.clearCompleted();
    expect(cleared).toBe(1);
    expect(registry.list('s', true)).toHaveLength(1);
    expect(registry.list('s', true)[0].status).toBe('running');
  });

  it('runningCount() tracks active tasks', async () => {
    expect(registry.runningCount()).toBe(0);
    const e1 = registry.register('s', 't1', async () => ({ text: '' } as any));
    registry.register('s', 't2', async () => { await delay(60000); return { text: '' } as any; });
    expect(registry.runningCount()).toBe(2);
    await e1.promise;
    expect(registry.runningCount()).toBe(1);
  });

  it('appendOutput() streams partial output to running tasks', () => {
    registry.register('s', 'stream', async () => { await delay(60000); return { text: '' } as any; });
    const t = registry.list('s', false)[0];
    registry.appendOutput(t.id, 'chunk1');
    registry.appendOutput(t.id, 'chunk2');
    expect(t.partialOutput).toBe('chunk1chunk2');
  });

  it('stop() returns not-found for unknown id', () => {
    expect(registry.stop('bg-nonexistent', 's', false)).toBe('not-found');
  });
});
