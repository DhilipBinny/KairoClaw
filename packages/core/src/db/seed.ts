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

  // Create default tenant
  const tenantId = crypto.randomUUID();
  await db.run(
    'INSERT INTO tenants (id, name, slug, plan) VALUES (?, ?, ?, ?)',
    [tenantId, 'Default', 'default', 'community']
  );

  // Create admin user — use AGW_ADMIN_KEY env var if set, otherwise generate one
  const userId = crypto.randomUUID();
  const apiKey = process.env.AGW_ADMIN_KEY || ('agw_sk_' + crypto.randomBytes(32).toString('hex'));
  const apiKeyHash = hashApiKey(apiKey);

  await db.run(
    'INSERT INTO users (id, tenant_id, name, role, api_key_hash) VALUES (?, ?, ?, ?, ?)',
    [userId, tenantId, 'Admin', 'admin', apiKeyHash]
  );

  // Insert default tool permissions
  const defaultPermissions = [
    // Admin can do everything
    { role: 'admin', pattern: '*', permission: 'allow' },
    // Users can read, search, analyze
    { role: 'user', pattern: 'read_file', permission: 'allow' },
    { role: 'user', pattern: 'list_directory', permission: 'allow' },
    { role: 'user', pattern: 'web_fetch', permission: 'allow' },
    { role: 'user', pattern: 'web_search', permission: 'allow' },
    { role: 'user', pattern: 'inspect_image', permission: 'allow' },
    { role: 'user', pattern: 'memory_*', permission: 'allow' },
    { role: 'user', pattern: 'mcp__*', permission: 'allow' },
    // Users need confirmation for write ops
    { role: 'user', pattern: 'write_file', permission: 'confirm' },
    { role: 'user', pattern: 'edit_file', permission: 'confirm' },
    { role: 'user', pattern: 'exec', permission: 'confirm' },
    // Viewers are read-only
    { role: 'viewer', pattern: 'read_file', permission: 'allow' },
    { role: 'viewer', pattern: 'list_directory', permission: 'allow' },
    { role: 'viewer', pattern: 'web_search', permission: 'allow' },
    { role: 'viewer', pattern: '*', permission: 'deny' },
  ];

  for (const p of defaultPermissions) {
    await db.run(
      'INSERT INTO tool_permissions (tenant_id, role, tool_pattern, permission) VALUES (?, ?, ?, ?)',
      [tenantId, p.role, p.pattern, p.permission]
    );
  }

  return { apiKey, isFirstRun: true };
}
