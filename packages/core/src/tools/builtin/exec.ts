import { EXEC_MAX_STDOUT, EXEC_MAX_STDERR, EXEC_MAX_TIMEOUT_SECONDS, EXEC_DEFAULT_TIMEOUT_SECONDS, SCOPE_DIR_NAME } from '../../constants.js';
import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ToolRegistration } from '../types.js';
import { scopedSafePath } from './files.js';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '../envelope.js';

/**
 * Format an exec result (stdout + stderr + exitCode) as a single
 * readable text block. Sections are omitted when empty so a clean
 * `echo hello` doesn't waste tokens on empty `stderr:` lines.
 *
 * Exported for unit testing.
 */
export function formatExecResult(stdout: string, stderr: string, exitCode: number): string {
  const lines: string[] = [`exit code: ${exitCode}`];
  if (stdout) {
    lines.push('', 'stdout:', stdout);
  }
  if (stderr) {
    lines.push('', 'stderr:', stderr);
  }
  return lines.join('\n');
}

const execFileAsync = promisify(execFileCb);

/** Maximum stdout size returned (10 KB). */
const MAX_STDOUT = EXEC_MAX_STDOUT;

/** Maximum stderr size returned (5 KB). */
const MAX_STDERR = EXEC_MAX_STDERR;

/** Safe environment variables allowed in child processes (allowlist). */
export const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'NODE_ENV', 'TZ', 'TMPDIR', 'COLORTERM',
];

// ── Minimal blocks — apply to ALL users including admin ────
// Only truly catastrophic / irreversible system commands
const MINIMAL_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-.*r.*-.*f|.*-.*f.*-.*r)\s*\//i, reason: 'rm -rf on root path' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(?!\w)/i, reason: 'recursive delete on root' },
  { pattern: /\bmkfs\b/i, reason: 'format filesystem' },
  { pattern: /\bdd\b.*\bof\s*=\s*\/dev\//i, reason: 'write to disk device' },
  { pattern: /\b>\s*\/dev\/[sh]d/i, reason: 'redirect to disk device' },
  // System control
  { pattern: /\bshutdown\b/i, reason: 'system shutdown' },
  { pattern: /\breboot\b/i, reason: 'system reboot' },
  { pattern: /\binit\s+[06]\b/i, reason: 'init runlevel change' },
  { pattern: /\bkill\s+-9\s+1\b/i, reason: 'kill init process' },
  // Remote code execution
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/i, reason: 'curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/i, reason: 'wget pipe to shell' },
  // Environment/loader hijacking
  { pattern: /\bLD_PRELOAD\s*=/i, reason: 'LD_PRELOAD injection' },
  { pattern: /\bDYLD_/i, reason: 'DYLD injection' },
  { pattern: /\bLD_LIBRARY_PATH\s*=/i, reason: 'LD_LIBRARY_PATH hijacking' },
];

