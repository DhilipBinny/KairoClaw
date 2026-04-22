import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';
import { UserRepository } from '../repositories/user.js';
import { SenderLinkRepository } from '../repositories/sender-link.js';
import { CronJobRepository } from '../repositories/cron-job.js';
import { ToolPermissionRepository } from '../repositories/tool-permission.js';
// import crypto from 'node:crypto';

let db: TestDb;
const TENANT = 'test-tenant';

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ── User Repository ──────────────────────────────────────

describe('UserRepository', () => {
  let repo: UserRepository;

  beforeEach(() => {
    repo = new UserRepository(db as any);
  });

  it('creates a user', async () => {
    const user = await repo.create({
      tenantId: TENANT,
      name: 'Alice',
      email: 'alice@test.com',
      role: 'user',
      apiKeyHash: 'hash123',
    });
    expect(user.name).toBe('Alice');
    expect(user.role).toBe('user');
    expect(user.id).toBeDefined();
  });

  it('lists users by tenant', async () => {
    // Seed a second tenant for isolation test
    await db.run(`INSERT INTO tenants (id, name, slug) VALUES ('other-tenant', 'Other', 'other')`);
    await repo.create({ tenantId: TENANT, name: 'A', apiKeyHash: 'h1' });
    await repo.create({ tenantId: TENANT, name: 'B', apiKeyHash: 'h2' });
    await repo.create({ tenantId: 'other-tenant', name: 'C', apiKeyHash: 'h3' });
    const users = await repo.listByTenant(TENANT);
    expect(users.length).toBe(2);
  });

  it('updates user with tenant scoping', async () => {
    const user = await repo.create({ tenantId: TENANT, name: 'Old', apiKeyHash: 'h' });
    await repo.update(user.id, TENANT, { name: 'New', elevated: 1 });
    const updated = await repo.getById(user.id, TENANT);
    expect(updated!.name).toBe('New');
    expect(updated!.elevated).toBe(1);
  });

  it('update does not affect other tenant', async () => {
    const user = await repo.create({ tenantId: TENANT, name: 'Alice', apiKeyHash: 'h' });
    await repo.update(user.id, 'wrong-tenant', { name: 'Hacked' });
    const unchanged = await repo.getById(user.id, TENANT);
    expect(unchanged!.name).toBe('Alice');
  });

  it('deactivates and reactivates', async () => {
    const user = await repo.create({ tenantId: TENANT, name: 'Bob', apiKeyHash: 'h' });
    await repo.deactivate(user.id, TENANT);
    let u = await repo.getById(user.id, TENANT);
    expect(u!.active).toBe(0);
    expect(u!.deactivated_at).toBeDefined();

    await repo.reactivate(user.id, TENANT);
    u = await repo.getById(user.id, TENANT);
    expect(u!.active).toBe(1);
    expect(u!.deactivated_at).toBeNull();
  });

  it('hard delete removes user and nullifies sessions', async () => {
    const user = await repo.create({ tenantId: TENANT, name: 'Del', apiKeyHash: 'h' });
    // Create a session for this user
    await db.run(
      `INSERT INTO sessions (id, tenant_id, user_id, channel, chat_id) VALUES (?, ?, ?, 'web', 'web:test')`,
      ['sess-1', TENANT, user.id],
    );
    await repo.hardDelete(user.id, TENANT);
    const gone = await repo.getById(user.id, TENANT);
    expect(gone).toBeUndefined();
    // Session preserved but user_id nullified
    const sess = await db.get<{ user_id: string | null }>('SELECT user_id FROM sessions WHERE id = ?', ['sess-1']);
    expect(sess!.user_id).toBeNull();
  });
});

// ── Sender Link Repository ───────────────────────────────

