/**
 * manage_plugins — unified tool for managing CLI and HTTP plugins.
 *
 * Actions: list, add, update, remove
 * Type: "cli" or "http" (required for add/update/remove, optional for list)
 *
 * Reads/writes plugins.json and triggers hot-reload after changes.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRegistration } from '../types.js';
import type { PluginsConfig } from '@agw/types';
import { loadPlugins, savePlugins } from '../../plugins/store.js';

const execFileAsync = promisify(execFileCb);

/** Validate a command name is safe (no shell metacharacters). */
function isValidCommand(cmd: string): boolean {
  return /^[a-zA-Z0-9_\-\.]+$/.test(cmd);
}

export const pluginTools: ToolRegistration[] = [
  {
    definition: {
      name: 'manage_plugins',
      description: `Manage plugins (CLI tools and HTTP APIs) that the agent can use.

CLI plugins: wrap a command-line tool (gh, docker, kubectl) as a single agent tool. The LLM already knows CLI syntax from training — 1 tool ≈ 200 tokens vs MCP's 55,000 tokens for GitHub.
HTTP plugins: connect REST APIs as agent tools. Each endpoint becomes a separate tool.

Before adding a CLI plugin, use the exec tool to verify the command exists (e.g. exec "gh --version").
Before adding an HTTP plugin, use exec with curl to test the endpoint.

Plugins are stored in plugins.json (separate from config.json).`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'update', 'remove'],
            description: 'Action to perform',
          },
          type: {
            type: 'string',
            enum: ['cli', 'http'],
            description: 'Plugin type. Required for add/update/remove. Optional for list (omit = show all).',
          },
          name: {
            type: 'string',
            description: 'Plugin name (for update/remove)',
          },
          plugin: {
            type: 'object',
            description: `Plugin configuration (for add/update).

CLI plugin fields:
  name, command, description, enabled, timeout (max 120),
  allowedSubcommands (empty=all), blockedSubcommands, requireConfirmation,
  env: ["GITHUB_TOKEN", ...] — env var names to inject from secrets store

HTTP plugin fields:
  name, baseUrl, description, enabled, timeout (max 600),
  endpoints: [{ name, method, path, description, parameters: { paramName: { type, description, required, default } } }]`,
          },
          // Secrets (CLI env vars or HTTP auth token) — stored in secrets.json, never in plugins.json
          secrets: {
            type: 'object',
            description: 'Secret values to store. For CLI: env var values (e.g. { "GITHUB_TOKEN": "ghp_..." }). For HTTP: { "token": "sk-..." }. Stored securely in secrets store.',
          },
          // HTTP auth (add/update)
          auth: {
            type: 'object',
            description: 'Auth config for HTTP plugins. { type: "bearer"|"header"|"query"|"basic", headerName?, queryParam? }',
            properties: {
              type: { type: 'string', enum: ['bearer', 'header', 'query', 'basic'] },
              headerName: { type: 'string' },
              queryParam: { type: 'string' },
            },
          },
        },
        required: ['action'],
      },
    },
    executor: async (args, context) => {
      const action = args.action as string;
      if (!action) return { error: 'action is required' };

      const ctx = context as Record<string, unknown>;
      const config = ctx.config as Record<string, unknown>;
      const stateDir = (config as Record<string, unknown>)._stateDir as string || '';
      const type = args.type as 'cli' | 'http' | undefined;

      const secretsStore = ctx.secretsStore as {
        get: (ns: string, key: string) => string | undefined;
        set: (ns: string, key: string, value: string) => void;
        deleteNamespace: (ns: string) => void;
      } | undefined;

      switch (action) {
        // ─── LIST ─────────────────────────────────────
        case 'list': {
          const pluginsData = loadPlugins(stateDir);
          const result: Record<string, unknown> = {};

          if (!type || type === 'cli') {
            result.cli = {
              count: pluginsData.cli.length,
              plugins: pluginsData.cli.map(p => ({
                name: p.name,
                command: p.command,
                description: p.description,
                enabled: p.enabled,
                timeout: p.timeout,
                allowedSubcommands: p.allowedSubcommands,
                blockedSubcommands: p.blockedSubcommands,
                requireConfirmation: p.requireConfirmation,
                env: p.env || [],
              })),
            };
          }

          if (!type || type === 'http') {
            result.http = {
              count: pluginsData.http.length,
              plugins: pluginsData.http.map(p => ({
                name: p.name,
                baseUrl: p.baseUrl,
                description: p.description,
                enabled: p.enabled,
                timeout: p.timeout,
                endpointCount: p.endpoints?.length || 0,
                endpoints: (p.endpoints || []).map(e => ({
                  name: e.name,
                  method: e.method,
                  path: e.path,
                  description: e.description,
                })),
                hasAuth: !!(p.auth as unknown as Record<string, unknown>)?.type,
              })),
            };
          }

          return result;
        }

        // ─── ADD ──────────────────────────────────────
        case 'add': {
          if (!type) return { error: 'type is required for add (use "cli" or "http")' };
          const pluginData = args.plugin as Record<string, unknown> | undefined;
          if (!pluginData) return { error: 'plugin object is required for add' };

          const name = pluginData.name as string;
          if (!name) return { error: 'plugin.name is required' };
          if (!/^[a-z0-9_]+$/.test(name)) return { error: 'plugin.name must be lowercase alphanumeric + underscores' };

          const pluginsData = loadPlugins(stateDir);

          // Check name collision across both types
          if (pluginsData.cli.some(p => p.name === name) || pluginsData.http.some(p => p.name === name)) {
            return { error: `Plugin "${name}" already exists (check both CLI and HTTP). Use action="update" or choose a different name.` };
          }

          if (type === 'cli') {
            const command = pluginData.command as string;
            if (!command) return { error: 'plugin.command is required for CLI plugins' };

            // Validate command is a safe binary name (prevent shell injection in `which`)
            if (!isValidCommand(command)) {
              return { error: `Invalid command "${command}". Must be a simple binary name (letters, numbers, hyphens, underscores, dots).` };
            }

            // Verify command exists
            try {
              await execFileAsync('/bin/sh', ['-c', `which ${command}`], { timeout: 5000 });
            } catch {
              return { error: `Command "${command}" not found. Install it first (e.g. use exec tool to run: sudo apt install ${command}).` };
            }

            const envVars = (pluginData.env as string[]) || [];

            pluginsData.cli.push({
              name,
              command,
              description: (pluginData.description as string) || `${command} CLI`,
              enabled: pluginData.enabled !== false,
              timeout: Math.min(Math.max((pluginData.timeout as number) || 30, 1), 120),
              allowedSubcommands: (pluginData.allowedSubcommands as string[]) || [],
              blockedSubcommands: (pluginData.blockedSubcommands as string[]) || [],
              requireConfirmation: (pluginData.requireConfirmation as string[]) || [],
              env: envVars,
            });

            // Store secrets if provided
            const secrets = args.secrets as Record<string, string> | undefined;
            if (secrets && secretsStore) {
              for (const [key, val] of Object.entries(secrets)) {
                secretsStore.set(`plugins.${name}`, key, val);
              }
            }

            try { savePlugins(stateDir, pluginsData); } catch {
              return { error: 'Failed to write plugins file' };
            }
            (config as Record<string, unknown>).plugins = pluginsData;

            const reloader = ctx.pluginReloader as (() => string[]) | undefined;
            const tools = reloader ? reloader() : [];

            return { success: true, type: 'cli', plugin: name, tool: `cli_${name}`, totalPluginTools: tools.length };

          } else {
            // HTTP
            const baseUrl = pluginData.baseUrl as string;
            if (!baseUrl) return { error: 'plugin.baseUrl is required for HTTP plugins' };

            const endpoints = pluginData.endpoints as Array<Record<string, unknown>> | undefined;
            if (!endpoints || endpoints.length === 0) return { error: 'plugin.endpoints is required (at least one)' };

            for (const ep of endpoints) {
              if (!ep.name || !/^[a-z0-9_]+$/.test(ep.name as string)) {
                return { error: `Endpoint name "${ep.name}" must be lowercase alphanumeric + underscores` };
              }
            }

            const pluginConfig: Record<string, unknown> = {
              name,
              baseUrl,
              description: (pluginData.description as string) || '',
              enabled: pluginData.enabled !== false,
              timeout: Math.min(Math.max((pluginData.timeout as number) || 30, 1), 600),
              endpoints: endpoints.map(ep => ({
                name: ep.name,
                method: ((ep.method as string) || 'GET').toUpperCase(),
                path: ep.path || '/',
                description: ep.description || '',
                parameters: ep.parameters || {},
              })),
            };

            // Handle auth
            const authConfig = args.auth as Record<string, unknown> | undefined;
            const secrets = args.secrets as Record<string, string> | undefined;
            if (authConfig?.type) {
              const secretNamespace = `plugins.${name}`;
              pluginConfig.auth = {
                type: authConfig.type,
                tokenSecret: secretNamespace,
                ...(authConfig.headerName ? { headerName: authConfig.headerName } : {}),
                ...(authConfig.queryParam ? { queryParam: authConfig.queryParam } : {}),
              };
              if (secrets?.token && secretsStore) {
                secretsStore.set(secretNamespace, 'token', secrets.token);
              }
            }

            pluginsData.http.push(pluginConfig as any);

            try { savePlugins(stateDir, pluginsData); } catch {
              return { error: 'Failed to write plugins file' };
            }
            (config as Record<string, unknown>).plugins = pluginsData;

            const reloader = ctx.pluginReloader as (() => string[]) | undefined;
            const tools = reloader ? reloader() : [];

            return {
              success: true,
              type: 'http',
              plugin: name,
              endpoints: endpoints.map(e => `http_${name}_${e.name}`),
              totalPluginTools: tools.length,
            };
          }
        }

        // ─── UPDATE ───────────────────────────────────
        case 'update': {
          if (!type) return { error: 'type is required for update (use "cli" or "http")' };
          const pluginName = (args.name || (args.plugin as Record<string, unknown>)?.name) as string;
          if (!pluginName) return { error: 'name is required for update' };

          const pluginsData = loadPlugins(stateDir);
          const updates = args.plugin as Record<string, unknown> | undefined;

          if (type === 'cli') {
            const idx = pluginsData.cli.findIndex(p => p.name === pluginName);
            if (idx < 0) return { error: `CLI plugin "${pluginName}" not found` };

            if (updates) {
              const target = pluginsData.cli[idx] as unknown as Record<string, unknown>;
              if (updates.command) target.command = updates.command;
              if (updates.description !== undefined) target.description = updates.description;
              if (updates.enabled !== undefined) target.enabled = updates.enabled;
              if (updates.timeout !== undefined) target.timeout = Math.min(Math.max(updates.timeout as number, 1), 120);
              if (updates.allowedSubcommands) target.allowedSubcommands = updates.allowedSubcommands;
              if (updates.blockedSubcommands) target.blockedSubcommands = updates.blockedSubcommands;
              if (updates.requireConfirmation) target.requireConfirmation = updates.requireConfirmation;
              if (updates.env) target.env = updates.env;
            }

            // Store/update secrets
            const secrets = args.secrets as Record<string, string> | undefined;
            if (secrets && secretsStore) {
              for (const [key, val] of Object.entries(secrets)) {
                secretsStore.set(`plugins.${pluginName}`, key, val);
              }
            }
          } else {
            const idx = pluginsData.http.findIndex(p => p.name === pluginName);
            if (idx < 0) return { error: `HTTP plugin "${pluginName}" not found` };

            if (updates) {
              const target = pluginsData.http[idx] as unknown as Record<string, unknown>;
              if (updates.baseUrl) target.baseUrl = updates.baseUrl;
              if (updates.description !== undefined) target.description = updates.description;
              if (updates.enabled !== undefined) target.enabled = updates.enabled;
              if (updates.timeout !== undefined) target.timeout = Math.min(Math.max(updates.timeout as number, 1), 600);
              if (updates.endpoints) target.endpoints = (updates.endpoints as Array<Record<string, unknown>>).map(ep => ({
                name: ep.name,
                method: ((ep.method as string) || 'GET').toUpperCase(),
                path: ep.path || '/',
                description: ep.description || '',
                parameters: ep.parameters || {},
              }));
            }

            // Handle auth update
            const authConfig = args.auth as Record<string, unknown> | undefined;
            const secrets = args.secrets as Record<string, string> | undefined;
            if (authConfig?.type) {
              const secretNamespace = `plugins.${pluginName}`;
              (pluginsData.http[pluginsData.http.findIndex(p => p.name === pluginName)] as unknown as Record<string, unknown>).auth = {
                type: authConfig.type,
                tokenSecret: secretNamespace,
                ...(authConfig.headerName ? { headerName: authConfig.headerName } : {}),
                ...(authConfig.queryParam ? { queryParam: authConfig.queryParam } : {}),
              };
              if (secrets?.token && secretsStore) {
                secretsStore.set(secretNamespace, 'token', secrets.token);
              }
            }
          }

          try { savePlugins(stateDir, pluginsData); } catch {
            return { error: 'Failed to write plugins file' };
          }
          (config as Record<string, unknown>).plugins = pluginsData;

          const reloader = ctx.pluginReloader as (() => string[]) | undefined;
          if (reloader) reloader();

          return { success: true, type, plugin: pluginName };
        }

        // ─── REMOVE ───────────────────────────────────
        case 'remove': {
          if (!type) return { error: 'type is required for remove (use "cli" or "http")' };
          const pluginName = args.name as string;
          if (!pluginName) return { error: 'name is required for remove' };

          const pluginsData = loadPlugins(stateDir);

          if (type === 'cli') {
            const idx = pluginsData.cli.findIndex(p => p.name === pluginName);
            if (idx < 0) return { error: `CLI plugin "${pluginName}" not found` };
            pluginsData.cli.splice(idx, 1);
          } else {
            const idx = pluginsData.http.findIndex(p => p.name === pluginName);
            if (idx < 0) return { error: `HTTP plugin "${pluginName}" not found` };
            pluginsData.http.splice(idx, 1);
          }

          // Clean up secrets for both types
          {
            if (secretsStore) {
              try { secretsStore.deleteNamespace(`plugins.${pluginName}`); } catch { /* non-fatal */ }
            }
          }

          try { savePlugins(stateDir, pluginsData); } catch {
            return { error: 'Failed to write plugins file' };
          }
          (config as Record<string, unknown>).plugins = pluginsData;

          const reloader = ctx.pluginReloader as (() => string[]) | undefined;
          if (reloader) reloader();

          return { success: true, type, removed: pluginName };
        }

        default:
          return { error: `Unknown action: ${action}. Use: list, add, update, remove` };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
