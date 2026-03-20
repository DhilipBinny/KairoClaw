import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { logBuffer, listLogFiles, searchLogFiles, getLogFilePath } from '../observability/logger.js';
import { requireRole } from '../auth/middleware.js';

export const registerLogRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/logs — recent in-memory logs (real-time view)
  app.get('/api/v1/admin/logs', { preHandler: [requireRole('admin')] }, async (request) => {
    const lines = parseInt((request.query as any)?.lines || '200');
    return {
      entries: logBuffer.getRecent(lines),
      buffered: logBuffer.size,
    };
  });

  // GET /api/v1/admin/logs/files — list available log files
  app.get('/api/v1/admin/logs/files', { preHandler: [requireRole('admin')] }, async () => {
    return { files: listLogFiles() };
  });

  // GET /api/v1/admin/logs/search — search persisted log files
  app.get('/api/v1/admin/logs/search', { preHandler: [requireRole('admin')] }, async (request) => {
    const q = request.query as Record<string, string>;
    const results = searchLogFiles({
      query: q.q || q.query || undefined,
      level: q.level || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      limit: parseInt(q.limit || '200'),
    });
    return { entries: results, count: results.length };
  });

  // GET /api/v1/admin/logs/download/:date — download a specific day's log file
  app.get('/api/v1/admin/logs/download/:date', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { date } = request.params as { date: string };
    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.code(400).send({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    const filePath = getLogFilePath(date);
    if (!filePath) {
      return reply.code(404).send({ error: `No log file for ${date}` });
    }
    const stream = fs.createReadStream(filePath);
    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('Content-Disposition', `attachment; filename="server-${date}.log"`);
    return reply.send(stream);
  });

  // PUT /api/v1/admin/log-level — change log level at runtime
  app.put('/api/v1/admin/log-level', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { level } = request.body as { level?: string };
    const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    if (!level || !validLevels.includes(level)) {
      return reply.code(400).send({ error: `Invalid level. Use: ${validLevels.join(', ')}` });
    }
    app.log.level = level;
    return { success: true, level };
  });
};
