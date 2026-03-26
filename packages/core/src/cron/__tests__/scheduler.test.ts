/**
 * Cron scheduler tests — DB persistence, job management, per-user ownership.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CronScheduler } from '../scheduler.js';
import { createTestDb, type TestDb } from '../../db/__tests__/test-db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';

let db: TestDb;
let stateDir: string;
const logger = pino({ level: 'silent' });

beforeEach(() => {
  db = createTestDb();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-cron-test-'));
});

afterEach(() => {
  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('CronScheduler', () => {
  it('starts with empty DB — no jobs', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();
    expect(scheduler.list().length).toBe(0);
    scheduler.stop();
  });

  it('adds a cron job', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    const job = scheduler.add({
      name: 'Test Job',
      schedule: { type: 'cron', value: '0 9 * * *' },
      prompt: 'Say hello',
    });

    expect(job.name).toBe('Test Job');
    expect(job.schedule.type).toBe('cron');
    expect(scheduler.list().length).toBe(1);
    scheduler.stop();
  });

  it('adds job with userId', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    const job = scheduler.add({
      name: 'User Job',
      schedule: { type: 'every', value: '60000' },
      prompt: 'Check status',
      userId: 'user-123',
    });

    expect(job.userId).toBe('user-123');
    scheduler.stop();
  });

  it('persists jobs to DB', async () => {
    const s1 = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await s1.start();
    s1.add({ name: 'Persistent', schedule: { type: 'cron', value: '* * * * *' }, prompt: 'test' });
    s1.stop();

    // Wait for async DB write
    await new Promise(r => setTimeout(r, 100));

    // New scheduler instance should load from DB
    const s2 = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await s2.start();
    expect(s2.list().length).toBe(1);
    expect(s2.list()[0].name).toBe('Persistent');
    s2.stop();
  });

  it('removes a job', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    const job = scheduler.add({ name: 'ToRemove', schedule: { type: 'cron', value: '* * * * *' }, prompt: 'x' });
    expect(scheduler.list().length).toBe(1);

    scheduler.remove(job.id);
    expect(scheduler.list().length).toBe(0);
    scheduler.stop();
  });

  it('validates schedule type', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    expect(() => scheduler.add({
      name: 'Bad',
      schedule: { type: 'invalid' as any, value: 'x' },
      prompt: 'x',
    })).toThrow('Invalid schedule type');
    scheduler.stop();
  });

  it('validates cron expression (5 fields)', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    expect(() => scheduler.add({
      name: 'Bad Cron',
      schedule: { type: 'cron', value: '0 9 *' }, // only 3 fields
      prompt: 'x',
    })).toThrow('5 fields');
    scheduler.stop();
  });

  it('validates minimum interval', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    expect(() => scheduler.add({
      name: 'Too Fast',
      schedule: { type: 'every', value: '1000' }, // 1 second, below 5s minimum
      prompt: 'x',
    })).toThrow();
    scheduler.stop();
  });

  it('migrates from JSON to DB', async () => {
    // Write a legacy cron-jobs.json
    const legacyJobs = [{
      id: 'legacy-1',
      name: 'Legacy Job',
      schedule: { type: 'cron', value: '0 8 * * *' },
      prompt: 'legacy prompt',
      delivery: 'none',
      enabled: true,
      createdAt: '2026-01-01T00:00:00Z',
      lastRun: null,
      lastResult: null,
      lastError: null,
      lastDelivered: null,
      lastDeliveryChannel: null,
      runCount: 5,
    }];
    fs.writeFileSync(path.join(stateDir, 'cron-jobs.json'), JSON.stringify(legacyJobs));

    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();

    // Job should be loaded
    expect(scheduler.list().length).toBe(1);
    expect(scheduler.list()[0].name).toBe('Legacy Job');

    // JSON file should be renamed
    expect(fs.existsSync(path.join(stateDir, 'cron-jobs.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'cron-jobs.json.migrated'))).toBe(true);

    scheduler.stop();
  });

  it('get returns a specific job', async () => {
    const scheduler = new CronScheduler({ stateDir, logger, db: db as any, tenantId: 'test-tenant' });
    await scheduler.start();
    const job = scheduler.add({ name: 'FindMe', schedule: { type: 'cron', value: '0 12 * * *' }, prompt: 'hello' });

    const found = scheduler.get(job.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('FindMe');

    expect(scheduler.get('nonexistent')).toBeFalsy();
    scheduler.stop();
  });
});
