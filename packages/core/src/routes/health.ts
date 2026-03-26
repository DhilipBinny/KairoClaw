import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { SecretsStore } from '../secrets/store.js';
import { getDb } from './utils.js';

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
    const db = getDb(request);
    const config = (request as unknown as { ctx: { config: Record<string, unknown> } }).ctx.config;
    const warnings: string[] = [];

    // Database connectivity check
    let dbOk = true;
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
    } catch {
      dbOk = false;
      warnings.push('Database connection failed');
    }

    const secretsDegraded = secretsStore?.isDegraded ?? false;
    if (secretsDegraded) {
      warnings.push('Secrets store decrypt failed — API keys unavailable. Check AGW_MASTER_KEY.');
    }

    const status = !dbOk ? 'unhealthy' : secretsDegraded ? 'degraded' : 'ok';

    return {
      status,
      version: APP_VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      model: (config as Record<string, Record<string, string>>)?.model?.primary || 'not configured',
      database: dbOk ? 'connected' : 'disconnected',
      firstRun,
      users: { total: totalUsers, active: activeUsers },
      ...(warnings.length > 0 ? { warnings } : {}),
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
    const db = getDb(request);
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
