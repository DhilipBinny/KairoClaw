/**
 * Skill tools — lets the agent discover and load skill instructions.
 *
 * The agent sees a list of available skills in the system prompt (names +
 * descriptions only). When it decides to use a skill, it calls load_skill
 * to get the full instructions for that skill.
 */

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
];
