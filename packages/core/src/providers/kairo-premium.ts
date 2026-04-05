/**
 * Kairo Premium Provider — enterprise auth via @dhilipbinny/kairo-enterprise package.
 *
 * This provider wraps the optional @dhilipbinny/kairo-enterprise npm package which
 * provides proprietary authentication (OAuth subscription auth, Claude CLI proxy).
 *
 * If the package is not installed, this provider is not registered —
 * KairoClaw falls back to standard API key auth.
 */

import type { ProviderInterface, ProviderResponse, ChatArgs } from './types.js';
import type { GatewayConfig } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

/** Minimal type for the @dhilipbinny/kairo-enterprise module exports we use. */
interface KairoEnterprise {
  createProvider(config: {
    licenseKey: string;
    authToken?: string;
    mode: 'oauth' | 'sdk';
    defaultModel?: string;
  }): { name: string; chat(args: unknown): Promise<unknown> };
  testConnection(config: {
    licenseKey: string;
    authToken?: string;
    mode: 'oauth' | 'sdk';
  }): Promise<{ success: boolean; model?: string; latencyMs?: number; error?: string; note?: string }>;
  validateLicense(key: string): boolean;
  listModels(authToken: string): Promise<{ id: string; displayName: string }[]>;
  isAvailable(): boolean;
  VERSION: string;
}

/**
 * Cached load promise — ensures only one dynamic import runs even with concurrent callers.
 * undefined = not yet attempted, Promise = in progress or done.
 */
let loadPromise: Promise<KairoEnterprise | null> | undefined;

/**
 * Try to load @dhilipbinny/kairo-enterprise. Returns the module or null.
 * Concurrent callers share the same promise (no duplicate imports).
 */
function loadEnterprise(): Promise<KairoEnterprise | null> {
  if (loadPromise !== undefined) return loadPromise;

  loadPromise = import('@dhilipbinny/kairo-enterprise')
    .then((mod) => {
      const enterprise = mod as unknown as KairoEnterprise;
      log.info({ version: enterprise.VERSION }, 'Kairo Enterprise module loaded');
      return enterprise;
    })
    .catch(() => {
      return null;
    });

  return loadPromise;
}

/** Check if Kairo Enterprise package is available. */
export async function isKairoPremiumAvailable(): Promise<boolean> {
  const mod = await loadEnterprise();
  return mod !== null;
}

/** List available models via enterprise package. */
export async function listKairoPremiumModels(authToken: string): Promise<{ id: string; displayName: string }[]> {
  const mod = await loadEnterprise();
  if (!mod) return [];
  try {
    return await mod.listModels(authToken);
  } catch {
    return [];
  }
}

/** Test the enterprise provider connection. */
export async function testKairoPremiumConnection(config: {
  licenseKey: string;
  authToken?: string;
  mode: 'oauth' | 'sdk';
}): Promise<{ success: boolean; model?: string; latencyMs?: number; error?: string; note?: string }> {
  const mod = await loadEnterprise();
  if (!mod) return { success: false, error: 'Kairo Enterprise package not installed' };
  return mod.testConnection(config);
}

/**
 * Kairo Premium LLM Provider.
 *
 * Delegates to the @dhilipbinny/kairo-enterprise package for actual API calls.
 * The enterprise package handles OAuth headers, CLI proxy, streaming, etc.
 */
export class KairoPremiumProvider implements ProviderInterface {
  name = 'kairo-premium';
  defaultModel: string;
  private innerProvider: { name: string; chat(args: unknown): Promise<unknown> };

  constructor(
    enterprise: KairoEnterprise,
    config: GatewayConfig,
    licenseKey: string,
    authToken = '',
  ) {
    const mode = (config.providers?.kairoPremium?.mode as 'oauth' | 'sdk') || 'oauth';
    this.defaultModel = config.providers?.kairoPremium?.defaultModel || config.model?.primary || 'sonnet';

    this.innerProvider = enterprise.createProvider({
      licenseKey,
      authToken,
      mode,
      defaultModel: this.defaultModel,
    });

    log.info({ mode, model: this.defaultModel }, 'Kairo Premium provider initialized');
  }

  async chat(args: ChatArgs): Promise<ProviderResponse> {
    return this.innerProvider.chat(args) as Promise<ProviderResponse>;
  }
}

/**
 * Factory: create a KairoPremiumProvider if the enterprise package is available.
 * Returns null if the package is not installed or license is invalid.
 */
export async function createKairoPremiumProvider(
  config: GatewayConfig,
  licenseKey: string,
  authToken: string,
): Promise<KairoPremiumProvider | null> {
  const enterprise = await loadEnterprise();
  if (!enterprise) return null;

  if (!enterprise.validateLicense(licenseKey)) {
    log.warn('Kairo Premium: invalid license key');
    return null;
  }

  try {
    return new KairoPremiumProvider(enterprise, config, licenseKey, authToken);
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'Kairo Premium provider failed to initialize');
    return null;
  }
}
