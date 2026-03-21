/**
 * Auto-Memory System — Layered Memory for Agent Continuity
 *
 * Two layers:
 *   1. PROFILE.md (long-term) — permanent user profile, preferences, key facts
 *   2. sessions/YYYY-MM-DD.md (short-term) — daily session notes, auto-expires after 7 days
 *
 * Flow:
 *   - After each real conversation (not cron), extract NEW facts
 *   - Read existing profile + today's notes before saving (dedup)
 *   - Append only genuinely new information to session file
 *   - Periodically consolidate sessions → update profile
 *   - Clean up expired session files (>7 days)
 *
 * See docs/MEMORY.md for full design documentation.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/index.js';
import type { GatewayConfig, ChatArgs, ProviderResponse } from '@agw/types';
import { MessageRepository } from '../db/repositories/message.js';
import { MEMORY_SESSION_RETENTION_DAYS, MEMORY_MIN_TURNS, MEMORY_MAX_CONVERSATION_CHARS } from '../constants.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('memory');

const PROFILE_FILE = 'memory/PROFILE.md';
const SESSIONS_DIR = 'memory/sessions';
const SESSION_RETENTION_DAYS = MEMORY_SESSION_RETENTION_DAYS;

// ── Helpers ─────────────────────────────────────

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch { return ''; }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

// ── Auto-Summarize (called after each session) ──

/**
 * Extract NEW facts from a session and save to layered memory.
 * Skips cron sessions, short sessions, and deduplicates against existing memory.
 */
export async function autoSummarizeToMemory(opts: {
  sessionId: string;
  channel: string;
  db: DatabaseAdapter;
  config: GatewayConfig;
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
  minTurns?: number;
}): Promise<void> {
  const { sessionId, channel, db, config, callLLM, minTurns = MEMORY_MIN_TURNS } = opts;
  const workspace = config.agent.workspace;
  const messageRepo = new MessageRepository(db);

  // Skip non-conversational sessions (cron jobs, sub-agents)
  if (channel === 'cron' || channel === 'internal') {
    log.debug({ channel }, 'Auto-memory: skipping non-conversational session');
    return;
  }

  try {
    const messages = messageRepo.listBySession(sessionId);
    const userMessages = messages.filter(m => m.role === 'user');

    if (userMessages.length < minTurns) return;

    // Build conversation text
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 500) : '[multimodal]'}`)
      .join('\n')
      .slice(0, MEMORY_MAX_CONVERSATION_CHARS);

    // Read existing memory for deduplication
    const profilePath = path.join(workspace, PROFILE_FILE);
    const existingProfile = readFileOrEmpty(profilePath);

    const date = new Date().toISOString().split('T')[0];
    const sessionsDir = path.join(workspace, SESSIONS_DIR);
    const sessionFile = path.join(sessionsDir, `${date}.md`);
    const existingSessionNotes = readFileOrEmpty(sessionFile);

    const existingMemory = [
      existingProfile ? `## Existing Profile:\n${existingProfile.slice(0, 3000)}` : '',
      existingSessionNotes ? `## Today's Notes:\n${existingSessionNotes.slice(0, 2000)}` : '',
    ].filter(Boolean).join('\n\n');

    // Ask LLM to extract ONLY NEW facts
    const response = await callLLM({
      messages: [{
        role: 'user',
        content: `You are a memory extraction assistant. Extract ONLY NEW facts from this conversation that are NOT already captured in existing memory.

${existingMemory ? `### Already Known:\n${existingMemory}\n` : ''}
### New Conversation:\n${conversationText}

Rules:
- Only include genuinely NEW information not already in existing memory
- Format as bullet points
- Include: user preferences, decisions, project context, key outcomes
- Skip: greetings, debugging details, error messages, tool outputs
- If nothing new to remember, respond with just "NOTHING"
- Be concise — each bullet should be one line`,
      }],
      model: config.model.primary,
      systemPrompt: 'Extract only NEW facts not already in memory. Be concise. Respond NOTHING if no new information.',
    });

    const summary = response.text?.trim();
    if (!summary || summary === 'NOTHING' || summary.length < 20) {
      log.debug('Auto-memory: nothing new to save');
      return;
    }

    // Append to daily session file
    ensureDir(sessionsDir);
    const timestamp = new Date().toLocaleTimeString();
    const entry = `\n## ${timestamp} (${channel})\n${summary}\n`;
    fs.appendFileSync(sessionFile, entry, 'utf8');

    log.info({
      file: `${SESSIONS_DIR}/${date}.md`,
      summaryLength: summary.length,
      channel,
    }, 'Auto-memory: saved session notes');

    // Clean up expired session files
    cleanExpiredSessions(sessionsDir);

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ err: msg }, 'Auto-memory: failed to summarize session');
  }
}

