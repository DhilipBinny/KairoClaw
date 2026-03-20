import type { ProviderInterface, ProviderResponse, ChatArgs } from '@agw/types';

export type { ProviderInterface, ProviderResponse, ChatArgs };

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  authToken?: string;
  defaultModel: string;
  timeoutMs?: number;
}
