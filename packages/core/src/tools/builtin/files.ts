import { FILE_MAX_WRITE_SIZE } from '../../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';

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
    if (e instanceof Error && e.message.includes('Path traversal blocked')) throw e;
  }

  return resolved;
}

/**
 * Get the workspace directory from context or fall back to cwd.
 */
function getWorkspace(context: { session?: { key?: string }; db?: unknown }): string {
  // In the v2 system, workspace comes from config injected via context.
  // For now, use process.cwd() as the fallback.
  const ctx = context as Record<string, unknown>;
  return (ctx.workspace as string) || process.cwd();
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
      const workspace = getWorkspace(context);
      const filePath = safePath(args.path as string, workspace);
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
      const workspace = getWorkspace(context);
      const filePath = safePath(args.path as string, workspace);
      const fileContent = (args.content as string) || '';
      const contentSize = Buffer.byteLength(fileContent);
      if (contentSize > MAX_WRITE_SIZE) {
        return { error: `Content too large: ${(contentSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_WRITE_SIZE / 1024 / 1024}MB limit` };
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, fileContent);
      return { success: true, path: args.path, bytes: contentSize };
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
      const workspace = getWorkspace(context);
      const filePath = safePath(args.path as string, workspace);
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
      const workspace = getWorkspace(context);
      const dirPath = safePath(args.path as string | undefined, workspace);
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
