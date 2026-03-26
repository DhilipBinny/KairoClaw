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

    // Sanitize: only allow simple filenames (uuid.ext or timestamp-name.ext)
    if (!/^[a-zA-Z0-9._-]+\.[a-z0-9]+$/i.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    // 1. Check MediaStore (legacy /data/media/ + agent-generated)
    let filePath = mediaStore.getPath(filename);

    // 2. If not found, search workspace scoped media dirs
    if (!filePath) {
      const config = (request as any).ctx?.config as { agent?: { workspace?: string } } | undefined;
      const workspace = config?.agent?.workspace;
      if (workspace) {
        const safe = path.basename(filename); // prevent traversal

        // Check shared/media/ (accessible to all)
        const sharedPath = path.join(workspace, 'shared', 'media', safe);
        if (fs.existsSync(sharedPath)) {
          filePath = sharedPath;
        } else if (request.user?.role === 'admin') {
          // Admin: search all scoped media dirs
          const scopesDir = path.join(workspace, 'scopes');
          if (fs.existsSync(scopesDir)) {
            for (const scope of fs.readdirSync(scopesDir)) {
              const scopedPath = path.join(scopesDir, scope, 'media', safe);
              if (fs.existsSync(scopedPath)) {
                filePath = scopedPath;
                break;
              }
            }
          }
        } else if (request.user?.id) {
          // Non-admin: only own scope
          const ownPath = path.join(workspace, 'scopes', request.user.id, 'media', safe);
          if (fs.existsSync(ownPath)) {
            filePath = ownPath;
          }
        }
        // Unauthenticated: only MediaStore (legacy) + shared/media (already checked above)
      }
    }

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

  // POST /api/v1/media/upload — upload a file to workspace/media (auth required)
  app.post('/api/v1/media/upload', { preHandler: [requireRole('user')] }, async (request, reply) => {
    const config = (request as any).ctx?.config as { agent?: { workspace?: string } } | undefined;
    const workspace = config?.agent?.workspace || process.cwd();

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of data.file) {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_SIZE) {
        return reply.code(413).send({ error: 'File too large (max 20MB)' });
      }
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const originalName = data.filename || 'upload';
    const ext = path.extname(originalName).slice(1).toLowerCase() || 'bin';

    // Save to user's scoped media dir if authenticated, otherwise shared/media
    if (!request.user?.id) {
      return reply.code(401).send({ error: 'Authentication required for uploads' });
    }
    const mediaDir = path.join(workspace, 'scopes', request.user.id, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'bin';
    const savedName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}.${safeExt}`;
    const filePath = path.join(mediaDir, savedName);
    fs.writeFileSync(filePath, new Uint8Array(buffer));

    const relativePath = path.relative(workspace, filePath);
    return {
      success: true,
      filename: savedName,
      originalName,
      filePath: relativePath, // relative to workspace (not absolute server path)
      mediaUrl: `/api/v1/media/${encodeURIComponent(savedName)}`,
      mimeType: data.mimetype || 'application/octet-stream',
      sizeBytes: buffer.length,
    };
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
