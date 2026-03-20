import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import { safePath } from './files.js';
import type { MemorySystem } from '../../memory/index.js';

/**
 * Shared MemorySystem instance — set during bootstrap via setMemorySystem().
 */
let memorySystem: MemorySystem | null = null;

export function setMemorySystem(ms: MemorySystem): void {
  memorySystem = ms;
}

/**
 * Get the workspace directory from context.
 */
function getWorkspace(context: Record<string, unknown>): string {
  return (context.workspace as string) || process.cwd();
}

export const memoryTools: ToolRegistration[] = [
  {
    definition: {
      name: 'memory_search',
      description: 'Search through memory files (MEMORY.md and memory/*.md) using semantic keyword search. Returns top-N matching snippets with file path, line range, and relevance score.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (keywords or phrases)' },
          topN: { type: 'number', description: 'Number of results to return (default: 5)' },
        },
        required: ['query'],
      },
    },
    executor: async (args) => {
      const query = args.query as string;
      if (!query) return { error: 'query is required' };
      const topN = (args.topN as number) || 5;

      if (!memorySystem) {
        return { results: [], error: 'Memory system not initialized' };
      }

      const results = memorySystem.search(query, topN);
      const stats = memorySystem.getStats();

      return {
        results: results.map((r) => ({
          filePath: r.filePath,
          lineStart: r.lineStart,
          lineEnd: r.lineEnd,
          content: r.content,
          score: r.score,
        })),
        query,
        totalChunks: stats.totalChunks,
      };
    },
    source: 'builtin',
    category: 'read',
  },
  {
    definition: {
      name: 'memory_read',
      description: 'Read a memory file from the workspace (MEMORY.md or memory/*.md files).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path within workspace (e.g., "memory/2026-03-07.md" or "MEMORY.md")' },
          from: { type: 'number', description: 'Start line (1-indexed)' },
          lines: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = safePath(args.path as string, workspace);
      if (!fs.existsSync(filePath)) return { text: '', path: args.path, note: 'File does not exist yet' };
      let content = fs.readFileSync(filePath, 'utf8');
      if (args.from || args.lines) {
        const allLines = content.split('\n');
        const start = ((args.from as number) || 1) - 1;
        const count = (args.lines as number) || allLines.length;
        content = allLines.slice(start, start + count).join('\n');
      }
      return { text: content, path: args.path };
    },
    source: 'builtin',
    category: 'read',
  },
  {
    definition: {
      name: 'analyze_image',
      description: 'Analyze an image file. Provide a file path to an image and a question/prompt about it. Delegates to vision model if available.',
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
      const filePath = safePath(args.path as string, workspace);
      if (!fs.existsSync(filePath)) return { error: `Image not found: ${args.path}` };
      const ext = path.extname(filePath).toLowerCase();
      const supported = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (!supported.includes(ext)) {
        return { error: `Unsupported image format: ${ext}. Supported: ${supported.join(', ')}` };
      }
      const stats = fs.statSync(filePath);
      return {
        path: args.path,
        size: stats.size,
        format: ext,
        prompt: (args.prompt as string) || 'describe this image',
        note: 'Image file found. Vision analysis requires a multimodal model. File is available for reference.',
      };
    },
    source: 'builtin',
    category: 'read',
  },
];
