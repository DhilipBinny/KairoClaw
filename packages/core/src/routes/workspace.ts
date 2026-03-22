/**
 * Workspace file routes — view and edit persona/identity files.
 *
 * Whitelisted files: IDENTITY.md, SOUL.md, USER.md, RULES.md, MEMORY.md
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { GatewayConfig } from '@agw/types';
import { requireRole } from '../auth/middleware.js';
import { WORKSPACE_MAX_FILE_SIZE } from '../constants.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('system');

const WORKSPACE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'RULES.md', 'MEMORY.md'];

export const registerWorkspaceRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/workspace/files — list workspace files
  app.get('/api/v1/workspace/files', { preHandler: [requireRole('admin', 'user')] }, async (request) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const workspace = config.agent.workspace;

    const files = WORKSPACE_FILES.map((name) => {
      const filePath = path.join(workspace, name);
      const exists = fs.existsSync(filePath);
      let size = 0;
      let modified: string | null = null;
      if (exists) {
        const stat = fs.statSync(filePath);
        size = stat.size;
        modified = stat.mtime.toISOString();
      }
      return { name, exists, size, modified };
    });

    return { files };
  });

  // GET /api/v1/workspace/files/:name — read a workspace file
  app.get('/api/v1/workspace/files/:name', { preHandler: [requireRole('admin', 'user')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const { name } = request.params as { name: string };

    if (!WORKSPACE_FILES.includes(name)) {
      return reply.code(400).send({ error: `Not an editable file: ${name}` });
    }

    const filePath = path.join(config.agent.workspace, name);
    if (!fs.existsSync(filePath)) {
      return { name, content: '', exists: false };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    return { name, content, exists: true };
  });

  // PUT /api/v1/workspace/files/:name — save a workspace file
  app.put(
    '/api/v1/workspace/files/:name',
    { preHandler: [requireRole('admin', 'user')] },
    async (request, reply) => {
      const config = (request as any).ctx.config as GatewayConfig;
      const { name } = request.params as { name: string };

      if (!WORKSPACE_FILES.includes(name)) {
        return reply.code(400).send({ error: `Not an editable file: ${name}` });
      }

      const { content } = request.body as { content?: string };
      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }
      if (content.length > WORKSPACE_MAX_FILE_SIZE) {
        return reply.code(400).send({ error: 'Content exceeds 1MB limit' });
      }

      const filePath = path.join(config.agent.workspace, name);
      // Ensure workspace directory exists
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      log.info({ file: name, size: content.length }, 'Workspace file saved');

      return { success: true, name, size: content.length };
    },
  );
};
