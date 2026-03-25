import { FILE_MAX_WRITE_SIZE, PERSONA_FILES, DOCUMENTS_DIR, SCOPE_DIR_NAME } from '../../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import type { ToolExecutionContext } from '@agw/types';
import { getWorkspace } from './utils.js';

/**
 * Enforce workspace file organization.
 * - Persona files in root (IDENTITY.md, SOUL.md, etc.) are protected from agent writes
 * - Files written to workspace root are redirected to documents/
 * - Subdirectory writes (documents/x.md, media/x.png) pass through unchanged
 */
function enforceFileOrganization(filePath: string, workspace: string): { path: string; redirected: boolean } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
  const relative = path.relative(workspace, resolved);

  // If writing to a subdirectory, allow as-is
  if (relative.includes(path.sep)) {
    // Scoped directories — agent can read and write freely
    // (USER.md, memory/PROFILE.md, memory/sessions/ are all agent-managed per user)
    return { path: resolved, redirected: false };
  }

  // Writing to workspace root — check if it's a protected persona file
  const fileName = path.basename(resolved);
  if (PERSONA_FILES.includes(fileName)) {
    throw new Error(`Cannot overwrite "${fileName}" — this is a protected persona file. Edit it from the admin UI.`);
  }

  // Redirect other root-level files to documents/
  const docsDir = path.join(workspace, DOCUMENTS_DIR);
  const redirected = path.join(docsDir, fileName);
  return { path: redirected, redirected: true };
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
      description: 'Read the contents of a file. Returns the text content.',
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
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const offset = ((args.offset as number) || 1) - 1;
      const limit = (args.limit as number) || lines.length;
      const sliced = lines.slice(offset, offset + limit);
      return { content: sliced.join('\n'), totalLines: lines.length };
    },
    source: 'builtin',
    category: 'read',
  },
  {
    definition: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories automatically. Overwrites existing files.',
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

      // Enforce file organization — redirect root files to documents/, protect persona files
      let filePath = rawPath;
      let note: string | undefined;
      try {
        const result = enforceFileOrganization(rawPath, workspace);
        filePath = result.path;
        if (result.redirected) {
          note = `File saved to documents/ (workspace root is reserved for system files)`;
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileContent);
      const savedPath = path.relative(workspace, filePath);
      return { success: true, path: savedPath, bytes: contentSize, ...(note ? { note } : {}) };
    },
    source: 'builtin',
    category: 'write',
  },
  {
    definition: {
      name: 'edit_file',
      description: 'Edit a file by replacing exact text. The old_string must match exactly (including whitespace).',
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

      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      let content = fs.readFileSync(filePath, 'utf8');
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      if (!content.includes(oldStr)) {
        return { error: 'old_string not found in file. Make sure it matches exactly.' };
      }
      content = content.replace(oldStr, newStr);
      fs.writeFileSync(filePath, content);
      return { success: true, path: args.path };
    },
    source: 'builtin',
    category: 'write',
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
      return {
        entries: entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        })),
      };
    },
    source: 'builtin',
    category: 'read',
  },
];
