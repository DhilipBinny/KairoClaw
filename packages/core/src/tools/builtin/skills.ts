/**
 * Skill tools — lets the agent discover, load, and create skills.
 *
 * The agent sees a list of available skills in the system prompt (names +
 * descriptions only). When it decides to use a skill, it calls load_skill
 * to get the full instructions for that skill. The create_skill tool
 * validates and saves new skills following the Anthropic skills format.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import type { SkillRegistry } from '../../skills/registry.js';
import { createModuleLogger } from '../../observability/logger.js';
import { getWorkspace } from './utils.js';

const log = createModuleLogger('plugins');

let skillRegistry: SkillRegistry | null = null;

/** Wire up the skill registry. Called from index.ts at startup. */
export function setSkillRegistry(registry: SkillRegistry): void {
  skillRegistry = registry;
}

/** Slash command names that cannot be used as skill names. */
const RESERVED_NAMES = new Set(['new', 'reset', 'status', 'stop', 'compact', 'model', 'help', 'sessions']);

/** Maximum skill file size in characters (enforced on create/save). */
const MAX_SKILL_CONTENT_CHARS = 10_000;

/** Maximum instructions length returned by load_skill (truncated if larger). */
const MAX_LOAD_INSTRUCTIONS_CHARS = 5_000;

/** Warn when skill instructions exceed this size (may overflow small model contexts). */
const LARGE_SKILL_WARN_CHARS = 3_000;

export const skillTools: ToolRegistration[] = [
  {
    definition: {
      name: 'load_skill',
      description: 'Load a skill\'s full instructions by name. Use this when you need detailed guidance for a specialized task. Call list_skills first to see what\'s available.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name to load (e.g. "summarize", "translate", "research")' },
        },
        required: ['name'],
      },
    },
    executor: async (args, context) => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      const name = args.name as string;
      const scopeKey = context.scopeKey ?? null;
      const skill = skillRegistry.getForScope(name, scopeKey);

      if (!skill) {
        const available = skillRegistry.listMerged(scopeKey).map(s => s.name);
        return {
          error: `Skill "${name}" not found`,
          available,
          hint: available.length > 0
            ? `Available skills: ${available.join(', ')}`
            : 'No skills are installed. Skills can be added to the workspace/skills/ directory.',
        };
      }

      // Warn if large skill is loaded (may overflow small model contexts)
      if (skill.instructions.length > LARGE_SKILL_WARN_CHARS) {
        log.warn(
          { skill: name, instructionLen: skill.instructions.length },
          'Large skill loaded — may consume significant context on small models',
        );
      }

      // Truncate if over the load limit (protects context window)
      const instructions = skill.instructions.length > MAX_LOAD_INSTRUCTIONS_CHARS
        ? skill.instructions.slice(0, MAX_LOAD_INSTRUCTIONS_CHARS) + '\n\n[... skill instructions truncated ...]'
        : skill.instructions;

      // Include channel context so the model can adapt output format
      const channel = (context as Record<string, unknown>).channel as string | undefined;
      const formatNote = (channel === 'telegram' || channel === 'whatsapp')
        ? 'Output for mobile messaging — avoid markdown tables, keep formatting simple, use short bullet points'
        : undefined;

      return {
        skill: skill.meta.name,
        description: skill.meta.description,
        instructions,
        ...(skill.meta.tools ? { recommendedTools: skill.meta.tools } : {}),
        ...(channel ? { channel } : {}),
        ...(formatNote ? { formatNote } : {}),
      };
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  },
  {
    definition: {
      name: 'list_skills',
      description: 'List all available skills with their descriptions.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    executor: async (_args, context) => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      const scopeKey = context.scopeKey ?? null;
      const skills = skillRegistry.listMerged(scopeKey);
      if (skills.length === 0) {
        return { skills: [], note: 'No skills installed. Add SKILL.md files to workspace/skills/ directory.' };
      }

      return {
        skills: skills.map(s => ({
          name: s.name,
          description: s.description,
          invoke: `/${s.name}`,
        })),
      };
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  },
  {
    definition: {
      name: 'create_skill',
      description: 'Create a new personal skill. Saves to your user scope — only you will see it. To create shared skills for all users, use the admin UI at /admin/skills.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (lowercase with hyphens, e.g. "property-inquiry")' },
          description: { type: 'string', description: 'One-line description of what the skill does' },
          content: { type: 'string', description: 'Full skill instructions in markdown (WITHOUT frontmatter — it will be added automatically)' },
        },
        required: ['name', 'description', 'content'],
      },
    },
    executor: async (args, context) => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      // Require user scope — agent skills are always user-scoped, never shared
      const scopeKey = context.scopeKey;
      if (!scopeKey) {
        return { error: 'Cannot create skills without a user context. Use the admin UI at /admin/skills to create shared skills.' };
      }

      const name = (args.name as string).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const description = args.description as string;
      const content = args.content as string;

      if (!name) return { error: 'Skill name is required' };
      if (!description) return { error: 'Skill description is required' };
      if (!content) return { error: 'Skill content is required' };
      if (name.length > 50) return { error: 'Skill name too long (max 50 chars)' };

      // Prevent shadowing built-in slash commands
      if (RESERVED_NAMES.has(name)) {
        return { error: `"${name}" is a reserved command name and cannot be used as a skill name` };
      }

      // Enforce content size limit
      if (content.length > MAX_SKILL_CONTENT_CHARS) {
        return { error: `Skill content too large (${content.length} chars). Maximum is ${MAX_SKILL_CONTENT_CHARS} chars.` };
      }

      // Write to user scope only — never touches shared skills/
      const workspace = getWorkspace(context as Record<string, unknown>);
      const userSkillsDir = skillRegistry.getUserSkillsDir(scopeKey);

      // Path traversal protection
      const skillPath = path.join(userSkillsDir, `${name}.md`);
      const resolved = path.resolve(skillPath);
      const resolvedDir = path.resolve(userSkillsDir);
      if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
        return { error: 'Invalid skill name' };
      }

      // Build the file with proper frontmatter (agent doesn't need to worry about format)
      const fileContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;

      try {
        fs.mkdirSync(userSkillsDir, { recursive: true });
        fs.writeFileSync(skillPath, fileContent, 'utf8');
      } catch (e) {
        return { error: `Failed to save skill: ${e instanceof Error ? e.message : String(e)}` };
      }

      log.info({ skill: name, scopeKey, size: fileContent.length }, 'User skill created');
      void workspace; // used for future scope validation if needed

      return {
        success: true,
        skill: name,
        path: `scopes/${scopeKey}/skills/${name}.md`,
        invoke: `/${name}`,
        message: `Skill "${name}" created and active. Invoke it with /${name}`,
      };
    },
    source: 'builtin',
    category: 'write',
  },
];
