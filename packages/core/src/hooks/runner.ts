/**
 * Hook runner — PreToolUse / PostToolUse shell hooks.
 *
 * Phase 12. Lets the user hang arbitrary shell commands off every
 * tool call via config. Examples:
 *
 *   hooks:
 *     PreToolUse:
 *       - matcher: "write_file"
 *         command: "echo checking write..."
 *     PostToolUse:
 *       - matcher: "write_file"
 *         command: "prettier --write $(echo $AGW_HOOK_INPUT | jq -r '.input.path')"
 *       - matcher: "exec"
 *         command: "logger 'agent exec: '$(echo $AGW_HOOK_INPUT | jq -r '.input.command')"
 *
 * The matched shell command is spawned via `/bin/sh -c` with an
 * `AGW_HOOK_INPUT` environment variable containing a JSON payload:
 *
 *   {
 *     tool: <toolName>,
 *     input: <args the LLM passed — mutable by PreToolUse>,
 *     output: <tool result — only on PostToolUse>,
 *     sessionId: <session id>,
 *     scopeKey: <scope key or null>
 *   }
 *
 * PreToolUse semantics:
 *   - If the hook prints JSON on stdout, it replaces the tool's
 *     input for subsequent hooks and for the actual tool execution.
 *     Useful for normalisation, rewriting paths, injecting defaults.
 *   - If the hook exits non-zero, the tool call is aborted and the
 *     agent receives an error message. Useful for policy gates.
 *   - Hooks run sequentially in config order.
 *
 * PostToolUse semantics:
 *   - Stdout is ignored (the result has already been decided).
 *   - Non-zero exit is logged but doesn't fail the tool call — the
 *     agent already has the result.
 *   - Fired fire-and-forget from the registry so the agent's round
 *     isn't blocked on slow side-effects like auto-format or
 *     notifications.
 *
 * Matcher syntax (simple glob, not full globby):
 *   - "*"              → match all tools
 *   - "write_file"     → exact match
 *   - "send_*"         → prefix match
 *   - "*_email"        → suffix match
 *   - "mcp__github__*" → prefix match (for MCP-namespaced tools)
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createModuleLogger } from '../observability/logger.js';

const execFile = promisify(execFileCb);
const log = createModuleLogger('tool');

const DEFAULT_HOOK_TIMEOUT_MS = 5000;
const MAX_HOOK_STDOUT_BYTES = 64 * 1024;

export interface HookConfig {
  /** Glob pattern matching tool names. */
  matcher: string;
  /** Shell command to run via `/bin/sh -c`. */
  command: string;
  /** Optional per-hook timeout override in ms. */
  timeoutMs?: number;
}

export interface SessionLifecycleHook {
  /** Shell command to run via `/bin/sh -c`. */
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  PreToolUse?: HookConfig[];
  PostToolUse?: HookConfig[];
  SessionStart?: SessionLifecycleHook[];
  PostCompact?: SessionLifecycleHook[];
}

/**
 * Glob-match a tool name against a hook matcher. Supports exact
 * match, `*` as a wildcard (prefix/suffix or whole), and plain
 * strings. Not a full glob implementation — the patterns people
 * actually write for tool hooks are simple.
 */
export function matchesHookPattern(toolName: string, matcher: string): boolean {
  if (matcher === '*') return true;
  if (matcher === toolName) return true;
  if (matcher.endsWith('*') && !matcher.startsWith('*')) {
    return toolName.startsWith(matcher.slice(0, -1));
  }
  if (matcher.startsWith('*') && !matcher.endsWith('*')) {
    return toolName.endsWith(matcher.slice(1));
  }
  if (matcher.startsWith('*') && matcher.endsWith('*')) {
    return toolName.includes(matcher.slice(1, -1));
  }
  return false;
}

export interface PreToolHookResult {
  /** If set, replaces the tool's input for subsequent hooks + execution. */
  mutatedInput?: Record<string, unknown>;
  /** If set, aborts the tool call with this error. */
  abort?: { error: string };
}

/**
 * Run every matching PreToolUse hook in sequence. Returns the final
 * input (possibly mutated by hooks) or an abort signal if any hook
 * exited non-zero.
 */
