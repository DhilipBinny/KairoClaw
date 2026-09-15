/**
 * Document content extraction — DOCX, XLSX, PPTX.
 *
 * Extracts readable text from Office 2007+ (OOXML) documents so the agent
 * can reason about their contents. Follows the same pattern as pdf.ts:
 *   - Pure extraction functions (no tool registration here)
 *   - Wired into read_file via extension routing (files.ts)
 *   - Wired into file-preview.ts for upload previews
 *
 * Dependencies: mammoth (DOCX), exceljs (XLSX), jszip (PPTX — transitive via mammoth).
 */

import fs from 'node:fs';
import {
  DOC_MAX_EXTRACT_CHARS,
  DOC_MAX_FILE_SIZE,
  XLSX_MAX_ROWS_PER_SHEET,
  PPTX_MAX_SLIDES,
} from './constants.js';

// ── Result types ───────────────────────────────────────────

export interface DocxResult {
  text: string;
  paragraphs: number;
  method: 'mammoth';
}

export interface XlsxResult {
  text: string;
  sheets: number;
  totalRows: number;
  method: 'exceljs';
}

export interface PptxResult {
  text: string;
  slides: number;
  method: 'zip-xml';
}

export type DocumentResult = DocxResult | XlsxResult | PptxResult;

// ── DOCX extraction ────────────────────────────────────────

export async function extractDocxText(filePath: string): Promise<DocxResult | { error: string }> {
  const sizeError = checkFileSize(filePath);
  if (sizeError) return sizeError;

  try {
    const mammoth = await import('mammoth');
    const buffer = await fs.promises.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();

    if (!text) {
      return { error: 'DOCX file contains no extractable text' };
    }

    const paragraphs = text.split(/\n\n+/).length;
    const capped = text.length > DOC_MAX_EXTRACT_CHARS
      ? text.slice(0, DOC_MAX_EXTRACT_CHARS) + '\n\n[... truncated — use read_file with offset/limit for more]'
      : text;

    return { text: capped, paragraphs, method: 'mammoth' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isEncryptedError(msg)) return { error: 'Document is password-protected' };
    return { error: `DOCX extraction failed: ${msg}` };
  }
}

// ── XLSX extraction ────────────────────────────────────────

export async function extractXlsxText(
  filePath: string,
  opts?: { sheet?: string | number },
): Promise<XlsxResult | { error: string }> {
  const sizeError = checkFileSize(filePath);
  if (sizeError) return sizeError;

  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();
    await workbook.xlsx.readFile(filePath);

    const parts: string[] = [];
    let totalRows = 0;
    let sheetsWithData = 0;
    let sheetIndex = 0;

    for (const worksheet of workbook.worksheets) {
      const currentIndex = sheetIndex;
      sheetIndex++;

      if (opts?.sheet !== undefined) {
        const match = typeof opts.sheet === 'number'
          ? currentIndex === opts.sheet
          : worksheet.name.toLowerCase() === opts.sheet.toLowerCase();
        if (!match) continue;
      }

      const sheetRows: string[] = [];
      let rowCount = 0;

      worksheet.eachRow((row) => {
        if (rowCount >= XLSX_MAX_ROWS_PER_SHEET) return;
        const values = (row.values as unknown[])
          .slice(1)
          .map(v => cellToString(v));
        sheetRows.push(values.join('\t'));
        rowCount++;
      });

      if (sheetRows.length > 0) {
        sheetsWithData++;
        totalRows += rowCount;
        const header = workbook.worksheets.length > 1
          ? `\n### Sheet: ${worksheet.name}\n`
          : '';
        parts.push(`${header}${sheetRows.join('\n')}`);
      }
    }

    if (parts.length === 0) {
      return { error: 'XLSX file contains no readable data' };
    }

    let text = parts.join('\n\n');
    if (text.length > DOC_MAX_EXTRACT_CHARS) {
      text = text.slice(0, DOC_MAX_EXTRACT_CHARS) + '\n\n[... truncated — use read_file with offset/limit for more]';
    }

    return { text, sheets: sheetsWithData, totalRows, method: 'exceljs' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isEncryptedError(msg)) return { error: 'Document is password-protected' };
    return { error: `XLSX extraction failed: ${msg}` };
  }
}