describe('SenderLinkRepository', () => {
  let repo: SenderLinkRepository;
  let userId: string;

  beforeEach(async () => {
    repo = new SenderLinkRepository(db as any);
    // Create a user first
    const userRepo = new UserRepository(db as any);
    const user = await userRepo.create({ tenantId: TENANT, name: 'TestUser', apiKeyHash: 'h' });
    userId = user.id;
  });

  it('links a sender', async () => {
    const link = await repo.link({
      tenantId: TENANT,
      channelType: 'telegram',
      senderId: '12345',
      userId,
    });
    expect(link.channel_type).toBe('telegram');
    expect(link.sender_id).toBe('12345');
    expect(link.user_id).toBe(userId);
  });

  it('finds by channel sender', async () => {
    await repo.link({ tenantId: TENANT, channelType: 'whatsapp', senderId: '65123', userId });
    const found = await repo.findByChannelSender(TENANT, 'whatsapp', '65123');
    expect(found).toBeDefined();
    expect(found!.user_id).toBe(userId);
  });

  it('enforces tenant isolation', async () => {
    await repo.link({ tenantId: TENANT, channelType: 'telegram', senderId: '999', userId });
    const notFound = await repo.findByChannelSender('other-tenant', 'telegram', '999');
    expect(notFound).toBeUndefined();
  });

  it('upserts on duplicate (same tenant+channel+sender)', async () => {
    const userRepo = new UserRepository(db as any);
    const user2 = await userRepo.create({ tenantId: TENANT, name: 'User2', apiKeyHash: 'h2' });

    await repo.link({ tenantId: TENANT, channelType: 'telegram', senderId: '555', userId });
    await repo.link({ tenantId: TENANT, channelType: 'telegram', senderId: '555', userId: user2.id });

    const link = await repo.findByChannelSender(TENANT, 'telegram', '555');
    expect(link!.user_id).toBe(user2.id); // updated to user2
  });

  it('backfills sessions on link', async () => {
    // Create a session with matching chat_id
    await db.run(
      `INSERT INTO sessions (id, tenant_id, channel, chat_id) VALUES (?, ?, 'telegram', 'telegram:12345')`,
      ['sess-tg', TENANT],
    );
    await repo.link({ tenantId: TENANT, channelType: 'telegram', senderId: '12345', userId });
    const sess = await db.get<{ user_id: string }>('SELECT user_id FROM sessions WHERE id = ?', ['sess-tg']);
    expect(sess!.user_id).toBe(userId);
  });

  it('whatsapp backfill excludes groups', async () => {
    // Create a group session that starts with the same phone
    await db.run(
      `INSERT INTO sessions (id, tenant_id, channel, chat_id) VALUES (?, ?, 'whatsapp', 'whatsapp:65123@g.us')`,
      ['sess-grp', TENANT],
    );
    // Create a DM session
    await db.run(
      `INSERT INTO sessions (id, tenant_id, channel, chat_id) VALUES (?, ?, 'whatsapp', 'whatsapp:65123@s.whatsapp.net')`,
      ['sess-dm', TENANT],
    );
    await repo.link({ tenantId: TENANT, channelType: 'whatsapp', senderId: '65123', userId });

    const grp = await db.get<{ user_id: string | null }>('SELECT user_id FROM sessions WHERE id = ?', ['sess-grp']);
    const dm = await db.get<{ user_id: string | null }>('SELECT user_id FROM sessions WHERE id = ?', ['sess-dm']);
    expect(grp!.user_id).toBeNull(); // group NOT backfilled
    expect(dm!.user_id).toBe(userId); // DM backfilled
  });
});

// ── Cron Job Repository ──────────────────────────────────

