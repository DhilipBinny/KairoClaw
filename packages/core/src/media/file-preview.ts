/**
 * File Preview Generator — creates smart summaries of uploaded files
 * for the agent context, without dumping entire file contents.
 *
 * Strategy:
 *   - Tiny (<10KB): full content inline — fast, cheap, complete
 *   - Small (10KB-100KB): full content with size note
 *   - Medium text (100KB-1MB): structured preview (headers, sample rows, line count)
 *   - Large (>1MB): metadata only — agent uses read_file for sections
 *   - Binary: metadata only (always)
 *
 * Never loads >1MB into memory at once. Uses streaming for line counting.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Size thresholds in bytes. */
const TINY_LIMIT = 10 * 1024;        // 10KB — read fully
const SMALL_LIMIT = 100 * 1024;      // 100KB — read fully with note
const MEDIUM_LIMIT = 1024 * 1024;    // 1MB — preview only

/** Text-based extensions that we can read and preview. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.csv', '.json', '.log', '.yml', '.yaml', '.xml',
  '.html', '.htm', '.ts', '.js', '.py', '.sh', '.env', '.toml',
  '.ini', '.cfg', '.conf', '.sql', '.r', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.css', '.scss', '.svelte', '.vue',
]);

/**
 * Generate a preview string for an uploaded file.
 * The result is passed directly to the agent as the message text.
 */
export async function generateFilePreview(
  filePath: string,
  fileName: string,
): Promise<string> {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const ext = path.extname(fileName).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext);
  const sizeStr = formatSize(size);

  // Binary files — always metadata only
  if (!isText) {
    return `[File received: ${fileName}]\nType: ${ext || 'unknown'} | Size: ${sizeStr}\nFile saved to disk. Use \`read_file\` to examine contents if it's a readable format.`;
  }

  // Tiny text files (<10KB) — read fully inline
  if (size <= TINY_LIMIT) {
    const content = fs.readFileSync(filePath, 'utf8');
    return `[File: ${fileName}]\n\`\`\`\n${content}\n\`\`\``;
  }

  // Small text files (10KB-100KB) — read fully with size note
  if (size <= SMALL_LIMIT) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;
    return `[File: ${fileName} — ${sizeStr}, ${lines} lines]\n\`\`\`\n${content}\n\`\`\``;
  }

  // Medium and large text files — generate structured preview
  if (ext === '.csv') {
    return await previewCSV(filePath, fileName, size);
  }
  if (ext === '.json') {
    return await previewJSON(filePath, fileName, size);
  }
  return await previewTextFile(filePath, fileName, size, ext);
}

/**
 * Preview a CSV file: headers + row count + sample rows.
 */
async function previewCSV(
  filePath: string,
  fileName: string,
  size: number,
): Promise<string> {
  const { lineCount, firstLines, lastLines } = await readFileEdges(filePath, 6, 3);
  const sizeStr = formatSize(size);
  const rowCount = lineCount - 1; // subtract header

  const header = firstLines[0] || '';
  const columns = header.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
  const sampleRows = firstLines.slice(0, 6).join('\n');

  let preview = `[File received: ${fileName}]\n`;
  preview += `Type: CSV | Size: ${sizeStr} | Rows: ~${rowCount.toLocaleString()} | Columns: ${columns.length}\n`;
  preview += `Column names: ${columns.join(', ')}\n\n`;
  preview += `Preview (first rows):\n\`\`\`csv\n${sampleRows}\n\`\`\`\n`;

  if (lastLines.length > 0) {
    preview += `\nLast rows:\n\`\`\`csv\n${header}\n${lastLines.join('\n')}\n\`\`\`\n`;
  }

  preview += `\nUse \`read_file\` with offset and limit to examine specific sections.`;
  return preview;
}

/**
 * Preview a JSON file: top-level structure + size.
 */
