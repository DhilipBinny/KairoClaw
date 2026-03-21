/**
 * Scope — per-user memory isolation.
 *
 * Each user gets their own directory under workspace/scopes/{channel:userId}/
 * with isolated memory (PROFILE.md, sessions/) and optional personality
 * overrides (SOUL.md, USER.md).
 *
 * Resolution order:
 *   1. scopes/{scopeKey}/{file} — if exists, use it
 *   2. workspace/{file} — global fallback
 *
 * Global-only files (RULES.md, IDENTITY.md, TOOLS.md) always resolve to
 * the workspace root, never scoped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SCOPE_DIR_NAME, GLOBAL_ONLY_FILES, SCOPED_CHANNELS } from '../constants.js';

/**
 * Derive the scope key from channel + userId.
 * Returns null for channels that should use global scope.
 */
export function deriveScopeKey(
  channel: string,
  userId?: string | number,
): string | null {
  if (!userId) return null;
  if (!SCOPED_CHANNELS.includes(channel)) return null;

  const id = String(userId).trim();
  if (!id || id === 'system' || id === 'anonymous') return null;

  return `${channel}:${id}`;
}

/**
 * Resolve a workspace file with scope cascading.
 *
 * - Global-only files: always workspace/{file}
 * - Cascading files: scopes/{key}/{file} if exists, else workspace/{file}
 */
export function resolveScopedFile(
  workspace: string,
  filename: string,
  scopeKey: string | null,
): string {
  // Global-only files never cascade
  if (GLOBAL_ONLY_FILES.includes(filename)) {
    return path.join(workspace, filename);
  }

  // No scope — use global
  if (!scopeKey) {
    return path.join(workspace, filename);
  }

  // Check for scoped override
  const scopedPath = path.join(workspace, SCOPE_DIR_NAME, scopeKey, filename);
  if (fs.existsSync(scopedPath)) {
    return scopedPath;
  }

  // Fallback to global
  return path.join(workspace, filename);
}

/**
 * Get the memory directory for a scope.
 * Memory is always isolated — no fallback to global when scoped.
 */
export function getScopedMemoryDir(
  workspace: string,
  scopeKey: string | null,
): string {
  if (!scopeKey) {
    return path.join(workspace, 'memory');
  }
  return path.join(workspace, SCOPE_DIR_NAME, scopeKey, 'memory');
}

/**
 * Ensure the scope directory structure exists.
 * Called on first message from a new user.
 */
export function ensureScopeDir(
  workspace: string,
  scopeKey: string,
): void {
  const memoryDir = path.join(workspace, SCOPE_DIR_NAME, scopeKey, 'memory', 'sessions');
  fs.mkdirSync(memoryDir, { recursive: true });
}
