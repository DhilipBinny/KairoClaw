/**
 * Memory write tools — memory_write, memory_pin, memory_forget.
 *
 * Gives the agent explicit write access to the user's long-term memory:
 * - memory_write: append notes to PROFILE.md (searchable via memory_search)
 * - memory_pin: hot-loaded notes injected into every system prompt (max 5)
 * - memory_forget: surgically delete entries by their 8-hex-char id
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import { getScopedMemoryDir } from '../../agent/scope.js';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '../envelope.js';

const PIN_MAX = 5;

function shortId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function ensureMemoryDir(workspace: string, scopeKey: string | null | undefined): string {
  const dir = getScopedMemoryDir(workspace, scopeKey ?? null);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── PROFILE.md helpers ──────────────────────────────────────

export function appendProfileEntry(memoryDir: string, content: string): string {
  const profilePath = path.join(memoryDir, 'PROFILE.md');
  const id = shortId();
  const ts = new Date().toISOString();
  const entry = `\n## Note ${ts} id:${id}\n${content.trim()}\n`;

  fs.appendFileSync(profilePath, entry, 'utf8');
  return id;
}

// ── PINNED.md helpers ───────────────────────────────────────

interface PinnedEntry {
  id: string;
  ts: string;
  content: string;
}

const PIN_LINE_RE = /^- \(([^ ]+) id:([0-9a-f]{8})\) (.+)$/;

export function readPinned(memoryDir: string): PinnedEntry[] {
  const pinnedPath = path.join(memoryDir, 'PINNED.md');
  if (!fs.existsSync(pinnedPath)) return [];

  const raw = fs.readFileSync(pinnedPath, 'utf8');
  const entries: PinnedEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(PIN_LINE_RE);
    if (m) entries.push({ ts: m[1], id: m[2], content: m[3] });
  }
  return entries;
}

export function writePinned(memoryDir: string, entries: PinnedEntry[]): void {
  const pinnedPath = path.join(memoryDir, 'PINNED.md');
  const lines = [
    '# Pinned Notes',
    '',
    'Always loaded into the system prompt. Managed by memory_pin / memory_forget.',
    '',
    ...entries.map(e => `- (${e.ts} id:${e.id}) ${e.content}`),
    '',
  ];
  fs.writeFileSync(pinnedPath, lines.join('\n'), 'utf8');
}

// ── Surgical deletion ───────────────────────────────────────

export function forgetById(memoryDir: string, id: string): { changed: number; details: string[] } {
  const details: string[] = [];
  let changed = 0;

  // PINNED.md
  const pins = readPinned(memoryDir);
  const pinsKept = pins.filter(e => e.id !== id);
  if (pinsKept.length !== pins.length) {
    writePinned(memoryDir, pinsKept);
    const removed = pins.length - pinsKept.length;
    details.push(`removed ${removed} pinned entr${removed === 1 ? 'y' : 'ies'}`);
    changed++;
  }

  // PROFILE.md — blocks headed by `## Note <ts> id:<id>`
  const profilePath = path.join(memoryDir, 'PROFILE.md');
  if (fs.existsSync(profilePath)) {
    const raw = fs.readFileSync(profilePath, 'utf8');
    const lines = raw.split('\n');
    const out: string[] = [];
    let skipping = false;
    let removedBlocks = 0;
    for (const line of lines) {
      const headerMatch = line.match(/^## Note .* id:([0-9a-f]{8})/);
      if (headerMatch) {
        if (headerMatch[1] === id) {
          skipping = true;
          removedBlocks++;
          continue;
        } else {
          skipping = false;
        }
      } else if (line.startsWith('## ') && skipping) {
        skipping = false;
      }
      if (!skipping) out.push(line);
    }
    if (removedBlocks > 0) {
      fs.writeFileSync(profilePath, out.join('\n'), 'utf8');
      details.push(`removed ${removedBlocks} profile block${removedBlocks === 1 ? '' : 's'}`);
      changed++;
    }
  }

  return { changed, details };
}

// ── Tool registrations ──────────────────────────────────────

export const memoryWriteTools: ToolRegistration[] = [
  {
    definition: {
      name: 'memory_write',
      searchHint: 'save note remember long-term profile memory',
      alwaysLoad: true,
      description:
        'Append a note to the long-term PROFILE.md for the current scope. ' +
        'Use this when the user says "remember X" or when you decide a fact ' +
        'is worth preserving across sessions. The note gets a timestamped ' +
        'header with a short id, making it searchable via memory_search and ' +
        'deletable via memory_forget.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The note content to save. Plain prose or markdown.',
          },
        },
        required: ['content'],
      },
    },
    executor: async (args, context) => {
      const content = args.content as string;
      if (!content || typeof content !== 'string' || !content.trim()) {
        return { error: 'content is required and must be a non-empty string' };
      }
      try {
        const workspace = getWorkspace(context as Record<string, unknown>);
        const memoryDir = ensureMemoryDir(workspace, context.scopeKey);
        const id = appendProfileEntry(memoryDir, content);
        return textEnvelope(
          `Saved to PROFILE.md with id ${id}.\n` +
          `Searchable via memory_search. Delete with memory_forget(id="${id}").`,
        );
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    source: 'builtin',
    category: 'memory',
    isDestructive: false,
    concurrencySafe: false,
  },
  {
    definition: {
      name: 'memory_pin',
      searchHint: 'pin note hot-loaded always-on system prompt',
      alwaysLoad: true,
      description:
        'Pin a short note that will be injected into the system prompt on ' +
        'every turn for this scope. Use for critical context the agent should ' +
        'never miss — e.g. "user prefers terse replies", "always use pnpm not npm". ' +
        `Max ${PIN_MAX} pins per scope; adding a ${PIN_MAX + 1}th drops the oldest. ` +
        'For larger notes, use memory_write instead.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Short pin content (one sentence recommended). Keep under ~200 chars.',
          },
        },
        required: ['content'],
      },
    },
    executor: async (args, context) => {
      const content = args.content as string;
      if (!content || typeof content !== 'string' || !content.trim()) {
        return { error: 'content is required and must be a non-empty string' };
      }
      const flat = content.replace(/\s+/g, ' ').trim();
      try {
        const workspace = getWorkspace(context as Record<string, unknown>);
        const memoryDir = ensureMemoryDir(workspace, context.scopeKey);
        const entries = readPinned(memoryDir);
        const id = shortId();
        entries.push({ id, ts: new Date().toISOString(), content: flat });
        let dropped: PinnedEntry | null = null;
        while (entries.length > PIN_MAX) {
          dropped = entries.shift() ?? null;
        }
        writePinned(memoryDir, entries);
        const droppedMsg = dropped
          ? `\nDropped oldest pin (id:${dropped.id}) to stay within the ${PIN_MAX}-pin cap.`
          : '';
        return textEnvelope(
          `Pinned with id ${id} (${entries.length}/${PIN_MAX}).${droppedMsg}\n` +
          `Delete with memory_forget(id="${id}").`,
        );
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    source: 'builtin',
    category: 'memory',
    isDestructive: false,
    concurrencySafe: false,
  },
  {
    definition: {
      name: 'memory_forget',
      searchHint: 'forget delete note pin memory remove',
      alwaysLoad: true,
      description:
        'Surgically remove a memory entry by its id. The id is the 8-char ' +
        'hex string returned by memory_write or memory_pin and shown in the ' +
        'header of each note. Searches both PROFILE.md and PINNED.md.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '8-character hex id of the entry to remove.',
          },
        },
        required: ['id'],
      },
    },
    executor: async (args, context) => {
      const id = (args.id as string || '').trim().toLowerCase();
      if (!/^[0-9a-f]{8}$/.test(id)) {
        return { error: 'id must be an 8-character hex string' };
      }
      try {
        const workspace = getWorkspace(context as Record<string, unknown>);
        const memoryDir = getScopedMemoryDir(workspace, context.scopeKey ?? null);
        if (!fs.existsSync(memoryDir)) {
          return textEnvelope(`No memory directory exists yet — nothing to remove.`);
        }
        const { changed, details } = forgetById(memoryDir, id);
        if (changed === 0) {
          return textEnvelope(`No entries with id ${id} found.`);
        }
        return textEnvelope(`memory_forget(${id}): ${details.join(', ')}.`);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    source: 'builtin',
    category: 'memory',
    isDestructive: true,
    concurrencySafe: false,
  },
];
