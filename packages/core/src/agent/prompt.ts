/**
 * System prompt builder.
 *
 * Reads workspace files (IDENTITY.md, SOUL.md, RULES.md, USER.md)
 * and injects them into the system prompt alongside tool descriptions and
 * runtime context.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { GatewayConfig } from '@agw/types';
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
 * @param config   Gateway configuration (provides agent name, workspace, model).
 * @param tools    Tool definitions to list in the prompt (optional).
 * @param scopeKey Scope key for per-user memory isolation (optional).
 */
export function buildSystemPrompt(
  config: GatewayConfig,
  tools: ToolDefinition[] = [],
  scopeKey?: string | null,
): string {
  const workspace = config.agent.workspace;

  const sections: string[] = [];

  // Identity
  sections.push(
    `You are ${config.agent.name}, a personal AI assistant running on a self-hosted agentic gateway.`,
  );

  // Tooling
  if (tools.length > 0) {
    sections.push('## Tools');
    sections.push('You have access to the following tools:\n');
    for (const t of tools) {
      sections.push(`- **${t.name}**: ${t.description}`);
    }
    sections.push(
      '\nCall tools by returning tool_use blocks. Wait for results before proceeding.',
    );
  }

  // Safety — product-level guardrails from constants.ts (not user-editable)
  sections.push(`## Safety\n${SAFETY_RULES.map(r => `- ${r}`).join('\n')}`);

  // Workspace
  sections.push(`## Workspace
Your working directory is: ${workspace}

File organization rules:
- **documents/** — save any generated documents, research, reports, plans, or exports here
- **media/** — images and media files (managed by the system)
- **scopes/** — per-user memory (managed by the system, do not write here directly)
- Do NOT create .md files in the workspace root — the root is reserved for system persona files
- When the user asks you to create a file, save it to documents/ unless they specify a different path`);

  // Time
  sections.push(`## Current Date & Time
${new Date().toISOString()}
Model: ${config.model.primary}`);

  // Silent replies
  sections.push(`## Silent Replies
When you have nothing to say, respond with ONLY: NO_REPLY
It must be your ENTIRE message — nothing else.`);

  // Memory — tell the agent the correct paths for its scope
  const memoryBasePath = scopeKey
    ? `scopes/${scopeKey}/memory`
    : 'memory';
  sections.push(`## Memory
You wake up fresh each session. Your memory files are your continuity:
- **${memoryBasePath}/PROFILE.md** — long-term memory (preferences, key facts, consolidated from sessions)
- **${memoryBasePath}/sessions/YYYY-MM-DD.md** — recent session notes (last 7 days, auto-extracted)
If someone says "remember this", write it to ${memoryBasePath}/PROFILE.md.`);

  // Inject layered memory: profile + recent sessions (scoped per user)
  const memoryDir = getScopedMemoryDir(workspace, scopeKey ?? null);
  const profilePath = path.join(memoryDir, 'PROFILE.md');
  if (fs.existsSync(profilePath)) {
    const profile = fs.readFileSync(profilePath, 'utf8').slice(0, MEMORY_PROFILE_MAX_CHARS);
    if (profile.trim()) {
      sections.push(`### User Profile (Long-Term Memory)\n${profile}`);
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
      sections.push(`### Recent Sessions\n${sessionSummaries.join('\n\n')}`);
    }
  }

  // Inject workspace files (IDENTITY, SOUL, RULES are global; USER.md cascades per scope)
  sections.push('\n## Project Context (Workspace Files)');
  for (const filename of PROMPT_BOOTSTRAP_FILES) {
    const filePath = resolveScopedFile(workspace, filename, scopeKey ?? null);
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.length > PROMPT_MAX_FILE_CHARS) {
        content = content.slice(0, PROMPT_MAX_FILE_CHARS) + '\n\n[... truncated ...]';
      }
      if (content.trim()) {
        sections.push(`### ${filename}\n${content}`);
      }
    }
  }

  return sections.join('\n\n');
}
