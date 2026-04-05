/**
 * Type declarations for the optional @dhilipbinny/kairo-enterprise package.
 *
 * This package is not a dependency of KairoClaw — it's optionally installed
 * by enterprise customers. The dynamic import in kairo-premium.ts handles
 * the case where it's not installed.
 */
declare module '@dhilipbinny/kairo-enterprise' {
  export interface EnterpriseConfig {
    licenseKey: string;
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

  export function createProvider(config: EnterpriseConfig): EnterpriseProvider;
  export function testConnection(config: EnterpriseConfig): Promise<TestResult>;
  export function validateLicense(key: string): boolean;
  export function isAvailable(): boolean;
  export const VERSION: string;

  export interface ModelInfo {
    id: string;
    displayName: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: Record<string, unknown>;
  }
  export function listModels(authToken: string): Promise<ModelInfo[]>;
}
