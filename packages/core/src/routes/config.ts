import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { GatewayConfig } from '@agw/types';
import { requireRole } from '../auth/middleware.js';
import type { AuditService } from '../security/audit.js';
import { configSchema } from '../config/schema.js';

/**
 * Set a nested property on an object by dot-separated path.
 * e.g. setNestedPath(obj, "model.primary", "claude-sonnet-4-6")
 */
function setNestedPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export const registerConfigRoutes: FastifyPluginAsync<{
  auditService?: AuditService;
  onConfigChange?: (path: string, value: unknown) => Promise<void>;
}> = async (app, opts) => {
  const auditService = opts?.auditService;
  const onConfigChange = opts?.onConfigChange;
  // GET /api/v1/admin/config — get config (sanitized, no secrets)
  app.get('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = (request as any).ctx.config;
    // Return config with secrets masked
    const sanitized = JSON.parse(JSON.stringify(config));
    // Mask API keys
    if (sanitized.providers?.anthropic?.apiKey) sanitized.providers.anthropic.apiKey = '***';
    if (sanitized.providers?.openai?.apiKey) sanitized.providers.openai.apiKey = '***';
    if (sanitized.channels?.telegram?.token) sanitized.channels.telegram.token = '***';
    return { config: sanitized };
  });

  // PATCH /api/v1/admin/config — save config changes
  app.patch('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const { path: dotPath, value } = request.body as { path?: string; value?: unknown };

    if (!dotPath || typeof dotPath !== 'string') {
      return reply.code(400).send({ error: 'Missing or invalid "path"' });
    }

    // Allowlist of paths that can be updated via this endpoint
    // NEVER allow: providers.*apiKey, providers.*authToken, gateway.token, any secret fields
    const allowedPaths = [
      'model.primary', 'model.fallback',
      'agent.name', 'agent.maxToolRounds', 'agent.compactionThreshold', 'agent.keepRecentMessages',
      'session.resetHour', 'session.idleMinutes',
      'channels.telegram.enabled', 'channels.telegram.allowFrom', 'channels.telegram.groupsEnabled', 'channels.telegram.groupRequireMention',
      'channels.whatsapp.enabled', 'channels.whatsapp.allowFrom', 'channels.whatsapp.groupAllowFrom', 'channels.whatsapp.groupsEnabled', 'channels.whatsapp.groupRequireMention', 'channels.whatsapp.sendReadReceipts',
      'tools.exec.enabled', 'tools.exec.timeout',
      'tools.webSearch.enabled',
      'tools.webFetch.enabled', 'tools.webFetch.maxChars',
    ];
    if (!allowedPaths.includes(dotPath)) {
      return reply.code(400).send({ error: `Path "${dotPath}" is not allowed` });
    }

    // Read raw config from disk to avoid saving resolved env vars / internal fields
    const stateDir = config._stateDir || '';
    const configPath = path.join(stateDir, 'config.json');

    let rawConfig: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      rawConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to read config file' });
    }

    // Set the value in a temporary copy and validate against the Zod schema
    const candidateConfig = JSON.parse(JSON.stringify(rawConfig));
    setNestedPath(candidateConfig, dotPath, value);

    const parseResult = configSchema.safeParse(candidateConfig);
    if (!parseResult.success) {
      // Zod v4 uses .issues, Zod v3 uses .errors — handle both
      const issues = (parseResult.error as any).issues ?? (parseResult.error as any).errors ?? [];
      const firstIssue = issues[0];
      const errorPath = firstIssue?.path?.join('.') || dotPath;
      const errorMsg = firstIssue?.message || 'Validation failed';
      return reply.code(400).send({ error: `Validation failed at "${errorPath}": ${errorMsg}` });
    }

    // Validation passed — apply to raw config (for disk) and live config (for runtime)
    setNestedPath(rawConfig, dotPath, value);
    setNestedPath(config as unknown as Record<string, unknown>, dotPath, value);

    // Write back to disk
    try {
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to write config file' });
    }

    // Audit log
    if (auditService) {
      try {
        auditService.log({
          tenantId: (request as any).ctx.tenantId || 'default',
          userId: (request as any).ctx.userId,
          action: 'config.update',
          resource: dotPath,
          details: { path: dotPath, value },
        });
      } catch { /* audit should not break config update */ }
    }

    // Notify listeners of config change (e.g. hot-reload channels)
    if (onConfigChange) {
      try {
        await onConfigChange(dotPath, value);
      } catch { /* config change hook should not break the response */ }
    }

    return { success: true, path: dotPath, value };
  });

  // GET /api/v1/admin/tools — tool metadata for dynamic rendering
  app.get('/api/v1/admin/tools', { preHandler: [requireRole('admin')] }, async () => {
    return {
      tools: [
        {
          key: 'exec',
          label: 'Shell Exec',
          hint: 'Allow the agent to execute shell commands',
          fields: [
            { key: 'enabled', type: 'boolean' },
            { key: 'timeout', type: 'number', label: 'Timeout (sec)', hint: 'Maximum seconds per command execution', showWhen: 'enabled', min: 1 },
          ],
        },
        {
          key: 'webSearch',
          label: 'Web Search',
          hint: 'Allow the agent to search the web',
          fields: [
            { key: 'enabled', type: 'boolean' },
          ],
        },
        {
          key: 'webFetch',
          label: 'Web Fetch',
          hint: 'Allow the agent to fetch web pages',
          fields: [
            { key: 'enabled', type: 'boolean' },
            { key: 'maxChars', type: 'number', label: 'Max Characters', hint: 'Maximum characters to fetch from a web page', showWhen: 'enabled', min: 0 },
          ],
        },
      ],
    };
  });

  // PUT /api/v1/admin/config — bulk save (raw JSON editor)
  app.put('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const { config: newConfig } = request.body as { config?: Record<string, unknown> };

    if (!newConfig || typeof newConfig !== 'object') {
      return reply.code(400).send({ error: 'Missing or invalid "config" object' });
    }

    // Never allow secrets to be set via bulk save — strip secret fields
    const secretPaths = [
      ['providers', 'anthropic', 'apiKey'], ['providers', 'anthropic', 'authToken'],
      ['providers', 'openai', 'apiKey'], ['channels', 'telegram', 'botToken'],
      ['gateway', 'token'], ['tools', 'webSearch', 'apiKey'],
    ];

    // Read existing raw config to preserve secrets
    const stateDir = config._stateDir || '';
    const configPath = path.join(stateDir, 'config.json');
    let rawConfig: Record<string, unknown>;
    try {
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return reply.code(500).send({ error: 'Failed to read config file' });
    }

    // Merge: use new config but preserve secret fields from raw
    const merged = JSON.parse(JSON.stringify(newConfig));
    for (const pathParts of secretPaths) {
      // Read secret from raw config
      let rawVal: unknown = rawConfig;
      for (const p of pathParts) {
        if (rawVal && typeof rawVal === 'object') rawVal = (rawVal as Record<string, unknown>)[p];
        else { rawVal = undefined; break; }
      }
      if (rawVal === undefined) continue;

      // Check if new config has a masked or empty value for this secret
      let newVal: unknown = merged;
      for (const p of pathParts) {
        if (newVal && typeof newVal === 'object') newVal = (newVal as Record<string, unknown>)[p];
        else { newVal = undefined; break; }
      }

      // Restore the original secret if the submitted value looks masked or empty
      if (newVal === '***' || newVal === '' || newVal === undefined) {
        let target: Record<string, unknown> = merged;
        for (let i = 0; i < pathParts.length - 1; i++) {
          if (!target[pathParts[i]] || typeof target[pathParts[i]] !== 'object') target[pathParts[i]] = {};
          target = target[pathParts[i]] as Record<string, unknown>;
        }
        target[pathParts[pathParts.length - 1]] = rawVal;
      }
    }

    // Remove internal fields
    delete merged._stateDir;

    // Validate against schema
    const parseResult = configSchema.safeParse(merged);
    if (!parseResult.success) {
      const issues = (parseResult.error as any).issues ?? (parseResult.error as any).errors ?? [];
      const firstIssue = issues[0];
      const errorPath = firstIssue?.path?.join('.') || 'unknown';
      const errorMsg = firstIssue?.message || 'Validation failed';
      return reply.code(400).send({ error: `Validation failed at "${errorPath}": ${errorMsg}` });
    }

    // Write to disk
    try {
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch {
      return reply.code(500).send({ error: 'Failed to write config file' });
    }

    // Apply to runtime config (shallow merge top-level keys)
    for (const key of Object.keys(merged)) {
      (config as unknown as Record<string, unknown>)[key] = (merged as Record<string, unknown>)[key];
    }

    // Audit
    if (auditService) {
      try {
        auditService.log({
          tenantId: (request as any).ctx.tenantId || 'default',
          userId: (request as any).ctx.userId,
          action: 'config.bulk_update',
          resource: 'config',
          details: { keys: Object.keys(merged) },
        });
      } catch { /* non-fatal */ }
    }

    // Notify config change
    if (onConfigChange) {
      try { await onConfigChange('*', merged); } catch { /* non-fatal */ }
    }

    return { success: true };
  });
};
