import fs from 'node:fs';
import path from 'node:path';

const CRON_OUTPUT_DIR = 'cron-output';
const MAX_SUMMARY_LINES = 200;
const MAX_SUMMARY_CHARS = 3_000;
const SUMMARY_LINE_LENGTH = 80;
const MAX_OUTPUT_CHARS = 2_000;
const RETENTION_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const SUMMARY_FILE = 'summary.log';

function outputDir(stateDir: string, jobId: string): string {
  return path.join(stateDir, CRON_OUTPUT_DIR, jobId);
}

/**
 * Load compressed run summaries for context injection.
 *
 * Each run is stored as a single line (~30-80 chars) in summary.log
 * instead of loading full output files. This gives the agent visibility
 * into 200 past runs at ~3K chars — vs the old approach of 30 runs
 * at 6K chars. Works for all cron types:
 *   - Creative: "baby fox in enchanted forest" → agent picks new theme
 *   - News: "Singapore haze PSI 224, India budget" → agent avoids repeating
 *   - Deals: "KFC buffet $25.95, Uniqlo 50% off" → agent finds new deals
 */
export function loadCronOutputHistory(stateDir: string, jobId: string): string | null {
  const summaryPath = path.join(outputDir(stateDir, jobId), SUMMARY_FILE);

  if (!fs.existsSync(summaryPath)) {
    return migrateFromRawFiles(stateDir, jobId);
  }

  try {
    const content = fs.readFileSync(summaryPath, 'utf8').trim();
    if (!content) return null;

    const lines = content.split('\n');
    const recent = lines.slice(-MAX_SUMMARY_LINES);

    let result = '';
    for (let i = recent.length - 1; i >= 0; i--) {
      if (result.length + recent[i].length + 1 > MAX_SUMMARY_CHARS) break;
      result = recent[i] + '\n' + result;
    }

    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * One-time migration: read existing raw .md files and build summary.log.
 * After migration, future runs use summary.log directly.
 */
function migrateFromRawFiles(stateDir: string, jobId: string): string | null {
  const dir = outputDir(stateDir, jobId);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (files.length === 0) return null;

  const summaryLines: string[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
      if (!content) continue;
      const date = file.replace('.md', '').slice(0, 10);
      const summary = extractSummary(content);
      if (summary) summaryLines.push(`${date}: ${summary}`);
    } catch {
      continue;
    }
  }

  if (summaryLines.length === 0) return null;

  const summaryPath = path.join(dir, SUMMARY_FILE);
  try {
    fs.writeFileSync(summaryPath, summaryLines.join('\n') + '\n');
  } catch {
    // non-fatal — will retry on next run
  }

  const recent = summaryLines.slice(-MAX_SUMMARY_LINES);
  let result = '';
  for (let i = recent.length - 1; i >= 0; i--) {
    if (result.length + recent[i].length + 1 > MAX_SUMMARY_CHARS) break;
    result = recent[i] + '\n' + result;
  }

  return result.trim() || null;
}

/**
 * Extract a compact summary line from a cron output.
 *
 * Strips emojis, formatting, and noise to produce a ~80 char summary
 * that captures the essence of what was generated.
 */
function extractSummary(text: string): string {
  const cleaned = text
    .replace(/!\[(?:image|[^\]]*)\]\([^)]+\)/g, '')
    .replace(/\[image\]/g, '')
    .replace(/\/api\/v1\/media\/[^\s)]+/g, '')
    .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const truncated = cleaned.length > SUMMARY_LINE_LENGTH
    ? cleaned.slice(0, SUMMARY_LINE_LENGTH).replace(/\s\S*$/, '')
    : cleaned;

  return truncated;
}

/**
 * Strip media noise from output for raw file storage.
 */
function cleanOutputForHistory(text: string): string {
  return text
    .replace(/!\[(?:image|[^\]]*)\]\([^)]+\)/g, '')
    .replace(/\[image\]/g, '')
    .replace(/\/api\/v1\/media\/[^\s)]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Save a cron run's output.
 *
 * Two storage layers:
 *   1. Raw .md file — full cleaned output for debugging/audit (7-day retention)
 *   2. summary.log — one-line summary appended (rolling 200 entries)
 *
 * The summary.log is what gets injected into the agent's context.
 * The raw files are kept for troubleshooting but never loaded into context.
 */
export function saveCronOutput(stateDir: string, jobId: string, output: string): void {
  const dir = outputDir(stateDir, jobId);
  fs.mkdirSync(dir, { recursive: true });

  const cleaned = cleanOutputForHistory(output);
  if (!cleaned) return;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const date = now.toISOString().slice(0, 10);

  // Raw file (debugging)
  const filePath = path.join(dir, `${timestamp}.md`);
  fs.writeFileSync(filePath, cleaned.slice(0, MAX_OUTPUT_CHARS));

  // Summary line (context injection)
  const summary = extractSummary(cleaned);
  if (summary) {
    const summaryPath = path.join(dir, SUMMARY_FILE);
    fs.appendFileSync(summaryPath, `${date}: ${summary}\n`);
    trimSummaryFile(summaryPath);
  }

  cleanupOldOutputs(dir);
}

/**
 * Keep summary.log under MAX_SUMMARY_LINES by trimming oldest entries.
 */
function trimSummaryFile(summaryPath: string): void {
  try {
    const content = fs.readFileSync(summaryPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > MAX_SUMMARY_LINES) {
      const trimmed = lines.slice(-MAX_SUMMARY_LINES);
      fs.writeFileSync(summaryPath, trimmed.join('\n') + '\n');
    }
  } catch {
    // non-fatal
  }
}

function cleanupOldOutputs(dir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * MS_PER_DAY;
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort();

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // non-fatal
  }
}
