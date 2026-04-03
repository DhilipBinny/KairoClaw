/**
 * Skill system types.
 *
 * Skills are markdown instruction files with YAML frontmatter that teach
 * the agent how to handle specialized tasks. They're loaded from the
 * workspace/skills/ directory and can be invoked via slash commands
 * or auto-discovered by the agent.
 */

export interface SkillFrontmatter {
  /** Unique skill name (lowercase, hyphens). Used as slash command: /skill-name */
  name: string;
  /** Human-readable description. Shown to the agent for auto-discovery. */
  description: string;
  /** Optional: which channels this skill applies to (e.g. ['telegram', 'whatsapp']). Empty = all. */
  channels?: string[];
  /** Optional: specific tools this skill needs. Agent is told to prefer these. */
  tools?: string[];
}

export interface Skill {
  /** Parsed frontmatter metadata. */
  meta: SkillFrontmatter;
  /** Full markdown instructions (loaded lazily on invoke). */
  instructions: string;
  /** File path relative to skills directory. */
  filePath: string;
}