// ── Sandboxed blocks — apply to non-admin users only ───────
// Persona files, source code, secrets, cross-scope access
const SANDBOXED_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  // Credential/key theft
  { pattern: /\bcat\b.*\/(\.ssh\/|\.aws\/|\.env\b|secrets\.json|\.docker\/config)/i, reason: 'read credential files' },
  { pattern: /\b(history|\.bash_history|\.zsh_history)\b/i, reason: 'read shell history' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+(docker|sshd|network|firewall)/i, reason: 'disable critical service' },

  // Persona file protection
  { pattern: /\b(sed|awk|perl)\b.*\b(IDENTITY|SOUL|RULES)\.md\b/i, reason: 'modify persona file' },
  { pattern: />\s*\S*(IDENTITY|SOUL|RULES)\.md/i, reason: 'redirect to persona file' },
  { pattern: /\b(echo|printf|cat|tee)\b.*>\s*\S*(IDENTITY|SOUL|RULES)\.md/i, reason: 'overwrite persona file' },
  { pattern: /\b(cp|mv)\b.*\b(IDENTITY|SOUL|RULES)\.md\b/i, reason: 'copy/move persona file' },
  { pattern: /\b(python[23]?|node|ruby|perl)\s+(-[cCe]\s+)?.*\b(IDENTITY|SOUL|RULES)\b/i, reason: 'script modify persona file' },
  { pattern: /\brm\b.*\b(IDENTITY|SOUL|RULES)\.md\b/i, reason: 'delete persona file' },

  // Application source code protection (Docker path)
  { pattern: /\/app\/packages\//i, reason: 'access application source code' },
  { pattern: /\/app\/node_modules\//i, reason: 'access application dependencies' },
  { pattern: /\bfind\s+\/app\b/i, reason: 'scan application directory' },

  // Encrypted secrets / master key
  { pattern: /\b(cat|head|tail|less|more|xxd|base64|strings)\b.*master\.key/i, reason: 'read encryption master key' },
  { pattern: /\b(cat|head|tail|less|more|xxd|base64|strings)\b.*secrets\.enc/i, reason: 'read encrypted secrets' },
];

// ── Layer 2: Confirmation required — risky but sometimes needed ──

const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive file operations on system paths
  { pattern: /\brm\s+-[a-zA-Z]*r/i, reason: 'recursive delete' },
  { pattern: /\brm\s+.*\//i, reason: 'delete with path' },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]+\s+\//i, reason: 'change permissions on system path' },
  { pattern: /\bchown\s+(-R\s+)?/i, reason: 'change ownership' },
  { pattern: /\bmv\s+.*\s+\//i, reason: 'move to system path' },
  // Process management
  { pattern: /\bkill\b/i, reason: 'kill process' },
  { pattern: /\bkillall\b/i, reason: 'kill all processes' },
  { pattern: /\bpkill\b/i, reason: 'pattern kill' },
  // Package management
  { pattern: /\b(apt|apt-get|yum|dnf|pacman|brew)\s+(install|remove|purge|update|upgrade)/i, reason: 'package management' },
  { pattern: /\bpip\s+install/i, reason: 'pip install' },
  { pattern: /\bnpm\s+(install|uninstall)\s+-g/i, reason: 'global npm install' },
  // Docker operations
  { pattern: /\bdocker\s+(rm|rmi|stop|kill|system\s+prune)/i, reason: 'docker destructive operation' },
  // Network
  { pattern: /\biptables\b/i, reason: 'firewall rules' },
  { pattern: /\bufw\b/i, reason: 'firewall management' },
  // Database
  { pattern: /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i, reason: 'destructive database operation' },
  // Git destructive
  { pattern: /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-zA-Z]*f)/i, reason: 'destructive git operation' },
  // Service management
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i, reason: 'service management' },
  // Crontab
  { pattern: /\bcrontab\s+-[re]/i, reason: 'modify crontab' },
];

/**
 * Check command safety. Two modes:
 * - 'unrestricted' (admin): only truly catastrophic commands blocked
 * - 'sandboxed' (non-admin): full blocks + persona/source/secret protection + confirm patterns
 */
function checkCommandSafety(
  command: string,
  mode: 'unrestricted' | 'sandboxed',
): { action: 'block' | 'confirm' | 'allow'; reason?: string } {
  // Minimal blocks always apply (rm -rf /, shutdown, curl|sh, etc.)
  for (const { pattern, reason } of MINIMAL_BLOCKED) {
    if (pattern.test(command)) {
      return { action: 'block', reason };
    }
  }

  // Sandboxed mode: additional blocks + confirmation patterns
  if (mode === 'sandboxed') {
    for (const { pattern, reason } of SANDBOXED_BLOCKED) {
      if (pattern.test(command)) {
        return { action: 'block', reason };
      }
    }
    for (const { pattern, reason } of CONFIRM_PATTERNS) {
      if (pattern.test(command)) {
        return { action: 'confirm', reason };
      }
    }
  }

  return { action: 'allow' };
}

