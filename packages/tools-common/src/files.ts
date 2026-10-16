import { FILE_MAX_WRITE_SIZE, PERSONA_FILES, DOCUMENTS_DIR, SCOPE_DIR_NAME, SHARED_DIR } from './constants.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '@agw/tool-platform';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '@agw/tool-platform';
import { scopedSafePath } from './safe-path.js';

/**
 * Enforce workspace file organization with per-user scoping.
 * - Persona files in root are protected from agent writes
 * - Root-level writes redirect to user's personal documents/ (if scoped) or shared/documents/
 * - Writes to shared/ pass through (team space)
 * - Writes to user's own scope pass through
 */
function enforceFileOrganization(
  filePath: string,
  workspace: string,
  scopeKey?: string | null,
): { path: string; redirected: boolean; note?: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
  const relative = path.relative(workspace, resolved);

  // If writing to a subdirectory, allow as-is
  if (relative.includes(path.sep)) {
    return { path: resolved, redirected: false };
  }

  // Writing to workspace root — check if it's a protected persona file
  const fileName = path.basename(resolved);
  if (PERSONA_FILES.includes(fileName)) {
    throw new Error(`Cannot overwrite "${fileName}" — this is a protected persona file. Edit it from the admin UI.`);
  }

  // Redirect root-level files to user's personal documents/ (or shared/ if no scope)
  if (scopeKey) {
    const userDocsDir = path.join(workspace, SCOPE_DIR_NAME, scopeKey, DOCUMENTS_DIR);
    fs.mkdirSync(userDocsDir, { recursive: true });
    return { path: path.join(userDocsDir, fileName), redirected: true, note: 'Saved to your personal documents folder' };
  }

  // No scope (admin/system) — redirect to shared/documents/
  const sharedDocsDir = path.join(workspace, SHARED_DIR, DOCUMENTS_DIR);
  fs.mkdirSync(sharedDocsDir, { recursive: true });
  return { path: path.join(sharedDocsDir, fileName), redirected: true, note: 'Saved to shared documents folder' };
}

const MAX_WRITE_SIZE = FILE_MAX_WRITE_SIZE;

// safePath and scopedSafePath are in safe-path.ts — re-export for backward compat
export { safePath, scopedSafePath } from './safe-path.js';

