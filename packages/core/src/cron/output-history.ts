import fs from 'node:fs';
import path from 'node:path';
import type { ToolRegistration } from '@agw/tool-platform';

const CRON_OUTPUT_DIR = 'cron-output';
const MAX_SUMMARY_LINES = 200;
const MAX_EXCLUSION_ITEMS = 100;
const MAX_OUTPUT_CHARS = 2_000;
const RETENTION_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const SUMMARY_FILE = 'summary.log';

function outputDir(stateDir: string, jobId: string): string {
  return path.join(stateDir, CRON_OUTPUT_DIR, jobId);
}

/**
 * Load a deduplicated exclusion list from past cron runs.
 *
 * Reads summary.log (themes recorded by the agent via record_theme tool),
 * deduplicates them, and returns a compact list the agent can act on.
 * Returns null if no history exists.
 */
export function loadCronOutputHistory(stateDir: string, jobId: string): string | null {
  const summaryPath = path.join(outputDir(stateDir, jobId), SUMMARY_FILE);

  if (!fs.existsSync(summaryPath)) {
    migrateFromRawFiles(stateDir, jobId);
    if (!fs.existsSync(summaryPath)) return null;
  }

  try {
    const content = fs.readFileSync(summaryPath, 'utf8').trim();
    if (!content) return null;

    const lines = content.split('\n').filter(l => l.trim());
    const recent = lines.slice(-MAX_SUMMARY_LINES);

    const themes = recent.map(line => {
      const colonIdx = line.indexOf(': ');
      return colonIdx >= 0 ? line.slice(colonIdx + 2).trim() : line.trim();
    }).filter(Boolean);

    const unique = deduplicateThemes(themes);
    return unique.slice(-MAX_EXCLUSION_ITEMS).join(', ');
  } catch {
    return null;
  }
}

/**
 * Deduplicate themes by lowercased prefix matching.
 */
function deduplicateThemes(themes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const theme of themes) {
    const key = theme.toLowerCase().trim().slice(0, 25);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(theme);
  }

  return result;
}

/**
 * Record a theme chosen by the agent for this cron run.
 * Called by the record_theme tool during cron execution.
 */
export function recordTheme(stateDir: string, jobId: string, theme: string): void {
  const dir = outputDir(stateDir, jobId);
  fs.mkdirSync(dir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const clean = theme.replace(/\n/g, ' ').trim().slice(0, 120);
  if (!clean) return;

  const summaryPath = path.join(dir, SUMMARY_FILE);
  fs.appendFileSync(summaryPath, `${date}: ${clean}\n`);
  trimSummaryFile(summaryPath);
}

/**
 * Create the record_theme tool registration for cron contexts.
 *
 * This tool is only injected during cron execution — it lets the agent
 * declare what theme/topic it chose so future runs can avoid repeating it.
 */
export function createRecordThemeTool(stateDir: string, jobId: string): ToolRegistration {
  return {
    definition: {
      name: 'record_theme',
      description:
        'Record the theme or topic you chose for this scheduled task run. ' +
        'Call this ONCE per run with a short description (under 10 words) of your ' +
        'main theme — e.g. "baby otter floating in moonlit lake" or ' +
        '"Singapore haze crisis and school closures". Future runs will avoid ' +
        'repeating themes you have already recorded.',
      parameters: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            description: 'Short theme description (under 10 words)',
          },
        },
        required: ['theme'],
      },
    },
    executor: async (args) => {
      const theme = (args.theme as string || '').trim();
      if (!theme) return { error: 'theme is required' };
      recordTheme(stateDir, jobId, theme);
      return { recorded: theme };
    },
    source: 'builtin',
    category: 'write',
  };
}

/**
 * One-time migration: read existing raw .md files and build summary.log
 * using a simple heuristic extraction (since no record_theme calls exist yet).
 */
function migrateFromRawFiles(stateDir: string, jobId: string): void {
  const dir = outputDir(stateDir, jobId);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (files.length === 0) return;

  const summaryLines: string[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
      if (!content) continue;
      const date = file.replace('.md', '').slice(0, 10);
      const summary = extractSummaryFallback(content);
      if (summary) summaryLines.push(`${date}: ${summary}`);
    } catch {
      continue;
    }
  }

  if (summaryLines.length === 0) return;

  const summaryPath = path.join(dir, SUMMARY_FILE);
  try {
    fs.writeFileSync(summaryPath, summaryLines.join('\n') + '\n');
  } catch {
    // non-fatal
  }
}

/**
 * Fallback extraction for migration only — used when no record_theme
 * data exists. Strips emojis and formatting, takes first 80 chars.
 * Not used for ongoing runs (the agent records themes via tool call).
 */
function extractSummaryFallback(text: string): string {
  const cleaned = text
    .replace(/!\[(?:image|[^\]]*)\]\([^)]+\)/g, '')
    .replace(/\[image\]/g, '')
    .replace(/\/api\/v1\/media\/[^\s)]+/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/‍/g, '')
    .replace(/️/g, '')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  return cleaned.length > 80
    ? cleaned.slice(0, 80).replace(/\s\S*$/, '')
    : cleaned;
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
 * Save a cron run's raw output for debugging (7-day retention).
 * Theme tracking is handled separately by the record_theme tool.
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
