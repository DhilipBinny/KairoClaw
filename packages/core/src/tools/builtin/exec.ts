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