export const fileTools: ToolRegistration[] = [
  {
    definition: {
      name: 'read_file',
      description:
        'Read the contents of a file. Returns text content. For text files, ' +
        'use optional offset/limit to read a line range. For PDF files (.pdf), ' +
        'extracted text is returned with optional pages parameter. ' +
        'For Office documents (.docx, .xlsx, .pptx), text content is extracted automatically. ' +
        'The file is recorded in the session file-state tracker so subsequent ' +
        'edit_file calls see a matching hash.',
      searchHint: 'read file contents text source code pdf pages',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read (relative to workspace or absolute)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed) — text files only' },
          limit: { type: 'number', description: 'Maximum number of lines to read — text files only' },
          pages: { type: 'string', description: 'PDF page range ("1-5", "3", or omit for all, max 50) — PDF files only' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = scopedSafePath(args.path as string, workspace, context);
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };

      // TC-7: PDF branch — if the path ends in .pdf, route through the
      // shared PDF extractor so the agent gets PDF support without
      // needing a separate `read_pdf` tool_search round. The text
      // result still flows through the same envelope + persistence
      // pipeline as text-file reads.
      if (path.extname(filePath).toLowerCase() === '.pdf') {
        const { extractPdfText } = await import('./pdf.js');
        const result = await extractPdfText(filePath, { pages: args.pages as string | undefined });
        if ('error' in result) return result;
        const headerLine = `File: ${args.path} (PDF, ${result.totalPages} pages, extracted ${result.extractedFirst}-${result.extractedLast} via ${result.method}, ${result.text.length} chars)`;
        const warnBlock = result.warnings.length > 0
          ? `\n\nWarnings:\n${result.warnings.map((w) => `- ${w}`).join('\n')}`
          : '';
        // Record a synthetic "read" in the tracker using the PDF bytes
        // content so the tracker knows we looked at this file. We can't
        // hash the extracted text (it's derived) so we hash the raw
        // bytes instead.
        try {
          const raw = fs.readFileSync(filePath);
          context.fileState?.recordRead(filePath, raw.toString('base64'));
        } catch { /* tracker update is best-effort */ }
        return textEnvelope(`${headerLine}${warnBlock}\n\n${result.text}`);
      }

      // Office documents — extract text content
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
        const { extractDocxText, extractXlsxText, extractPptxText, formatDocumentMeta } = await import('./document.js');
        let docResult;
        if (ext === '.docx') docResult = await extractDocxText(filePath);
        else if (ext === '.xlsx') docResult = await extractXlsxText(filePath);
        else docResult = await extractPptxText(filePath);

        if ('error' in docResult) return docResult;

        const headerLine = `File: ${args.path} (${ext.slice(1).toUpperCase()}, ${formatDocumentMeta(docResult)}, extracted via ${docResult.method})`;

        try {
          const raw = fs.readFileSync(filePath);
          context.fileState?.recordRead(filePath, raw.toString('base64'));
        } catch { /* tracker update is best-effort */ }
        return textEnvelope(`${headerLine}\n\n${docResult.text}`);
      }

      const fullContent = fs.readFileSync(filePath, 'utf8');

      // Record in the session file-state tracker BEFORE slicing — the
      // tracker stores the hash of the WHOLE file so subsequent edits
      // compare against the on-disk state the reader actually saw.
      // A partial offset/limit read still counts as "the reader has
      // seen the file" for read-before-edit purposes.
      context.fileState?.recordRead(filePath, fullContent);

      const lines = fullContent.split('\n');
      const totalLines = lines.length;
      const offset = Math.max(0, ((args.offset as number) || 1) - 1);
      const limit = (args.limit as number) || lines.length;
      const sliced = lines.slice(offset, offset + limit);
      const slicedText = sliced.join('\n');

      // Build envelope with a header so the LLM sees where the read
      // came from and whether it's partial. Persistence happens at the
      // registry layer if this exceeds the per-tool threshold.
      const isPartial = offset > 0 || limit < totalLines;
      const header = isPartial
        ? `File: ${args.path} (lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines})\n`
        : `File: ${args.path} (${totalLines} line${totalLines === 1 ? '' : 's'})\n`;

      return textEnvelope(header + slicedText);
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    // 64KB cap before persistence kicks in — file reads are intentional,
    // give the LLM more headroom than the default 16KB before offloading.
    maxResultSizeChars: 64 * 1024,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '<unknown>';
      return `Reading ${p}`;
    },
  },
  {
    definition: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories automatically. Overwrites existing files. The file is recorded in the session file-state tracker.',
      searchHint: 'write save create file',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const rawPath = scopedSafePath(args.path as string, workspace, context);
      const fileContent = (args.content as string) || '';
      const contentSize = Buffer.byteLength(fileContent);
      if (contentSize > MAX_WRITE_SIZE) {
        return { error: `Content too large: ${(contentSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_WRITE_SIZE / 1024 / 1024}MB limit` };
      }

      // Enforce file organization — redirect root files to user's documents/, protect persona files
      let filePath = rawPath;
      let note: string | undefined;
      try {
        const result = enforceFileOrganization(rawPath, workspace, context.scopeKey);
        filePath = result.path;
        note = result.note;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      try {
        fs.writeFileSync(filePath, fileContent);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Failed to write file: ${msg}` };
      }

      // Record in file-state tracker — a write counts as a fresh read
      // so a subsequent edit in the same turn doesn't require re-reading.
      context.fileState?.recordWrite(filePath, fileContent);

      const savedPath = path.relative(workspace, filePath);
      const msg = `Wrote ${contentSize} byte${contentSize === 1 ? '' : 's'} to ${savedPath}` + (note ? ` (${note})` : '');
      return textEnvelope(msg);
    },
    source: 'builtin',
    category: 'write',
    isDestructive: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '<unknown>';
      return `Writing ${p}`;
    },
  },
  {
    definition: {
      name: 'edit_file',
      description: 'Edit a file by replacing exact text. The old_string must match exactly (including whitespace). You must call read_file on this path first in the current session — edit_file refuses to run on files you haven\'t read.',
      searchHint: 'edit modify replace text file',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'Exact text to find and replace' },
          new_string: { type: 'string', description: 'New text to replace with' },
          replace_all: {
            type: 'boolean',
            description: 'When true, replace EVERY occurrence of old_string. When false or omitted, old_string must match exactly once and the edit is rejected if it matches multiple times (safer default).',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = scopedSafePath(args.path as string, workspace, context);

      // Protect persona files from agent edits
      const relative = path.relative(workspace, filePath);
      if (!relative.includes(path.sep) && PERSONA_FILES.includes(path.basename(filePath))) {
        return { error: `Cannot edit "${path.basename(filePath)}" — this is a protected persona file. Edit it from the admin UI.` };
      }

      // Phase 6: read-before-edit enforcement via the session file-state
      // tracker. Refuse to edit files that haven't been read in this
      // session, or whose on-disk content has changed since the read.
      // The tracker's error messages are written for the LLM — they tell
      // the agent exactly what to do next (call read_file first / re-read).
      if (context.fileState) {
        const check = context.fileState.requireRead(filePath);
        if (!check.ok) {
          return { error: check.error };
        }
      }

      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      let content = fs.readFileSync(filePath, 'utf8');
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      const replaceAll = args.replace_all === true;
      if (oldStr === newStr) {
        return { error: 'old_string and new_string are identical — nothing to do.' };
      }
      if (!content.includes(oldStr)) {
        return { error: 'old_string not found in file. Make sure it matches exactly.' };
      }

      if (replaceAll) {
        // Count matches for a meaningful envelope. String.split is the
        // simplest way; replace all occurrences via the same approach.
        const matches = content.split(oldStr).length - 1;
        content = content.split(oldStr).join(newStr);
        try {
          fs.writeFileSync(filePath, content);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { error: `Failed to write file: ${msg}` };
        }
        context.fileState?.recordWrite(filePath, content);
        return textEnvelope(`Edited ${args.path} — replaced ${matches} occurrence${matches === 1 ? '' : 's'}.`);
      }

      // Phase 6 uniqueness check — reject ambiguous matches so the
      // agent has to pass enough context for a single precise edit.
      const firstIdx = content.indexOf(oldStr);
      if (content.indexOf(oldStr, firstIdx + 1) !== -1) {
        return { error: 'old_string matches more than once in the file. Include more surrounding context so the match is unique, or pass replace_all: true.' };
      }

      content = content.replace(oldStr, newStr);
      try {
        fs.writeFileSync(filePath, content);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Failed to write file: ${msg}` };
      }

      // Update the tracker to the new content so a subsequent edit in
      // the same turn sees a matching hash.
      context.fileState?.recordWrite(filePath, content);

      return textEnvelope(`Edited ${args.path}`);
    },
    source: 'builtin',
    category: 'write',
    isDestructive: true,
    validateInput: (input) => {
      const i = input as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
      if (typeof i.old_string !== 'string' || i.old_string.length === 0) {
        return { ok: false, error: 'old_string must be a non-empty string' };
      }
      if (typeof i.new_string !== 'string') {
        return { ok: false, error: 'new_string must be a string' };
      }
      if (i.old_string === i.new_string) {
        return { ok: false, error: 'old_string and new_string must differ' };
      }
      if (i.replace_all !== undefined && typeof i.replace_all !== 'boolean') {
        return { ok: false, error: 'replace_all must be a boolean when provided' };
      }
      return { ok: true };
    },
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '<unknown>';
      return `Editing ${p}`;
    },
  },
  {
    definition: {
      name: 'list_directory',
      description: 'List files and directories at a given path.',
      searchHint: 'list directory folder ls dir',
      alwaysLoad: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list (default: workspace root)' },
        },
        required: [],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const dirPath = scopedSafePath(args.path as string | undefined, workspace, context);
      if (!fs.existsSync(dirPath)) return { error: `Directory not found: ${args.path || '.'}` };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const lines = entries
        .map((e) => e.isDirectory() ? `${e.name}/` : e.name)
        .sort();
      const displayPath = args.path || path.relative(workspace, dirPath) || '.';
      const header = `Directory: ${displayPath} (${lines.length} item${lines.length === 1 ? '' : 's'})\n`;
      return textEnvelope(header + lines.join('\n'));
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
    isReadOnly: true,
    getActivityDescription: (input) => {
      const p = (input as { path?: string })?.path ?? '.';
      return `Listing ${p}`;
    },
  },
];
