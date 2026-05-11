/**
 * Path security utilities — prevents directory traversal, null byte injection,
 * symlink escapes, and enforces multi-user scope isolation.
 *
 * Exact copy from packages/core/src/tools/builtin/files.ts.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolExecutionContext } from '@agw/types';
import { SCOPE_DIR_NAME } from './constants.js';

/**
 * Sanitize and resolve a file path.
 * Prevents directory traversal, null byte injection, and symlink escapes.
 */
export function safePath(p: string | undefined, baseDir: string): string {
  if (!p) return baseDir;
  if (p.includes('\0')) throw new Error('Path traversal blocked: null bytes not allowed');
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error('Path traversal blocked: control characters not allowed');

  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir, p);
  const workspace = path.resolve(baseDir);
  const allowed = [workspace, '/tmp'];

  const isAllowed = allowed.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!isAllowed) {
    throw new Error(`Path traversal blocked: "${p}" resolves outside allowed directories`);
  }

  // Verify symlinks don't escape
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realAllowed = allowed.some(root =>
        realPath === root || realPath.startsWith(root + path.sep)
      );
      if (!realAllowed) {
        throw new Error(`Path traversal blocked: symlink "${p}" resolves outside allowed directories`);
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return resolved;
}

/**
 * Scope-aware path validation for multi-user isolation.
 * - Admin: unrestricted (same as safePath)
 * - User with scopeKey: can access own scope + shared dirs, blocked from other scopes
 * - Unscoped: can access everything except scopes/{other}/
 */
export function scopedSafePath(
  p: string | undefined,
  workspace: string,
  context: ToolExecutionContext,
): string {
  const resolved = safePath(p, workspace);

  // Admin bypasses scope restrictions
  if (context.user?.role === 'admin') return resolved;

  const scopeKey = context.scopeKey;
  const scopesDir = path.join(workspace, SCOPE_DIR_NAME);

  // Check if path is within the scopes/ directory
  if (resolved.startsWith(scopesDir + path.sep) || resolved === scopesDir) {
    // Listing scopes/ root → blocked for non-admin
    if (resolved === scopesDir) {
      throw new Error('Access denied: cannot list other users\' directories');
    }

    // Inside scopes/ — extract the scope from the path
    const relToScopes = path.relative(scopesDir, resolved);
    const targetScope = relToScopes.split(path.sep)[0]; // e.g. "telegram:12345"

    // Allow only own scope
    if (scopeKey && targetScope === scopeKey) {
      return resolved;
    }

    throw new Error('Access denied: cannot access other users\' files');
  }

  // Outside scopes/ — shared global files, documents/, media/, /tmp → allowed
  return resolved;
}
