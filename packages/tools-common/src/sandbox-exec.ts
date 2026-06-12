import type { ToolRegistration } from '@agw/tool-platform';
import { textEnvelope } from '@agw/tool-platform';
import type { ContainerManager } from '@agw/sandbox';
import { formatExecResult } from './exec.js';
import { getWorkspace } from './utils.js';

let containerManager: ContainerManager | null = null;

export function setSandboxManager(manager: ContainerManager | null): void {
  containerManager = manager;
}

export const sandboxExecTools: ToolRegistration[] = [
  {
    definition: {
      name: 'sandbox_exec',
      description:
        'Execute a command inside a sandboxed Docker container. ' +
        'Isolated from the host — has its own filesystem, network policy, and resource limits. ' +
        'The container persists for the session, so installed packages and created files survive across calls. ' +
        'Pre-installed: Node.js 22, Python 3.12, npm, pnpm, pip, git, curl, jq. ' +
        'Use this for code execution, package installs, builds, or any command that should not affect the host.',
      searchHint: 'sandbox docker container isolated execute run safe',
      alwaysLoad: false,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute inside the sandbox' },
          timeout: { type: 'number', description: 'Timeout in seconds (default from config)' },
          workdir: { type: 'string', description: 'Working directory inside container (default: /workspace)' },
        },
        required: ['command'],
      },
    },
    executor: async (args, context) => {
      if (!containerManager) {
        return { error: 'Sandbox is not available. Docker may not be running or sandbox is disabled in config.' };
      }

      const command = args.command as string;
      if (!command || typeof command !== 'string') {
        return { error: 'command is required and must be a string' };
      }
      if (command.length > 10000) {
        return { error: 'Command too long (max 10000 chars)' };
      }

      const userId = context.user?.id;
      const session = context.session as Record<string, unknown> | undefined;
      const sessionId = session?.sessionId as string ?? session?.id as string;
      if (!userId || !sessionId) {
        return { error: 'sandbox_exec requires an authenticated user with an active session' };
      }

      const workspace = getWorkspace(context as Record<string, unknown>);
      const role = context.user?.role ?? 'user';
      const isAdmin = role === 'admin';
      const scopeKey = context.scopeKey ?? null;

      const workdir = args.workdir as string | undefined;
      if (workdir && !/^\/[\w./-]*$/.test(workdir)) {
        return { error: 'Invalid workdir: must be an absolute path with safe characters' };
      }
      const timeout = args.timeout as number | undefined;
      if (timeout !== undefined && (typeof timeout !== 'number' || timeout < 1 || timeout > 600)) {
        return { error: 'timeout must be a number between 1 and 600 seconds' };
      }

      try {
        const result = await containerManager.exec({
          userId,
          sessionId,
          role,
          workspacePath: workspace,
          scopeKey,
          isAdmin,
          command,
          workdir,
          timeout,
        });

        if (result.exitCode === 137) {
          result.stderr = (result.stderr ? result.stderr + '\n' : '') +
            '[Container killed — likely out of memory. Try a smaller operation or ask admin to increase memory limit.]';
        }
        return textEnvelope(formatExecResult(result.stdout, result.stderr, result.exitCode));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not running') || msg.includes('not found')) {
          return { error: 'Sandbox container was stopped or expired. Try again — a new container will be created.' };
        }
        return { error: `Sandbox exec failed: ${msg}` };
      }
    },
    source: 'builtin',
    category: 'execute',
    isDestructive: true,
    maxResultSizeChars: 16 * 1024,
    getActivityDescription: (input) => {
      const cmd = (input as { command?: string })?.command ?? '';
      return `Sandbox: ${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}`;
    },
  },
  // ── sandbox_read_file ─────────────────────────────
  {
    definition: {
      name: 'sandbox_read_file',
      description:
        'Read a file from inside the sandbox container. Returns the first 2000 lines by default. ' +
        'Use offset and limit for large files. Works even when workspace is read-only or "none" mode.',
      searchHint: 'sandbox read file container download retrieve',
      alwaysLoad: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path inside the container (e.g. /workspace/output.csv)' },
          offset: { type: 'number', description: 'Start reading from this line number (0-based, default: 0)' },
          limit: { type: 'number', description: 'Number of lines to read (default: 2000)' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      if (!containerManager) {
        return { error: 'Sandbox is not available.' };
      }
      const filePath = args.path as string;
      if (!filePath || typeof filePath !== 'string') {
        return { error: 'path is required and must be a string' };
      }
      if (!/^\/[\w./-]*$/.test(filePath)) {
        return { error: 'Invalid path: must be an absolute path with safe characters' };
      }
      const userId = context.user?.id;
      const session = context.session as Record<string, unknown> | undefined;
      const sessionId = session?.sessionId as string ?? session?.id as string;
      if (!userId || !sessionId) {
        return { error: 'Requires an authenticated user with an active session' };
      }
      if (!containerManager.hasContainer(userId, sessionId)) {
        return { error: 'No sandbox container running for this session. Run sandbox_exec first.' };
      }
      try {
        const result = await containerManager.readFile({
          userId,
          sessionId,
          role: context.user?.role ?? 'user',
          workspacePath: getWorkspace(context as Record<string, unknown>),
          scopeKey: context.scopeKey ?? null,
          isAdmin: context.user?.role === 'admin',
          path: filePath,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
        if (result.exitCode !== 0) {
          return { error: `File not found or not readable: ${result.stderr.trim()}` };
        }
        return textEnvelope(result.stdout);
      } catch (err) {
        return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    concurrencySafe: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '';
      return `Sandbox read: ${p}`;
    },
  },
  // ── sandbox_write_file ────────────────────────────
  {
    definition: {
      name: 'sandbox_write_file',
      description:
        'Write content to a file inside the sandbox container. Use this to upload scripts, ' +
        'config files, or data into the sandbox before running them with sandbox_exec. ' +
        'Creates parent directories automatically.',
      searchHint: 'sandbox write file container upload create',
      alwaysLoad: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path inside the container (e.g. /workspace/script.py)' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
    executor: async (args, context) => {
      if (!containerManager) {
        return { error: 'Sandbox is not available.' };
      }
      const filePath = args.path as string;
      const content = args.content as string;
      if (!filePath || typeof filePath !== 'string') {
        return { error: 'path is required' };
      }
      if (content == null || typeof content !== 'string') {
        return { error: 'content is required' };
      }
      if (!/^\/[\w./-]*$/.test(filePath)) {
        return { error: 'Invalid path: must be an absolute path with safe characters' };
      }
      if (content.length > 512 * 1024) {
        return { error: 'Content too large (max 512KB)' };
      }
      const userId = context.user?.id;
      const session = context.session as Record<string, unknown> | undefined;
      const sessionId = session?.sessionId as string ?? session?.id as string;
      if (!userId || !sessionId) {
        return { error: 'Requires an authenticated user with an active session' };
      }
      if (!containerManager.hasContainer(userId, sessionId)) {
        return { error: 'No sandbox container running for this session. Run sandbox_exec first.' };
      }
      try {
        const result = await containerManager.writeFile({
          userId,
          sessionId,
          role: context.user?.role ?? 'user',
          workspacePath: getWorkspace(context as Record<string, unknown>),
          scopeKey: context.scopeKey ?? null,
          isAdmin: context.user?.role === 'admin',
          path: filePath,
          content,
        });
        if (result.exitCode !== 0) {
          return { error: `Failed to write: ${result.stderr.trim()}` };
        }
        return textEnvelope(`File written: ${filePath} (${content.length} bytes)`);
      } catch (err) {
        return { error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    source: 'builtin',
    category: 'write',
    isDestructive: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '';
      return `Sandbox write: ${p}`;
    },
  },
  // ── sandbox_list_files ────────────────────────────
  {
    definition: {
      name: 'sandbox_list_files',
      description:
        'List files in a directory inside the sandbox container. Shows file names, sizes, ' +
        'and permissions. Use this to see what files exist in the sandbox.',
      searchHint: 'sandbox list files directory container ls',
      alwaysLoad: false,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path inside the container (default: /workspace)' },
        },
        required: [],
      },
    },
    executor: async (args, context) => {
      if (!containerManager) {
        return { error: 'Sandbox is not available.' };
      }
      const dirPath = (args.path as string) || '/workspace';
      if (!/^\/[\w./-]*$/.test(dirPath)) {
        return { error: 'Invalid path: must be an absolute path with safe characters' };
      }
      const userId = context.user?.id;
      const session = context.session as Record<string, unknown> | undefined;
      const sessionId = session?.sessionId as string ?? session?.id as string;
      if (!userId || !sessionId) {
        return { error: 'Requires an authenticated user with an active session' };
      }
      if (!containerManager.hasContainer(userId, sessionId)) {
        return { error: 'No sandbox container running for this session. Run sandbox_exec first.' };
      }
      try {
        const result = await containerManager.listFiles({
          userId,
          sessionId,
          role: context.user?.role ?? 'user',
          workspacePath: getWorkspace(context as Record<string, unknown>),
          scopeKey: context.scopeKey ?? null,
          isAdmin: context.user?.role === 'admin',
          path: dirPath,
        });
        if (result.exitCode !== 0) {
          return { error: `Directory not found: ${result.stderr.trim()}` };
        }
        return textEnvelope(result.stdout);
      } catch (err) {
        return { error: `Failed to list files: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    source: 'builtin',
    category: 'read',
    isReadOnly: true,
    concurrencySafe: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '/workspace';
      return `Sandbox ls: ${p}`;
    },
  },
];
