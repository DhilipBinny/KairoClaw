/**
 * @agw/logger — structured logging with three destinations:
 *   1. pino-pretty → terminal (human-readable, colorized)
 *   2. JSON file → daily rotation with retention
 *   3. Ring buffer → in-memory for admin UI
 */

import fs from 'node:fs';
import path from 'node:path';
import { pino, multistream } from 'pino';
import type { Logger } from 'pino';
import { Writable } from 'node:stream';
import type { AgwLogger } from '@agw/types';
import pinoPretty from 'pino-pretty';
import { filterOutput, redactSecrets } from '@agw/security';

const DEFAULT_BUFFER_CAPACITY = 1_000;
const DEFAULT_RETENTION_DAYS = 7;

// ── Redaction ──────────────────────────────────────
// Secrets can reach the logs two ways: embedded in a free-text message, or as a
// structured field. We defend both, on all three destinations:
//   - `redact` censors well-known credential keys by name (catching values that
//     don't match a pattern, e.g. a short password). It also covers `.child()`
//     bindings, which never pass through the logMethod hook.
//   - The `logMethod` hook scrubs pattern-matchable secrets anywhere in the
//     message string or merged object, and (via redactSecrets) redacts values
//     under credential-looking keys case-insensitively.
//   - As a final backstop, EVERY destination stream (file, ring buffer, and the
//     pretty/stdout stream) runs filterOutput over each rendered line, which
//     also covers serialized Error messages/stacks the hook leaves intact.

const REDACT_PATHS = [
  'password', 'token', 'secret', 'apiKey', 'api_key', 'apikey', 'authorization',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'privateKey', 'private_key', 'botToken', 'bot_token', 'masterKey', 'master_key',
  'AGW_MASTER_KEY', 'TELEGRAM_BOT_TOKEN', 'BRAVE_API_KEY',
  // pino matches paths case-sensitively, so list HTTP-header / capitalized forms.
  'Authorization', 'Cookie', 'Password', 'Token', 'Secret',
  '*.password', '*.token', '*.secret', '*.apiKey', '*.api_key', '*.authorization',
  '*.accessToken', '*.refreshToken', '*.privateKey', '*.botToken',
  '*.Authorization', '*.Cookie',
];

function redactLogMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string') args[i] = filterOutput(a);
    else if (a && typeof a === 'object') args[i] = redactSecrets(a);
  }
  method.apply(this, args);
}

const REDACT_OPTIONS = {
  redact: { paths: REDACT_PATHS, censor: '***REDACTED***' },
  hooks: { logMethod: redactLogMethod },
};

/** Wrap a destination stream so every rendered line is run through filterOutput. */
function redactingWritable(dest: NodeJS.WritableStream): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      dest.write(filterOutput(chunk.toString()));
      callback();
    },
  });
}

// ── Types ─────────────────────────────────────────

export interface LogEntry {
  level: string;
  msg: string;
  time: number;
  category?: string;
  [key: string]: unknown;
}

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
  | 'security'
  | 'plugins'
  | 'browser';

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

// ── Ring Buffer ────────────────────────────────────

export class LogBuffer {
  private buffer: LogEntry[];
  private head: number;
  private count: number;
  private readonly capacity: number;

  constructor(capacity: number = DEFAULT_BUFFER_CAPACITY) {
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

function createLogBufferStream(): Writable {
  return new Writable({
    objectMode: false,
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      try {
        // Backstop redaction over the whole line (covers serialized Error
        // messages/stacks the logMethod hook leaves intact). Replacements never
        // contain quotes/braces, so the line stays valid JSON.
        const entry = JSON.parse(filterOutput(chunk.toString()));
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

function createFileStream(logsDir: string, retentionDays = DEFAULT_RETENTION_DAYS): Writable {
  fs.mkdirSync(logsDir, { recursive: true });
  let currentDate = new Date().toISOString().slice(0, 10);
  let filePath = path.join(logsDir, `server-${currentDate}.log`);
  let fd = fs.openSync(filePath, 'a');

  return new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== currentDate) {
        fs.closeSync(fd);
        currentDate = today;
        filePath = path.join(logsDir, `server-${currentDate}.log`);
        fd = fs.openSync(filePath, 'a');
        cleanOldLogs(logsDir, retentionDays);
      }
      // Backstop redaction over the persisted line (see ring-buffer stream).
      fs.writeSync(fd, filterOutput(chunk.toString()));
      callback();
    },
    final(callback: () => void) {
      fs.closeSync(fd);
      callback();
    },
  });
}

function cleanOldLogs(logsDir: string, keepDays: number): void {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('server-') && f.endsWith('.log'));
    for (const file of files) {
      const fp = path.join(logsDir, file);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch { /* non-critical */ }
}

// ── Shared state ───────────────────────────────────

let _logsDir = '';
let _sharedStream: ReturnType<typeof multistream> | null = null;

export function getLogsDir(): string { return _logsDir; }

// ── Logger Factories ───────────────────────────────

export function createLogger(level?: string): Logger {
  // Use a direct pino-pretty stream (not a worker-thread transport) so its
  // rendered output passes through the filterOutput backstop before stdout.
  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    destination: redactingWritable(process.stdout),
  });
  return pino({
    level: level || process.env.LOG_LEVEL || 'info',
    ...REDACT_OPTIONS,
  }, prettyStream);
}

