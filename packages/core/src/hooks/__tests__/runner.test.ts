/**
 * Tests for the hook runner — matchers, PreToolUse mutate/abort
 * semantics, PostToolUse fire-and-forget, timeout enforcement, and
 * the stdin-only payload contract (no AGW_HOOK_INPUT env var).
 *
 * Each test spawns a real `/bin/sh -c` process with a small
 * inline command. `jq` is widely available on developer boxes; if
 * a test depends on it, we assert via plain shell so the suite
 * stays portable on minimal CI containers.
 */
import { describe, it, expect } from 'vitest';
import {
  matchesHookPattern,
  runPreToolUseHooks,
  runPostToolUseHooks,
  runSessionStartHooks,
  type HookConfig,
} from '@agw/tool-platform';

describe('matchesHookPattern', () => {
  it('matches "*" against any tool name', () => {
    expect(matchesHookPattern('write_file', '*')).toBe(true);
    expect(matchesHookPattern('mcp__github__list_issues', '*')).toBe(true);
  });

  it('exact match', () => {
    expect(matchesHookPattern('write_file', 'write_file')).toBe(true);
    expect(matchesHookPattern('write_file', 'read_file')).toBe(false);
  });

  it('prefix match with trailing *', () => {
    expect(matchesHookPattern('mcp__github__issues', 'mcp__*')).toBe(true);
    expect(matchesHookPattern('write_file', 'mcp__*')).toBe(false);
  });

  it('suffix match with leading *', () => {
    expect(matchesHookPattern('send_email', '*_email')).toBe(true);
    expect(matchesHookPattern('write_file', '*_email')).toBe(false);
  });

  it('substring match with surrounding *', () => {
    expect(matchesHookPattern('mcp__github__list', '*github*')).toBe(true);
    expect(matchesHookPattern('write_file', '*github*')).toBe(false);
  });
});

describe('PreToolUse — mutation via stdin', () => {
  it('reads payload from stdin (NOT from AGW_HOOK_INPUT env var)', async () => {
    // The hook prints whatever it gets on stdin back to stdout.
    // If we fed via env var, stdin would be empty and the result
    // would be `{}` rather than the real payload.
    const hook: HookConfig = { matcher: '*', command: 'cat' };
    const result = await runPreToolUseHooks(
      [hook],
      'write_file',
      { path: '/x', content: 'hi' },
      'sess-1',
      null,
    );
    expect(result.abort).toBeUndefined();
    expect(result.mutatedInput).toBeDefined();
    expect(result.mutatedInput!.tool).toBe('write_file');
    const inputField = result.mutatedInput!.input as { path: string; content: string };
    expect(inputField.path).toBe('/x');
    expect(inputField.content).toBe('hi');
  });

  it('does not set AGW_HOOK_INPUT in the child env', async () => {
    // If the var leaks through, the hook will print non-empty;
    // we expect empty stdout → no mutation.
    const hook: HookConfig = {
      matcher: '*',
      command: 'printf "%s" "$AGW_HOOK_INPUT"',
    };
    const result = await runPreToolUseHooks(
      [hook],
      'exec',
      { command: 'ls' },
      's',
      null,
    );
    // No JSON parse → no mutation reported; stdin-only contract
    expect(result.mutatedInput).toBeUndefined();
    expect(result.abort).toBeUndefined();
  });

  it('replaces tool input when the hook prints valid JSON object on stdout', async () => {
    const hook: HookConfig = {
      matcher: '*',
      command: 'echo \'{"path":"/replaced","content":"new"}\'',
    };
    const result = await runPreToolUseHooks(
      [hook],
      'write_file',
      { path: '/orig', content: 'old' },
      's',
      null,
    );
    expect(result.mutatedInput).toEqual({ path: '/replaced', content: 'new' });
  });

  it('keeps original input when stdout is non-JSON', async () => {
    const hook: HookConfig = { matcher: '*', command: 'echo informational' };
    const result = await runPreToolUseHooks(
      [hook],
      'write_file',
      { path: '/orig' },
      's',
      null,
    );
    expect(result.mutatedInput).toBeUndefined();
  });

  it('aborts the tool call when the hook exits non-zero', async () => {
    const hook: HookConfig = {
      matcher: '*',
      command: 'echo deny >&2; exit 13',
    };
    const result = await runPreToolUseHooks(
      [hook],
      'write_file',
      { path: '/x' },
      's',
      null,
    );
    expect(result.mutatedInput).toBeUndefined();
    expect(result.abort).toBeDefined();
    expect(result.abort!.error).toContain('write_file');
  });

  it('skips hooks whose matcher does not apply', async () => {
    // This hook would abort if it ran. It should not run because
    // the matcher targets a different tool.
    const hook: HookConfig = { matcher: 'write_file', command: 'exit 1' };
    const result = await runPreToolUseHooks(
      [hook],
      'read_file',
      { path: '/x' },
      's',
      null,
    );
    expect(result.abort).toBeUndefined();
  });

  it('runs hooks sequentially and threads mutations through', async () => {
    // The runner's contract: hook stdout JSON replaces `currentInput`
    // (the args record), and the next hook sees the mutated args
    // wrapped in a fresh envelope. So each hook only emits the NEW
    // args dict on stdout, not the whole {tool, input, …} envelope.
    //
    // hook1 takes the input record (envelope.input) and adds stage1.
    // hook2 takes the input record (now containing stage1) and adds
    // stage2. The final mutatedInput must contain both stage1+stage2.
    const hook1: HookConfig = {
      matcher: '*',
      command: 'jq \'.input | .stage1 = true\'',
    };
    const hook2: HookConfig = {
      matcher: '*',
      command: 'jq \'.input | .stage2 = true\'',
    };
    // Skip when jq is missing (rare in dev, common on minimal CI)
    const probe = await runPreToolUseHooks(
      [{ matcher: '*', command: 'jq --version >/dev/null 2>&1' }],
      'x',
      {},
      's',
      null,
    );
    if (probe.abort) return;

    const result = await runPreToolUseHooks(
      [hook1, hook2],
      'tool',
      { initial: 1 },
      'sess',
      null,
    );
    expect(result.mutatedInput).toBeDefined();
    expect(result.mutatedInput!.stage1).toBe(true);
    expect(result.mutatedInput!.stage2).toBe(true);
    expect(result.mutatedInput!.initial).toBe(1);
  });
});