// ── Consolidation (merge sessions → profile) ────

/**
 * Consolidate recent session notes into the long-term profile.
 * Reads all session files + existing profile → LLM produces updated profile.
 * Called periodically (e.g., daily via cron or on-demand).
 */
export async function consolidateMemory(opts: {
  config: GatewayConfig;
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
}): Promise<void> {
  const { config, callLLM } = opts;
  const workspace = config.agent.workspace;
  const profilePath = path.join(workspace, PROFILE_FILE);
  const sessionsDir = path.join(workspace, SESSIONS_DIR);

  const existingProfile = readFileOrEmpty(profilePath);

  // Read all session files
  let sessionNotes = '';
  try {
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.md'))
        .sort();
      for (const file of files) {
        const content = readFileOrEmpty(path.join(sessionsDir, file));
        if (content.trim()) {
          sessionNotes += `\n### ${file.replace('.md', '')}\n${content}\n`;
        }
      }
    }
  } catch { /* non-critical */ }

  if (!sessionNotes.trim()) {
    log.debug('Memory consolidation: no session notes to process');
    return;
  }

  try {
    const response = await callLLM({
      messages: [{
        role: 'user',
        content: `You are a memory consolidation assistant. Merge the session notes into an updated user profile.

### Current Profile:
${existingProfile || '(empty — first time)'}

### Session Notes (recent):
${sessionNotes.slice(0, 10000)}

Rules:
- Produce a complete, updated profile in markdown
- Merge new facts with existing ones — don't duplicate
- Organize into clear sections: User Info, Preferences, Projects, Key Decisions
- Remove outdated/contradicted information
- Keep it concise — aim for under 2000 characters
- This profile is read by the AI at the start of every conversation`,
      }],
      model: config.model.primary,
      systemPrompt: 'Produce a clean, consolidated user profile in markdown. Merge, deduplicate, organize.',
    });

    const newProfile = response.text?.trim();
    if (!newProfile || newProfile.length < 30) {
      log.warn('Memory consolidation: LLM returned empty profile');
      return;
    }

    // Write updated profile
    ensureDir(path.dirname(profilePath));
    fs.writeFileSync(profilePath, newProfile, 'utf8');

    log.info({
      profileLength: newProfile.length,
      sessionFiles: fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0,
    }, 'Memory consolidation: profile updated');

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error({ err: msg }, 'Memory consolidation failed');
  }
}

// ── Cleanup ─────────────────────────────────────

/** Remove session files older than retention period. */
function cleanExpiredSessions(sessionsDir: string): void {
  try {
    if (!fs.existsSync(sessionsDir)) return;
    const cutoffDate = new Date(Date.now() - SESSION_RETENTION_DAYS * 86400000)
      .toISOString().split('T')[0];

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const fileDate = file.replace('.md', '');
      if (fileDate < cutoffDate) {
        fs.unlinkSync(path.join(sessionsDir, file));
        log.info({ file }, 'Auto-memory: cleaned expired session file');
      }
    }
  } catch { /* non-critical */ }
}
