/**
 * System prompt builder.
 *
 * Reads workspace files (IDENTITY.md, SOUL.md, RULES.md, USER.md)
 * and injects them into the system prompt alongside tool descriptions and
 * runtime context.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { GatewayConfig, StructuredSystemPrompt } from '@agw/types';
import type { ToolDefinition } from '@agw/types';
import {
  SAFETY_RULES,
  PROMPT_BOOTSTRAP_FILES,
  PROMPT_MAX_FILE_CHARS,
  MEMORY_PROFILE_MAX_CHARS,
  MEMORY_SESSION_MAX_CHARS,
  MEMORY_RECENT_DAYS,
} from '../constants.js';
import { resolveScopedFile, getScopedMemoryDir } from './scope.js';

/**
 * Build the full system prompt from config, workspace files, and tool
 * definitions.
 *
 * Returns a StructuredSystemPrompt with separate `cached` and `dynamic`
 * sections. The cached prefix (identity, tools, safety, workspace rules,
 * persona files) is stable across turns — Anthropic caches it for 5 min,
 * saving ~90% on input token costs. The dynamic suffix (time, memory,
 * compaction guidance) changes every call.
 *
 * @param config   Gateway configuration (provides agent name, workspace, model).
 * @param tools    Tool definitions to list in the prompt (optional).
 * @param scopeKey Scope key for per-user memory isolation (optional).
 */
export function buildSystemPrompt(
  config: GatewayConfig,
  tools: ToolDefinition[] = [],
  scopeKey?: string | null,
): StructuredSystemPrompt {
  const workspace = config.agent.workspace;

  // ── CACHED PREFIX (stable across turns within a session) ────────

  const cached: string[] = [];

  // Identity
  cached.push(
    `You are ${config.agent.name}, a personal AI assistant running on a self-hosted agentic gateway.`,
  );

  // Tooling
  if (tools.length > 0) {
    cached.push('## Tools');
    cached.push('You have access to the following tools:\n');
    for (const t of tools) {
      cached.push(`- **${t.name}**: ${t.description}`);
    }
    cached.push(
      '\nCall tools by returning tool_use blocks. Wait for results before proceeding.',
    );

  }

  // Safety — product-level guardrails from constants.ts (not user-editable)
  cached.push(`## Safety\n${SAFETY_RULES.map(r => `- ${r}`).join('\n')}`);

  // Workspace — do NOT expose absolute server path or other users' scopes
  const workspaceSection = scopeKey
    ? `## Workspace
You have two file areas:
- **documents/** — your personal documents (only you can access). Files you create go here by default.
- **shared/documents/** — team-shared documents (all users can access). Use when user explicitly asks to share.
- **media/** — your personal media and uploads
- **shared/media/** — team-shared media
- Your memory files are managed by the system automatically.
- Do NOT create .md files in the workspace root — reserved for system files.

When the user asks to create/save a file → save to documents/ (personal).
When the user says "save to shared" or "share this" → save to shared/documents/.

SCOPE BOUNDARY: You are serving a single user. Do not access other users' directories.`
    : `## Workspace
File organization:
- **shared/documents/** — save documents, research, reports, plans here
- **shared/media/** — images and media files
- Do NOT create .md files in the workspace root — reserved for system files.
- When the user asks to create a file, save it to shared/documents/.`;
  cached.push(workspaceSection);

  // Context compaction guidance (stable rules)
  cached.push(`## Compacted Context
If you see a [Context Summary] system message, your conversation history was compacted. Follow these rules:
- Focus on items under "## Active Tasks" — these are your current objectives
- Treat "## Resolved Topics" as historical record only — do NOT revisit, re-investigate, or reference these unless the user explicitly asks
- Use "## Key Facts" as reference data
- Use "## Current Work" to understand what was happening right before compaction — resume from here
- If unsure whether something is still relevant, ask the user or use tools to verify — do NOT assume from the summary`);

  // Silent replies (stable rule)
  cached.push(`## Silent Replies
When you have nothing to say, respond with ONLY: NO_REPLY
It must be your ENTIRE message — nothing else.`);

  // Memory path guidance (stable for this scope)
  const memoryBasePath = scopeKey
    ? `scopes/${scopeKey}/memory`
    : 'memory';
  cached.push(`## Memory
You wake up fresh each session. Your memory files are your continuity:
- **${memoryBasePath}/PROFILE.md** — long-term memory (preferences, key facts, consolidated from sessions)
- **${memoryBasePath}/sessions/YYYY-MM-DD.md** — recent session notes (last 7 days, auto-extracted)
If someone says "remember this", write it to ${memoryBasePath}/PROFILE.md.`);

  // Inject workspace files (IDENTITY, SOUL, RULES are global; USER.md cascades per scope)
  // These change rarely (only when admin edits persona files) — cacheable
  cached.push('\n## Project Context (Workspace Files)');
  for (const filename of PROMPT_BOOTSTRAP_FILES) {
    const filePath = resolveScopedFile(workspace, filename, scopeKey ?? null);
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.length > PROMPT_MAX_FILE_CHARS) {
        content = content.slice(0, PROMPT_MAX_FILE_CHARS) + '\n\n[... truncated ...]';
      }
      if (content.trim()) {
        cached.push(`### ${filename}\n${content}`);
      }
    }
  }

  // ── DYNAMIC SUFFIX (changes every turn) ─────────────────────────

  const dynamic: string[] = [];

  // Time (changes every call)
  dynamic.push(`## Current Date & Time
${new Date().toISOString()}
Model: ${config.model.primary}`);

  // Inject layered memory: profile + recent sessions (scoped per user)
  // Memory content changes as conversations happen — dynamic
  const memoryDir = getScopedMemoryDir(workspace, scopeKey ?? null);
  const profilePath = path.join(memoryDir, 'PROFILE.md');
  if (fs.existsSync(profilePath)) {
    const profile = fs.readFileSync(profilePath, 'utf8').slice(0, MEMORY_PROFILE_MAX_CHARS);
    if (profile.trim()) {
      dynamic.push(`### User Profile (Long-Term Memory)\n${profile}`);
    }
  }

  const sessionsDir = path.join(memoryDir, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessionFiles = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, MEMORY_RECENT_DAYS); // Last 3 days
    const sessionSummaries: string[] = [];
    for (const file of sessionFiles) {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf8').slice(0, MEMORY_SESSION_MAX_CHARS);
      if (content.trim()) {
        sessionSummaries.push(`#### ${file.replace('.md', '')}\n${content}`);
      }
    }
    if (sessionSummaries.length > 0) {
      dynamic.push(`### Recent Sessions\n${sessionSummaries.join('\n\n')}`);
    }
  }

  return {
    cached: cached.join('\n\n'),
    dynamic: dynamic.join('\n\n'),
  };
}
