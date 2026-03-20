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
