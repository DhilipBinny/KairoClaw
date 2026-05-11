/**
 * Injectable interfaces for @agw/plugins.
 * Each matches the exact API surface used by plugin files.
 */

import type { ToolRegistration } from '@agw/tool-platform';

/** Subset of ToolRegistry used by plugin registration. */
export interface PluginToolRegistry {
  register(tool: ToolRegistration): void;
  unregister(name: string): void;
}

/** Subset of SecretsStore used by HTTP plugins for auth token resolution. */
export interface PluginSecretsResolver {
  get(namespace: string, key: string): string | undefined;
}

/**
 * Subset of MediaStore used by HTTP plugins for saving response media.
 * Matches the exact methods/properties accessed in http.ts.
 */
export interface PluginMediaStore {
  /** Base directory where media files are stored. */
  dir: string;
  /** Save a Buffer to a file, returns the filename. */
  save(buffer: Buffer, ext: string): string;
  /** Save a base64 string to a file, returns the filename. */
  saveBase64(base64: string, ext: string): string;
  /** Get the URL path for a saved media file. */
  getUrl(filename: string): string;
}