async function previewJSON(
  filePath: string,
  fileName: string,
  size: number,
): Promise<string> {
  const sizeStr = formatSize(size);

  // For medium files, try to read and parse for structure
  if (size <= MEDIUM_LIMIT) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);

      let structure = '';
      if (Array.isArray(parsed)) {
        structure = `Array with ${parsed.length} items`;
        if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
          structure += `\nItem keys: ${Object.keys(parsed[0]).join(', ')}`;
        }
        // Show first 2 items as sample
        const sample = JSON.stringify(parsed.slice(0, 2), null, 2);
        const truncSample = sample.length > 2000 ? sample.slice(0, 2000) + '\n...' : sample;
        return `[File received: ${fileName}]\nType: JSON | Size: ${sizeStr} | ${structure}\n\nSample:\n\`\`\`json\n${truncSample}\n\`\`\`\n\nUse \`read_file\` to examine the full content.`;
      } else if (typeof parsed === 'object' && parsed !== null) {
        const keys = Object.keys(parsed);
        structure = `Object with ${keys.length} keys: ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? '...' : ''}`;
        const sample = JSON.stringify(parsed, null, 2).slice(0, 2000);
        return `[File received: ${fileName}]\nType: JSON | Size: ${sizeStr} | ${structure}\n\nPreview:\n\`\`\`json\n${sample}\n...\n\`\`\`\n\nUse \`read_file\` to examine the full content.`;
      }
    } catch { /* invalid JSON or too large — fall through */ }
  }

  // Large JSON — just show first lines
  const { firstLines } = await readFileEdges(filePath, 20, 0);
  return `[File received: ${fileName}]\nType: JSON | Size: ${sizeStr}\n\nPreview (first 20 lines):\n\`\`\`json\n${firstLines.join('\n')}\n\`\`\`\n\nUse \`read_file\` with offset and limit to examine sections.`;
}

/**
 * Preview a generic text file: first N lines + last N lines + line count.
 */
async function previewTextFile(
  filePath: string,
  fileName: string,
  size: number,
  ext: string,
): Promise<string> {
  const sizeStr = formatSize(size);
  const lang = ext.slice(1); // strip dot for code block language hint
  const { lineCount, firstLines, lastLines } = await readFileEdges(filePath, 30, 10);

  let preview = `[File received: ${fileName}]\n`;
  preview += `Type: ${ext} | Size: ${sizeStr} | Lines: ${lineCount.toLocaleString()}\n\n`;
  preview += `First ${firstLines.length} lines:\n\`\`\`${lang}\n${firstLines.join('\n')}\n\`\`\`\n`;

  if (lastLines.length > 0 && lineCount > firstLines.length + lastLines.length) {
    preview += `\n... (${(lineCount - firstLines.length - lastLines.length).toLocaleString()} lines omitted)\n\n`;
    preview += `Last ${lastLines.length} lines:\n\`\`\`${lang}\n${lastLines.join('\n')}\n\`\`\`\n`;
  }

  preview += `\nUse \`read_file\` with offset and limit to examine specific sections.`;
  return preview;
}

/**
 * Stream-read a file to get first N lines, last M lines, and total line count.
 * Never loads the entire file into memory.
 */
async function readFileEdges(
  filePath: string,
  firstN: number,
  lastN: number,
): Promise<{ lineCount: number; firstLines: string[]; lastLines: string[] }> {
  const firstLines: string[] = [];
  const lastLines: string[] = []; // circular buffer
  let lineCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineCount++;
    const safeLine = (line as string).length > 1000 ? (line as string).slice(0, 1000) + '...' : (line as string);
    if (firstLines.length < firstN) {
      firstLines.push(safeLine);
    }
    if (lastN > 0) {
      lastLines.push(safeLine);
      if (lastLines.length > lastN) {
        lastLines.shift();
      }
    }
  }

  const effectiveLastLines = lineCount > firstN + lastN ? lastLines : [];
  return { lineCount, firstLines, lastLines: effectiveLastLines };
}

/**
 * Format byte size to human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
