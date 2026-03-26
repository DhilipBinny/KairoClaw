/**
 * Resolve the correct media directory for a given sender.
 * If the sender is linked to a user, saves to their scope's media/.
 * Otherwise saves to shared/media/.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/index.js';
import { SCOPE_DIR_NAME, SHARED_DIR } from '../constants.js';

/**
 * Get the media directory for a channel sender.
 * Looks up sender_links to find the user UUID → scopes/{uuid}/media/
 * Falls back to shared/media/ if no link found.
 */
export async function getScopedMediaDir(
  workspace: string,
  channel: string,
  senderId: string,
  db?: DatabaseAdapter,
  tenantId = 'default',
): Promise<string> {
  // Try to resolve user UUID from sender_links
  if (db) {
    try {
      const link = await db.get<{ user_id: string }>(
        'SELECT user_id FROM sender_links WHERE tenant_id = ? AND channel_type = ? AND sender_id = ?',
        [tenantId, channel, senderId],
      );
      if (link) {
        const dir = path.join(workspace, SCOPE_DIR_NAME, link.user_id, 'media');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch { /* fall through to shared */ }
  }

  // No link found — use shared/media/
  const dir = path.join(workspace, SHARED_DIR, 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
