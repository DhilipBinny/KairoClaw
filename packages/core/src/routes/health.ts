import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  // GET /health — simple health check
  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/v1/health — detailed health check (legacy)
  app.get('/api/v1/health', async (request) => {
    const db = (request as unknown as { ctx: { db: DatabaseAdapter; config: Record<string, unknown> } }).ctx.db;
    const config = (request as unknown as { ctx: { db: DatabaseAdapter; config: Record<string, unknown> } }).ctx.config;

    // First-run detection: only 1 user (the seeded admin) and no provider API key set
    let firstRun = false;
    try {
      const userCount = db.get<{ count: number }>('SELECT COUNT(*) as count FROM users');
      const providers = (config as Record<string, Record<string, Record<string, string>>>)?.providers;
      const hasApiKey = !!(providers?.anthropic?.apiKey && providers.anthropic.apiKey !== '' && !providers.anthropic.apiKey.startsWith('${'));
      const hasAuthToken = !!(providers?.anthropic?.authToken && providers.anthropic.authToken !== '' && !providers.anthropic.authToken.startsWith('${'));
      firstRun = (userCount?.count ?? 0) <= 1 && !hasApiKey && !hasAuthToken;
    } catch { /* non-critical */ }

    return {
      status: 'ok',
      version: '0.2.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      model: (config as Record<string, Record<string, string>>)?.model?.primary || 'not configured',
      firstRun,
    };
  });

  // GET /api/v2/health — v2 health check
  app.get('/api/v2/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  });
};