export async function runPreToolUseHooks(
  hooks: HookConfig[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
  sessionId: string,
  scopeKey: string | null,
): Promise<PreToolHookResult> {
  if (!hooks || hooks.length === 0) return {};

  let currentInput = input;
  let mutated = false;

  for (const hook of hooks) {
    if (!matchesHookPattern(toolName, hook.matcher)) continue;

    const payload = JSON.stringify({
      tool: toolName,
      input: currentInput,
      sessionId,
      scopeKey,
    });

    try {
      const { stdout } = await execFile('/bin/sh', ['-c', hook.command], {
        timeout: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        env: { ...process.env, AGW_HOOK_INPUT: payload },
        maxBuffer: MAX_HOOK_STDOUT_BYTES,
      });

      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        // Hook wants to rewrite the input — parse its stdout as JSON
        // and replace currentInput. If parsing fails, treat stdout as
        // informational and keep the input unchanged.
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            currentInput = parsed as Record<string, unknown>;
            mutated = true;
            log.info({ tool: toolName, matcher: hook.matcher }, 'PreToolUse hook mutated input');
          }
        } catch {
          // Non-JSON stdout is just logging — not a mutation signal
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ tool: toolName, matcher: hook.matcher, err: msg }, 'PreToolUse hook aborted tool call');
      return {
        abort: {
          error: `PreToolUse hook "${hook.matcher}" aborted "${toolName}": ${msg}`,
        },
      };
    }
  }

  return mutated ? { mutatedInput: currentInput } : {};
}

/**
 * Run every SessionStart hook sequentially and collect their stdout.
 * Called once per session from `runAgent` right after the session
 * row is created. Hook stdout is returned as a list of strings so
 * the agent loop can inject it as synthetic context (typically by
 * prepending the concatenated output to the first user message as
 * `[hook output] ...`).
 *
 * A SessionStart hook crashing is not fatal to the session — it's
 * logged and its output slot is filled with an empty string. This
 * matches the PostToolUse non-fatal semantic: hook failures must
 * never break the agent loop.
 */
export async function runSessionStartHooks(
  hooks: SessionLifecycleHook[] | undefined,
  sessionId: string,
  scopeKey: string | null,
): Promise<string[]> {
  if (!hooks || hooks.length === 0) return [];
  const outputs: string[] = [];

  const payload = JSON.stringify({
    event: 'SessionStart',
    sessionId,
    scopeKey,
  });

  for (const hook of hooks) {
    try {
      const { stdout } = await execFile('/bin/sh', ['-c', hook.command], {
        timeout: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        env: { ...process.env, AGW_HOOK_INPUT: payload },
        maxBuffer: MAX_HOOK_STDOUT_BYTES,
      });
      const trimmed = stdout.trim();
      if (trimmed) {
        outputs.push(trimmed);
        log.info({ sessionId, bytes: trimmed.length }, 'SessionStart hook produced output');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ sessionId, err: msg }, 'SessionStart hook failed (non-fatal)');
    }
  }

  return outputs;
}

/**
 * Run every PostCompact hook sequentially. Called from the agent's
 * compaction path after a hard-compact replaces the session's
 * message history. Like SessionStart, hook stdout is collected and
 * returned so the caller can fold it back into the new compacted
 * state (typically appended to the `[Context Summary]` system
 * message as a `[post-compact hook output] ...` suffix).
 *
 * Failures are non-fatal — compaction already happened, and the
 * agent has a valid compacted context regardless.
 */
export async function runPostCompactHooks(
  hooks: SessionLifecycleHook[] | undefined,
  sessionId: string,
  scopeKey: string | null,
): Promise<string[]> {
  if (!hooks || hooks.length === 0) return [];
  const outputs: string[] = [];

  const payload = JSON.stringify({
    event: 'PostCompact',
    sessionId,
    scopeKey,
  });

  for (const hook of hooks) {
    try {
      const { stdout } = await execFile('/bin/sh', ['-c', hook.command], {
        timeout: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        env: { ...process.env, AGW_HOOK_INPUT: payload },
        maxBuffer: MAX_HOOK_STDOUT_BYTES,
      });
      const trimmed = stdout.trim();
      if (trimmed) {
        outputs.push(trimmed);
        log.info({ sessionId, bytes: trimmed.length }, 'PostCompact hook produced output');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ sessionId, err: msg }, 'PostCompact hook failed (non-fatal)');
    }
  }

  return outputs;
}

/**
 * Run every matching PostToolUse hook in sequence. Does not affect
 * the tool's result (the agent has already seen it). Called
 * fire-and-forget from the registry so slow hooks (auto-format,
 * notifications) don't block the agent's round.
 *
 * Hook failures are logged but never thrown.
 */
export async function runPostToolUseHooks(
  hooks: HookConfig[] | undefined,
  toolName: string,
  input: unknown,
  output: unknown,
  sessionId: string,
  scopeKey: string | null,
): Promise<void> {
  if (!hooks || hooks.length === 0) return;

  for (const hook of hooks) {
    if (!matchesHookPattern(toolName, hook.matcher)) continue;

    const payload = JSON.stringify({
      tool: toolName,
      input,
      output,
      sessionId,
      scopeKey,
    });

    try {
      await execFile('/bin/sh', ['-c', hook.command], {
        timeout: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
        env: { ...process.env, AGW_HOOK_INPUT: payload },
        maxBuffer: MAX_HOOK_STDOUT_BYTES,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn({ tool: toolName, matcher: hook.matcher, err: msg }, 'PostToolUse hook failed (non-fatal)');
    }
  }
}
