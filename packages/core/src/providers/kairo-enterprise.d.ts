/**
 * Type declarations for the optional @bsigma-ai/kairo-enterprise package.
 *
 * This package is not a dependency of KairoClaw — it's optionally installed
 * by enterprise customers. The dynamic import in kairo-premium.ts handles
 * the case where it's not installed.
 */
declare module '@bsigma-ai/kairo-enterprise' {
  export interface EnterpriseConfig {
    authToken?: string;
    mode: 'oauth' | 'sdk';
    defaultModel?: string;
  }

  export interface EnterpriseProvider {
    name: string;
    chat(args: unknown): Promise<unknown>;
  }

  export interface TestResult {
    success: boolean;
    model?: string;
    latencyMs?: number;
    error?: string;
    note?: string;
  }

  export interface ModelInfo {
    id: string;
    displayName: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: Record<string, unknown>;
  }

  export function createProvider(config: EnterpriseConfig): EnterpriseProvider;
  export function testConnection(config: EnterpriseConfig): Promise<TestResult>;
  export function listModels(authToken: string): Promise<ModelInfo[]>;
  export function isAvailable(): boolean;
  export const VERSION: string;
}
