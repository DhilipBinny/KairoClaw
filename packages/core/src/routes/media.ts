/**
 * Media routes — serve generated media files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { MediaStore } from '../media/store.js';
import { requireRole } from '../auth/middleware.js';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

export const registerMediaRoutes: FastifyPluginAsync<{ mediaStore: MediaStore }> = async (app, opts) => {
  const { mediaStore } = opts;

  // GET /api/v1/media/:filename — serve a media file (no auth required for image embedding)
  app.get('/api/v1/media/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };

    // Sanitize: only allow simple filenames (uuid.ext)
    if (!/^[a-f0-9\-]+\.[a-z0-9]+$/i.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const filePath = mediaStore.getPath(filename);
    if (!filePath) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const ext = path.extname(filename).slice(1).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);

    return reply
      .header('Content-Type', contentType)
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'public, max-age=86400')
      .send(stream);
  });

  // GET /api/v1/media — media storage stats (admin only)
  app.get('/api/v1/media', { preHandler: [requireRole('admin')] }, async () => {
    const stats = mediaStore.stats();
    return {
      count: stats.count,
      totalMB: (stats.totalBytes / 1024 / 1024).toFixed(1),
    };
  });
};