export const execTools: ToolRegistration[] = [
  {
    definition: {
      name: 'exec',
      description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
      searchHint: 'run shell command bash execute',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
          workdir: { type: 'string', description: 'Working directory (default: workspace)' },
        },
        required: ['command'],
      },
    },
    executor: async (args, context) => {
      const command = args.command as string;
      if (!command || typeof command !== 'string') {
        return { error: 'command is required and must be a string' };
      }
      if (command.length > 10000) {
        return { error: 'Command too long (max 10000 chars)' };
      }

      // Safety check — admin gets unrestricted, others get sandboxed
      const execMode = context.user?.role === 'admin' ? 'unrestricted' : 'sandboxed';
      const safety = checkCommandSafety(command, execMode);
      if (safety.action === 'block') {
        return { error: `Blocked: ${safety.reason}. This command is too dangerous to execute. Ask the user to run it manually if needed.` };
      }
      if (safety.action === 'confirm') {
        return {
          _requiresConfirmation: true,
          command,
          reason: safety.reason,
          message: `This command requires confirmation: "${command.slice(0, 200)}"\nReason: ${safety.reason}\n\nTell the user what you want to run and why, and ask them to confirm or run it themselves.`,
        };
      }

      const workspace = getWorkspace(context as Record<string, unknown>);
      const isAdmin = context.user?.role === 'admin';
      const scopeKey = context.scopeKey;

      // For non-admin: dynamic source code protection (works on any install path)
      if (!isAdmin) {
        // Block access to the application's own source directory (parent of workspace)
        const appRoot = path.resolve(workspace, '..');
        const nodeModules = path.join(appRoot, 'node_modules');
        if (command.includes(nodeModules) || command.includes(path.join(appRoot, 'packages'))) {
          return { error: 'Blocked: access to application source code. This is restricted for security.' };
        }
      }

      // For non-admin users, block commands that reference other users' scopes
      if (!isAdmin && scopeKey) {
        const scopesRef = new RegExp(`${SCOPE_DIR_NAME}/(?!${scopeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$))`);
        if (scopesRef.test(command)) {
          return { error: 'Access denied: cannot access other users\' directories via exec' };
        }
      }

      const ctx = context as Record<string, unknown>;
      const configTimeout = (ctx.config as Record<string, unknown>)?.tools
        ? ((ctx.config as Record<string, Record<string, Record<string, unknown>>>).tools?.exec?.timeout as number)
        : undefined;
      const defaultTimeout = typeof configTimeout === 'number' && configTimeout > 0 ? configTimeout : EXEC_DEFAULT_TIMEOUT_SECONDS;
      const timeout = Math.min((args.timeout as number) || defaultTimeout, EXEC_MAX_TIMEOUT_SECONDS) * 1000;

      // Default cwd: user's own scope dir for non-admin, workspace root for admin
      let defaultCwd = workspace;
      if (!isAdmin && scopeKey) {
        defaultCwd = path.join(workspace, SCOPE_DIR_NAME, scopeKey);
      }
      const cwd = args.workdir ? scopedSafePath(args.workdir as string, workspace, context) : defaultCwd;

      // Only pass safe env vars to child process (allowlist, not denylist)
      const safeEnv: Record<string, string> = {};
      for (const key of SAFE_ENV_KEYS) {
        if (process.env[key]) safeEnv[key] = process.env[key]!;
      }

      try {
        // Use execFile with /bin/sh -c to avoid shell metacharacter injection
        // execFile does not spawn an intermediary shell, so the command string
        // is passed as a single argument to /bin/sh, preventing injection.
        const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          env: safeEnv,
        });
        return textEnvelope(formatExecResult(
          stdout.slice(0, MAX_STDOUT),
          stderr.slice(0, MAX_STDERR),
          0,
        ));
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string; code?: unknown; status?: number };
        return textEnvelope(formatExecResult(
          (err.stdout || '').slice(0, MAX_STDOUT),
          (err.stderr || err.message || '').slice(0, MAX_STDERR),
          err.status || (typeof err.code === 'number' ? err.code : 1),
        ));
      }
    },
    source: 'builtin',
    category: 'execute',
    isDestructive: true,
    // Exec output can be huge (build logs, test runs) — give it a
    // generous 128 KB threshold before persistence kicks in. Over that,
    // the registry offloads to disk and returns a reference so the
    // agent can read specific portions via read_file if needed.
    maxResultSizeChars: 128 * 1024,
    getActivityDescription: (input) => {
      const cmd = (input as { command?: string })?.command ?? '';
      return `Running: ${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}`;
    },
  },
  // batch_exec — run multiple commands in parallel
  {
    definition: {
      name: 'batch_exec',
      searchHint: 'batch parallel multiple commands run execute concurrent',
      alwaysLoad: false,
      description:
        'Run multiple shell commands in parallel and return all results. ' +
        'Much faster than sequential exec calls when commands are independent. ' +
        'Each command runs in its own subprocess. Max 10 commands per batch. ' +
        'Use this when you need to run the same script on multiple inputs, ' +
        'or gather data from multiple sources at once.',
      parameters: {
        type: 'object',
        properties: {
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of shell commands to run in parallel. Max 10.',
          },
          workdir: {
            type: 'string',
            description: 'Working directory for all commands (optional).',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds per command (default 30, max 120).',
          },
        },
        required: ['commands'],
      },
    },
    validateInput: (input) => {
      const args = input as Record<string, unknown>;
      if (!Array.isArray(args.commands) || args.commands.length === 0) {
        return { ok: false, error: 'commands must be a non-empty array of strings.' };
      }
      if (args.commands.length > 10) {
        return { ok: false, error: 'Maximum 10 commands per batch.' };
      }
      for (const cmd of args.commands) {
        if (typeof cmd !== 'string' || cmd.trim().length === 0) {
          return { ok: false, error: 'Each command must be a non-empty string.' };
        }
      }
      return { ok: true };
    },
    executor: async (args, context) => {
      const commands = args.commands as string[];
      const workdir = (args.workdir as string) || undefined;
      const timeout = Math.min(Math.max(Number(args.timeout) || 30, 1), 120);

      const ctx = context as Record<string, unknown>;
      const workspace = getWorkspace(ctx);
      const cwd = workdir
        ? (path.isAbsolute(workdir) ? workdir : path.join(workspace, workdir))
        : workspace;

      const startTime = Date.now();
      const results = await Promise.allSettled(
        commands.map(async (cmd) => {
          try {
            const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', cmd], {
              cwd,
              timeout: timeout * 1000,
              maxBuffer: MAX_STDOUT * 2,
              env: { ...process.env, HOME: process.env.HOME },
            });
            return { command: cmd, exitCode: 0, stdout: (stdout || '').slice(0, MAX_STDOUT), stderr: (stderr || '').slice(0, 2000) };
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; code?: number; signal?: string };
            return {
              command: cmd,
              exitCode: err.code ?? 1,
              stdout: (err.stdout || '').slice(0, MAX_STDOUT),
              stderr: (err.stderr || '').slice(0, 2000),
              error: err.signal ? `killed by ${err.signal}` : undefined,
            };
          }
        }),
      );

      const elapsed = Date.now() - startTime;
      const output: string[] = [`Batch: ${commands.length} commands in ${elapsed}ms (parallel)\n`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        output.push(`--- [${i + 1}] ${commands[i].slice(0, 80)} ---`);
        if (r.status === 'fulfilled') {
          output.push(formatExecResult(r.value.stdout, r.value.stderr, r.value.exitCode));
        } else {
          output.push(`error: ${r.reason}`);
        }
        output.push('');
      }

      return textEnvelope(output.join('\n'));
    },
    source: 'builtin',
    category: 'execute',
    isDestructive: true,
    concurrencySafe: true,
    getActivityDescription: (input) => {
      const cmds = (input as { commands?: string[] })?.commands ?? [];
      return `Batch: ${cmds.length} commands in parallel`;
    },
  },
];
