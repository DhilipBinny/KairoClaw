/**
 * Scope — per-user memory isolation.
 *
 * Each user gets their own directory under workspace/scopes/{channel:userId}/
 * with isolated memory (PROFILE.md, sessions/) and optional
 * overrides (USER.md).
 *
 * Resolution order:
 *   1. scopes/{scopeKey}/{file} — if exists, use it
 *   2. workspace/{file} — global fallback
 *
 * Global-only files (RULES.md, IDENTITY.md, SOUL.md) always resolve to
 * the workspace root, never scoped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SCOPE_DIR_NAME, GLOBAL_ONLY_FILES, SCOPED_CHANNELS, SHARED_DIR, DOCUMENTS_DIR } from '../constants.js';
import type { DatabaseAdapter } from '../db/index.js';

/**
 * Derive the scope key for per-user isolation.
 *
 * Priority:
 *   1. resolvedUserId (user UUID from DB) — one scope per user, all channels share it
 *   2. channel:senderId fallback — for unlinked senders before they get a user account
 *
 * Returns null for channels that should use global scope.
 */
export function deriveScopeKey(
  channel: string,
  userId?: string | number,
  resolvedUserId?: string,
): string | null {
  if (!userId && !resolvedUserId) return null;
  if (!SCOPED_CHANNELS.includes(channel)) return null;

  // Prefer resolved user UUID — one scope across all channels
  if (resolvedUserId) {
    const uid = resolvedUserId.trim();
    if (uid && uid !== 'system' && uid !== 'anonymous' && !/[/\\]|\.\./.test(uid)) {
      return uid;
    }
  }

  // Fallback to channel:senderId for unlinked senders
  const id = String(userId).trim();
  if (!id || id === 'system' || id === 'anonymous') return null;
  if (/[/\\]|\.\./.test(id) || /[/\\]|\.\./.test(channel)) return null;

  return `${channel}:${id}`;
}

/**
 * Derive scope key for a group chat.
 * Groups get their own memory scope: group:{channel}:{chatId}
 * Returns null for non-group or non-scoped channels.
 */
export function deriveGroupScopeKey(
  channel: string,
  chatId: string,
): string | null {
  if (!SCOPED_CHANNELS.includes(channel)) return null;
  // Sanitize chatId — remove the channel: prefix if present, block traversal
  const raw = chatId.replace(/^(telegram|whatsapp):/, '');
  if (!raw || /[/\\]|\.\./.test(raw)) return null;
  return `group_${channel}_${raw.replace(/[^a-zA-Z0-9@._-]/g, '_')}`;
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
 * On first creation, seeds a USER.md with the sender's info so
 * the agent knows who it's talking to from the very first message.
 */
export function ensureScopeDir(
  workspace: string,
  scopeKey: string,
  senderInfo?: { name?: string; channel?: string; userId?: string | number },
): void {
  const scopeDir = path.join(workspace, SCOPE_DIR_NAME, scopeKey);
  const memoryDir = path.join(scopeDir, 'memory', 'sessions');
  const sessionContextDir = path.join(scopeDir, 'memory', 'session-context');
  const docsDir = path.join(scopeDir, 'documents');
  const mediaDir = path.join(scopeDir, 'media');
  const isNew = !fs.existsSync(scopeDir);

  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(sessionContextDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });

  // Seed USER.md on first creation (skip for group scopes — groups aren't a person)
  if (isNew && senderInfo && !scopeKey.startsWith('group_')) {
    const userMd = path.join(scopeDir, 'USER.md');
    const channel = senderInfo.channel || (scopeKey.includes(':') ? scopeKey.split(':')[0] : 'web');
    const name = senderInfo.name || 'Unknown';
    const userId = senderInfo.userId || (scopeKey.includes(':') ? scopeKey.split(':')[1] : scopeKey);

    const content = `# User Profile\n\n` +
      `- **Name**: ${name}\n` +
      `- **Channel**: ${channel}\n` +
      `- **ID**: ${userId}\n` +
      `- **First seen**: ${new Date().toISOString().split('T')[0]}\n\n` +
      `_This is a new user. Learn their preferences as you chat._\n`;

    fs.writeFileSync(userMd, content, 'utf8');
  }
}

