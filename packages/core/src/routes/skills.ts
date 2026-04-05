/**
 * Skill management routes — list, view, edit, delete skills.
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

  // GET /api/v1/skills — list all skills
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

  // GET /api/v1/skills/:name — read a skill's full content
  app.get('/api/v1/skills/:name', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };

    // Security: no path traversal
    if (/[/\\]|\.\./.test(name)) {
      return reply.code(400).send({ error: 'Invalid skill name' });
    }

    const skill = skillRegistry.get(name);
    if (!skill) {
      return reply.code(404).send({ error: `Skill "${name}" not found` });
    }

    // Read the raw file content (frontmatter + body)
    const filePath = path.join(skillRegistry.directory, `${name}.md`);
    let content = '';
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, 'utf8');
    }

    return { name, description: skill.meta.description, content };
  });

  // PUT /api/v1/skills/:name — update a skill's content
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

    // Reload registry
    skillRegistry.loadSkills();
    log.info({ skill: name, size: content.length }, 'Skill updated via admin');

    return { success: true, name, size: content.length };
  });

  // DELETE /api/v1/skills/:name — delete a skill
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
    log.info({ skill: name }, 'Skill deleted via admin');

    return { success: true, name };
  });
};
