/**
 * Shared utilities for route handlers.
 */

/**
 * Set a nested property on an object by dot-separated path.
 * e.g. setNestedPath(obj, "model.primary", "claude-sonnet-4-6")
 */
export function setNestedPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  const dangerous = ['__proto__', 'constructor', 'prototype'];
  if (parts.some((p) => dangerous.includes(p))) {
    throw new Error(`Invalid path: "${dotPath}"`);
  }
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
