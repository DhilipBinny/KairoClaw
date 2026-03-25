import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
const APP_VERSION = pkg.version;

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  // GET /health — simple health check
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/v1/health — detailed health check (legacy)
  app.get('/api/v1/health', async (request) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter; config: Record<string, unknown> } }).ctx.db;
    const config = (request as unknown as { ctx: { db: DatabaseAdapter; config: Record<string, unknown> } }).ctx.config;

    // First-run detection and user stats
    let firstRun = false;
    let totalUsers = 0;
    let activeUsers = 0;
    try {
      const userCount = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM users');
      const activeCount = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM users WHERE active = 1');
      const sessionCount = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM sessions');
      totalUsers = userCount?.count ?? 0;
      activeUsers = activeCount?.count ?? 0;
      firstRun = totalUsers <= 1 && (sessionCount?.count ?? 0) === 0;
    } catch { /* non-critical */ }

    return {
      status: 'ok',
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      model: (config as Record<string, Record<string, string>>)?.model?.primary || 'not configured',
      firstRun,
      users: { total: totalUsers, active: activeUsers },
    };
  });

  // GET /api/v2/health — v2 health check
  app.get('/api/v2/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    });
  });
};
