import type { DatabaseAdapter } from './index.js';
import crypto from 'node:crypto';
import { hashApiKey } from '../auth/keys.js';

/**
 * Seed the database with default tenant and admin user.
 * Only runs if no tenants exist (first-time setup).
 * Returns the generated admin API key (printed to console on first run).
 */
export async function seedDatabase(db: DatabaseAdapter): Promise<{ apiKey?: string; isFirstRun: boolean }> {
  // Check if any tenants exist
  const existing = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM tenants');
  if (existing && existing.count > 0) {
    return { isFirstRun: false };
  }

  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const apiKey = process.env.AGW_ADMIN_KEY || ('agw_sk_' + crypto.randomBytes(32).toString('hex'));
  const apiKeyHash = hashApiKey(apiKey);

  const defaultPermissions = [
    { role: 'admin', pattern: '*', permission: 'allow' },
    { role: 'user', pattern: 'read_file', permission: 'allow' },
    { role: 'user', pattern: 'list_directory', permission: 'allow' },
    { role: 'user', pattern: 'web_fetch', permission: 'allow' },
    { role: 'user', pattern: 'web_search', permission: 'allow' },
    { role: 'user', pattern: 'inspect_image', permission: 'allow' },
    { role: 'user', pattern: 'memory_*', permission: 'allow' },
    { role: 'user', pattern: 'mcp__*', permission: 'allow' },
    { role: 'user', pattern: 'write_file', permission: 'power_user' },
    { role: 'user', pattern: 'exec', permission: 'power_user' },
    { role: 'user', pattern: 'manage_cron', permission: 'power_user' },
    { role: 'user', pattern: 'browse', permission: 'power_user' },
    { role: 'user', pattern: 'sandbox_exec', permission: 'allow' },
    { role: 'user', pattern: 'edit_file', permission: 'allow' },
    { role: 'viewer', pattern: 'read_file', permission: 'allow' },
    { role: 'viewer', pattern: 'list_directory', permission: 'allow' },
    { role: 'viewer', pattern: 'web_search', permission: 'allow' },
    { role: 'viewer', pattern: '*', permission: 'deny' },
  ];

  await db.transaction(async () => {
    await db.run(
      'INSERT INTO tenants (id, name, slug, plan) VALUES (?, ?, ?, ?)',
      [tenantId, 'Default', 'default', 'community'],
    );
    await db.run(
      'INSERT INTO users (id, tenant_id, name, role, api_key_hash) VALUES (?, ?, ?, ?, ?)',
      [userId, tenantId, 'Admin', 'admin', apiKeyHash],
    );
    for (const p of defaultPermissions) {
      await db.run(
        'INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES (?, ?, ?, ?)',
        [tenantId, p.role, p.pattern, p.permission],
      );
    }
  });

  return { apiKey, isFirstRun: true };
}
