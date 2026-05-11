/**
 * `apply_patch` — atomic multi-file unified-diff application.
 *
 * Phase 9. Wraps `git apply` so the agent can make multi-file edits
 * in a single atomic operation instead of calling edit_file N times.
 * Useful for:
 *   - refactors that touch several files together
 *   - applying a diff the agent composed after reviewing the codebase
 *   - importing a diff from an external source (code review, patch file)
 *
 * Flow:
 *   1. `git apply --check` first as validation (dry-run — no mutation)
 *   2. If validation passes AND dry_run is false, `git apply` for real
 *   3. Parse the patch for touched file paths and update each one in
 *      the session's FileStateTracker so follow-up edits see fresh
 *      hashes instead of "file changed on disk since last read"
 *
 * Requires `git` on PATH. The working directory defaults to the
 * agent's workspace (must be a git repo); override with `cwd` for
 * patches targeting a different repo the agent has access to.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '../types.js';
import { scopedSafePath } from './files.js';
import { getWorkspace } from './utils.js';
import { textEnvelope } from '../envelope.js';

const EXEC_TIMEOUT_MS = 30_000;

interface GitApplyResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

/**
 * Run `git apply` with the patch passed via stdin. Returns the full
 * stdout/stderr and exit code without throwing on non-zero — the
 * caller inspects exitCode to decide whether the apply worked.
 */
function gitApply(cwd: string, patch: string, extraArgs: string[]): Promise<GitApplyResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', ...extraArgs], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, EXEC_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    (child as unknown as NodeJS.EventEmitter).on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n[spawn error]', exitCode: 1, killed });
    });
    (child as unknown as NodeJS.EventEmitter).on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, killed });
    });

    try {
      child.stdin.write(patch);
      child.stdin.end();
    } catch {
      /* child already closed stdin; the close handler will resolve */
    }
  });
}

/**
 * Extract the file paths touched by a unified diff. Looks at the
 * `+++ b/<path>` and `--- a/<path>` headers. Returns absolute-free
 * paths — resolution against cwd happens at the tracker call site.
 *
 * Handles the common cases: normal edits, additions (--- /dev/null),
 * deletions (+++ /dev/null), and renames.
 */
export function extractPatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split('\n');
  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if (line.startsWith('+++ ') && (m = line.match(/^\+\+\+ (?:b\/)?(.+?)(?:\t|$)/))) {
      const p = m[1].trim();
      if (p && p !== '/dev/null') paths.add(p);
    } else if (line.startsWith('--- ') && (m = line.match(/^--- (?:a\/)?(.+?)(?:\t|$)/))) {
      const p = m[1].trim();
      if (p && p !== '/dev/null') paths.add(p);
    } else if (line.startsWith('diff --git ')) {
      const m2 = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m2) {
        paths.add(m2[1].trim());
        paths.add(m2[2].trim());
      }
    }
  }
  return Array.from(paths);
}

export const applyPatchTools: ToolRegistration[] = [
  {
    definition: {
      name: 'apply_patch',
      searchHint: 'apply git diff patch multi-file',
      description:
        'Apply a unified diff (git patch) atomically via `git apply`. ' +
        'Validates with `git apply --check` first so invalid patches ' +
        'never touch disk. Use this instead of multiple edit_file calls ' +
        'when you need to change several files together, or when you ' +
        'already have a diff from code review / a patch file. ' +
        'The working directory defaults to the agent workspace; ' +
        'override with `cwd` for patches targeting other repos. ' +
        'Files touched by the patch are registered in the session ' +
        'file-state tracker so subsequent edit_file calls see fresh hashes.',
      parameters: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: 'Full unified diff text (including diff --git headers, @@ hunks, etc.)',
          },
          cwd: {
            type: 'string',
            description: 'Git repo root to apply the patch in. Defaults to the agent workspace.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, only validates the patch with `git apply --check` without applying. Default false.',
          },
        },
        required: ['patch'],
      },
    },
    executor: async (args, context) => {
      const patch = args.patch as string;
      if (!patch || typeof patch !== 'string') {
        return { error: 'patch is required and must be a string' };
      }

      const workspace = getWorkspace(context as Record<string, unknown>);

      let cwd: string;
      try {
        cwd = args.cwd
          ? scopedSafePath(args.cwd as string, workspace, context)
          : workspace;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }

      if (!fs.existsSync(cwd)) {
        return { error: `cwd does not exist: ${cwd}` };
      }

      // Validate first — this must succeed before any real apply
      const check = await gitApply(cwd, patch, ['--check', '--verbose']);
      if (check.killed) {
        return { error: 'git apply --check timed out (30 s)' };
      }
      if (check.exitCode !== 0) {
        return {
          error:
            `Patch validation failed (git apply --check exit ${check.exitCode}):\n` +
            (check.stderr || check.stdout || '(no output)'),
        };
      }

      const dryRun = args.dry_run === true;
      if (dryRun) {
        const paths = extractPatchPaths(patch);
        return textEnvelope(
          `git apply --check OK (dry run).\n\n` +
          `Patch would touch ${paths.length} file${paths.length === 1 ? '' : 's'}:\n` +
          paths.map((p) => `  ${p}`).join('\n'),
        );
      }

      // Real apply
      const apply = await gitApply(cwd, patch, ['--verbose']);
      if (apply.killed) {
        return { error: 'git apply timed out (30 s) — the repo may be in a partial state' };
      }
      if (apply.exitCode !== 0) {
        return {
          error:
            `git apply failed (exit ${apply.exitCode}):\n` +
            (apply.stderr || apply.stdout || '(no output)') +
            '\n\nThe check step passed but the real apply failed — this is unusual. Inspect the repo state.',
        };
      }

      // Update the session file-state tracker for every file we touched.
      // This prevents the next edit_file call from seeing a stale-hash
      // error on freshly patched files.
      const paths = extractPatchPaths(patch);
      let trackedCount = 0;
      if (context.fileState) {
        for (const rel of paths) {
          const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
          // Only track files that resolve within cwd (prevent path traversal)
          if (!abs.startsWith(cwd + '/') && abs !== cwd) continue;
          try {
            if (fs.existsSync(abs)) {
              const content = fs.readFileSync(abs);
              context.fileState.recordWrite(abs, content);
              trackedCount++;
            }
          } catch { /* file may have been deleted by the patch */ }
        }
      }

      return textEnvelope(
        `Applied patch to ${paths.length} file${paths.length === 1 ? '' : 's'} in ${cwd}.\n` +
        `Updated file-state tracker for ${trackedCount} file${trackedCount === 1 ? '' : 's'}.\n\n` +
        `Touched files:\n` +
        paths.map((p) => `  ${p}`).join('\n'),
      );
    },
    source: 'builtin',
    category: 'write',
    isDestructive: true,
    maxResultSizeChars: 64 * 1024,
    getActivityDescription: (input) => {
      const patch = (input as { patch?: string })?.patch ?? '';
      const fileCount = extractPatchPaths(patch).length;
      return `apply_patch (${fileCount} files)`;
    },
  },
];
