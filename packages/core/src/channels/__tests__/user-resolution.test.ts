/**
 * User resolution + group detection tests.
 * Tests the logic from index.ts createRunner without starting the full server.
 * Verifies: sender→user resolution, group detection, context assignment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../db/__tests__/test-db.js';
import { UserRepository } from '../../db/repositories/user.js';
import { SenderLinkRepository } from '../../db/repositories/sender-link.js';
import { deriveScopeKey, deriveGroupScopeKey } from '../../agent/scope.js';
import { hashApiKey } from '../../auth/keys.js';

let db: TestDb;
const TENANT = 'test-tenant';

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

/**
 * Replicate the user resolution logic from index.ts createRunner.
 * This is the critical multi-user flow that determines:
 * - Which user is messaging
 * - What role/permissions they get
 * - What scope they're in
 */
async function resolveUserContext(inbound: {
  channel: string;
  chatId: string;
  userId?: string;
}) {
  const senderLinkRepo = new SenderLinkRepository(db as any);

  // Step 1: Try direct user lookup (web/API)
  let resolvedUser: { id: string; role: string; elevated: number; active: number } | undefined;
  if (inbound.userId) {
    resolvedUser = await db.get<{ id: string; role: string; elevated: number; active: number }>(
      'SELECT id, role, elevated, active FROM users WHERE id = ? AND active = 1',
      [String(inbound.userId)],
    );
  }

  // Step 2: Sender links lookup (Telegram/WhatsApp)
  if (!resolvedUser && inbound.userId && inbound.channel !== 'web' && inbound.channel !== 'api') {
    const link = await senderLinkRepo.findByChannelSender(TENANT, inbound.channel, String(inbound.userId));
    if (link) {
      resolvedUser = await db.get<{ id: string; role: string; elevated: number; active: number }>(
        'SELECT id, role, elevated, active FROM users WHERE id = ? AND active = 1',
        [link.user_id],
      );
    }
  }

  // Step 3: Group detection
  const chatIdStr = String(inbound.chatId);
  const isGroupChat = chatIdStr.startsWith('telegram:-') || chatIdStr.includes('@g.us');

  // Step 4: User context assignment
  const user = resolvedUser
    ? { id: resolvedUser.id, role: resolvedUser.role, elevated: !!resolvedUser.elevated }
    : (['cron', 'internal', 'heartbeat'].includes(inbound.channel)
      ? { id: 'system', role: 'admin', elevated: true }
      : { id: 'anonymous', role: 'user', elevated: false });

  // Step 5: Scope key
  const scopeKey = isGroupChat
    ? deriveGroupScopeKey(inbound.channel, chatIdStr)
    : deriveScopeKey(inbound.channel, inbound.userId, resolvedUser?.id);

  // Step 6: Session user_id (null for groups)
  const validUserId = isGroupChat ? undefined : resolvedUser?.id;

  return { user, scopeKey, validUserId, isGroupChat };
}

describe('User resolution', () => {
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    const userRepo = new UserRepository(db as any);
    const admin = await userRepo.create({ tenantId: TENANT, name: 'Admin', role: 'admin', apiKeyHash: hashApiKey('admin-key') });
    adminId = admin.id;
    const user = await userRepo.create({ tenantId: TENANT, name: 'Sruthi', role: 'user', apiKeyHash: hashApiKey('user-key') });
    userId = user.id;

    // Link Sruthi to WhatsApp
    const linkRepo = new SenderLinkRepository(db as any);
    await linkRepo.link({ tenantId: TENANT, channelType: 'whatsapp', senderId: '6580961895', userId: user.id });
    // Link Admin to Telegram
    await linkRepo.link({ tenantId: TENANT, channelType: 'telegram', senderId: '8606526093', userId: admin.id });
  });

  // Linked user via WhatsApp
  it('resolves linked WhatsApp user', async () => {
    const ctx = await resolveUserContext({ channel: 'whatsapp', chatId: 'whatsapp:6580961895@s.whatsapp.net', userId: '6580961895' });
    expect(ctx.user.id).toBe(userId);
    expect(ctx.user.role).toBe('user');
    expect(ctx.scopeKey).toBe(userId); // UUID scope
    expect(ctx.validUserId).toBe(userId);
  });

  // Linked admin via Telegram
  it('resolves linked Telegram admin', async () => {
    const ctx = await resolveUserContext({ channel: 'telegram', chatId: 'telegram:8606526093', userId: '8606526093' });
    expect(ctx.user.id).toBe(adminId);
    expect(ctx.user.role).toBe('admin');
    expect(ctx.scopeKey).toBe(adminId);
  });

  // Web user with UUID
  it('resolves web user by UUID', async () => {
    const ctx = await resolveUserContext({ channel: 'web', chatId: 'web:main', userId: userId });
    expect(ctx.user.id).toBe(userId);
    expect(ctx.user.role).toBe('user');
  });

  // Unlinked sender
  it('unlinked sender gets anonymous user role', async () => {
    const ctx = await resolveUserContext({ channel: 'telegram', chatId: 'telegram:9999999', userId: '9999999' });
    expect(ctx.user.id).toBe('anonymous');
    expect(ctx.user.role).toBe('user');
    expect(ctx.user.elevated).toBe(false);
    expect(ctx.scopeKey).toBe('telegram:9999999'); // channel:sender fallback
  });

  // Cron gets admin
  it('cron gets admin context', async () => {
    const ctx = await resolveUserContext({ channel: 'cron', chatId: 'cron:job-1', userId: 'system' });
    expect(ctx.user.role).toBe('admin');
    expect(ctx.user.elevated).toBe(true);
    expect(ctx.scopeKey).toBeNull(); // cron not scoped
  });

  // Group — individual sender resolved but session not owned
  it('group message: resolved sender but validUserId is null', async () => {
    const ctx = await resolveUserContext({ channel: 'telegram', chatId: 'telegram:-1003319503773', userId: '8606526093' });
    expect(ctx.isGroupChat).toBe(true);
    expect(ctx.user.id).toBe(adminId); // sender is admin
    expect(ctx.user.role).toBe('admin');
    expect(ctx.validUserId).toBeUndefined(); // group session NOT owned
    expect(ctx.scopeKey).toMatch(/^group_telegram_/); // group scope
  });

  // Group — unlinked sender
  it('group message from unlinked sender: restricted', async () => {
    const ctx = await resolveUserContext({ channel: 'telegram', chatId: 'telegram:-1003319503773', userId: '9999999' });
    expect(ctx.isGroupChat).toBe(true);
    expect(ctx.user.role).toBe('user'); // restricted, not admin
    expect(ctx.validUserId).toBeUndefined();
  });

  // WhatsApp group
  it('whatsapp group detected correctly', async () => {
    const ctx = await resolveUserContext({ channel: 'whatsapp', chatId: 'whatsapp:120363408838097788@g.us', userId: '6580961895' });
    expect(ctx.isGroupChat).toBe(true);
    expect(ctx.scopeKey).toMatch(/^group_whatsapp_/);
    expect(ctx.validUserId).toBeUndefined();
  });

  // Deactivated user
  it('deactivated user not resolved', async () => {
    const userRepo = new UserRepository(db as any);
    await userRepo.deactivate(userId, TENANT);
    const ctx = await resolveUserContext({ channel: 'whatsapp', chatId: 'whatsapp:6580961895@s.whatsapp.net', userId: '6580961895' });
    expect(ctx.user.id).toBe('anonymous'); // falls to unlinked
    expect(ctx.user.role).toBe('user');
  });
});