export function createModuleLogger(category: LogCategory | string, level?: string): Logger {
  const logLevel = level || process.env.LOG_LEVEL || 'info';
  let _inner: Logger | null = null;
  function getInner(): Logger {
    if (_inner) return _inner;
    if (_sharedStream) {
      _inner = pino({ level: logLevel, ...REDACT_OPTIONS }, _sharedStream).child({ category });
    } else {
      _inner = createLogger(logLevel).child({ category });
    }
    return _inner;
  }
  return new Proxy({} as Logger, {
    get(_target, prop) {
      const inner = getInner();
      const val = (inner as any)[prop];
      return typeof val === 'function' ? val.bind(inner) : val;
    },
  });
}

export function toAgwLogger(pinoLogger: Logger): AgwLogger {
  return {
    info: pinoLogger.info.bind(pinoLogger),
    warn: pinoLogger.warn.bind(pinoLogger),
    error: pinoLogger.error.bind(pinoLogger),
    debug: pinoLogger.debug.bind(pinoLogger),
    child(bindings: Record<string, unknown>): AgwLogger {
      return toAgwLogger(pinoLogger.child(bindings));
    },
  };
}

export function createServerLogger(stateDir: string, level?: string): { stream: ReturnType<typeof multistream> } {
  const logLevel = level || process.env.LOG_LEVEL || 'info';
  const logsDir = path.join(stateDir, 'logs');
  _logsDir = logsDir;

  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    // Backstop redaction over the rendered line before it reaches stdout, so
    // secrets in serialized Errors / child bindings the hook leaves intact don't
    // leak to the terminal/journald.
    destination: redactingWritable(process.stdout),
  });

  const stream = multistream([
    { level: logLevel as any, stream: prettyStream },
    { level: logLevel as any, stream: createFileStream(logsDir) },
    { level: logLevel as any, stream: createLogBufferStream() },
  ]);

  _sharedStream = stream;
  return { stream };
}

// ── Log File Reader ────────────────────────────────

export function listLogFiles(): Array<{ date: string; file: string; sizeBytes: number }> {
  if (!_logsDir) return [];
  try {
    return fs.readdirSync(_logsDir)
      .filter(f => f.startsWith('server-') && f.endsWith('.log'))
      .sort().reverse()
      .map(file => {
        const stat = fs.statSync(path.join(_logsDir, file));
        return { date: file.replace('server-', '').replace('.log', ''), file, sizeBytes: stat.size };
      });
  } catch { return []; }
}

export function searchLogFiles(opts: {
  query?: string; level?: string; from?: string; to?: string; limit?: number;
}): LogEntry[] {
  if (!_logsDir) return [];
  const { query, level, from, to, limit = 200 } = opts;
  const results: LogEntry[] = [];

  const files = fs.readdirSync(_logsDir)
    .filter(f => f.startsWith('server-') && f.endsWith('.log'))
    .sort().reverse();

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
          if (level && entryLevel !== level) continue;
          if (query && !JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) continue;
          results.push({ ...entry, level: entryLevel, msg: entry.msg || '', time: entry.time || 0 });
          if (results.length >= limit) return results;
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }
  return results;
}

export function getLogFilePath(date: string): string | null {
  if (!_logsDir) return null;
  const filePath = path.join(_logsDir, `server-${date}.log`);
  return fs.existsSync(filePath) ? filePath : null;
}