describe('PreToolUse — timeout enforcement', () => {
  it('kills hooks that exceed the configured timeout', async () => {
    const hook: HookConfig = {
      matcher: '*',
      command: 'sleep 10',
      timeoutMs: 200,
    };
    const start = Date.now();
    const result = await runPreToolUseHooks(
      [hook],
      'write_file',
      { path: '/x' },
      's',
      null,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result.abort).toBeDefined();
    expect(result.abort!.error).toMatch(/timed out/i);
  });
});

describe('PostToolUse — fire-and-forget', () => {
  it('does not throw when a hook exits non-zero', async () => {
    const hook: HookConfig = { matcher: '*', command: 'exit 5' };
    await expect(
      runPostToolUseHooks(
        [hook],
        'write_file',
        { path: '/x' },
        { ok: true },
        's',
        null,
      ),
    ).resolves.toBeUndefined();
  });

  it('completes successfully when a hook exits zero', async () => {
    const hook: HookConfig = { matcher: '*', command: 'true' };
    await expect(
      runPostToolUseHooks([hook], 'tool', {}, {}, 's', null),
    ).resolves.toBeUndefined();
  });

  it('skips hooks whose matcher does not apply', async () => {
    // If this hook ran it would fail (and be swallowed), but we
    // verify the path completes promptly and matcher is honoured.
    const hook: HookConfig = { matcher: 'something_else', command: 'exit 1' };
    const start = Date.now();
    await runPostToolUseHooks([hook], 'tool', {}, {}, 's', null);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('SessionStart — collects stdout, fails soft', () => {
  it('returns trimmed stdout from each hook', async () => {
    const outputs = await runSessionStartHooks(
      [
        { command: 'echo branch=main' },
        { command: 'echo time=12:34' },
      ],
      'sess-1',
      null,
    );
    expect(outputs).toEqual(['branch=main', 'time=12:34']);
  });

  it('skips a failing hook without crashing', async () => {
    const outputs = await runSessionStartHooks(
      [
        { command: 'exit 1' },
        { command: 'echo recovered' },
      ],
      's',
      null,
    );
    expect(outputs).toEqual(['recovered']);
  });
});
