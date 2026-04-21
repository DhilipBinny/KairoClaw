/**
 * Auto-fetch model capabilities from provider APIs and persist to config.
 *
 * Called on: startup, provider reinit, manual refresh button.
 * Preserves entries with source: "manual" (admin edits).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GatewayConfig, ModelCapabilities } from '@agw/types';
import type { SecretsStore } from '../secrets/store.js';
import { parseAnthropicModels, parseOllamaModel, mergeCapabilities } from './registry.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('system');

/** Lock to prevent concurrent refreshes from corrupting config. */
let refreshInProgress: Promise<RefreshResult> | null = null;

interface RefreshResult {
  fetched: number;
  providers: string[];
}

/**
 * Fetch model capabilities from all configured providers and write to config.
 * Concurrent calls are serialized — if a refresh is already running, callers
 * wait for it to finish and share its result.
 */
export function refreshModelCapabilities(
  config: GatewayConfig,
  secretsStore?: SecretsStore,
): Promise<RefreshResult> {
  // Serialize concurrent calls — share the same promise
  if (refreshInProgress) return refreshInProgress;
  refreshInProgress = doRefresh(config, secretsStore).finally(() => { refreshInProgress = null; });
  return refreshInProgress;
}

async function doRefresh(
  config: GatewayConfig,
  secretsStore?: SecretsStore,
): Promise<RefreshResult> {
  const stateDir = config._stateDir;
  if (!stateDir) return { fetched: 0, providers: [] };

  const existing = config.models?.capabilities || {};
  let allFetched: Record<string, Partial<ModelCapabilities>> = {};
  const providers: string[] = [];

  // 1. Anthropic (API key)
  const anthropicKey = secretsStore?.get('providers.anthropic', 'apiKey')
    || config.providers?.anthropic?.apiKey;
  if (anthropicKey && !anthropicKey.startsWith('${')) {
    try {
      const baseUrl = config.providers?.anthropic?.baseUrl || 'https://api.anthropic.com';
      const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': anthropicKey };
      let allModels: Array<Record<string, unknown>> = [];
      let afterId: string | undefined;

      // Paginate through all models
      do {
        const url = `${baseUrl}/v1/models?limit=100${afterId ? `&after_id=${afterId}` : ''}`;
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!resp.ok) break;
        const page = await resp.json() as { data?: Array<Record<string, unknown>>; has_more?: boolean; last_id?: string };
        allModels.push(...(page.data || []));
        afterId = page.has_more ? page.last_id as string : undefined;
      } while (afterId);

      if (allModels.length > 0) {
        const parsed = parseAnthropicModels({ data: allModels });
        allFetched = { ...allFetched, ...parsed };
        providers.push('anthropic');
        log.info({ count: Object.keys(parsed).length }, 'Fetched Anthropic model capabilities');
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'Failed to fetch Anthropic models');
    }
  }

  // 2. Kairo Premium (OAuth — uses same Anthropic models API)
  if (config.providers?.kairoPremium?.enabled) {
    const kAuthToken = secretsStore?.get('kairo.providers.anthropic', 'authToken') || '';
    if (kAuthToken) {
      try {
        const { listKairoPremiumModels } = await import('../providers/kairo-premium.js');
        const models = await listKairoPremiumModels(kAuthToken);
        for (const m of models) {
          // Only add if not already fetched from Anthropic API key path
          if (!allFetched[m.id]) {
            allFetched[m.id] = {
              displayName: m.displayName,
              provider: 'anthropic',
              source: 'auto' as const,
            };
          }
        }
        if (models.length > 0) providers.push('kairo-premium');
        log.info({ count: models.length }, 'Fetched Kairo Premium model list');
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'Failed to fetch Kairo Premium models');
      }
    }
  }

  // 3. Ollama
  const ollamaUrl = secretsStore?.get('providers.ollama', 'baseUrl')
    || config.providers?.ollama?.baseUrl;
  if (ollamaUrl && !ollamaUrl.startsWith('${')) {
    try {
      const tagsResp = await fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(5000) });
      if (tagsResp.ok) {
        const tagsData = await tagsResp.json() as { models?: Array<{ name: string }> };
        const modelNames = (tagsData.models || []).map(m => m.name);

        for (const name of modelNames) {
          try {
            const showResp = await fetch(ollamaUrl + '/api/show', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
              signal: AbortSignal.timeout(5000),
            });
            if (showResp.ok) {
              const showData = await showResp.json() as Record<string, unknown>;
              allFetched[name] = parseOllamaModel(name, showData);
            }
          } catch {
            // Individual model fetch failure — skip
          }
        }
        if (modelNames.length > 0) providers.push('ollama');
        log.info({ count: modelNames.length }, 'Fetched Ollama model capabilities');
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'Failed to fetch Ollama models');
    }
  }

  // 4. OpenAI (API returns no capabilities — just register model IDs)
  const openaiKey = secretsStore?.get('providers.openai', 'apiKey')
    || config.providers?.openai?.apiKey;
  if (openaiKey && !openaiKey.startsWith('${')) {
    try {
      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${openaiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json() as { data?: Array<{ id: string }> };
        const chatModels = (data.data || [])
          .filter(m =>
            m.id.startsWith('gpt-') || m.id.startsWith('o1') ||
            m.id.startsWith('o3') || m.id.startsWith('o4'),
          );
        for (const m of chatModels) {
          if (!allFetched[m.id]) {
            allFetched[m.id] = {
              provider: 'openai',
              displayName: m.id,
              supportsVision: true,
              supportsToolCalling: true,
              supportsStreaming: true,
              source: 'auto' as const,
            };
          }
        }
        if (chatModels.length > 0) providers.push('openai');
        log.info({ count: chatModels.length }, 'Fetched OpenAI model list');
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'Failed to fetch OpenAI models');
    }
  }

  if (Object.keys(allFetched).length === 0) {
    return { fetched: 0, providers };
  }

  // Merge with existing (preserves manual entries)
  const merged = mergeCapabilities(existing, allFetched);

  // Write to config.json
  try {
    const configPath = path.join(stateDir, 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!raw.models) raw.models = {};
      raw.models.capabilities = merged;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'Failed to persist model capabilities to config');
  }

  // Update in-memory config
  if (!config.models) (config as unknown as Record<string, unknown>).models = { capabilities: {} };
  config.models.capabilities = merged;

  log.info({ total: Object.keys(merged).length, fetched: Object.keys(allFetched).length, providers }, 'Model capabilities refreshed');

  return { fetched: Object.keys(allFetched).length, providers };
}
