/**
 * `glob` — fast filename matching via ripgrep.
 *
 * Uses `rg --files --sort modified -g <pattern>` under the hood so we
 * get correct .gitignore handling + sorted-by-mtime results without
 * pulling in a new dependency. Ripgrep is already a dep of the grep
 * tool so there's no new install burden.
 *
 * Returns a content-block envelope with matching file paths, newest
 * first.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ToolRegistration } from '@agw/tool-platform';
import { scopedSafePath } from './safe-path.js';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '@agw/tool-platform';

const execFile = promisify(execFileCb);

const DEFAULT_HEAD_LIMIT = 200;
const EXEC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export const globTools: ToolRegistration[] = [
  {
    definition: {
      name: 'glob',
      searchHint: 'find files by pattern glob fast',
      alwaysLoad: true,
      description:
        'List files matching a glob pattern, sorted by modification time (newest first). ' +
        'Respects .gitignore. Use this instead of shelling to `find` — it\'s faster and honours project ignores. ' +
        'Examples: "**/*.ts" for all TypeScript, "src/**/*.svelte" for Svelte in src, "*.md" for top-level Markdown.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (ripgrep glob syntax, e.g. "**/*.ts", "src/**/*.{js,tsx}").',
          },
          path: {
            type: 'string',
            description: 'Directory to search from. Defaults to workspace root.',
          },
          head_limit: {
            type: 'number',
            description: 'Max file paths to return (default 200).',
          },
        },
        required: ['pattern'],
      },
    },
    executor: async (args, context) => {
      const pattern = args.pattern as string;
      if (!pattern || typeof pattern !== 'string') {
        return { error: 'pattern is required and must be a string' };
      }

      const workspace = getWorkspace(context as Record<string, unknown>);

      let searchPath: string;
      try {
        searchPath = args.path
          ? scopedSafePath(args.path as string, workspace, context)
          : workspace;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }

      const rgArgs = [
        '--files',
        '--sort', 'modified',
        '-g', pattern,
        searchPath,
      ];

      let stdout = '';
      try {
        const result = await execFile('rg', rgArgs, {
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: EXEC_TIMEOUT_MS,
        });
        stdout = result.stdout;
      } catch (e: unknown) {
        const err = e as { stdout?: string; code?: number | string; message?: string };
        // rg --files exits 1 when no files match; treat as empty
        if (err.code === 1) {
          return textEnvelope(`No files match pattern: ${pattern}`);
        }
        if (err.code === 2 || typeof err.code === 'string') {
          return { error: `ripgrep error: ${err.message || 'unknown'}` };
        }
        stdout = err.stdout || '';
      }

      // `--sort modified` already returns newest-first. Reverse with
      // --sort-r modified if we ever want oldest-first; for now newest
      // is the right default since "recently changed" is the usual
      // intent when listing files.
      const files = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((f) => path.relative(workspace, f) || f);

      const headLimit = typeof args.head_limit === 'number' && args.head_limit > 0
        ? args.head_limit
        : DEFAULT_HEAD_LIMIT;
      const total = files.length;
      const shown = files.slice(0, headLimit);
      const truncated = total > shown.length;

      const header = `glob ${pattern}  ${total} match${total === 1 ? '' : 'es'}${truncated ? `  (showing ${shown.length})` : ''}`;
      const body = shown.join('\n');
      const footer = truncated ? `\n\n[${total - shown.length} more — bump head_limit to see more]` : '';

      return textEnvelope(`${header}\n\n${body}${footer}`);
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    maxResultSizeChars: 32 * 1024,
    getActivityDescription: (input) => {
      const p = (input as { pattern?: string })?.pattern ?? '';
      return `glob ${p}`;
    },
  },
];
