import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  extractTextFromXml,
  getDocumentType,
  formatDocumentMeta,
} from '../document.js';
import type { DocxResult, XlsxResult, PptxResult } from '../document.js';
import { DOC_MAX_FILE_SIZE } from '../constants.js';

// ── extractTextFromXml ─────────────────────────────────────

describe('extractTextFromXml', () => {
  it('extracts text from simple paragraphs', () => {
    const xml = '<a:p><a:r><a:t>Hello</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['Hello']);
  });

  it('concatenates text runs within a paragraph', () => {
    const xml = '<a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>World</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['Hello World']);
  });

  it('handles multiple paragraphs', () => {
    const xml = '<a:p><a:r><a:t>First</a:t></a:r></a:p><a:p><a:r><a:t>Second</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['First', 'Second']);
  });

  it('handles <a:t> with attributes (xml:space="preserve")', () => {
    const xml = '<a:p><a:r><a:t xml:space="preserve"> spaced </a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual([' spaced ']);
  });

  it('handles <a:p> with attributes', () => {
    const xml = '<a:p algn="ctr"><a:r><a:t>Centered</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['Centered']);
  });

  it('decodes named XML entities', () => {
    const xml = '<a:p><a:r><a:t>A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['A & B < C > D "E" \'F\'']);
  });

  it('decodes decimal numeric entities', () => {
    const xml = '<a:p><a:r><a:t>A&#8212;B</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['A—B']);
  });

  it('decodes hex numeric entities', () => {
    const xml = '<a:p><a:r><a:t>A&#x2014;B</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['A—B']);
  });

  it('skips empty paragraphs', () => {
    const xml = '<a:p></a:p><a:p><a:r><a:t>Text</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['Text']);
  });

  it('skips paragraphs with only whitespace text', () => {
    const xml = '<a:p><a:r><a:t>   </a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual([]);
  });

  it('returns empty array for XML with no a:p elements', () => {
    const xml = '<p:sp><p:txBody></p:txBody></p:sp>';
    expect(extractTextFromXml(xml)).toEqual([]);
  });
});

// ── getDocumentType ────────────────────────────────────────

describe('getDocumentType', () => {
  it('returns docx for .docx', () => {
    expect(getDocumentType('.docx')).toBe('docx');
  });

  it('returns xlsx for .xlsx', () => {
    expect(getDocumentType('.xlsx')).toBe('xlsx');
  });

  it('returns pptx for .pptx', () => {
    expect(getDocumentType('.pptx')).toBe('pptx');
  });

  it('returns null for .xls (legacy format not supported)', () => {
    expect(getDocumentType('.xls')).toBeNull();
  });

  it('returns null for .doc (legacy format not supported)', () => {
    expect(getDocumentType('.doc')).toBeNull();
  });

  it('returns null for .pdf', () => {
    expect(getDocumentType('.pdf')).toBeNull();
  });

  it('returns null for .txt', () => {
    expect(getDocumentType('.txt')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getDocumentType('')).toBeNull();
  });
});

// ── formatDocumentMeta ─────────────────────────────────────

describe('formatDocumentMeta', () => {
  it('formats DOCX result', () => {
    const result: DocxResult = { text: 'hello', paragraphs: 5, method: 'mammoth' };
    expect(formatDocumentMeta(result)).toBe('5 paragraphs');
  });

  it('formats XLSX result', () => {
    const result: XlsxResult = { text: 'data', sheets: 3, totalRows: 150, method: 'exceljs' };
    expect(formatDocumentMeta(result)).toBe('3 sheets, 150 rows');
  });

  it('formats PPTX result', () => {
    const result: PptxResult = { text: 'slides', slides: 12, method: 'zip-xml' };
    expect(formatDocumentMeta(result)).toBe('12 slides');
  });
});

// ── XML entity edge cases ──────────────────────────────────

describe('extractTextFromXml entity edge cases', () => {
  it('handles invalid numeric code points gracefully', () => {
    const xml = '<a:p><a:r><a:t>A&#x999999;B</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['AB']);
  });

  it('preserves &amp;#x in literal text (double-encoded)', () => {
    const xml = '<a:p><a:r><a:t>&amp;#x2014;</a:t></a:r></a:p>';
    expect(extractTextFromXml(xml)).toEqual(['&#x2014;']);
  });
});

// ── File size guard ────────────────────────────────────────

describe('file size guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects files exceeding DOC_MAX_FILE_SIZE for DOCX', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: DOC_MAX_FILE_SIZE + 1 } as fs.Stats);
    const { extractDocxText } = await import('../document.js');
    const result = await extractDocxText('/fake/large.docx');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('File too large');
    }
  });

  it('rejects files exceeding DOC_MAX_FILE_SIZE for XLSX', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: DOC_MAX_FILE_SIZE + 1 } as fs.Stats);
    const { extractXlsxText } = await import('../document.js');
    const result = await extractXlsxText('/fake/large.xlsx');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('File too large');
    }
  });

  it('rejects files exceeding DOC_MAX_FILE_SIZE for PPTX', async () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: DOC_MAX_FILE_SIZE + 1 } as fs.Stats);
    const { extractPptxText } = await import('../document.js');
    const result = await extractPptxText('/fake/large.pptx');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('File too large');
    }
  });

  it('returns error for inaccessible files', async () => {
    vi.spyOn(fs, 'statSync').mockImplementation(() => { throw new Error('ENOENT'); });
    const { extractDocxText } = await import('../document.js');
    const result = await extractDocxText('/nonexistent/file.docx');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Cannot access file');
    }
  });
});