// ── PPTX extraction ────────────────────────────────────────

export async function extractPptxText(filePath: string): Promise<PptxResult | { error: string }> {
  const sizeError = checkFileSize(filePath);
  if (sizeError) return sizeError;

  try {
    const JSZip = (await import('jszip')).default;
    const buffer = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    const slideFiles = Object.keys(zip.files)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
        const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
        return numA - numB;
      });

    if (slideFiles.length === 0) {
      return { error: 'PPTX file contains no slides' };
    }

    const parts: string[] = [];
    const slideCount = Math.min(slideFiles.length, PPTX_MAX_SLIDES);

    for (let i = 0; i < slideCount; i++) {
      const xml = await zip.files[slideFiles[i]].async('text');
      const texts = extractTextFromXml(xml);
      if (texts.length > 0) {
        parts.push(`--- Slide ${i + 1} ---\n${texts.join('\n')}`);
      }
    }

    if (parts.length === 0) {
      return { error: 'PPTX slides contain no extractable text' };
    }

    let text = parts.join('\n\n');
    if (text.length > DOC_MAX_EXTRACT_CHARS) {
      text = text.slice(0, DOC_MAX_EXTRACT_CHARS) + '\n\n[... truncated]';
    }

    if (slideFiles.length > PPTX_MAX_SLIDES) {
      text += `\n\n[Showing ${PPTX_MAX_SLIDES} of ${slideFiles.length} slides]`;
    }

    return { text, slides: slideFiles.length, method: 'zip-xml' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isEncryptedError(msg)) return { error: 'Document is password-protected' };
    return { error: `PPTX extraction failed: ${msg}` };
  }
}

// ── XML text extraction (exported for testing) ─────────────

export function extractTextFromXml(xml: string): string[] {
  const paragraphs: string[] = [];
  const pRegex = /<a:p\b[^>]*>(.*?)<\/a:p>/gs;
  let pMatch;

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1];
    const texts: string[] = [];
    const tRegex = /<a:t\b[^>]*>(.*?)<\/a:t>/gs;
    let tMatch;

    while ((tMatch = tRegex.exec(pContent)) !== null) {
      const decoded = decodeXmlEntities(tMatch[1]);
      if (decoded.trim()) texts.push(decoded);
    }

    if (texts.length > 0) {
      paragraphs.push(texts.join(''));
    }
  }

  return paragraphs;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function safeFromCodePoint(cp: number): string {
  try { return String.fromCodePoint(cp); }
  catch { return ''; }
}

// ── Cell value coercion ────────────────────────────────────

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  const obj = v as Record<string, unknown>;
  if ('richText' in obj && Array.isArray(obj.richText)) {
    return (obj.richText as { text?: string }[]).map(run => run.text ?? '').join('');
  }
  if ('text' in obj) return String(obj.text);
  if ('result' in obj) return String(obj.result);
  if ('error' in obj) return String(obj.error);
  return String(v);
}

// ── Shared helpers ─────────────────────────────────────────

function checkFileSize(filePath: string): { error: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > DOC_MAX_FILE_SIZE) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = DOC_MAX_FILE_SIZE / (1024 * 1024);
      return { error: `File too large (${sizeMB}MB) — maximum supported size is ${limitMB}MB` };
    }
    return null;
  } catch {
    return { error: `Cannot access file: ${filePath}` };
  }
}

function isEncryptedError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return ['encrypted', 'password', 'not a valid zip', 'end of data reached', 'corrupted zip']
    .some(p => lower.includes(p));
}

export function formatDocumentMeta(result: DocumentResult): string {
  if ('paragraphs' in result) return `${result.paragraphs} paragraphs`;
  if ('sheets' in result) return `${result.sheets} sheets, ${result.totalRows} rows`;
  return `${result.slides} slides`;
}

// ── Extension routing ──────────────────────────────────────

const DOCUMENT_EXTENSIONS: Record<string, 'docx' | 'xlsx' | 'pptx'> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
};

export function getDocumentType(ext: string): 'docx' | 'xlsx' | 'pptx' | null {
  return DOCUMENT_EXTENSIONS[ext] ?? null;
}
