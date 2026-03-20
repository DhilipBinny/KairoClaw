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
      'channels.whatsapp.enabled', 'channels.whatsapp.allowFrom', 'channels.whatsapp.groupsEnabled', 'channels.whatsapp.groupRequireMention', 'channels.whatsapp.sendReadReceipts',
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
};
