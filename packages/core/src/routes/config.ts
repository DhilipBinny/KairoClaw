import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { GatewayConfig } from '@agw/types';
import { requireRole } from '../auth/middleware.js';
import type { AuditService } from '../security/audit.js';
import { setNestedPath, getConfig, getTenantId } from './utils.js';
import { configSchema, pluginsSchema } from '../config/schema.js';
import { loadPlugins, savePlugins } from '../plugins/store.js';

/** Get stateDir from config, throw if not set. */
function getStateDir(config: GatewayConfig): string {
  const stateDir = config._stateDir;
  if (!stateDir) throw new Error('_stateDir not set on config');
  return stateDir;
}

export const registerConfigRoutes: FastifyPluginAsync<{
  auditService?: AuditService;
  onConfigChange?: (path: string, value: unknown) => Promise<void>;
}> = async (app, opts) => {
  const auditService = opts?.auditService;
  const onConfigChange = opts?.onConfigChange;
  // GET /api/v1/admin/config — get config (sanitized, no secrets)
  app.get('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = getConfig(request);
    // Return config with secrets masked
    const sanitized = JSON.parse(JSON.stringify(config));
    // Mask API keys
    if (sanitized.providers?.anthropic?.apiKey) sanitized.providers.anthropic.apiKey = '***';
    if (sanitized.providers?.anthropic?.authToken) sanitized.providers.anthropic.authToken = '***';
    if (sanitized.providers?.openai?.apiKey) sanitized.providers.openai.apiKey = '***';
    if (sanitized.channels?.telegram?.botToken) sanitized.channels.telegram.botToken = '***';
    if (sanitized.gateway?.token) sanitized.gateway.token = '***';
    if (sanitized.tools?.webSearch?.apiKey) sanitized.tools.webSearch.apiKey = '***';
    return { config: sanitized };
  });

  // PATCH /api/v1/admin/config — save config changes
  app.patch('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = getConfig(request);
    const { path: dotPath, value } = request.body as { path?: string; value?: unknown };

    if (!dotPath || typeof dotPath !== 'string') {
      return reply.code(400).send({ error: 'Missing or invalid "path"' });
    }

    // Allowlist of paths that can be updated via this endpoint
    // NEVER allow: providers.*apiKey, providers.*authToken, gateway.token, any secret fields
    const allowedPaths = [
      'model.primary', 'model.fallback',
      'agent.name', 'agent.maxToolRounds', 'agent.compactionThreshold', 'agent.softCompactionThreshold', 'agent.keepRecentMessages',
      'agent.thinking.enabled', 'agent.thinking.mode', 'agent.thinking.budgetTokens',
      'agent.thinking.showThinking.web', 'agent.thinking.showThinking.telegram', 'agent.thinking.showThinking.whatsapp',
      'session.resetHour', 'session.idleMinutes',
      'channels.telegram.enabled', 'channels.telegram.allowFrom', 'channels.telegram.groupsEnabled', 'channels.telegram.groupRequireMention',
      'channels.whatsapp.enabled', 'channels.whatsapp.allowFrom', 'channels.whatsapp.groupAllowFrom', 'channels.whatsapp.groupsEnabled', 'channels.whatsapp.groupRequireMention', 'channels.whatsapp.sendReadReceipts',
      'channels.whatsapp.outboundPolicy', 'channels.whatsapp.outboundAllowlist',
      'channels.telegram.outboundPolicy', 'channels.telegram.outboundAllowlist',
      'tools.exec.enabled', 'tools.exec.timeout',
      'tools.webSearch.enabled',
      'tools.webFetch.enabled', 'tools.webFetch.maxChars',
      'tools.email.enabled', 'tools.email.host', 'tools.email.port', 'tools.email.secure',
      'tools.email.from', 'tools.email.allowedDomains', 'tools.email.allowedRecipients',
      'tools.email.maxRecipientsPerMessage',
      'tools.email.rateLimit.perMinute', 'tools.email.rateLimit.perHour', 'tools.email.rateLimit.perDay', 'tools.email.rateLimit.perRecipientPerHour',
      'tools.transcription.enabled', 'tools.transcription.baseUrl', 'tools.transcription.model', 'tools.transcription.language',
      'tools.browse.enabled',
    ];
    if (!allowedPaths.includes(dotPath)) {
      return reply.code(400).send({ error: `Path "${dotPath}" is not allowed` });
    }

    // Read raw config from disk to avoid saving resolved env vars / internal fields
    const stateDir = getStateDir(config);
    const configPath = path.join(stateDir, 'config.json');

    let rawConfig: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      rawConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch (_e) {
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
    } catch (_e) {
      return reply.code(500).send({ error: 'Failed to write config file' });
    }

    // Audit log
    if (auditService) {
      try {
        await auditService.log({
          tenantId: getTenantId(request),
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
        {
          key: 'email',
          label: 'Email (SMTP)',
          hint: 'Allow the agent to send emails via SMTP',
          fields: [
            { key: 'enabled', type: 'boolean' },
            { key: 'host', type: 'text', label: 'SMTP Host', hint: 'e.g. smtp.gmail.com', showWhen: 'enabled' },
            { key: 'port', type: 'number', label: 'Port', hint: '587 (STARTTLS) or 465 (SSL)', showWhen: 'enabled', min: 1 },
            { key: 'secure', type: 'boolean', label: 'Use SSL', hint: 'Enable for port 465. Leave off for 587 (auto STARTTLS).', showWhen: 'enabled' },
            { key: 'from', type: 'text', label: 'From Address', hint: 'Sender email (locked — LLM cannot change this)', showWhen: 'enabled' },
            { key: 'maxRecipientsPerMessage', type: 'number', label: 'Max Recipients', hint: 'Max to+cc+bcc per email', showWhen: 'enabled', min: 1 },
          ],
        },
        {
          key: 'transcription',
          label: 'Voice Transcription',
          hint: 'Transcribe voice messages to text using an OpenAI-compatible STT endpoint (e.g. self-hosted Whisper)',
          fields: [
            { key: 'enabled', type: 'boolean' },
            { key: 'baseUrl', type: 'text', label: 'STT Endpoint URL', hint: 'e.g. http://10.0.2.20:5007', showWhen: 'enabled' },
            { key: 'model', type: 'text', label: 'Model', hint: 'Model name sent in requests (e.g. whisper-small)', showWhen: 'enabled' },
            { key: 'language', type: 'text', label: 'Language', hint: 'ISO 639-1 code (e.g. en). Leave empty for auto-detect.', showWhen: 'enabled' },
          ],
        },
        {
          key: 'browse',
          label: 'Browser',
          hint: 'Allow the agent to browse websites, take screenshots, fill forms (uses headless Chromium or Chrome extension)',
          fields: [
            { key: 'enabled', type: 'boolean' },
          ],
        },
      ],
    };
  });

  // POST /api/v1/admin/tools/transcription/test — test STT endpoint connectivity
  app.post('/api/v1/admin/tools/transcription/test', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = getConfig(request);
    const txConfig = config.tools?.transcription;
    if (!txConfig?.baseUrl) {
      return { success: false, error: 'No endpoint URL configured' };
    }
    try {
      const res = await fetch(`${txConfig.baseUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { success: false, error: `Endpoint returned ${res.status}` };
      }
      const data = await res.json() as Record<string, unknown>;
      return {
        success: true,
        gpu: data.gpu,
        gpuName: data.gpu_name,
        modelLoaded: data.model_loaded,
        modelSize: data.model_size,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Cannot reach endpoint: ${msg}` };
    }
  });

  // GET /api/v1/admin/plugins — read plugins.json
  app.get('/api/v1/admin/plugins', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = getConfig(request);
    const stateDir = getStateDir(config);
    const plugins = loadPlugins(stateDir);
    return { plugins };
  });

  // PUT /api/v1/admin/plugins — save plugins.json (raw JSON editor)
  app.put('/api/v1/admin/plugins', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = getConfig(request);
    const { plugins: newPlugins } = request.body as { plugins?: Record<string, unknown> };

    if (!newPlugins || typeof newPlugins !== 'object') {
      return reply.code(400).send({ error: 'Missing or invalid "plugins" object' });
    }

    // Validate
    const parseResult = pluginsSchema.safeParse(newPlugins);
    if (!parseResult.success) {
      const issues = (parseResult.error as any).issues ?? (parseResult.error as any).errors ?? [];
      const firstIssue = issues[0];
      const errorPath = firstIssue?.path?.join('.') || 'unknown';
      const errorMsg = firstIssue?.message || 'Validation failed';
      return reply.code(400).send({ error: `Validation failed at "${errorPath}": ${errorMsg}` });
    }

    // Save to disk — preserve _seededDefaults from existing file
    const stateDir = getStateDir(config);
    const existing = loadPlugins(stateDir);
    const toSave = parseResult.data as any;
    if ((existing as any)._seededDefaults && !toSave._seededDefaults) {
      toSave._seededDefaults = (existing as any)._seededDefaults;
    }
    try {
      savePlugins(stateDir, toSave);
    } catch {
      return reply.code(500).send({ error: 'Failed to write plugins.json' });
    }

    // Update runtime config
    config.plugins = toSave;

    // Trigger plugin hot-reload
    if (onConfigChange) {
      try { await onConfigChange('plugins', newPlugins); } catch { /* non-fatal */ }
    }

    // Audit
    if (auditService) {
      try {
        await auditService.log({
          tenantId: getTenantId(request),
          userId: (request as any).ctx.userId,
          action: 'plugins.update',
          resource: 'plugins.json',
          details: {
            cli: (parseResult.data as any).cli?.length || 0,
            http: (parseResult.data as any).http?.length || 0,
          },
        });
      } catch { /* non-fatal */ }
    }

    return { success: true };
  });

  // PUT /api/v1/admin/config — bulk save (raw JSON editor)
  app.put('/api/v1/admin/config', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = getConfig(request);
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
    const stateDir = getStateDir(config);
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

      // Always restore original secret — secrets cannot be set via bulk save
      // (use the secrets/credentials endpoints instead)
      {
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
        await auditService.log({
          tenantId: getTenantId(request),
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
