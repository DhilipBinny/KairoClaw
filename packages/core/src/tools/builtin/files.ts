import { FILE_MAX_WRITE_SIZE, PERSONA_FILES, DOCUMENTS_DIR, SCOPE_DIR_NAME, SHARED_DIR } from '../../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import type { ToolExecutionContext } from '@agw/types';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '../envelope.js';

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

/**
 * Sanitize and resolve a file path.
 * Prevents directory traversal, null byte injection, and symlink escapes.
 */
export function safePath(p: string | undefined, baseDir: string): string {
  if (!p) return baseDir;
  if (p.includes('\0')) throw new Error('Path traversal blocked: null bytes not allowed');
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error('Path traversal blocked: control characters not allowed');

  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir, p);
  const workspace = path.resolve(baseDir);
  const allowed = [workspace, '/tmp'];

  const isAllowed = allowed.some(root =>
    resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!isAllowed) {
    throw new Error(`Path traversal blocked: "${p}" resolves outside allowed directories`);
  }

  // Verify symlinks don't escape
  try {
    if (fs.existsSync(resolved)) {
      const realPath = fs.realpathSync(resolved);
      const realAllowed = allowed.some(root =>
        realPath === root || realPath.startsWith(root + path.sep)
      );
      if (!realAllowed) {
        throw new Error(`Path traversal blocked: symlink "${p}" resolves outside allowed directories`);
      }
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  return resolved;
}

/**
 * Scope-aware path validation for multi-user isolation.
 * - Admin: unrestricted (same as safePath)
 * - User with scopeKey: can access own scope + shared dirs, blocked from other scopes
 * - Unscoped: can access everything except scopes/{other}/
 */
export function scopedSafePath(
  p: string | undefined,
  workspace: string,
  context: ToolExecutionContext,
): string {
  const resolved = safePath(p, workspace);

  // Admin bypasses scope restrictions
  if (context.user?.role === 'admin') return resolved;

  const scopeKey = context.scopeKey;
  const scopesDir = path.join(workspace, SCOPE_DIR_NAME);

  // Check if path is within the scopes/ directory
  if (resolved.startsWith(scopesDir + path.sep) || resolved === scopesDir) {
    // Listing scopes/ root → blocked for non-admin
    if (resolved === scopesDir) {
      throw new Error('Access denied: cannot list other users\' directories');
    }

    // Inside scopes/ — extract the scope from the path
    const relToScopes = path.relative(scopesDir, resolved);
    const targetScope = relToScopes.split(path.sep)[0]; // e.g. "telegram:12345"

    // Allow only own scope
    if (scopeKey && targetScope === scopeKey) {
      return resolved;
    }

    throw new Error('Access denied: cannot access other users\' files');
  }

  // Outside scopes/ — shared global files, documents/, media/, /tmp → allowed
  return resolved;
}

export const fileTools: ToolRegistration[] = [
  {
    definition: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the text content. The file is recorded in the session file-state tracker so you can safely edit it afterwards.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to read (relative to workspace or absolute)' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'Maximum number of lines to read' },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const workspace = getWorkspace(context as Record<string, unknown>);
      const filePath = scopedSafePath(args.path as string, workspace, context);
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };

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
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'Exact text to find and replace' },
          new_string: { type: 'string', description: 'New text to replace with' },
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
      if (oldStr === newStr) {
        return { error: 'old_string and new_string are identical — nothing to do.' };
      }
      if (!content.includes(oldStr)) {
        return { error: 'old_string not found in file. Make sure it matches exactly.' };
      }
      // Phase 6 uniqueness check — reject ambiguous matches so the
      // agent has to pass enough context for a single precise edit.
      const firstIdx = content.indexOf(oldStr);
      if (content.indexOf(oldStr, firstIdx + 1) !== -1) {
        return { error: 'old_string matches more than once in the file. Include more surrounding context so the match is unique.' };
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
      const i = input as { old_string?: unknown; new_string?: unknown };
      if (typeof i.old_string !== 'string' || i.old_string.length === 0) {
        return { ok: false, error: 'old_string must be a non-empty string' };
      }
      if (typeof i.new_string !== 'string') {
        return { ok: false, error: 'new_string must be a string' };
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
