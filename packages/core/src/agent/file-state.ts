/**
 * File-state tracker — per-session "read before edit" enforcement.
 *
 * Every successful `read_file` records the path, a hash of the content,
 * and the read time. `edit_file` and `write_file` refuse to run unless:
 *
 *   1. The target path has a recorded read in this session, AND
 *   2. The on-disk content still matches the recorded hash.
 *
 * This prevents the agent from blindly editing files it hasn't seen,
 * or overwriting changes that happened out-of-band while the agent
 * was "thinking". It's the tool-shape safety guarantee from Phase 6 —
 * enforced by mechanics, not permissions.
 *
 * Implements the `FileStateTracker` interface from `@agw/types`.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import type { FileStateTracker as FileStateTrackerInterface } from '@agw/types';

interface FileStateEntry {
  readAt: number;
  hash: string;
  size: number;
}

export class FileStateTracker implements FileStateTrackerInterface {
  private entries = new Map<string, FileStateEntry>();

  /**
   * Record a successful read. Hash is computed from the content the
   * reader actually returned (not re-read from disk) so even if the
   * file changes between the read and this call, the hash matches
   * what the LLM saw.
   */
  recordRead(absolutePath: string, content: Uint8Array | string): void {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    this.entries.set(absolutePath, {
      readAt: Date.now(),
      hash,
      size: buf.byteLength,
    });
  }

  /**
   * Verify that the file was previously read AND its on-disk contents
   * still match the recorded hash. Returns `{ok:true, hash}` if safe to
   * edit, or `{ok:false, error}` with a clear reason if not.
   *
   * The error messages are written for the LLM — they tell the agent
   * exactly what to do next (`call read_file first`, `re-read because
   * the file changed`, etc.) instead of just saying "denied".
   */
  requireRead(absolutePath: string): { ok: true; hash: string } | { ok: false; error: string } {
    const entry = this.entries.get(absolutePath);
    if (!entry) {
      return {
        ok: false,
        error: `File not read yet in this session: ${absolutePath}. Call read_file first so you have fresh context before editing.`,
      };
    }

    // Verify the on-disk hash still matches
    let currentContent: Buffer;
    try {
      currentContent = fs.readFileSync(absolutePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `File no longer exists or is unreadable: ${absolutePath} (${msg}). It may have been deleted or moved.`,
      };
    }

    const currentHash = crypto.createHash('sha256').update(currentContent).digest('hex');
    if (currentHash !== entry.hash) {
      return {
        ok: false,
        error: `File changed on disk since last read: ${absolutePath}. Call read_file again to see the latest contents, then retry the edit against the new content.`,
      };
    }

    return { ok: true, hash: entry.hash };
  }

  /** Record a successful write or edit. Updates the hash to match new content. */
  recordWrite(absolutePath: string, content: Uint8Array | string): void {
    // Same logic as recordRead — a write is also "latest seen" for this session.
    this.recordRead(absolutePath, content);
  }

  /** Forget a path — useful when the file is intentionally deleted. */
  forget(absolutePath: string): void {
    this.entries.delete(absolutePath);
  }

  /** Clear all entries — called at session end. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of tracked files. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Debug helper: snapshot the current state. Not part of the interface,
   * useful for tests and the admin UI.
   */
  debugSnapshot(): Array<{ path: string; readAt: number; size: number; hash: string }> {
    return Array.from(this.entries.entries()).map(([path, e]) => ({
      path,
      readAt: e.readAt,
      size: e.size,
      hash: e.hash,
    }));
  }
}
