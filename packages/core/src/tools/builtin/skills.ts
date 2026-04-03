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

let skillRegistry: SkillRegistry | null = null;

/** Wire up the skill registry. Called from index.ts at startup. */
export function setSkillRegistry(registry: SkillRegistry): void {
  skillRegistry = registry;
}

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
    executor: async (args) => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      const name = args.name as string;
      const skill = skillRegistry.get(name);

      if (!skill) {
        const available = skillRegistry.list().map(s => s.name);
        return {
          error: `Skill "${name}" not found`,
          available,
          hint: available.length > 0
            ? `Available skills: ${available.join(', ')}`
            : 'No skills are installed. Skills can be added to the workspace/skills/ directory.',
        };
      }

      return {
        skill: skill.meta.name,
        description: skill.meta.description,
        instructions: skill.instructions,
        ...(skill.meta.tools ? { recommendedTools: skill.meta.tools } : {}),
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
    executor: async () => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      const skills = skillRegistry.list();
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
      description: 'Create a new skill file. Validates the Anthropic skills format (YAML frontmatter with name + description required). Saves to the skills/ directory and reloads the registry.',
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
    executor: async (args) => {
      if (!skillRegistry) {
        return { error: 'Skill system not initialized' };
      }

      const name = (args.name as string).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const description = args.description as string;
      const content = args.content as string;

      if (!name) return { error: 'Skill name is required' };
      if (!description) return { error: 'Skill description is required' };
      if (!content) return { error: 'Skill content is required' };
      if (name.length > 50) return { error: 'Skill name too long (max 50 chars)' };

      // Build the file with proper frontmatter (agent doesn't need to worry about format)
      const fileContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;

      const skillPath = path.join(skillRegistry.directory, `${name}.md`);

      try {
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, fileContent, 'utf8');
      } catch (e) {
        return { error: `Failed to save skill: ${e instanceof Error ? e.message : String(e)}` };
      }

      // Reload registry so the skill is immediately available
      skillRegistry.loadSkills();

      return {
        success: true,
        skill: name,
        path: `skills/${name}.md`,
        invoke: `/${name}`,
        message: `Skill "${name}" created and active. Users can invoke it with /${name}`,
      };
    },
    source: 'builtin',
    category: 'write',
  },
];