/**
 * Migrate old channel-based scopes (telegram:123, whatsapp:456) to user UUID scopes.
 * For each sender_link in DB, if old scope dir exists, merge into user UUID scope.
 * Merges memory files (keeps newest), then removes old dir.
 * Safe to run multiple times — skips already-migrated dirs.
 */
export async function migrateScopesToUserUUID(
  workspace: string,
  db: DatabaseAdapter,
): Promise<{ migrated: number; skipped: number }> {
  const scopesDir = path.join(workspace, SCOPE_DIR_NAME);
  if (!fs.existsSync(scopesDir)) return { migrated: 0, skipped: 0 };

  // Get all sender_links to know which channel:sender maps to which user
  const links = await db.query<{ channel_type: string; sender_id: string; user_id: string }>(
    'SELECT channel_type, sender_id, user_id FROM sender_links',
  );

  let migrated = 0;
  let skipped = 0;

  for (const link of links) {
    const oldKey = `${link.channel_type}:${link.sender_id}`;
    const newKey = link.user_id;
    const oldDir = path.join(scopesDir, oldKey);
    const newDir = path.join(scopesDir, newKey);

    // Skip if old dir doesn't exist (already migrated or never created)
    if (!fs.existsSync(oldDir)) { skipped++; continue; }

    // Skip if old and new are the same (shouldn't happen)
    if (oldKey === newKey) { skipped++; continue; }

    // Create new scope dir
    fs.mkdirSync(path.join(newDir, 'memory', 'sessions'), { recursive: true });

    // Merge files: copy from old to new, newer file wins
    mergeDir(oldDir, newDir);

    // Remove old dir
    fs.rmSync(oldDir, { recursive: true, force: true });
    migrated++;
  }

  return { migrated, skipped };
}

/** Recursively merge srcDir into destDir. Newer files win on conflict. */
function mergeDir(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      mergeDir(srcPath, destPath);
    } else {
      // If dest exists: session files always merge, other files newer-wins
      if (fs.existsSync(destPath)) {
        const isSessionFile = /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name);
        if (isSessionFile) {
          // Session files (daily notes): append unique content from src
          const srcContent = fs.readFileSync(srcPath, 'utf8').trim();
          const destContent = fs.readFileSync(destPath, 'utf8');
          if (srcContent && !destContent.includes(srcContent)) {
            fs.appendFileSync(destPath, '\n\n' + srcContent);
          }
        } else {
          // Non-session files (PROFILE.md, USER.md): keep newer
          const srcStat = fs.statSync(srcPath);
          const destStat = fs.statSync(destPath);
          if (srcStat.mtimeMs > destStat.mtimeMs) {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Migrate old workspace/documents/ and workspace/media/ to workspace/shared/.
 * One-time on startup. Safe to run repeatedly (skips if shared/ already exists).
 */
export function migrateToSharedDir(workspace: string): { migrated: boolean } {
  const sharedDir = path.join(workspace, SHARED_DIR);
  const sharedDocs = path.join(sharedDir, DOCUMENTS_DIR);
  const sharedMedia = path.join(sharedDir, 'media');
  const oldDocs = path.join(workspace, DOCUMENTS_DIR);
  const oldMedia = path.join(workspace, 'media');

  // Skip if shared/ already has documents (already migrated)
  if (fs.existsSync(sharedDocs) && fs.readdirSync(sharedDocs).length > 0) {
    return { migrated: false };
  }

  let migrated = false;

  // Move documents/ → shared/documents/
  if (fs.existsSync(oldDocs) && fs.readdirSync(oldDocs).length > 0) {
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.renameSync(oldDocs, sharedDocs);
    migrated = true;
  }

  // Move media/ → shared/media/
  if (fs.existsSync(oldMedia) && fs.readdirSync(oldMedia).length > 0) {
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.renameSync(oldMedia, sharedMedia);
    migrated = true;
  }

  // Ensure shared dirs exist even if nothing to migrate
  fs.mkdirSync(sharedDocs, { recursive: true });
  fs.mkdirSync(sharedMedia, { recursive: true });

  return { migrated };
}
