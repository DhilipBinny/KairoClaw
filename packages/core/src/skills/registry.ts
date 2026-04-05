/**
 * Skill registry — discovers, loads, and manages skills from the workspace.
 *
 * Skills are markdown files with YAML frontmatter in workspace/skills/.
 * Each subdirectory containing a SKILL.md file is treated as a skill.
 *
 * Inspired by Claude Code's skill system (src/skills/loadSkillsDir.ts)
 * and Anthropic's skills spec (github.com/anthropics/skills).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Skill, SkillFrontmatter } from './types.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('plugins'); // skills use 'plugins' log category

/** Maximum size for a skill file — prevents context bloat */
const MAX_SKILL_FILE_CHARS = 10_000;

/**
 * Parse YAML-like frontmatter from a markdown string.
 * Handles: name, description, channels (array), tools (array).
 * Lightweight — no YAML library needed.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return null;

  const [, fmBlock, body] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of fmBlock!.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Handle arrays: [item1, item2] or YAML list syntax
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body: body!.trim() };
}

/**
 * Validate frontmatter has required fields.
 */
function validateFrontmatter(fm: Record<string, unknown>, filePath: string): SkillFrontmatter | null {
  if (!fm.name || typeof fm.name !== 'string') {
    log.warn({ filePath }, 'Skill missing required "name" in frontmatter, skipping');
    return null;
  }
  if (!fm.description || typeof fm.description !== 'string') {
    log.warn({ filePath, name: fm.name }, 'Skill missing required "description" in frontmatter, skipping');
    return null;
  }

  return {
    name: fm.name as string,
    description: fm.description as string,
    channels: Array.isArray(fm.channels) ? fm.channels as string[] : undefined,
    tools: Array.isArray(fm.tools) ? fm.tools as string[] : undefined,
  };
}

/**
 * Load all valid skills from a directory into a Map.
 * Used for both shared and user-scoped skill directories.
 */
function loadSkillsFromDir(dirPath: string): Map<string, Skill> {
  const result = new Map<string, Skill>();
  if (!fs.existsSync(dirPath)) return result;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skills can be:
    // 1. A directory with SKILL.md inside: skills/pdf/SKILL.md
    // 2. A standalone .md file: skills/translate.md
    let skillPath: string;
    let relativePath: string;

    if (entry.isDirectory()) {
      skillPath = path.join(dirPath, entry.name, 'SKILL.md');
      relativePath = path.join(entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      skillPath = path.join(dirPath, entry.name);
      relativePath = entry.name;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillPath, 'utf8');

      // Size limit — prevent context bloat
      if (content.length > MAX_SKILL_FILE_CHARS) {
        log.warn(
          { filePath: relativePath, size: content.length, max: MAX_SKILL_FILE_CHARS },
          `Skill file too large (${content.length} chars > ${MAX_SKILL_FILE_CHARS} max), skipping`,
        );
        continue;
      }

      const parsed = parseFrontmatter(content);
      if (!parsed) {
        log.warn({ filePath: relativePath }, 'Skill file has no YAML frontmatter (---), skipping. See https://github.com/anthropics/skills for the correct format.');
        continue;
      }

      const meta = validateFrontmatter(parsed.frontmatter, relativePath);
      if (!meta) continue;

      if (result.has(meta.name)) {
        log.warn({ name: meta.name, filePath: relativePath }, 'Duplicate skill name, skipping');
        continue;
      }

      result.set(meta.name, {
        meta,
        instructions: parsed.body,
        filePath: relativePath,
      });
    } catch (err) {
      log.warn({ filePath: relativePath, err: (err as Error).message }, 'Failed to load skill');
    }
  }

  return result;
}

/**
 * Skill registry — scans workspace/skills/ for SKILL.md files.
 */
export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private skillsDir: string;
  private workspace: string;

  constructor(workspacePath: string) {
    this.workspace = workspacePath;
    this.skillsDir = path.join(workspacePath, 'skills');
  }

  /**
   * Scan the shared skills directory and load all valid skills.
   * Call this at startup and after workspace changes.
   */
  loadSkills(): void {
    this.skills = loadSkillsFromDir(this.skillsDir);
    log.info({ count: this.skills.size, skills: [...this.skills.keys()] }, `Loaded ${this.skills.size} shared skills`);
  }

  /**
   * Get the user-scoped skills directory for a given scope key.
   */
  getUserSkillsDir(scopeKey: string): string {
    return path.join(this.workspace, 'scopes', scopeKey, 'skills');
  }

  /**
   * Load user-scoped skills for a given scope key.
   * Returns only that user's skills (not merged with shared).
   */
  getUserSkills(scopeKey: string): Map<string, Skill> {
    return loadSkillsFromDir(this.getUserSkillsDir(scopeKey));
  }

  /**
   * List all skills visible to a session — shared skills merged with
   * user-scoped skills. User skills override shared skills with the same name.
   */
  listMerged(scopeKey?: string | null): SkillFrontmatter[] {
    const merged = new Map(this.skills); // copy shared
    if (scopeKey) {
      for (const [name, skill] of this.getUserSkills(scopeKey)) {
        merged.set(name, skill); // user overrides shared
      }
    }
    return [...merged.values()].map(s => s.meta);
  }

  /**
   * Get a skill by name, checking user scope first, then shared.
   * User-scoped skill overrides shared skill with the same name.
   */
  getForScope(name: string, scopeKey?: string | null): Skill | undefined {
    if (scopeKey) {
      const userSkills = this.getUserSkills(scopeKey);
      if (userSkills.has(name)) return userSkills.get(name);
    }
    return this.skills.get(name);
  }

  /**
   * Get a shared skill by name.
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * List all loaded shared skills (metadata only — no instructions).
   */
  list(): SkillFrontmatter[] {
    return [...this.skills.values()].map(s => s.meta);
  }

  /**
   * List shared skills relevant to a specific channel.
   */
  listForChannel(channel: string): SkillFrontmatter[] {
    return this.list().filter(s => !s.channels || s.channels.length === 0 || s.channels.includes(channel));
  }

  /**
   * Check if a shared skill exists.
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get shared skill count.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Get the shared skills directory path.
   */
  get directory(): string {
    return this.skillsDir;
  }
}
