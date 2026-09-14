/**
 * Document content extraction — DOCX, XLSX, PPTX.
 *
 * Extracts readable text from Office documents so the agent can reason
 * about their contents. Follows the same pattern as pdf.ts:
 *   - Pure extraction functions (no tool registration here)
 *   - Wired into read_file via extension routing (files.ts)
 *   - Wired into file-preview.ts for upload previews
 *
 * Dependencies: mammoth (DOCX), exceljs (XLSX), jszip (PPTX — transitive via mammoth).
 */

import fs from 'node:fs';

const MAX_EXTRACT_CHARS = 50_000;
const XLSX_MAX_ROWS_PER_SHEET = 500;
const PPTX_MAX_SLIDES = 50;

// ── DOCX extraction ────────────────────────────────────────

export interface DocxResult {
  text: string;
  paragraphs: number;
  method: 'mammoth';
}

export async function extractDocxText(filePath: string): Promise<DocxResult | { error: string }> {
  try {
    const mammoth = await import('mammoth');
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();

    if (!text) {
      return { error: 'DOCX file contains no extractable text' };
    }

    const paragraphs = text.split(/\n\n+/).length;
    const capped = text.length > MAX_EXTRACT_CHARS
      ? text.slice(0, MAX_EXTRACT_CHARS) + '\n\n[... truncated — use read_file with offset/limit for more]'
      : text;

    return { text: capped, paragraphs, method: 'mammoth' };
  } catch (e) {
    return { error: `DOCX extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── XLSX extraction ────────────────────────────────────────

export interface XlsxResult {
  text: string;
  sheets: number;
  totalRows: number;
  method: 'exceljs';
}

export async function extractXlsxText(
  filePath: string,
  opts?: { sheet?: string | number },
): Promise<XlsxResult | { error: string }> {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.default.Workbook();
    await workbook.xlsx.readFile(filePath);

    const parts: string[] = [];
    let totalRows = 0;
    let sheetsProcessed = 0;

    for (const worksheet of workbook.worksheets) {
      if (opts?.sheet !== undefined) {
        const match = typeof opts.sheet === 'number'
          ? sheetsProcessed === opts.sheet
          : worksheet.name.toLowerCase() === opts.sheet.toLowerCase();
        if (!match) continue;
      }

      sheetsProcessed++;
      const sheetRows: string[] = [];
      let rowCount = 0;

      worksheet.eachRow((row, rowNumber) => {
        if (rowCount >= XLSX_MAX_ROWS_PER_SHEET) return;
        const values = (row.values as (string | number | boolean | null | undefined)[])
          .slice(1) // exceljs row.values is 1-indexed (index 0 is empty)
          .map(v => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).text);
            if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) return String((v as Record<string, unknown>).result);
            return String(v);
          });
        sheetRows.push(values.join('\t'));
        rowCount++;
        if (rowNumber > totalRows) totalRows = rowNumber;
      });

      if (sheetRows.length > 0) {
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
    if (text.length > MAX_EXTRACT_CHARS) {
      text = text.slice(0, MAX_EXTRACT_CHARS) + '\n\n[... truncated — use read_file with offset/limit for more]';
    }

    return { text, sheets: sheetsProcessed, totalRows, method: 'exceljs' };
  } catch (e) {
    return { error: `XLSX extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── PPTX extraction ────────────────────────────────────────

export interface PptxResult {
  text: string;
  slides: number;
  method: 'zip-xml';
}

export async function extractPptxText(filePath: string): Promise<PptxResult | { error: string }> {
  try {
    const JSZip = (await import('jszip')).default;
    const buffer = fs.readFileSync(filePath);
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
    if (text.length > MAX_EXTRACT_CHARS) {
      text = text.slice(0, MAX_EXTRACT_CHARS) + '\n\n[... truncated]';
    }

    if (slideFiles.length > PPTX_MAX_SLIDES) {
      text += `\n\n[Showing ${PPTX_MAX_SLIDES} of ${slideFiles.length} slides]`;
    }

    return { text, slides: slideFiles.length, method: 'zip-xml' };
  } catch (e) {
    return { error: `PPTX extraction failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Extract text content from OOXML slide XML.
 * Text lives in <a:t> tags within <a:p> (paragraph) elements.
 */
function extractTextFromXml(xml: string): string[] {
  const paragraphs: string[] = [];
  const pRegex = /<a:p\b[^>]*>(.*?)<\/a:p>/gs;
  let pMatch;

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1];
    const texts: string[] = [];
    const tRegex = /<a:t>(.*?)<\/a:t>/gs;
    let tMatch;

    while ((tMatch = tRegex.exec(pContent)) !== null) {
      const decoded = tMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
      if (decoded.trim()) texts.push(decoded);
    }

    if (texts.length > 0) {
      paragraphs.push(texts.join(''));
    }
  }

  return paragraphs;
}

// ── Extension routing ──────────────────────────────────────

const DOCX_EXTENSIONS = new Set(['.docx']);
const XLSX_EXTENSIONS = new Set(['.xlsx', '.xls']);
const PPTX_EXTENSIONS = new Set(['.pptx']);

export function isDocumentExtension(ext: string): boolean {
  return DOCX_EXTENSIONS.has(ext) || XLSX_EXTENSIONS.has(ext) || PPTX_EXTENSIONS.has(ext);
}

export function getDocumentType(ext: string): 'docx' | 'xlsx' | 'pptx' | null {
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  return null;
}
