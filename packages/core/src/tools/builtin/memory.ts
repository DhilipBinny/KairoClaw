import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import { scopedSafePath } from './files.js';
import { getWorkspace } from './utils.js';
import type { MemorySystem } from '../../memory/index.js';
import { textEnvelope } from '../envelope.js';

/**
 * Shared MemorySystem instance — set during bootstrap via setMemorySystem().
 */
let memorySystem: MemorySystem | null = null;

export function setMemorySystem(ms: MemorySystem): void {
  memorySystem = ms;
}

export const memoryTools: ToolRegistration[] = [
  {
    definition: {
      name: 'memory_search',
      description: 'Search through memory files (memory/PROFILE.md and memory/sessions/*.md) using semantic keyword search. Returns top-N matching snippets with file path, line range, and relevance score.',
      searchHint: 'memory recall history profile search',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (keywords or phrases)' },
          topN: { type: 'number', description: 'Number of results to return (default: 5)' },
        },
        required: ['query'],
      },
    },
    executor: async (args, context) => {
      const query = args.query as string;
      if (!query) return { error: 'query is required' };
      const topN = (args.topN as number) || 5;

      if (!memorySystem) {
        return { error: 'Memory system not initialized' };
      }

      // Scope isolation: non-admin users only see own scope + global memory
      // If non-admin has no scope (unlinked/anonymous), use sentinel to show global-only
      const isAdmin = context.user?.role === 'admin';
      const scopeFilter = isAdmin ? undefined : (context.scopeKey || '__no_scope__');
      const results = await memorySystem.search(query, topN, scopeFilter);
      const stats = await memorySystem.getStats();

      if (results.length === 0) {
        return textEnvelope(`Query: ${query}\nTotal chunks indexed: ${stats.totalChunks}\n\nNo matches.`);
      }

      const lines: string[] = [
        `Query: ${query}`,
        `Total chunks indexed: ${stats.totalChunks}`,
        `Top ${results.length} match${results.length === 1 ? '' : 'es'}:`,
        '',
      ];
      for (const r of results) {
        lines.push(`[${r.filePath}:${r.lineStart}-${r.lineEnd}] score=${r.score.toFixed(2)}`);
        lines.push(r.content);
        lines.push('');
      }
      return textEnvelope(lines.join('\n'));
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const q = (input as { query?: string })?.query ?? '';
      return `Memory search: ${q.slice(0, 60)}`;
    },
  },
  {
    definition: {
      name: 'memory_read',
      description: 'Read a memory file from the workspace (memory/PROFILE.md or memory/sessions/*.md).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path within workspace (e.g., "memory/PROFILE.md" or "memory/sessions/2026-03-23.md")' },
          from: { type: 'number', description: 'Start line (1-indexed)' },
          lines: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = scopedSafePath(args.path as string, workspace, context);
      if (!fs.existsSync(filePath)) {
        return textEnvelope(`Memory file: ${args.path}\n[File does not exist yet]`);
      }
      let content = fs.readFileSync(filePath, 'utf8');
      if (args.from || args.lines) {
        const allLines = content.split('\n');
        const start = ((args.from as number) || 1) - 1;
        const count = (args.lines as number) || allLines.length;
        content = allLines.slice(start, start + count).join('\n');
      }
      return textEnvelope(`Memory file: ${args.path}\n\n${content}`);
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '<unknown>';
      return `Reading memory: ${p}`;
    },
  },
  {
    definition: {
      name: 'inspect_image',
      description: 'Inspect an image file metadata (size, format). Does NOT perform visual analysis — for that, attach the image to a message.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the image file' },
          prompt: { type: 'string', description: 'What to analyze about the image' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = scopedSafePath(args.path as string, workspace, context);
      if (!fs.existsSync(filePath)) return { error: `Image not found: ${args.path}` };
      const ext = path.extname(filePath).toLowerCase();
      const supported = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (!supported.includes(ext)) {
        return { error: `Unsupported image format: ${ext}. Supported: ${supported.join(', ')}` };
      }
      const stats = fs.statSync(filePath);
      const prompt = (args.prompt as string) || 'describe this image';
      const lines = [
        `Image: ${args.path}`,
        `Size: ${stats.size} bytes`,
        `Format: ${ext}`,
        `Prompt: ${prompt}`,
        '',
        'Image file found. Vision analysis requires a multimodal model. Attach the image to a user message for actual visual understanding.',
      ];
      return textEnvelope(lines.join('\n'));
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '<unknown>';
      return `Inspecting image: ${p}`;
    },
  },
];
