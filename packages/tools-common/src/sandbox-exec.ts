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
      alwaysLoad: true,
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
      const sessionId = context.session?.sessionId;
      if (!userId || !sessionId) {
        return { error: 'sandbox_exec requires an authenticated user with an active session' };
      }

      const workspace = getWorkspace(context as Record<string, unknown>);
      const role = context.user?.role ?? 'user';
      const isAdmin = role === 'admin';
      const scopeKey = context.scopeKey ?? null;

      try {
        const result = await containerManager.exec({
          userId,
          sessionId,
          role,
          workspacePath: workspace,
          scopeKey,
          isAdmin,
          command,
          workdir: args.workdir as string | undefined,
          timeout: args.timeout as number | undefined,
        });

        return textEnvelope(formatExecResult(result.stdout, result.stderr, result.exitCode));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Sandbox exec failed: ${msg}` };
      }
    },
    source: 'builtin',
    category: 'execute',
    isDestructive: false,
    maxResultSizeChars: 128 * 1024,
    getActivityDescription: (input) => {
      const cmd = (input as { command?: string })?.command ?? '';
      return `Sandbox: ${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}`;
    },
  },
];
