/**
 * Cron scheduler -- proactive agent feature.
 *
 * Supports three schedule types:
 *   - `at`    : one-shot execution at a specific ISO date/time
 *   - `every` : recurring interval in milliseconds (min 5 000)
 *   - `cron`  : standard 5-field cron expression (min hour dom month dow)
 *
 * Jobs are persisted to a JSON file under the state directory.
 * Ported from src/cron/scheduler.js.
 */

import { CRON_MAX_JOBS, CRON_MIN_INTERVAL_MS } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { DatabaseAdapter } from '../db/index.js';
import { CronJobRepository, type CronJobRow } from '../db/repositories/cron-job.js';

// ---------------------------------------------------------------------------
// Cron expression parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field (minute, hour, etc.) into a set of allowed values.
 * Returns `null` when the field is `*` (matches all).
 */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null;
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range: string;
    let step = 1;
    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2]);
    } else {
      range = part;
    }
    if (range === '*') {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      for (let i = a; i <= b; i += step) values.add(i);
    } else {
      values.add(parseInt(range));
    }
  }
  return values;
}

/** Check whether a 5-field cron expression matches the given Date. */
function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const minute = parseCronField(minF, 0, 59);
  const hour = parseCronField(hourF, 0, 23);
  const dom = parseCronField(domF, 1, 31);
  const month = parseCronField(monF, 1, 12);
  const dow = parseCronField(dowF, 0, 6);

  if (minute && !minute.has(date.getMinutes())) return false;
  if (hour && !hour.has(date.getHours())) return false;
  if (dom && !dom.has(date.getDate())) return false;
  if (month && !month.has(date.getMonth() + 1)) return false;
  if (dow && !dow.has(date.getDay())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronJobSchedule {
  type: 'at' | 'every' | 'cron';
  value: string | number; // ISO date for 'at', ms for 'every', cron expr for 'cron'
  tz?: string;
}

export interface CronDeliveryTarget {
  channel: string;
  to?: string;
}

export interface CronJobDelivery {
  mode: 'none' | 'announce' | 'always';
  /** Per-channel delivery targets (preferred). */
  targets?: CronDeliveryTarget[];
  /** Legacy: single channel or array. Used if targets is absent. */
  channel?: string | string[];
  /** Legacy: single target ID. Used if targets is absent. */
  to?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: CronJobSchedule;
  prompt: string;
  delivery: CronJobDelivery | string;
  enabled: boolean;
  createdAt: string;
  lastRun: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastDelivered: boolean | null;
  lastDeliveryChannel: string | null;
  runCount: number;
  userId?: string | null; // owner — crons run with this user's permissions
}

export type JobExecutor = (job: CronJob) => Promise<{ text?: string; media?: import('@agw/types').MediaAttachment[] }>;

/** Callback that delivers a cron job result to a specific channel. */
export type JobDeliverer = (
  text: string,
  channel: string,
  to?: string,
  media?: import('@agw/types').MediaAttachment[],
) => Promise<void>;

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, { timer: ReturnType<typeof setTimeout>; type: 'timeout' | 'interval' }>();
  private runningJobs = new Set<string>();
  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private jobsPath: string;
  private log: Logger;
  private executor?: JobExecutor;
  private deliverer?: JobDeliverer;
  private repo?: CronJobRepository;
  private tenantId: string;

  constructor(opts: {
    stateDir: string;
    logger: Logger;
    executor?: JobExecutor;
    deliverer?: JobDeliverer;
    db?: DatabaseAdapter;
    tenantId?: string;
  }) {
    this.jobsPath = path.join(opts.stateDir, 'cron-jobs.json');
    this.log = opts.logger;
    this.executor = opts.executor;
    this.deliverer = opts.deliverer;
    this.tenantId = opts.tenantId || 'default';
    if (opts.db) {
      this.repo = new CronJobRepository(opts.db);
    }
  }

  // -- Persistence ----------------------------------------------------------

  /** Load jobs from DB. Falls back to JSON for migration. */
  async load(): Promise<void> {
    // Try DB first
    if (this.repo) {
      try {
        const rows = await this.repo.listByTenant(this.tenantId);
        if (rows.length > 0) {
          for (const row of rows) {
            this.jobs.set(row.id, this._rowToJob(row));
          }
          this.log.info({ count: this.jobs.size }, 'Cron jobs loaded from DB');
          return;
        }
      } catch (e) {
        this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to load cron jobs from DB');
      }

      // DB is empty — check for JSON migration
      if (fs.existsSync(this.jobsPath)) {
        await this._migrateJsonToDb();
        return;
      }
    }

    // No DB — fall back to JSON (legacy)
    this._loadJson();
  }

  private _loadJson(): void {
    try {
      if (fs.existsSync(this.jobsPath)) {
        const data: CronJob[] = JSON.parse(fs.readFileSync(this.jobsPath, 'utf8'));
        for (const job of data) {
          this.jobs.set(job.id, job);
        }
        this.log.info({ count: this.jobs.size }, 'Cron jobs loaded from JSON (legacy)');
      }
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to load cron jobs');
    }
  }

  private async _migrateJsonToDb(): Promise<void> {
    if (!this.repo) return;
    try {
      const data: CronJob[] = JSON.parse(fs.readFileSync(this.jobsPath, 'utf8'));
      for (const job of data) {
        const delivery = typeof job.delivery === 'string' ? job.delivery : JSON.stringify(job.delivery);
        await this.repo.create({
          id: job.id,
          tenantId: this.tenantId,
          userId: job.userId ?? null,
          name: job.name || '',
          scheduleType: job.schedule?.type || 'cron',
          scheduleValue: String(job.schedule?.value || ''),
          timezone: job.schedule?.tz,
          prompt: job.prompt,
          delivery,
          enabled: job.enabled !== false,
        });
        this.jobs.set(job.id, job);
      }
      // Rename JSON file (backup)
      const migratedPath = this.jobsPath + '.migrated';
      fs.renameSync(this.jobsPath, migratedPath);
      this.log.info({ count: data.length }, 'Migrated cron jobs from JSON to DB');
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Failed to migrate cron jobs from JSON to DB');
      this._loadJson(); // fall back
    }
  }

  /** Persist a single job change to DB (or JSON fallback). */
  private async _saveJob(job: CronJob): Promise<void> {
    if (this.repo) {
      try {
        const existing = await this.repo.getById(job.id, this.tenantId);
        if (existing) {
          await this.repo.update(job.id, this.tenantId, {
            name: job.name,
            scheduleType: job.schedule?.type,
            scheduleValue: String(job.schedule?.value || ''),
            timezone: job.schedule?.tz,
            prompt: job.prompt,
            delivery: typeof job.delivery === 'string' ? job.delivery : JSON.stringify(job.delivery),
            enabled: job.enabled,
          });
        } else {
          await this.repo.create({
            id: job.id,
            tenantId: this.tenantId,
            userId: job.userId ?? null,
            name: job.name || '',
            scheduleType: job.schedule?.type || 'cron',
            scheduleValue: String(job.schedule?.value || ''),
            timezone: job.schedule?.tz,
            prompt: job.prompt,
            delivery: typeof job.delivery === 'string' ? job.delivery : JSON.stringify(job.delivery),
            enabled: job.enabled,
          });
        }
        return;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Failed to save cron job to DB');
      }
    }
    // JSON fallback
    this._saveAllJson();
  }

  private _saveAllJson(): void {
    try {
      const data = Array.from(this.jobs.values());
      fs.writeFileSync(this.jobsPath, JSON.stringify(data, null, 2));
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : String(e) }, 'Failed to save cron jobs JSON');
    }
  }

  /** Backward-compatible sync save — persists all jobs (fire-and-forget for DB). */
  private _save(): void {
    if (this.repo) {
      // Fire-and-forget DB writes for each job
      for (const job of this.jobs.values()) {
        this._saveJob(job).catch(e =>
          this.log.error({ err: e instanceof Error ? e.message : String(e), jobId: job.id }, 'Failed to persist cron job'));
      }
    } else {
      this._saveAllJson();
    }
  }

  /** Convert a DB row to a CronJob object. */
  private _rowToJob(row: CronJobRow): CronJob {
    let delivery: CronJobDelivery | string;
    try { delivery = JSON.parse(row.delivery); } catch { delivery = row.delivery; }
    return {
      id: row.id,
      name: row.name,
      schedule: { type: row.schedule_type as CronJobSchedule['type'], value: row.schedule_value, tz: row.timezone || undefined },
      prompt: row.prompt,
      delivery,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      lastRun: row.last_run,
      lastResult: row.last_result,
      lastError: null,
      lastDelivered: null,
      lastDeliveryChannel: null,
      runCount: row.run_count,
      userId: row.user_id,
    };
  }

  // -- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    // Load jobs from DB (or JSON fallback) before starting timers
    await this.load();
    for (const job of this.jobs.values()) {
      if (job.enabled !== false) {
        this._scheduleJob(job);
      }
    }
    // Check cron expressions every 60 seconds
    this.cronInterval = setInterval(() => this._checkCronJobs(), 60_000);
    this.log.info({ jobs: this.jobs.size }, 'Cron scheduler started');
  }

  stop(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval);
      this.cronInterval = null;
    }
    for (const entry of this.timers.values()) {
      if (entry.type === 'interval') {
        clearInterval(entry.timer);
      } else {
        clearTimeout(entry.timer);
      }
    }
    this.timers.clear();
    this.log.info('Cron scheduler stopped');
  }

  // -- Internal scheduling --------------------------------------------------

  private _scheduleJob(job: CronJob): void {
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) {
      if (existing.type === 'interval') {
        clearInterval(existing.timer);
      } else {
        clearTimeout(existing.timer);
      }
      this.timers.delete(job.id);
    }

    if (job.schedule.type === 'at') {
      const runAt = new Date(job.schedule.value as string).getTime();
      const delay = runAt - Date.now();
      if (delay <= 0) {
        this.log.warn({ jobId: job.id, scheduledAt: job.schedule.value }, 'Cron job "at" time already passed — skipping');
        return;
      }
      const timer = setTimeout(() => {
        void this._executeJob(job);
        this.jobs.delete(job.id);
        this.timers.delete(job.id);
        this._save();
      }, delay);
      this.timers.set(job.id, { timer, type: 'timeout' });
    } else if (job.schedule.type === 'every') {
      const ms = job.schedule.value as number;
      if (ms < CRON_MIN_INTERVAL_MS) return; // min 5 seconds
      const timer = setInterval(() => {
        void this._executeJob(job);
      }, ms);
      this.timers.set(job.id, { timer, type: 'interval' });
    }
    // 'cron' type handled by _checkCronJobs
  }

  private _checkCronJobs(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled === false) continue;
      if (job.schedule.type !== 'cron') continue;

      const tz = job.schedule.tz || 'UTC';
      let now: Date;
      try {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        const parts = formatter.formatToParts(new Date());
        const get = (type: string) =>
          parseInt(parts.find((p) => p.type === type)?.value || '0');
        now = new Date(
          get('year'),
          get('month') - 1,
          get('day'),
          get('hour'),
          get('minute'),
          get('second'),
        );
      } catch (e) {
        this.log.warn({ jobId: job.id, tz, err: e instanceof Error ? e.message : String(e) }, 'Timezone parsing failed, falling back to system time');
        now = new Date();
      }

      if (cronMatches(String(job.schedule.value), now)) {
        void this._executeJob(job);
      }
    }
  }

  private async _executeJob(job: CronJob): Promise<void> {
    if (this.runningJobs.has(job.id)) {
      this.log.debug({ jobId: job.id }, 'Cron job already running, skipping');
      return;
    }
    this.runningJobs.add(job.id);
    this.log.info({ jobId: job.id, name: job.name }, 'Executing cron job');
    job.lastRun = new Date().toISOString();
    job.runCount = (job.runCount || 0) + 1;
    this._save();

    try {
      if (!this.executor) {
        this.log.warn({ jobId: job.id }, 'No executor configured; skipping execution');
        return;
      }

      // If delivery mode is 'announce', the scheduler delivers the result
      // to the configured channel(s). Tell the agent to just generate text,
      // not use send_message or other delivery tools.
      const delivery = typeof job.delivery === 'string'
        ? { mode: job.delivery as CronJobDelivery['mode'] }
        : job.delivery;

      let announceChannels = 'the user';
      if (delivery.targets && delivery.targets.length > 0) {
        announceChannels = delivery.targets.map(t => t.channel).join(' and ');
      } else if (delivery.channel) {
        announceChannels = Array.isArray(delivery.channel) ? delivery.channel.join(' and ') : delivery.channel;
      }

      const execJob = (delivery.mode === 'announce')
        ? { ...job, prompt: `${job.prompt}\n\n[SYSTEM: Your response will be delivered automatically to ${announceChannels}. Just return the message content directly. Do NOT use send_message or any delivery tools.]` }
        : job;

      const result = await this.executor(execJob);
      const responseText = (result.text || '').trim();
      const responseMedia = result.media;
      job.lastResult = responseText.slice(0, 500);
      job.lastError = null;

      // Deliver result to configured channel(s)
      if (delivery.mode === 'announce' && (responseText || responseMedia?.length) && this.deliverer) {
        // Build targets list: prefer targets[], fall back to legacy channel/to
        let targets: CronDeliveryTarget[] = [];
        if (delivery.targets && delivery.targets.length > 0) {
          targets = delivery.targets;
        } else {
          const channels = Array.isArray(delivery.channel)
            ? delivery.channel
            : delivery.channel ? [delivery.channel] : [];
          targets = channels.map(ch => ({ channel: ch, to: delivery.to }));
        }

        if (targets.length === 0) {
          job.lastDelivered = false;
          job.lastError = 'delivery.mode is "announce" but no delivery targets configured — job disabled to prevent repeated failures';
          job.enabled = false;
          this.log.error({ jobId: job.id }, 'Cron job has announce mode but no delivery targets — disabled');
        } else {
          const delivered: string[] = [];
          for (const target of targets) {
            try {
              await this.deliverer(responseText, target.channel, target.to, responseMedia);
              delivered.push(target.channel);
            } catch (e) {
              this.log.error({ jobId: job.id, channel: target.channel, err: e instanceof Error ? e.message : String(e) }, 'Cron delivery to channel failed');
            }
          }
          job.lastDelivered = delivered.length > 0;
          job.lastDeliveryChannel = delivered.join(',');
          if (delivered.length > 0) {
            this.log.info({ jobId: job.id, channels: delivered }, 'Cron job delivered');
          }
        }
      }

      this._save();
      this.log.info({ jobId: job.id, resultLen: responseText.length }, 'Cron job completed');
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.log.error({ jobId: job.id, err: errMsg }, 'Cron job execution failed');
      job.lastError = errMsg;
      this._save();
    } finally {
      this.runningJobs.delete(job.id);
    }
  }

  // -- CRUD -----------------------------------------------------------------

  add(jobSpec: {
    id?: string;
    name?: string;
    schedule: { type?: string; kind?: string; value?: string | number; expr?: string; tz?: string; timezone?: string };
    prompt?: string;
    payload?: { message?: string };
    delivery?: CronJobDelivery | string;
    enabled?: boolean;
    userId?: string | null;
  }): CronJob {
    const schedule = jobSpec.schedule || ({} as any);
    const scheduleType = (schedule.type || schedule.kind) as CronJob['schedule']['type'];
    const scheduleValue = schedule.value || schedule.expr;

    const validTypes = ['at', 'every', 'cron'] as const;
    if (!scheduleType || !validTypes.includes(scheduleType as any)) {
      throw new Error(
        `Invalid schedule type: ${scheduleType}. Must be: ${validTypes.join(', ')}`,
      );
    }
    if (!scheduleValue) {
      throw new Error('Schedule value/expr is required');
    }
    // Validate schedule values
    if (scheduleType === 'cron') {
      const parts = String(scheduleValue).trim().split(/\s+/);
      if (parts.length !== 5) {
        throw new Error(`Invalid cron expression: "${scheduleValue}". Must have 5 fields: minute hour day month weekday`);
      }
    } else if (scheduleType === 'every') {
      const ms = Number(scheduleValue);
      if (isNaN(ms) || ms < CRON_MIN_INTERVAL_MS) {
        throw new Error(`Invalid interval: ${scheduleValue}. Must be at least ${CRON_MIN_INTERVAL_MS}ms`);
      }
    } else if (scheduleType === 'at') {
      const ts = new Date(scheduleValue as string).getTime();
      if (isNaN(ts)) {
        throw new Error(`Invalid date: "${scheduleValue}". Must be a valid ISO date string`);
      }
    }
    if (this.jobs.size >= CRON_MAX_JOBS) {
      throw new Error('Maximum number of cron jobs (50) reached');
    }

    let prompt = jobSpec.prompt || '';
    if (jobSpec.payload?.message) {
      prompt = jobSpec.payload.message;
    }

    const job: CronJob = {
      id: jobSpec.id || crypto.randomUUID().slice(0, 12),
      name: String(jobSpec.name || 'Untitled').slice(0, 200),
      schedule: {
        type: scheduleType,
        value: scheduleValue,
        tz: schedule.tz || schedule.timezone || 'UTC',
      },
      prompt: String(prompt).slice(0, 5_000),
      delivery: jobSpec.delivery || 'none',
      enabled: jobSpec.enabled !== false,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null,
      lastError: null,
      lastDelivered: null,
      lastDeliveryChannel: null,
      userId: jobSpec.userId ?? null,
      runCount: 0,
    };

    this.jobs.set(job.id, job);
    this._save();
    if (job.enabled) this._scheduleJob(job);
    this.log.info({ jobId: job.id, name: job.name, schedule: job.schedule }, 'Cron job added');
    return job;
  }

  update(id: string, updates: Partial<CronJob>): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    // Only allow updating safe fields — reject internal/tracking fields
    const safeFields = new Set(['schedule', 'prompt', 'channel', 'chatId', 'enabled', 'timezone', 'name', 'delivery']);
    const safeUpdates: Partial<CronJob> = {};
    for (const key of Object.keys(updates) as Array<keyof CronJob>) {
      if (safeFields.has(key)) {
        (safeUpdates as any)[key] = updates[key];
      }
    }
    Object.assign(job, safeUpdates, { id }); // don't overwrite id
    this._save();
    if (job.enabled) {
      this._scheduleJob(job);
    } else {
      const existing = this.timers.get(id);
      if (existing) {
        if (existing.type === 'interval') {
          clearInterval(existing.timer);
        } else {
          clearTimeout(existing.timer);
        }
        this.timers.delete(id);
      }
    }
    return job;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    const existing = this.timers.get(id);
    if (existing) {
      if (existing.type === 'interval') {
        clearInterval(existing.timer);
      } else {
        clearTimeout(existing.timer);
      }
      this.timers.delete(id);
    }
    this.jobs.delete(id);
    // Delete from DB
    if (this.repo) {
      this.repo.delete(id, this.tenantId).catch(e =>
        this.log.error({ err: e instanceof Error ? e.message : String(e), jobId: id }, 'Failed to delete cron job from DB'));
    } else {
      this._saveAllJson();
    }
    this.log.info({ jobId: id }, 'Cron job removed');
    return true;
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  get(id: string): CronJob | null {
    return this.jobs.get(id) || null;
  }

  async run(id: string): Promise<{ success?: boolean; lastResult?: string | null; error?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { error: 'Job not found' };
    await this._executeJob(job);
    return { success: true, lastResult: job.lastResult };
  }
}
