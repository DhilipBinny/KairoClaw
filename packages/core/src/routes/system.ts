/**
 * System diagnostics and provider test routes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { GatewayConfig } from '@agw/types';
import { requireRole } from '../auth/middleware.js';
import { getModelCapabilities } from '../models/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SecretsStore } from '../secrets/store.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const startTime = Date.now();

export const registerSystemRoutes: FastifyPluginAsync<{ providerRegistry?: ProviderRegistry; secretsStore?: SecretsStore }> = async (app, opts) => {
  const providerRegistry = opts?.providerRegistry;
  const secretsStore = opts?.secretsStore;
  // GET /api/v1/admin/system — system info
  app.get('/api/v1/admin/system', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const stateDir = config._stateDir || '';
    const mem = process.memoryUsage();
    const osMem = { total: os.totalmem(), free: os.freemem() };

    return {
      uptime: process.uptime(),
      startedAt: new Date(startTime).toISOString(),
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        rssFormatted: formatBytes(mem.rss),
        heapUsedFormatted: formatBytes(mem.heapUsed),
      },
      osMemory: {
        total: osMem.total,
        free: osMem.free,
        used: osMem.total - osMem.free,
        totalFormatted: formatBytes(osMem.total),
        freeFormatted: formatBytes(osMem.free),
      },
      stateDir,
      workspace: config.agent.workspace,
      pid: process.pid,
    };
  });

  // GET /api/v1/admin/doctor — run diagnostic checks
  app.get('/api/v1/admin/doctor', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const stateDir = config._stateDir || '';
    const checks: { name: string; status: string; message: string }[] = [];

    // 1. Check Anthropic connectivity
    const anthropicKey = config.providers.anthropic?.apiKey;
    const anthropicToken = config.providers.anthropic?.authToken;
    if (anthropicKey || anthropicToken) {
      try {
        const headers: Record<string, string> = {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };
        let authLabel = 'API Key';
        if (anthropicToken) {
          headers['authorization'] = `Bearer ${anthropicToken}`;
          headers['anthropic-beta'] = 'oauth-2025-04-20';
          authLabel = 'OAuth Token';
        } else {
          headers['x-api-key'] = anthropicKey;
        }
        const resp = await fetch(
          (config.providers.anthropic.baseUrl || 'https://api.anthropic.com') + '/v1/messages',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model: config.model?.primary?.split('/').pop() || 'claude-sonnet-4-20250514',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (resp.ok || resp.status === 400) {
          checks.push({ name: 'Anthropic API', status: 'ok', message: `Connected (${authLabel})` });
        } else if (resp.status === 401) {
          checks.push({ name: 'Anthropic API', status: 'error', message: `Invalid ${authLabel} (401)` });
        } else if (resp.status === 429) {
          checks.push({ name: 'Anthropic API', status: 'warn', message: `Rate limited (429) — ${authLabel} is valid` });
        } else {
          checks.push({ name: 'Anthropic API', status: 'error', message: `HTTP ${resp.status} (${authLabel})` });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({ name: 'Anthropic API', status: 'error', message: `Connection failed: ${msg}` });
      }
    } else {
      checks.push({ name: 'Anthropic API', status: 'skip', message: 'No API key or OAuth token configured' });
    }

    // 2. Check OpenAI connectivity
    if (config.providers.openai?.apiKey) {
      try {
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${config.providers.openai.apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          checks.push({ name: 'OpenAI API', status: 'ok', message: 'Connected' });
        } else if (resp.status === 401) {
          checks.push({ name: 'OpenAI API', status: 'error', message: 'Invalid API key (401)' });
        } else {
          checks.push({ name: 'OpenAI API', status: 'error', message: `HTTP ${resp.status}` });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({ name: 'OpenAI API', status: 'error', message: `Connection failed: ${msg}` });
      }
    } else {
      checks.push({ name: 'OpenAI API', status: 'skip', message: 'No API key configured' });
    }

    // 3. Check Ollama connectivity
    try {
      const ollamaUrl = config.providers.ollama?.baseUrl || 'http://localhost:11434';
      const resp = await fetch(ollamaUrl + '/api/tags', {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { models?: { name: string }[] };
        const models = (data.models || []).map((m) => m.name);
        checks.push({
          name: 'Ollama',
          status: 'ok',
          message: `Connected — ${models.length} model(s): ${models.slice(0, 5).join(', ')}`,
        });
      } else {
        checks.push({ name: 'Ollama', status: 'error', message: `HTTP ${resp.status}` });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      checks.push({ name: 'Ollama', status: 'warn', message: `Not reachable: ${msg.split('\n')[0]}` });
    }

    // 4. Check Telegram
    if (config.channels.telegram?.enabled) {
      if (config.channels.telegram?.botToken) {
        try {
          const resp = await fetch(
            `https://api.telegram.org/bot${config.channels.telegram.botToken}/getMe`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (resp.ok) {
            const data = (await resp.json()) as { result?: { username?: string } };
            checks.push({
              name: 'Telegram Bot',
              status: 'ok',
              message: `Connected as @${data.result?.username || '?'}`,
            });
          } else {
            checks.push({ name: 'Telegram Bot', status: 'error', message: `HTTP ${resp.status} — invalid token?` });
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          checks.push({ name: 'Telegram Bot', status: 'error', message: `Connection failed: ${msg}` });
        }
      } else {
        checks.push({ name: 'Telegram Bot', status: 'error', message: 'Enabled but no bot token set' });
      }
    } else {
      checks.push({ name: 'Telegram Bot', status: 'skip', message: 'Not enabled' });
    }

    // 5. Check disk space
    try {
      const stats = fs.statfsSync(stateDir || '/tmp');
      const freeGB = (stats.bfree * stats.bsize) / 1024 ** 3;
      const totalGB = (stats.blocks * stats.bsize) / 1024 ** 3;
      const usedPct = ((1 - stats.bfree / stats.blocks) * 100).toFixed(1);
      if (freeGB < 1) {
        checks.push({
          name: 'Disk Space',
          status: 'error',
          message: `Low: ${freeGB.toFixed(2)} GB free (${usedPct}% used)`,
        });
      } else {
        checks.push({
          name: 'Disk Space',
          status: 'ok',
          message: `${freeGB.toFixed(1)} GB free of ${totalGB.toFixed(1)} GB (${usedPct}% used)`,
        });
      }
    } catch {
      checks.push({ name: 'Disk Space', status: 'skip', message: 'Could not check' });
    }

    // 6. State directory writable
    try {
      const testFile = path.join(stateDir || '/tmp', '.write-test-' + Date.now());
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      checks.push({ name: 'State Directory', status: 'ok', message: `Writable: ${stateDir}` });
    } catch {
      checks.push({ name: 'State Directory', status: 'error', message: `Not writable: ${stateDir}` });
    }

    const allOk = checks.every((c) => c.status === 'ok' || c.status === 'skip');
    const hasErrors = checks.some((c) => c.status === 'error');

    return {
      overall: hasErrors ? 'unhealthy' : allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  // POST /api/v1/admin/providers/test — test provider credentials
  app.post(
    '/api/v1/admin/providers/test',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const config = (request as any).ctx.config as GatewayConfig;
      const {
        provider,
        apiKey: reqApiKey,
        authToken: reqAuthToken,
        baseUrl,
        useExisting,
      } = request.body as {
        provider?: string;
        apiKey?: string;
        authToken?: string;
        baseUrl?: string;
        useExisting?: boolean;
      };

      if (!provider) {
        return reply.code(400).send({ error: 'Missing provider' });
      }

      const apiKey =
        reqApiKey ||
        (useExisting && provider === 'anthropic' ? config.providers.anthropic?.apiKey : null) ||
        (useExisting && provider === 'openai' ? config.providers.openai?.apiKey : null) ||
        reqApiKey;

      const authToken =
        reqAuthToken ||
        (useExisting && provider === 'anthropic' ? config.providers.anthropic?.authToken : null) ||
        reqAuthToken;

      if (provider === 'anthropic') {
        const token = authToken || apiKey;
        if (!token) return reply.code(400).send({ error: 'No key or token provided' });

        const isOAuth = token.startsWith('sk-ant-oat');
        const headers: Record<string, string> = {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };
        if (isOAuth) {
          headers['authorization'] = `Bearer ${token}`;
          headers['anthropic-beta'] = 'oauth-2025-04-20';
        } else {
          headers['x-api-key'] = token;
        }

        let models: { id: string; name: string; created?: string; capabilities?: unknown }[] = [];
        try {
          const modelsResp = await fetch(
            (baseUrl || 'https://api.anthropic.com') + '/v1/models?limit=100',
            { headers, signal: AbortSignal.timeout(10000) },
          );
          if (modelsResp.ok) {
            const data = (await modelsResp.json()) as {
              data?: { id: string; display_name?: string; created_at?: string }[];
            };
            models = (data.data || []).map((m) => ({
              id: m.id,
              name: m.display_name || m.id,
              created: m.created_at,
              capabilities: getModelCapabilities(m.id),
            }));
          }
        } catch {
          /* models listing not available */
        }

        if (models.length === 0) {
          const testResp = await fetch(
            (baseUrl || 'https://api.anthropic.com') + '/v1/messages',
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }],
              }),
              signal: AbortSignal.timeout(10000),
            },
          );
          if (testResp.status === 401) {
            return { success: false, error: 'Invalid credentials (401)' };
          }
          models = [
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
          ].map((m) => ({ ...m, capabilities: getModelCapabilities(m.id) }));
        }

        return {
          success: true,
          authType: isOAuth ? 'oauth' : 'api-key',
          models: models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
        };
      } else if (provider === 'openai') {
        if (!apiKey) return reply.code(400).send({ error: 'No API key provided' });
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          return { success: false, error: `HTTP ${resp.status} — invalid key?` };
        }
        const data = (await resp.json()) as { data?: { id: string }[] };
        const chatModels = (data.data || [])
          .filter(
            (m) =>
              m.id.includes('gpt') ||
              m.id.includes('o1') ||
              m.id.includes('o3') ||
              m.id.includes('o4'),
          )
          .map((m) => ({ id: m.id, name: m.id, capabilities: getModelCapabilities(m.id) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { success: true, models: chatModels };
      } else if (provider === 'ollama') {
        const url = baseUrl || 'http://localhost:11434';
        const resp = await fetch(url + '/api/tags', {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          return { success: false, error: `HTTP ${resp.status}` };
        }
        const data = (await resp.json()) as { models?: { name: string }[] };
        const modelList = (data.models || []).slice(0, 30);

        // Auto-discover capabilities via /api/show for each model
        const models = await Promise.all(modelList.map(async (m) => {
          const fallback = getModelCapabilities(m.name, config);
          try {
            const showResp = await fetch(url + '/api/show', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: m.name }),
              signal: AbortSignal.timeout(3000),
            });
            if (showResp.ok) {
              const info = await showResp.json() as {
                model_info?: Record<string, unknown>;
                capabilities?: string[];
              };
              const caps = info.capabilities || [];
              // Extract context_length from model_info (key varies by architecture)
              let contextWindow = fallback.contextWindow;
              if (info.model_info) {
                for (const [key, val] of Object.entries(info.model_info)) {
                  if (key.endsWith('.context_length') && typeof val === 'number') {
                    contextWindow = val;
                    break;
                  }
                }
              }
              return {
                id: m.name,
                name: m.name,
                capabilities: {
                  ...fallback,
                  contextWindow,
                  supportsVision: caps.includes('vision'),
                  supportsToolCalling: caps.includes('tools'),
                  provider: 'ollama',
                },
              };
            }
          } catch { /* fall back to registry defaults */ }
          return { id: m.name, name: m.name, capabilities: fallback };
        }));
        return { success: true, models };
      } else {
        return reply.code(400).send({ error: `Unknown provider: ${provider}` });
      }
    },
  );

  // PATCH /api/v1/admin/providers/:id/credentials — save provider secrets
  app.patch('/api/v1/admin/providers/:id/credentials', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const { id } = request.params as { id: string };
    const body = request.body as { apiKey?: string; authToken?: string; baseUrl?: string };

    const knownProviders = ['anthropic', 'openai', 'ollama'];
    if (!knownProviders.includes(id)) {
      return reply.code(400).send({ error: `Unknown provider: ${id}` });
    }

    if (!secretsStore) {
      return reply.code(500).send({ error: 'Secrets store not available' });
    }

    const namespace = `providers.${id}`;
    let changed = false;

    if (id === 'anthropic') {
      // Mutually exclusive: apiKey clears authToken and vice versa
      if (body.apiKey) {
        secretsStore.set(namespace, 'apiKey', body.apiKey);
        secretsStore.set(namespace, 'authToken', ''); // clear
        // Update process.env for backward compat — provider registry reads env as fallback after secrets store
        process.env.ANTHROPIC_API_KEY = body.apiKey;
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        changed = true;
      } else if (body.authToken) {
        secretsStore.set(namespace, 'authToken', body.authToken);
        secretsStore.set(namespace, 'apiKey', ''); // clear
        // Update process.env for backward compat — provider registry reads env as fallback after secrets store
        process.env.ANTHROPIC_AUTH_TOKEN = body.authToken;
        delete process.env.ANTHROPIC_API_KEY;
        changed = true;
      }
      if (body.baseUrl !== undefined) {
        secretsStore.set(namespace, 'baseUrl', body.baseUrl);
        if (body.baseUrl) process.env.ANTHROPIC_BASE_URL = body.baseUrl;
        else delete process.env.ANTHROPIC_BASE_URL;
        changed = true;
      }
    } else if (id === 'openai') {
      if (body.apiKey !== undefined) {
        secretsStore.set(namespace, 'apiKey', body.apiKey || '');
        if (body.apiKey) process.env.OPENAI_API_KEY = body.apiKey;
        else delete process.env.OPENAI_API_KEY;
        changed = true;
      }
    } else if (id === 'ollama') {
      if (body.baseUrl !== undefined) {
        secretsStore.set(namespace, 'baseUrl', body.baseUrl || '');
        if (body.baseUrl) process.env.OLLAMA_BASE_URL = body.baseUrl;
        else delete process.env.OLLAMA_BASE_URL;
        changed = true;
      }
    }

    if (!changed) {
      return reply.code(400).send({ error: 'No credentials provided' });
    }

    // Update in-memory config
    const cfg = config.providers;
    if (id === 'anthropic') {
      if (body.apiKey) { cfg.anthropic.apiKey = body.apiKey; cfg.anthropic.authToken = ''; }
      if (body.authToken) { cfg.anthropic.authToken = body.authToken; cfg.anthropic.apiKey = ''; }
      if (body.baseUrl !== undefined) cfg.anthropic.baseUrl = body.baseUrl;
    } else if (id === 'openai' && body.apiKey !== undefined) {
      cfg.openai.apiKey = body.apiKey;
    } else if (id === 'ollama' && body.baseUrl !== undefined) {
      cfg.ollama.baseUrl = body.baseUrl;
    }

    // Reinitialize provider registry
    if (providerRegistry) {
      providerRegistry.reinitProviders();
    }

    return { success: true };
  });

  // PATCH /api/v1/admin/channels/:id/credentials — save channel secrets (bot tokens)
  app.patch('/api/v1/admin/channels/:id/credentials', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { botToken?: string };

    if (!secretsStore) {
      return reply.code(500).send({ error: 'Secrets store not available' });
    }

    if (id === 'telegram') {
      if (!body.botToken) {
        return reply.code(400).send({ error: 'botToken is required' });
      }
      secretsStore.set('channels.telegram', 'botToken', body.botToken);
      // Also set in process.env for backward compat
      process.env.TELEGRAM_BOT_TOKEN = body.botToken;
      return { success: true };
    }

    return reply.code(400).send({ error: `Unknown channel: ${id}. Supported: telegram` });
  });

  // GET /api/v1/admin/model — current model configuration and capabilities
  app.get('/api/v1/admin/model', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const primaryRef = config.model?.primary || 'anthropic/claude-sonnet-4-20250514';
    const fallbackRef = config.model?.fallback || '';

    function resolveModelInfo(ref: string) {
      const [providerName, ...modelParts] = ref.split('/');
      const modelId = modelParts.join('/') || providerName;
      const caps = getModelCapabilities(ref, config);
      return {
        id: ref,
        provider: caps.provider !== 'unknown' ? caps.provider : providerName,
        modelId,
        capabilities: {
          contextWindow: caps.contextWindow,
          maxOutputTokens: caps.maxOutputTokens,
          supportsVision: caps.supportsVision,
          supportsToolCalling: caps.supportsToolCalling,
          supportsStreaming: caps.supportsStreaming,
          costPer1M: caps.costPer1M,
          timeoutMs: caps.timeoutMs,
        },
      };
    }

    return {
      primary: resolveModelInfo(primaryRef),
      fallback: fallbackRef ? resolveModelInfo(fallbackRef) : null,
    };
  });

  // PATCH /api/v1/admin/models/capabilities — save capability overrides for a model
  app.patch('/api/v1/admin/models/capabilities', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const stateDir = config._stateDir || '';
    const body = request.body as {
      modelId: string;
      capabilities: Partial<{
        contextWindow: number;
        maxOutputTokens: number;
        supportsVision: boolean;
        supportsToolCalling: boolean;
        supportsStreaming: boolean;
        timeoutMs: number;
        costPer1M: { input: number; output: number } | null;
        provider: string;
      }>;
    };

    if (!body.modelId || !body.capabilities) {
      return reply.code(400).send({ error: 'modelId and capabilities are required' });
    }

    // Read raw config from disk to avoid saving resolved env vars
    const configPath = path.join(stateDir, 'config.json');
    let rawConfig: Record<string, unknown>;
    try {
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return reply.code(500).send({ error: 'Failed to read config file' });
    }

    // Update models.catalog
    if (!rawConfig.models) rawConfig.models = {};
    const models = rawConfig.models as Record<string, unknown>;
    if (!models.catalog) models.catalog = {};
    const catalog = models.catalog as Record<string, Record<string, unknown>>;
    catalog[body.modelId] = { ...(catalog[body.modelId] || {}), ...body.capabilities };

    // Write back
    try {
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), { mode: 0o600 });
    } catch {
      return reply.code(500).send({ error: 'Failed to write config file' });
    }

    // Update in-memory config
    if (!config.models) (config as any).models = { catalog: {} };
    if (!config.models.catalog) config.models.catalog = {};
    config.models.catalog[body.modelId] = {
      ...(config.models.catalog[body.modelId] || {}),
      ...body.capabilities,
    };

    return { success: true, modelId: body.modelId, capabilities: catalog[body.modelId] };
  });
};
