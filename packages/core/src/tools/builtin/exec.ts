import { EXEC_MAX_STDOUT, EXEC_MAX_STDERR, EXEC_MAX_TIMEOUT_SECONDS, EXEC_DEFAULT_TIMEOUT_SECONDS } from '../../constants.js';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRegistration } from '../types.js';
import { safePath } from './files.js';
import { getWorkspace } from './utils.js';

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

// ── Layer 1: Hard block — never execute these, period ──────

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
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
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+(docker|sshd|network|firewall)/i, reason: 'disable critical service' },
  // Remote code execution
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/i, reason: 'curl pipe to shell' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/i, reason: 'wget pipe to shell' },
  // Credential/key theft
  { pattern: /\bcat\b.*\/(\.ssh\/|\.aws\/|\.env\b|secrets\.json|\.docker\/config)/i, reason: 'read credential files' },
  { pattern: /\b(history|\.bash_history|\.zsh_history)\b/i, reason: 'read shell history' },
  // Environment/loader hijacking
  { pattern: /\bLD_PRELOAD\s*=/i, reason: 'LD_PRELOAD injection' },
  { pattern: /\bDYLD_/i, reason: 'DYLD injection' },
  { pattern: /\bLD_LIBRARY_PATH\s*=/i, reason: 'LD_LIBRARY_PATH hijacking' },
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
 * Check command safety. Returns:
 * - { action: 'block', reason } — never execute
 * - { action: 'confirm', reason } — ask user first
 * - { action: 'allow' } — safe to run
 */
function checkCommandSafety(command: string): { action: 'block' | 'confirm' | 'allow'; reason?: string } {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { action: 'block', reason };
    }
  }
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { action: 'confirm', reason };
    }
  }
  return { action: 'allow' };
}

export const execTools: ToolRegistration[] = [
  {
    definition: {
      name: 'exec',
      description: 'Execute a shell command. Returns stdout, stderr, and exit code.',
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

      // Two-layer safety check
      const safety = checkCommandSafety(command);
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
      const ctx = context as Record<string, unknown>;
      const configTimeout = (ctx.config as Record<string, unknown>)?.tools
        ? ((ctx.config as Record<string, Record<string, Record<string, unknown>>>).tools?.exec?.timeout as number)
        : undefined;
      const defaultTimeout = typeof configTimeout === 'number' && configTimeout > 0 ? configTimeout : EXEC_DEFAULT_TIMEOUT_SECONDS;
      const timeout = Math.min((args.timeout as number) || defaultTimeout, EXEC_MAX_TIMEOUT_SECONDS) * 1000;
      const cwd = args.workdir ? safePath(args.workdir as string, workspace) : workspace;

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
        return {
          stdout: stdout.slice(0, MAX_STDOUT),
          stderr: stderr.slice(0, MAX_STDERR),
          exitCode: 0,
        };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string; code?: unknown; status?: number };
        return {
          stdout: (err.stdout || '').slice(0, MAX_STDOUT),
          stderr: (err.stderr || err.message || '').slice(0, MAX_STDERR),
          exitCode: err.status || (typeof err.code === 'number' ? err.code : 1),
        };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
