/**
 * CLI Plugin Module — registers CLI tools into the ToolRegistry.
 *
 * Each enabled CLI plugin creates a single tool `cli_{name}` that
 * executes shell commands with subcommand filtering and safety controls.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { GatewayConfig } from '@agw/types';
import type { ToolRegistration } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { SAFE_ENV_KEYS } from '../tools/builtin/exec.js';
import { EXEC_MAX_STDOUT, EXEC_MAX_STDERR } from '../constants.js';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFileCb);

/**
 * Extract the subcommand (first 1-2 tokens) from an args string.
 * For commands like "pr list", returns ["pr", "list"].
 * For commands like "status", returns ["status"].
 */
function extractSubcommand(args: string): string[] {
  const tokens = args.trim().split(/\s+/);
  // Return up to 2 tokens for matching (e.g. "pr list", "issue create")
  return tokens.slice(0, 2).filter(Boolean);
}

/**
 * Check if a subcommand matches any pattern in a list.
 * Matches both single-token ("auth") and double-token ("auth login") patterns.
 */
function matchesSubcommand(tokens: string[], patterns: string[]): boolean {
  if (tokens.length === 0 || patterns.length === 0) return false;
  for (const pattern of patterns) {
    const patternTokens = pattern.trim().split(/\s+/);
    if (patternTokens.length === 1) {
      // Single token pattern — match first token
      if (tokens[0] === patternTokens[0]) return true;
    } else if (patternTokens.length >= 2) {
      // Multi-token pattern — match first N tokens
      if (tokens.length >= patternTokens.length &&
          patternTokens.every((t, i) => tokens[i] === t)) return true;
    }
  }
  return false;
}

/**
 * Register all enabled CLI plugins as tools in the registry.
 * Returns the list of registered tool names.
 */
export function registerCliPlugins(
  config: GatewayConfig,
  toolRegistry: ToolRegistry,
  logger: Logger,
): string[] {
  const plugins = config.plugins?.cli || [];
  const registered: string[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled) continue;

    const toolName = `cli_${plugin.name}`;

    // Build description with subcommand info
    let desc = `${plugin.description || `Execute ${plugin.command} CLI commands`}`;
    desc += `\nCommand: ${plugin.command}`;
    if (plugin.allowedSubcommands.length > 0) {
      desc += `\nAllowed subcommands: ${plugin.allowedSubcommands.join(', ')}`;
    }
    if (plugin.blockedSubcommands.length > 0) {
      desc += `\nBlocked subcommands: ${plugin.blockedSubcommands.join(', ')}`;
    }

    const registration: ToolRegistration = {
      definition: {
        name: toolName,
        description: desc,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'string',
              description: `Arguments to pass to ${plugin.command} (e.g. "pr list --state open")`,
            },
          },
          required: ['args'],
        },
      },
      executor: async (args, context) => {
        const argsStr = args.args as string;
        if (!argsStr || typeof argsStr !== 'string') {
          return { error: 'args is required and must be a string' };
        }
        if (argsStr.length > 10000) {
          return { error: 'Arguments too long (max 10000 chars)' };
        }

        // Extract and check subcommand
        const subTokens = extractSubcommand(argsStr);

        // Check blocked subcommands
        if (matchesSubcommand(subTokens, plugin.blockedSubcommands)) {
          return { error: `Blocked: subcommand "${subTokens.join(' ')}" is not allowed for ${plugin.command}` };
        }

        // Check allowed subcommands (if non-empty, only listed ones are permitted)
        if (plugin.allowedSubcommands.length > 0 &&
            !matchesSubcommand(subTokens, plugin.allowedSubcommands)) {
          return { error: `Not allowed: subcommand "${subTokens.join(' ')}" is not in the allowed list for ${plugin.command}. Allowed: ${plugin.allowedSubcommands.join(', ')}` };
        }

        // Check confirmation requirement
        if (matchesSubcommand(subTokens, plugin.requireConfirmation)) {
          return {
            _requiresConfirmation: true,
            message: `This command requires confirmation: ${plugin.command} ${argsStr}`,
            command: plugin.command,
            args: argsStr,
          };
        }

        // Build safe environment
        const safeEnv: Record<string, string> = {};
        for (const key of SAFE_ENV_KEYS) {
          if (process.env[key]) safeEnv[key] = process.env[key]!;
        }

        // Inject plugin-specific env vars from secrets store
        const ctx = context as Record<string, unknown>;
        if (plugin.env && plugin.env.length > 0) {
          const secrets = ctx.secretsStore as { get: (ns: string, key: string) => string | undefined } | undefined;
          if (secrets) {
            for (const envKey of plugin.env) {
              const val = secrets.get(`plugins.${plugin.name}`, envKey);
              if (val) safeEnv[envKey] = val;
            }
          }
        }

        // Resolve workspace for cwd
        const workspace = (ctx.workspace as string) ||
          ((ctx.config as Record<string, Record<string, string>>)?.agent?.workspace) ||
          process.cwd();

        const timeoutMs = Math.min(plugin.timeout, 120) * 1000;

        try {
          // Split args safely — no shell interpolation
          const cmdArgs = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          // Strip surrounding quotes from each arg
          const cleanArgs = cmdArgs.map(a =>
            (a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))
              ? a.slice(1, -1) : a
          );
          const { stdout, stderr } = await execFileAsync(
            plugin.command,
            cleanArgs,
            {
              cwd: workspace,
              timeout: timeoutMs,
              maxBuffer: 1024 * 1024,
              env: safeEnv,
            },
          );
          return {
            stdout: stdout.slice(0, EXEC_MAX_STDOUT),
            stderr: stderr.slice(0, EXEC_MAX_STDERR),
            exitCode: 0,
          };
        } catch (e: unknown) {
          const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
          return {
            stdout: (err.stdout || '').slice(0, EXEC_MAX_STDOUT),
            stderr: (err.stderr || err.message || '').slice(0, EXEC_MAX_STDERR),
            exitCode: (err as any).status || (typeof err.code === 'number' ? err.code : 1),
          };
        }
      },
      source: 'cli_plugin',
      category: 'execute',
    };

    toolRegistry.register(registration);
    registered.push(toolName);
    logger.info({ plugin: plugin.name, tool: toolName }, 'CLI plugin registered');
  }

  return registered;
}