describe('CronJobRepository', () => {
  let repo: CronJobRepository;

  beforeEach(() => {
    repo = new CronJobRepository(db as any);
  });

  it('creates and retrieves a cron job', async () => {
    const job = await repo.create({
      id: 'job-1',
      tenantId: TENANT,
      name: 'Test Job',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      prompt: 'Say hello',
      delivery: '{}',
    });
    expect(job.name).toBe('Test Job');
    expect(job.schedule_type).toBe('cron');

    const found = await repo.getById('job-1', TENANT);
    expect(found).toBeDefined();
    expect(found!.prompt).toBe('Say hello');
  });

  it('lists by tenant', async () => {
    await repo.create({ id: 'j1', tenantId: TENANT, name: 'A', scheduleType: 'cron', scheduleValue: '* * * * *', prompt: 'a', delivery: '{}' });
    await repo.create({ id: 'j2', tenantId: TENANT, name: 'B', scheduleType: 'every', scheduleValue: '60000', prompt: 'b', delivery: '{}' });
    const jobs = await repo.listByTenant(TENANT);
    expect(jobs.length).toBe(2);
  });

  it('lists by user', async () => {
    // Create real users for FK
    const userRepo = new UserRepository(db as any);
    const userA = await userRepo.create({ tenantId: TENANT, name: 'UserA', apiKeyHash: 'ha' });
    const userB = await userRepo.create({ tenantId: TENANT, name: 'UserB', apiKeyHash: 'hb' });
    await repo.create({ id: 'j1', tenantId: TENANT, userId: userA.id, name: 'A', scheduleType: 'cron', scheduleValue: '* * * * *', prompt: 'a', delivery: '{}' });
    await repo.create({ id: 'j2', tenantId: TENANT, userId: userB.id, name: 'B', scheduleType: 'cron', scheduleValue: '* * * * *', prompt: 'b', delivery: '{}' });
    const jobs = await repo.listByUser(TENANT, userA.id);
    expect(jobs.length).toBe(1);
    expect(jobs[0].name).toBe('A');
  });

  it('updates a job', async () => {
    await repo.create({ id: 'j1', tenantId: TENANT, name: 'Old', scheduleType: 'cron', scheduleValue: '0 9 * * *', prompt: 'old', delivery: '{}' });
    await repo.update('j1', TENANT, { name: 'New', enabled: false });
    const job = await repo.getById('j1', TENANT);
    expect(job!.name).toBe('New');
    expect(job!.enabled).toBe(0);
  });

  it('deletes with tenant scoping', async () => {
    await repo.create({ id: 'j1', tenantId: TENANT, name: 'Del', scheduleType: 'cron', scheduleValue: '* * * * *', prompt: 'x', delivery: '{}' });
    await repo.delete('j1', 'wrong-tenant'); // wrong tenant
    expect(await repo.getById('j1', TENANT)).toBeDefined(); // still exists

    await repo.delete('j1', TENANT); // correct tenant
    expect(await repo.getById('j1', TENANT)).toBeUndefined();
  });

  it('tracks run count', async () => {
    await repo.create({ id: 'j1', tenantId: TENANT, name: 'Runner', scheduleType: 'cron', scheduleValue: '* * * * *', prompt: 'x', delivery: '{}' });
    await repo.updateLastRun('j1', 'result text');
    await repo.updateLastRun('j1', 'result 2');
    const job = await repo.getById('j1', TENANT);
    expect(job!.run_count).toBe(2);
    expect(job!.last_result).toBe('result 2');
  });
});

// ── Tool Permission Repository ───────────────────────────

describe('ToolPermissionRepository', () => {
  let repo: ToolPermissionRepository;

  beforeEach(() => {
    repo = new ToolPermissionRepository(db as any);
  });

  it('creates and lists permissions', async () => {
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'exec', permission: 'power_user' });
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'web_search', permission: 'deny' });
    const rules = await repo.listByTenantAndRole(TENANT, 'user');
    expect(rules.length).toBe(2);
  });

  it('checkPermission returns most specific match', async () => {
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: '*', permission: 'deny' });
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'read_file', permission: 'allow' });
    expect(await repo.checkPermission(TENANT, 'user', 'read_file')).toBe('allow'); // exact wins
    expect(await repo.checkPermission(TENANT, 'user', 'exec')).toBe('deny'); // glob matches
  });

  it('no match returns allow', async () => {
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'exec', permission: 'deny' });
    expect(await repo.checkPermission(TENANT, 'user', 'read_file')).toBe('allow');
  });

  it('glob prefix matching', async () => {
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'mcp__*', permission: 'deny' });
    expect(await repo.checkPermission(TENANT, 'user', 'mcp__github__issues')).toBe('deny');
    expect(await repo.checkPermission(TENANT, 'user', 'read_file')).toBe('allow');
  });

  it('deletes with tenant scoping', async () => {
    await repo.create({ tenantId: TENANT, role: 'user', toolPattern: 'exec', permission: 'deny' });
    const rules = await repo.listByTenantAndRole(TENANT, 'user');
    await repo.delete(rules[0].id, 'wrong-tenant'); // wrong tenant
    expect((await repo.listByTenantAndRole(TENANT, 'user')).length).toBe(1); // still exists

    await repo.delete(rules[0].id, TENANT);
    expect((await repo.listByTenantAndRole(TENANT, 'user')).length).toBe(0);
  });
});
