/**
 * `grep` — ripgrep wrapper.
 *
 * Wraps the system `rg` binary with the schema kairobm's LLMs need
 * for code navigation: pattern, path, glob filter, type filter,
 * output modes (content / files_with_matches / count), context
 * lines, case-insensitive, line numbers, multiline, head_limit,
 * offset. Auto-excludes `.git` and `node_modules` (ripgrep does
 * this by default via its respect-gitignore behaviour, so we
 * don't need to add excludes ourselves).
 *
 * Returns a content-block envelope (Phase 6 shape). Large outputs
 * are auto-persisted by the registry when they exceed the 128 KB
 * `maxResultSizeChars` threshold (greps over big repos can easily
 * blow past that).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRegistration } from '@agw/tool-platform';
import { scopedSafePath } from './files.js';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '@agw/tool-platform';

const execFile = promisify(execFileCb);

const DEFAULT_HEAD_LIMIT = 250;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB hard cap from rg
const EXEC_TIMEOUT_MS = 30_000;

export const grepTools: ToolRegistration[] = [
  {
    definition: {
      name: 'grep',
      searchHint: 'search regex pattern code ripgrep',
      alwaysLoad: true,
      description:
        'Search file contents with ripgrep. Fast, regex-capable, respects .gitignore by default. ' +
        'Output modes: "files_with_matches" (default, just paths), "content" (matching lines), "count" (per-file counts). ' +
        'Use `glob` to narrow by filename pattern, `type` for language types. ' +
        'Supports context lines (-A/-B/-C), case-insensitive (-i), line numbers (-n), and multiline patterns.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for. Ripgrep syntax — literal braces/parens need escaping.',
          },
          path: {
            type: 'string',
            description: 'File or directory to search. Defaults to workspace root.',
          },
          glob: {
            type: 'string',
            description: 'Glob to filter filenames (e.g. "*.ts", "**/*.{js,tsx}"). Maps to rg --glob.',
          },
          type: {
            type: 'string',
            description: 'Ripgrep file type (e.g. "js", "py", "rust"). More efficient than glob for language-wide searches.',
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'content = matching lines with context; files_with_matches = file paths only (default); count = match counts per file',
          },
          '-i': { type: 'boolean', description: 'Case-insensitive match' },
          '-n': { type: 'boolean', description: 'Show line numbers (content mode only)' },
          '-A': { type: 'number', description: 'Lines of context after each match (content mode)' },
          '-B': { type: 'number', description: 'Lines of context before each match (content mode)' },
          '-C': { type: 'number', description: 'Lines of context before and after (content mode)' },
          multiline: { type: 'boolean', description: 'Enable multiline match (rg -U --multiline-dotall)' },
          head_limit: {
            type: 'number',
            description: 'Max output lines (default 250). Pass 0 for unlimited but mind context budget.',
          },
          offset: {
            type: 'number',
            description: 'Skip the first N output lines before applying head_limit.',
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

      // Scope-safe path resolution. Default to workspace root when no
      // path given. An absolute path gets validated against the allowed
      // roots; a relative path resolves under the workspace.
      let searchPath: string;
      try {
        searchPath = args.path
          ? scopedSafePath(args.path as string, workspace, context)
          : workspace;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }

      // Build ripgrep argv. Order: flags then pattern then path.
      const rgArgs: string[] = [];

      const outputMode = (args.output_mode as string) || 'files_with_matches';

      if (outputMode === 'files_with_matches') {
        rgArgs.push('--files-with-matches');
      } else if (outputMode === 'count') {
        rgArgs.push('--count-matches');
      }
      // content mode needs no extra flag — rg's default output is matching lines

      if (args['-i'] === true) rgArgs.push('-i');
      if (outputMode === 'content' && args['-n'] === true) rgArgs.push('-n');

      if (outputMode === 'content') {
        if (typeof args['-A'] === 'number') rgArgs.push('-A', String(args['-A']));
        if (typeof args['-B'] === 'number') rgArgs.push('-B', String(args['-B']));
        if (typeof args['-C'] === 'number') rgArgs.push('-C', String(args['-C']));
      }

      if (args.multiline === true) {
        rgArgs.push('-U', '--multiline-dotall');
      }

      if (typeof args.glob === 'string' && args.glob.length > 0) {
        rgArgs.push('-g', args.glob);
      }
      if (typeof args.type === 'string' && args.type.length > 0) {
        rgArgs.push('-t', args.type);
      }

      // Stable output ordering for reproducibility
      rgArgs.push('--color', 'never');
      rgArgs.push('--no-heading');

      rgArgs.push('--', pattern, searchPath);

      let stdout = '';
      let exitCode = 0;
      try {
        const result = await execFile('rg', rgArgs, {
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: EXEC_TIMEOUT_MS,
        });
        stdout = result.stdout;
      } catch (e: unknown) {
        const err = e as { stdout?: string; code?: number | string; message?: string };
        // ripgrep exits 1 when no matches — treat as empty, not error
        if (err.code === 1) {
          return textEnvelope(`No matches found for pattern: ${pattern}`);
        }
        if (err.code === 2 || typeof err.code === 'string') {
          return { error: `ripgrep error: ${err.message || 'unknown'}` };
        }
        stdout = err.stdout || '';
        exitCode = typeof err.code === 'number' ? err.code : 1;
      }

      const headLimit = typeof args.head_limit === 'number' && args.head_limit > 0
        ? args.head_limit
        : DEFAULT_HEAD_LIMIT;
      const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;

      // Apply offset + head_limit line-wise
      const allLines = stdout.split('\n').filter((l) => l.length > 0);
      const totalMatches = allLines.length;
      const paged = allLines.slice(offset, offset + (args.head_limit === 0 ? allLines.length : headLimit));
      const truncated = totalMatches > offset + paged.length;

      const header = `grep ${outputMode} — pattern=/${pattern}/  ${totalMatches} line${totalMatches === 1 ? '' : 's'}${offset > 0 ? `  offset=${offset}` : ''}${truncated ? `  (showing ${paged.length})` : ''}`;
      const footer = truncated
        ? `\n\n[${totalMatches - offset - paged.length} more lines — bump head_limit or use offset to page]`
        : '';

      return textEnvelope(`${header}\n\n${paged.join('\n')}${footer}${exitCode !== 0 ? `\n\n[rg exited ${exitCode}]` : ''}`);
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    maxResultSizeChars: 128 * 1024,
    getActivityDescription: (input) => {
      const p = (input as { pattern?: string })?.pattern ?? '';
      return `grep: ${p.slice(0, 60)}${p.length > 60 ? '…' : ''}`;
    },
  },
];
