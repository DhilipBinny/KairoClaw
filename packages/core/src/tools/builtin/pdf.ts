/**
 * PDF extraction tool — `read_pdf`.
 *
 * Tiered extraction pipeline:
 *   1. pdftotext (poppler-utils) — fast, good for text PDFs
 *   2. Tesseract OCR fallback — for scanned/image PDFs
 *   3. Text cleaning — unicode normalization, page numbers, whitespace
 *
 * Adapted from TK03 PdfExtractor (Python) for Node.js/CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRegistration } from '../types.js';
import { safePath } from './files.js';
import { getWorkspace } from './utils.js';
import {
  MAX_TOOL_RESULT_CHARS,
  PDF_MAX_PAGES,
  PDF_OCR_MIN_CHARS_PER_PAGE,
  PDF_TIMEOUT_MS,
} from '../../constants.js';

const execFile = promisify(execFileCb);

// ── Text cleaner (ported from TK03 TextCleaner) ─────────────

const UNICODE_REPLACEMENTS: Record<string, string> = {
  '\u2018': "'", '\u2019': "'",   // smart single quotes
  '\u201c': '"', '\u201d': '"',   // smart double quotes
  '\u2013': '-', '\u2014': '-',   // en/em dash
  '\u2026': '...', '\u00a0': ' ', // ellipsis, nbsp
  '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '', // zero-width
  '\u00ad': '',                   // soft hyphen
  '\u2022': '-', '\u25cf': '-', '\u00b7': '-', // bullets
};

const PAGE_NUM_RE = /^\s*(?:(?:Page\s+)?\d+\s*(?:of\s+\d+)?|-\s*\d+\s*-)\s*$/gim;
const HYPHEN_LINEBREAK_RE = /([a-z])-\s*\n\s*([a-z])/g;
const MULTI_BLANK_RE = /\n{4,}/g;
const MULTI_SPACE_RE = /[ \t]{3,}/g;

function cleanPdfText(text: string): string {
  // Unicode normalization
  for (const [old, repl] of Object.entries(UNICODE_REPLACEMENTS)) {
    text = text.replaceAll(old, repl);
  }
  // Strip page numbers
  text = text.replace(PAGE_NUM_RE, '');
  // Rejoin hyphenated line breaks
  text = text.replace(HYPHEN_LINEBREAK_RE, '$1$2');
  // Collapse whitespace
  text = text.replace(MULTI_BLANK_RE, '\n\n\n');
  text = text.replace(MULTI_SPACE_RE, '  ');
  return text.trim();
}

// ── CLI helpers ──────────────────────────────────────────────

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFile('which', [cmd], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function getPdfPageCount(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFile('pdfinfo', [filePath], { timeout: 10_000 });
    const match = stdout.match(/Pages:\s+(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ── Page range parsing ───────────────────────────────────────

function parsePageRange(pages: string, totalPages: number): { first: number; last: number } {
  const trimmed = pages.trim();

  // Single page: "3"
  if (/^\d+$/.test(trimmed)) {
    const p = Math.min(parseInt(trimmed, 10), totalPages);
    return { first: Math.max(1, p), last: Math.max(1, p) };
  }

  // Range: "1-5"
  const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const first = Math.max(1, parseInt(rangeMatch[1], 10));
    const last = Math.min(totalPages, parseInt(rangeMatch[2], 10));
    return { first, last: Math.max(first, last) };
  }

  // Default: all pages
  return { first: 1, last: Math.min(totalPages, PDF_MAX_PAGES) };
}

// ── Extraction tiers ─────────────────────────────────────────

async function extractWithPdftotext(
  filePath: string,
  first: number,
  last: number,
  layout: boolean,
): Promise<string> {
  const args = [
    ...(layout ? ['-layout'] : []),
    '-f', String(first),
    '-l', String(last),
    filePath,
    '-', // stdout
  ];
  const { stdout } = await execFile('pdftotext', args, {
    timeout: PDF_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function extractWithOcr(
  filePath: string,
  first: number,
  last: number,
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'pdf-ocr-'));
  try {
    // Convert PDF pages to images
    await execFile('pdftoppm', [
      '-f', String(first),
      '-l', String(last),
      '-png',
      '-r', '300',
      filePath,
      path.join(tmpDir, 'page'),
    ], { timeout: PDF_TIMEOUT_MS });

    // OCR each image
    const images = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    const pages: string[] = [];
    for (const img of images) {
      try {
        const { stdout } = await execFile('tesseract', [
          path.join(tmpDir, img),
          'stdout',
        ], { timeout: 30_000 });
        if (stdout.trim()) pages.push(stdout.trim());
      } catch {
        // Skip failed pages
      }
    }
    return pages.join('\n\n');
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

// ── Tool definition ──────────────────────────────────────────

export const pdfTools: ToolRegistration[] = [
  {
    definition: {
      name: 'read_pdf',
      description:
        'Extract text from a PDF file. Supports page ranges and layout preservation. ' +
        'Falls back to OCR for scanned/image PDFs if tesseract is available.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the PDF file (relative to workspace or absolute)',
          },
          pages: {
            type: 'string',
            description: 'Page range to extract: "1-5", "3", or omit for all pages (max 50)',
          },
          layout: {
            type: 'boolean',
            description: 'Preserve layout/columns/tables (default: false)',
          },
        },
        required: ['path'],
      },
    },
    executor: async (args, context) => {
      const ctx = context as Record<string, unknown>;
      const workspace = getWorkspace(ctx);

      // Validate path
      let filePath: string;
      try {
        filePath = safePath(args.path as string, workspace);
      } catch (e) {
        return { error: (e as Error).message };
      }

      if (!fs.existsSync(filePath)) {
        return { error: `File not found: ${args.path}` };
      }

      // Check it's a PDF (extension + magic bytes)
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.pdf') {
        return { error: `Not a PDF file (extension: ${ext})` };
      }
      try {
        const header = new Uint8Array(5);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, header, 0, 5, 0);
        fs.closeSync(fd);
        if (Buffer.from(header).toString('ascii') !== '%PDF-') {
          return { error: 'Not a valid PDF file (invalid header)' };
        }
      } catch {
        return { error: 'Could not read file header' };
      }

      // Check pdftotext is available
      if (!(await commandExists('pdftotext'))) {
        return { error: 'PDF extraction requires poppler-utils. Install with: apt-get install poppler-utils' };
      }

      // Get page count
      const totalPages = await getPdfPageCount(filePath);
      if (totalPages === 0) {
        return { error: 'Could not determine PDF page count — file may be corrupted' };
      }

      // Parse page range
      const pageRange = args.pages
        ? parsePageRange(args.pages as string, totalPages)
        : { first: 1, last: Math.min(totalPages, PDF_MAX_PAGES) };

      const layout = (args.layout as boolean) || false;
      const extractedPages = pageRange.last - pageRange.first + 1;
      const warnings: string[] = [];

      if (totalPages > PDF_MAX_PAGES && !args.pages) {
        warnings.push(`PDF has ${totalPages} pages — extracting first ${PDF_MAX_PAGES} only. Use the pages parameter for specific ranges.`);
      }

      // Tier 1: pdftotext
      let text: string;
      let method = 'pdftotext';
      try {
        text = await extractWithPdftotext(filePath, pageRange.first, pageRange.last, layout);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('Incorrect password')) {
          return { error: 'PDF is password-protected' };
        }
        return { error: `PDF text extraction failed: ${msg}` };
      }

      // Tier 2: OCR fallback if text is sparse
      const charsPerPage = text.trim().length / Math.max(1, extractedPages);
      if (charsPerPage < PDF_OCR_MIN_CHARS_PER_PAGE && text.trim().length < 200) {
        if (await commandExists('tesseract')) {
          try {
            const ocrText = await extractWithOcr(filePath, pageRange.first, pageRange.last);
            if (ocrText.trim().length > text.trim().length) {
              text = ocrText;
              method = 'tesseract_ocr';
              warnings.push('Used OCR — text quality depends on scan quality.');
            }
          } catch {
            warnings.push('OCR fallback failed — returning sparse text extraction.');
          }
        } else {
          warnings.push('Text extraction yielded very little content. This may be a scanned PDF. Install tesseract-ocr for OCR support.');
        }
      }

      // Clean text
      text = cleanPdfText(text);

      if (!text) {
        return {
          text: '',
          pageCount: totalPages,
          pagesExtracted: `${pageRange.first}-${pageRange.last}`,
          method,
          charCount: 0,
          warning: 'No text extracted — this may be a scanned or image-only PDF.',
        };
      }

      // Truncate if too large
      if (text.length > MAX_TOOL_RESULT_CHARS) {
        warnings.push(`Text truncated from ${text.length} to ${MAX_TOOL_RESULT_CHARS} chars. Use the pages parameter to extract specific sections.`);
        text = text.slice(0, MAX_TOOL_RESULT_CHARS);
      }

      return {
        text,
        pageCount: totalPages,
        pagesExtracted: `${pageRange.first}-${pageRange.last}`,
        method,
        charCount: text.length,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  },
];
