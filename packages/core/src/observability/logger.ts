import fs from 'node:fs';
import path from 'node:path';
import { LOG_BUFFER_CAPACITY, LOG_RETENTION_DAYS } from '../constants.js';
import { pino, multistream } from 'pino';
import type { Logger } from 'pino';
import { Writable } from 'node:stream';
import pinoPretty from 'pino-pretty';

/**
 * Logging system — three destinations via pino.multistream():
 *   1. pino-pretty → terminal (human-readable, colorized)
 *   2. JSON file   → ~/.agw/logs/server.log (daily rotation, 7 days retention)
 *   3. Ring buffer → in-memory for /api/logs admin UI (last 1000 entries)
 */

export interface LogEntry {
  level: string;
  msg: string;
  time: number;
  category?: string;
  [key: string]: unknown;
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

/** Directory where log files are stored. Set by createServerLogger(). */
let _logsDir = '';
export function getLogsDir(): string { return _logsDir; }

// ── Ring Buffer ────────────────────────────────────

export class LogBuffer {
  private buffer: LogEntry[];
  private head: number;
  private count: number;
  private readonly capacity: number;

  constructor(capacity: number = LOG_BUFFER_CAPACITY) {
    this.capacity = capacity;
    this.buffer = new Array<LogEntry>(capacity);
    this.head = 0;
    this.count = 0;
  }

  push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getRecent(n: number = 100): LogEntry[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - n));
  }

  getAll(): LogEntry[] {
    if (this.count < this.capacity) return this.buffer.slice(0, this.count);
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  get size(): number { return this.count; }

  clear(): void {
    this.buffer = new Array<LogEntry>(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}

export const logBuffer = new LogBuffer();

// ── Streams ────────────────────────────────────────

/** Ring buffer stream — filters HTTP noise, stores structured entries. */
function createLogBufferStream(): Writable {
  return new Writable({
    objectMode: false,
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      try {
        const entry = JSON.parse(chunk.toString());
        const msg = entry.msg || '';
        if (msg === 'incoming request' || msg === 'request completed') {
          callback();
          return;
        }
        logBuffer.push({
          ...entry,
          level: LEVEL_NAMES[entry.level] || String(entry.level),
          msg,
          time: entry.time || Date.now(),
        });
      } catch { /* ignore non-JSON lines */ }
      callback();
    },
  });
}

/** File stream — writes JSON lines to a log file with daily rotation. */
function createFileStream(logsDir: string): Writable {
  fs.mkdirSync(logsDir, { recursive: true });

  // Current log file path
  let currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let filePath = path.join(logsDir, `server-${currentDate}.log`);
  let fd = fs.openSync(filePath, 'a');

  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      // Check if date rolled over (daily rotation)
      const today = new Date().toISOString().slice(0, 10);
      if (today !== currentDate) {
        fs.closeSync(fd);
        currentDate = today;
        filePath = path.join(logsDir, `server-${currentDate}.log`);
        fd = fs.openSync(filePath, 'a');
        // Clean up old log files (keep 7 days)
        cleanOldLogs(logsDir, LOG_RETENTION_DAYS);
      }
      fs.writeSync(fd, chunk.toString());
      callback();
    },
    final(callback: () => void) {
      fs.closeSync(fd);
      callback();
    },
  });
}

/** Remove log files older than `keepDays` days. */
function cleanOldLogs(logsDir: string, keepDays: number): void {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('server-') && f.endsWith('.log'));
    for (const file of files) {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* non-critical */ }
}

// ── Log Categories ─────────────────────────────────
// Every log call should have a category for filtering in the admin UI.

export type LogCategory =
  | 'llm'
  | 'tool'
  | 'mcp'
  | 'channel.telegram'
  | 'channel.whatsapp'
  | 'channel.web'
  | 'cron'
  | 'memory'
  | 'auth'
  | 'config'
  | 'http'
  | 'system'
  | 'security';

// ── Shared multistream (set by createServerLogger, used by createModuleLogger) ──
let _sharedStream: ReturnType<typeof multistream> | null = null;

// ── Logger Factories ───────────────────────────────

/**
 * Standalone Pino logger — pretty-prints to terminal only.
 * Used as fallback before server logger is initialized.
 */
