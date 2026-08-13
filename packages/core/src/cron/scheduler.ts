/**
 * Re-export shim -- delegates to @agw/cron and adapts the legacy constructor API.
 */
export type {
  CronJob,
  CronJobSchedule,
  CronJobDelivery,
  CronDeliveryTarget,
  CronJobRow,
  CronJobStore,
  JobExecutor,
  JobDeliverer,
} from '@agw/cron';

import { CronScheduler as _CronScheduler, type CronJobStore } from '@agw/cron';
import type { Logger } from 'pino';
import type { DatabaseAdapter } from '../db/index.js';
import { CronJobRepository } from '../db/repositories/cron-job.js';

import type { JobExecutor, JobDeliverer } from '@agw/cron';

/** Adapter that wraps CronJobRepository to satisfy CronJobStore. */
function repoToStore(db: DatabaseAdapter): CronJobStore {
  const repo = new CronJobRepository(db);
  return {
    listByTenant: (tenantId) => repo.listByTenant(tenantId),
    getById: (id, tenantId) => repo.getById(id, tenantId),
    create: (job) => repo.create(job),
    update: (id, tenantId, fields) => repo.update(id, tenantId, fields as any),
    delete: (id, tenantId) => repo.delete(id, tenantId),
    updateLastRun: (id, tenantId, result) => repo.updateLastRun(id, tenantId, result),
  };
}

export class CronScheduler extends _CronScheduler {
  constructor(opts: {
    stateDir: string;
    logger: Logger;
    executor?: JobExecutor;
    deliverer?: JobDeliverer;
    db?: DatabaseAdapter;
    tenantId?: string;
  }) {
    super({
      stateDir: opts.stateDir,
      logger: opts.logger as any,
      executor: opts.executor,
      deliverer: opts.deliverer,
      store: opts.db ? repoToStore(opts.db) : undefined,
      tenantId: opts.tenantId,
    });
  }
}
