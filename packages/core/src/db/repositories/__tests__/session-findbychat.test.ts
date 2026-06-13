import { describe, it, expect } from 'vitest';
import { SessionRepository } from '../session.js';
import { createTestDb } from '../../__tests__/test-db.js';

describe('SessionRepository.findByChat (#186)', () => {
  it('resolves a session by chat key even past the old 500-session cap', async () => {
    const db = createTestDb();
    try {
      const repo = new SessionRepository(db as any);
      // Create the target chat's session first, then 600 unrelated sessions so a
      // 500-row scan ordered by updated_at would never reach the target.
      const target = await repo.create({ id: 'target', tenantId: 'test-tenant', channel: 'web', chatId: 'web:user:main' } as any);
      for (let i = 0; i < 600; i++) {
        await repo.create({ id: `other-${i}`, tenantId: 'test-tenant', channel: 'web', chatId: `web:user:other-${i}` } as any);
      }
      const found = await repo.findByChat('test-tenant', 'web', 'web:user:main');
      expect(found?.id).toBe(target.id);
    } finally {
      db.close();
    }
  });

  it('returns the most-recently-updated session when duplicates exist (self-heals old forks)', async () => {
    const db = createTestDb();
    try {
      const repo = new SessionRepository(db as any);
      await repo.create({ id: 'old', tenantId: 'test-tenant', channel: 'web', chatId: 'web:dup' } as any);
      await repo.create({ id: 'new', tenantId: 'test-tenant', channel: 'web', chatId: 'web:dup' } as any);
      // Bump 'new' to be most recently updated.
      await db.run(`UPDATE sessions SET updated_at = ? WHERE id = 'new'`, [new Date(Date.now() + 60000).toISOString()]);
      const found = await repo.findByChat('test-tenant', 'web', 'web:dup');
      expect(found?.id).toBe('new');
    } finally {
      db.close();
    }
  });

  it('scopes by channel and tenant', async () => {
    const db = createTestDb();
    try {
      const repo = new SessionRepository(db as any);
      await repo.create({ id: 'tg', tenantId: 'test-tenant', channel: 'telegram', chatId: 'shared' } as any);
      await repo.create({ id: 'web', tenantId: 'test-tenant', channel: 'web', chatId: 'shared' } as any);
      expect((await repo.findByChat('test-tenant', 'telegram', 'shared'))?.id).toBe('tg');
      expect((await repo.findByChat('test-tenant', 'web', 'shared'))?.id).toBe('web');
      expect(await repo.findByChat('other-tenant', 'web', 'shared')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