export function createLogger(level?: string): Logger {
  return pino({
    level: level || process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  });
}

/**
 * Create a category-aware logger that routes to ALL three destinations
 * (terminal + file + ring buffer) once the server logger is initialized.
 *
 * Before server startup, falls back to terminal-only.
 *
 * Usage:
 *   const log = createModuleLogger('mcp');
 *   log.info({ server: 'github' }, 'Connected');
 */
export function createModuleLogger(category: LogCategory, level?: string): Logger {
  const logLevel = level || process.env.LOG_LEVEL || 'info';

  // Use a lazy proxy: the actual logger is created on first use,
  // so modules imported before createServerLogger still get the multistream.
  let _inner: Logger | null = null;
  function getInner(): Logger {
    if (_inner) return _inner;
    if (_sharedStream) {
      _inner = pino({ level: logLevel }, _sharedStream).child({ category });
    } else {
      _inner = createLogger(logLevel).child({ category });
    }
    return _inner;
  }

  // Return a Proxy that delegates all property access to the lazy inner logger
  return new Proxy({} as Logger, {
    get(_target, prop) {
      const inner = getInner();
      const val = (inner as any)[prop];
      return typeof val === 'function' ? val.bind(inner) : val;
    },
  });
}

/**
 * Fastify server logger with three destinations:
 *   1. pino-pretty → terminal
 *   2. JSON file → daily-rotated log files
 *   3. Ring buffer → admin UI
 */
export function createServerLogger(stateDir: string, level?: string): { stream: ReturnType<typeof multistream> } {
  const logLevel = level || process.env.LOG_LEVEL || 'info';
  const logsDir = path.join(stateDir, 'logs');
  _logsDir = logsDir;

  // pino-pretty writes to stdout by default — no need to pipe
  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    destination: process.stdout,
  });

  const stream = multistream([
    { level: logLevel as any, stream: prettyStream },
    { level: logLevel as any, stream: createFileStream(logsDir) },
    { level: logLevel as any, stream: createLogBufferStream() },
  ]);

  // Store for createModuleLogger to use
  _sharedStream = stream;

  return { stream };
}

// ── Log File Reader (for search/download endpoints) ─

/**
 * List available log files with date and size.
 */
export function listLogFiles(): Array<{ date: string; file: string; sizeBytes: number }> {
  if (!_logsDir) return [];
  try {
    return fs.readdirSync(_logsDir)
      .filter(f => f.startsWith('server-') && f.endsWith('.log'))
      .sort()
      .reverse()
      .map(file => {
        const stat = fs.statSync(path.join(_logsDir, file));
        const date = file.replace('server-', '').replace('.log', '');
        return { date, file, sizeBytes: stat.size };
      });
  } catch { return []; }
}

/**
 * Search log files for entries matching criteria.
 */
export function searchLogFiles(opts: {
  query?: string;
  level?: string;
  from?: string;
  to?: string;
  limit?: number;
}): LogEntry[] {
  if (!_logsDir) return [];
  const { query, level, from, to, limit = 200 } = opts;
  const results: LogEntry[] = [];

  // Determine which files to search
  const files = fs.readdirSync(_logsDir)
    .filter(f => f.startsWith('server-') && f.endsWith('.log'))
    .sort()
    .reverse();

  for (const file of files) {
    const date = file.replace('server-', '').replace('.log', '');
    if (from && date < from) continue;
    if (to && date > to) continue;

    try {
      const lines = fs.readFileSync(path.join(_logsDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const entryLevel = LEVEL_NAMES[entry.level] || String(entry.level);

          // Filter by level
          if (level && entryLevel !== level) continue;

          // Filter by query (searches msg and other string fields)
          if (query) {
            const searchStr = JSON.stringify(entry).toLowerCase();
            if (!searchStr.includes(query.toLowerCase())) continue;
          }

          results.push({
            ...entry,
            level: entryLevel,
            msg: entry.msg || '',
            time: entry.time || 0,
          });

          if (results.length >= limit) return results;
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return results;
}

/**
 * Get the full path to a log file by date.
 */
export function getLogFilePath(date: string): string | null {
  if (!_logsDir) return null;
  const filePath = path.join(_logsDir, `server-${date}.log`);
  return fs.existsSync(filePath) ? filePath : null;
}
