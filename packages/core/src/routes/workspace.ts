/**
 * Workspace file routes — view and edit persona/identity files.
 *
 * Whitelisted files: IDENTITY.md, SOUL.md, RULES.md (global persona files)
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { GatewayConfig } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import { requireRole } from '../auth/middleware.js';
import { WORKSPACE_MAX_FILE_SIZE } from '../constants.js';
import { SCOPE_DIR_NAME } from '../constants.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('system');

const WORKSPACE_FILES = ['IDENTITY.md', 'SOUL.md', 'RULES.md'];

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

  // ── Scoped Users API ────────────────────────────

  // GET /api/v1/workspace/scopes — list all scoped users
  app.get('/api/v1/workspace/scopes', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const db = (request as any).ctx.db as DatabaseAdapter;
    const scopesDir = path.join(config.agent.workspace, SCOPE_DIR_NAME);

    if (!fs.existsSync(scopesDir)) {
      return { scopes: [] };
    }

    // Preload user names for UUID-based scopes
    const users = await db.query<{ id: string; name: string }>('SELECT id, name FROM users');
    const userNameMap = new Map(users.map(u => [u.id, u.name]));

    const entries = fs.readdirSync(scopesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const scopeKey = d.name;
        const scopePath = path.join(scopesDir, scopeKey);

        // Detect scope type: UUID (user), group_*, or legacy channel:sender
        const isGroup = scopeKey.startsWith('group_');
        const isUUID = !scopeKey.includes(':') && !isGroup;
        let channel: string;
        let userId: string;
        let userName: string | null = null;
        let scopeType: 'user' | 'group' | 'sender' = 'sender';

        if (isUUID) {
          scopeType = 'user';
          channel = 'user';
          userId = scopeKey;
          userName = userNameMap.get(scopeKey) || null;
        } else if (isGroup) {
          scopeType = 'group';
          // group_telegram_-1003319503773 → channel=telegram, id=-1003319503773
          const parts = scopeKey.replace(/^group_/, '').split('_');
          channel = parts[0] || 'unknown';
          userId = parts.slice(1).join('_');
        } else {
          const parts = scopeKey.split(':');
          channel = parts[0] || 'unknown';
          userId = parts.slice(1).join(':') || 'unknown';
        }

        // Read USER.md if exists
        const userMdPath = path.join(scopePath, 'USER.md');
        const hasUserMd = fs.existsSync(userMdPath);

        // Read PROFILE.md if exists
        const profilePath = path.join(scopePath, 'memory', 'PROFILE.md');
        const hasProfile = fs.existsSync(profilePath);

        // Count session files
        const sessionsDir = path.join(scopePath, 'memory', 'sessions');
        let sessionCount = 0;
        let lastSession: string | null = null;
        if (fs.existsSync(sessionsDir)) {
          const sessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md')).sort();
          sessionCount = sessions.length;
          lastSession = sessions.length > 0 ? sessions[sessions.length - 1].replace('.md', '') : null;
        }

        return {
          scopeKey,
          scopeType,
          channel,
          userId,
          userName,
          hasUserMd,
          hasProfile,
          sessionCount,
          lastSession,
        };
      })
      .sort((a, b) => (b.lastSession || '').localeCompare(a.lastSession || ''));

    return { scopes: entries };
  });

  // GET /api/v1/workspace/scopes/:key — read a specific scope's files
  app.get('/api/v1/workspace/scopes/:key', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const config = (request as any).ctx.config as GatewayConfig;
    const { key } = request.params as { key: string };

    // Validate scope key — no path traversal
    if (/[/\\]|\.\./.test(key)) {
      return reply.code(400).send({ error: 'Invalid scope key' });
    }

    const scopePath = path.join(config.agent.workspace, SCOPE_DIR_NAME, key);
    if (!fs.existsSync(scopePath)) {
      return reply.code(404).send({ error: 'Scope not found' });
    }

    // Read USER.md
    const userMdPath = path.join(scopePath, 'USER.md');
    const userMd = fs.existsSync(userMdPath) ? fs.readFileSync(userMdPath, 'utf8') : '';

    // Read PROFILE.md
    const profilePath = path.join(scopePath, 'memory', 'PROFILE.md');
    const profile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';

    // Read recent sessions
    const sessionsDir = path.join(scopePath, 'memory', 'sessions');
    const sessions: Array<{ date: string; content: string }> = [];
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 7); // Last 7 days
      for (const file of files) {
        const content = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
        sessions.push({ date: file.replace('.md', ''), content });
      }
    }

    return {
      scopeKey: key,
      userMd,
      profile,
      sessions,
    };
  });
};
