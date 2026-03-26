import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import type { SecretsStore } from '../secrets/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };
const APP_VERSION = pkg.version;

export const registerHealthRoutes: FastifyPluginAsync<{ secretsStore?: SecretsStore }> = async (app, opts) => {
  const { secretsStore } = opts;
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

    const secretsDegraded = secretsStore?.isDegraded ?? false;

    return {
      status: secretsDegraded ? 'degraded' : 'ok',
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
      ...(secretsDegraded ? { warnings: ['Secrets store decrypt failed — API keys unavailable. Check AGW_MASTER_KEY.'] } : {}),
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

  // GET /api/v1/my/dashboard — authenticated user's own stats
  app.get('/api/v1/my/dashboard', async (request) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter } }).ctx.db;
    const userId = request.user?.id;
    if (!userId) return { error: 'Not authenticated' };

    const sessions = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sessions WHERE user_id = ?', [userId]);
    const usage = await db.get<{ tokens: number; cost: number }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost
       FROM usage_records WHERE user_id = ?`, [userId]);

    return {
      user: { id: request.user!.id, name: request.user!.name, role: request.user!.role },
      sessions: sessions?.count || 0,
      usage: { tokens: usage?.tokens || 0, cost: usage?.cost || 0 },
    };
  });
};
