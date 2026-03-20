/**
 * Memory system — indexes workspace markdown files into searchable chunks.
 *
 * Ported from v1 (src/memory/index.js) to TypeScript class-based design.
 * Uses the main gateway.db via DatabaseAdapter instead of a separate SQLite file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseAdapter } from '../db/index.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('memory');

const CHUNK_SIZE = 400; // tokens (~1600 chars)
const CHUNK_OVERLAP = 80; // tokens (~320 chars)
const CHARS_PER_TOKEN = 4;

export interface MemoryChunk {
  id: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}

interface ChunkRow {
  id: number;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  updated_at: string;
}

export interface MemoryStats {
  initialized: boolean;
  totalChunks: number;
  indexedFiles: number;
  files: string[];
}

export class MemorySystem {
  private db: DatabaseAdapter;
  private workspace: string;
  private watchers: fs.FSWatcher[] = [];
  private initialized = false;
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(db: DatabaseAdapter, workspace: string) {
    this.db = db;
    this.workspace = workspace;
  }

  /**
   * Initialize the memory system: index existing files and start watchers.
   * The memory_chunks table is created via migration 002_memory_chunks.sql.
   */
  init(): void {
    try {
      this.indexAllFiles();
      this.startWatcher();
      this.initialized = true;
      log.info('Memory system initialized');
    } catch (e) {
      this.close();
      log.error({ err: (e as Error).message }, 'Failed to initialize memory system');
    }
  }

  /**
   * Search memory chunks using keyword scoring.
   * Returns top-N results ranked by term frequency with bonuses for
   * heading matches and exact phrase matches.
   */
  search(query: string, topN = 5): MemoryChunk[] {
    if (!this.initialized) return [];

    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (queryTerms.length === 0) return [];

    try {
      const allChunks = this.db.query<ChunkRow>(
        'SELECT * FROM memory_chunks ORDER BY updated_at DESC',
      );

      const queryLower = query.toLowerCase();

      const scored = allChunks.map((chunk) => {
        const contentLower = chunk.content.toLowerCase();
        let score = 0;

        for (const term of queryTerms) {
          // Count occurrences
          let idx = 0;
          let count = 0;
          while ((idx = contentLower.indexOf(term, idx)) !== -1) {
            count++;
            idx += term.length;
          }
          score += count;

          // Bonus for term in first line (likely a heading)
          const firstLine = contentLower.split('\n')[0];
          if (firstLine.includes(term)) score += 2;
        }

        // Bonus for exact phrase match
        if (contentLower.includes(queryLower)) {
          score += 5;
        }

        return { chunk, score };
      });

      return scored
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((r) => ({
          id: r.chunk.id,
          filePath: r.chunk.file_path,
          lineStart: r.chunk.line_start,
          lineEnd: r.chunk.line_end,
          content: r.chunk.content.slice(0, 1000),
          score: r.score,
        }));
    } catch (e) {
      log.error({ err: (e as Error).message }, 'Memory search error');
      return [];
    }
  }

  /**
   * Get memory system statistics.
   */
  getStats(): MemoryStats {
    if (!this.initialized) {
      return { initialized: false, totalChunks: 0, indexedFiles: 0, files: [] };
    }

    try {
      const chunkCount = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM memory_chunks',
      );
      const fileRows = this.db.query<{ file_path: string }>(
        'SELECT DISTINCT file_path FROM memory_chunks',
      );
      return {
        initialized: true,
        totalChunks: chunkCount?.count ?? 0,
        indexedFiles: fileRows.length,
        files: fileRows.map((r) => r.file_path),
      };
    } catch (e) {
      log.error({ err: (e as Error).message }, 'Memory stats error');
      return { initialized: true, totalChunks: 0, indexedFiles: 0, files: [] };
    }
  }

  /**
   * Re-index all memory files from scratch.
   */
  reindex(): void {
    this.indexAllFiles();
    log.info('Memory re-indexed');
  }

  /**
   * Stop file watchers and clean up.
   */
  close(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers = [];
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    this.initialized = false;
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Get all memory file paths to index:
   * - MEMORY.md in workspace root
   * - memory/*.md in workspace
   */
  private getMemoryFiles(): string[] {
    const files: string[] = [];

    const memoryMd = path.join(this.workspace, 'MEMORY.md');
    if (fs.existsSync(memoryMd)) files.push(memoryMd);

    const memoryDir = path.join(this.workspace, 'memory');
    if (fs.existsSync(memoryDir)) {
      const entries = fs.readdirSync(memoryDir);
      for (const entry of entries) {
        if (entry.endsWith('.md')) {
          files.push(path.join(memoryDir, entry));
        }
      }
    }

    return files;
  }

  /**
   * Chunk a file into overlapping segments by line count / character budget.
   */
  private chunkFile(
    filePath: string,
  ): Array<{ content: string; lineStart: number; lineEnd: number }> {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const chunks: Array<{ content: string; lineStart: number; lineEnd: number }> = [];

    const chunkChars = CHUNK_SIZE * CHARS_PER_TOKEN;
    const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;

    let i = 0;
    while (i < lines.length) {
      let chunkText = '';
      const lineStart = i + 1; // 1-indexed
      let lineEnd = i + 1;

      while (i < lines.length && chunkText.length < chunkChars) {
        chunkText += (chunkText ? '\n' : '') + lines[i];
        lineEnd = i + 1;
        i++;
      }

      if (chunkText.trim()) {
        chunks.push({ content: chunkText.trim(), lineStart, lineEnd });
      }

      // Overlap: back up by overlap amount
      if (i < lines.length) {
        let overlapLen = 0;
        let backtrack = 0;
        for (let j = i - 1; j >= 0 && overlapLen < overlapChars; j--) {
          overlapLen += lines[j].length + 1;
          backtrack++;
        }
        i = Math.max(i - backtrack, i - 1);
        if (i <= lineStart - 1) i = lineEnd; // Prevent infinite loop
      }
    }

    return chunks;
  }

  /**
   * Index a single file: delete old chunks and insert new ones.
   */
  private indexFile(filePath: string): void {
    try {
      const relativePath = path.relative(this.workspace, filePath);
      const now = new Date().toISOString();

      // Delete old chunks for this file
      this.db.run('DELETE FROM memory_chunks WHERE file_path = ?', [relativePath]);

      // Chunk and insert
      const chunks = this.chunkFile(filePath);

      this.db.transaction(() => {
        for (const chunk of chunks) {
          this.db.run(
            'INSERT INTO memory_chunks (file_path, line_start, line_end, content, updated_at) VALUES (?, ?, ?, ?, ?)',
            [relativePath, chunk.lineStart, chunk.lineEnd, chunk.content, now],
          );
        }
      });

      log.debug({ file: relativePath, chunks: chunks.length }, 'Indexed memory file');
    } catch (e) {
      log.error({ err: (e as Error).message, file: filePath }, 'Failed to index file');
    }
  }

  /**
   * Index all discovered memory files.
   */
  private indexAllFiles(): void {
    const files = this.getMemoryFiles();
    for (const file of files) {
      this.indexFile(file);
    }
    log.info({ files: files.length }, 'Memory files indexed');
  }

  /**
   * Watch workspace memory paths for changes and auto-reindex.
   */
  private startWatcher(): void {
    const watchPaths = [
      path.join(this.workspace, 'MEMORY.md'),
      path.join(this.workspace, 'memory'),
    ];

    for (const watchPath of watchPaths) {
      if (!fs.existsSync(watchPath)) continue;

      try {
        const w = fs.watch(watchPath, { recursive: false }, (_eventType, filename) => {
          // Debounce: wait for writes to settle
          const debounceKey = filename ? path.join(watchPath, filename) : watchPath;
          const existing = this._debounceTimers.get(debounceKey);
          if (existing) clearTimeout(existing);
          this._debounceTimers.set(debounceKey, setTimeout(() => {
            this._debounceTimers.delete(debounceKey);
            if (filename && filename.endsWith('.md')) {
              const isDir = fs.statSync(watchPath, { throwIfNoEntry: false })?.isDirectory();
              const fullPath = isDir ? path.join(watchPath, filename) : watchPath;
              if (fs.existsSync(fullPath)) {
                this.indexFile(fullPath);
              }
            } else if (!filename) {
              // MEMORY.md itself changed
              if (fs.existsSync(watchPath) && watchPath.endsWith('.md')) {
                this.indexFile(watchPath);
              }
            }
          }, 500));
        });

        this.watchers.push(w);
      } catch (e) {
        log.debug(
          { err: (e as Error).message, path: watchPath },
          'Could not watch path',
        );
      }
    }
  }
}
