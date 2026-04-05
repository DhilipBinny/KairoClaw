/**
 * Skill management routes — list, view, edit, delete skills.
 * Covers both shared skills (workspace/skills/) and
 * user-scoped skills (workspace/scopes/{scopeKey}/skills/).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getConfig } from './utils.js';
import type { SkillRegistry } from '../skills/registry.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('plugins');

export interface SkillRoutesOptions {
  skillRegistry: SkillRegistry;
}

/** Slash command names that cannot be used as skill names. */
const RESERVED_NAMES = new Set(['new', 'reset', 'status', 'stop', 'compact', 'model', 'help', 'sessions']);

/** Maximum skill file size in characters. */
const MAX_SKILL_CONTENT_CHARS = 10_000;

export const registerSkillRoutes: FastifyPluginAsync<SkillRoutesOptions> = async (app, opts) => {
  const { skillRegistry } = opts;

  // ── Shared skills ────────────────────────────────────────────

  // GET /api/v1/skills — list all shared skills
  app.get('/api/v1/skills', { preHandler: [requireRole('admin')] }, async () => {
    const skills = skillRegistry.list();
    const dir = skillRegistry.directory;

    return {
      skills: skills.map(s => {
        const filePath = path.join(dir, `${s.name}.md`);
        let size = 0;
        let modified: string | null = null;
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          size = stat.size;
          modified = stat.mtime.toISOString();
        }
        return { name: s.name, description: s.description, size, modified };
      }),
    };
  });

  // GET /api/v1/skills/users — list all user-scoped skills grouped by scope
  // Must be registered BEFORE /api/v1/skills/:name to avoid route conflict
  app.get('/api/v1/skills/users', { preHandler: [requireRole('admin')] }, async (request) => {
    const config = getConfig(request);
    const workspace = config.agent?.workspace || '';
    const scopesDir = path.join(workspace, 'scopes');

    if (!fs.existsSync(scopesDir)) {
      return { users: [] };
    }

    const result: Array<{ scopeKey: string; skills: Array<{ name: string; description: string; size: number; modified: string | null }> }> = [];

    const scopes = fs.readdirSync(scopesDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const scope of scopes) {
      const userSkillsDir = path.join(scopesDir, scope.name, 'skills');
      if (!fs.existsSync(userSkillsDir)) continue;

      const userSkills = skillRegistry.getUserSkills(scope.name);
      if (userSkills.size === 0) continue;

      result.push({
        scopeKey: scope.name,
        skills: [...userSkills.values()].map(s => {
          const filePath = path.join(userSkillsDir, `${s.meta.name}.md`);
          let size = 0;
          let modified: string | null = null;
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            size = stat.size;
            modified = stat.mtime.toISOString();
          }
          return { name: s.meta.name, description: s.meta.description, size, modified };
        }),
      });
    }

    return { users: result };
  });

  // GET /api/v1/skills/users/:scopeKey/:name — read a user skill
  app.get('/api/v1/skills/users/:scopeKey/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { scopeKey, name } = request.params as { scopeKey: string; name: string };
    const config = getConfig(request);
    const workspace = config.agent?.workspace || '';

    if (/[/\\]|\.\./.test(scopeKey) || /[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid scope key or skill name' });
    }

    const filePath = path.join(workspace, 'scopes', scopeKey, 'skills', `${name}.md`);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: `User skill "${name}" not found for scope "${scopeKey}"` });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const userSkills = skillRegistry.getUserSkills(scopeKey);
    const skill = userSkills.get(name);

    return {
      name,
      scopeKey,
      description: skill?.meta.description ?? '',
      content,
    };
  });

  // DELETE /api/v1/skills/users/:scopeKey/:name — admin delete a user skill
  app.delete('/api/v1/skills/users/:scopeKey/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { scopeKey, name } = request.params as { scopeKey: string; name: string };
    const config = getConfig(request);
    const workspace = config.agent?.workspace || '';

    if (/[/\\]|\.\./.test(scopeKey) || /[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid scope key or skill name' });
    }

    const filePath = path.join(workspace, 'scopes', scopeKey, 'skills', `${name}.md`);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: `User skill "${name}" not found` });
    }

    fs.unlinkSync(filePath);
    log.info({ skill: name, scopeKey }, 'User skill deleted by admin');

    return { success: true, name, scopeKey };
  });

  // GET /api/v1/skills/:name — read a shared skill's full content
  app.get('/api/v1/skills/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };

    if (/[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    const skill = skillRegistry.get(name);
    if (!skill) {
      return reply.code(404).send({ error: `Skill "${name}" not found` });
    }

    const filePath = path.join(skillRegistry.directory, `${name}.md`);
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }

    return { name, description: skill.meta.description, content };
  });

  // PUT /api/v1/skills/:name — create or update a shared skill
  app.put('/api/v1/skills/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { content } = request.body as { content?: string };

    if (/[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content must be a string' });
    }
    if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
      return reply.code(400).send({ error: 'Skill file must start with YAML frontmatter (---)' });
    }
    if (RESERVED_NAMES.has(name)) {
      return reply.code(400).send({ error: `"${name}" is a reserved command name and cannot be used as a skill name` });
    }
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      return reply.code(400).send({ error: `Skill content too large (${content.length} chars). Maximum is ${MAX_SKILL_CONTENT_CHARS} chars.` });
    }

    const filePath = path.join(skillRegistry.directory, `${name}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');

    skillRegistry.loadSkills();
    log.info({ skill: name, size: content.length }, 'Shared skill saved via admin');

    return { success: true, name, size: content.length };
  });

  // DELETE /api/v1/skills/:name — delete a shared skill
  app.delete('/api/v1/skills/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };

    if (/[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    const filePath = path.join(skillRegistry.directory, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: `Skill "${name}" not found` });
    }

    fs.unlinkSync(filePath);
    skillRegistry.loadSkills();
    log.info({ skill: name }, 'Shared skill deleted via admin');

    return { success: true, name };
  });
};
