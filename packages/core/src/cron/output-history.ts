import fs from 'node:fs';
import path from 'node:path';

const CRON_OUTPUT_DIR = 'cron-output';
const MAX_HISTORY_FILES = 30;
const MAX_HISTORY_CHARS = 6_000;
const MAX_OUTPUT_CHARS = 2_000;
const RETENTION_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function outputDir(stateDir: string, jobId: string): string {
  return path.join(stateDir, CRON_OUTPUT_DIR, jobId);
}

/**
 * Load the last N cron outputs for a job as context for the next run.
 * Returns null if no history exists.
 */
export function loadCronOutputHistory(stateDir: string, jobId: string): string | null {
  const dir = outputDir(stateDir, jobId);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, MAX_HISTORY_FILES);

  if (files.length === 0) return null;

  const entries: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    } catch {
      continue;
    }
    if (!content) continue;
    const date = file.replace('.md', '');
    const entry = `[${date}]\n${content}`;
    if (totalChars + entry.length > MAX_HISTORY_CHARS) break;
    entries.push(entry);
    totalChars += entry.length;
  }

  return entries.length > 0 ? entries.join('\n\n') : null;
}

/**
 * Strip media noise from output — keep only human-readable text.
 * Removes markdown image syntax, bare media URLs, and signed URL params.
 * Generic — works for any cron output type.
 */
function cleanOutputForHistory(text: string): string {
  return text
    .replace(/!\[(?:image|[^\]]*)\]\([^)]+\)/g, '')   // ![image](url) or ![alt](url)
    .replace(/\[image\]/g, '')                          // [image] placeholders
    .replace(/\/api\/v1\/media\/[^\s)]+/g, '')          // bare media URLs
    .replace(/\n{3,}/g, '\n\n')                         // collapse excessive newlines
    .trim();
}

/**
 * Save a cron run's output for future context injection.
 * Strips media URLs and saves only human-readable text.
 * Filename is timestamp-based for chronological ordering.
 */
export function saveCronOutput(stateDir: string, jobId: string, output: string): void {
  const dir = outputDir(stateDir, jobId);
  fs.mkdirSync(dir, { recursive: true });

  const cleaned = cleanOutputForHistory(output);
  if (!cleaned) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(dir, `${timestamp}.md`);
  fs.writeFileSync(filePath, cleaned.slice(0, MAX_OUTPUT_CHARS));

  cleanupOldOutputs(dir);
}

function cleanupOldOutputs(dir: string): void {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * MS_PER_DAY;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();

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
