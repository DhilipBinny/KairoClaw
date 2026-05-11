import { ProviderRegistry as BaseProviderRegistry } from '@agw/provider-bridge';
import type { GatewayConfig } from '@agw/types';
import { createKairoPremiumProvider, isKairoPremiumAvailable } from './kairo-premium.js';
import { createModuleLogger } from '../observability/logger.js';
import type { SecretsStore } from '../secrets/store.js';

export type { ProviderInfo } from '@agw/provider-bridge';

const log = createModuleLogger('llm');

export class ProviderRegistry extends BaseProviderRegistry {
  private _secretsStore?: SecretsStore;
  private _config: GatewayConfig;

  constructor(config: GatewayConfig) {
    super(config, log);
    this._config = config;
  }

  setSecretsStore(store: SecretsStore): void {
    this._secretsStore = store;
    this.setSecretsResolver(store);
    this.setCustomProviderInit(async (registry) => {
      const cfg = this._config.providers;
      if (cfg.kairoPremium?.enabled === true && await isKairoPremiumAvailable()) {
        const authToken = this._secretsStore?.get('kairo.providers.anthropic', 'authToken') || '';
        const premium = await createKairoPremiumProvider(this._config, authToken);
        if (premium) {
          registry.addProvider('kairo-premium', premium);
        }
      }
    });
  }
}
