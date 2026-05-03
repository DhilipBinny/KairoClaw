import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { generateFilePreview } from '../file-preview.js';

const TMP_DIR = `/tmp/kairo-test-file-preview-${Date.now()}`;

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// Ensure temp directory exists
fs.mkdirSync(TMP_DIR, { recursive: true });

describe('generateFilePreview', () => {
  it('tiny text file (<10KB): contains content in a code block', async () => {
    const filePath = path.join(TMP_DIR, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world');

    const preview = await generateFilePreview(filePath, 'hello.txt');
    expect(preview).toContain('hello world');
    expect(preview).toContain('```');
  });

  it('binary file: says "File saved to disk"', async () => {
    const filePath = path.join(TMP_DIR, 'data.bin');
    fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

    const preview = await generateFilePreview(filePath, 'data.bin');
    expect(preview).toContain('File saved to disk');
  });

  it('unknown extension: shows metadata only', async () => {
    const filePath = path.join(TMP_DIR, 'unknown.xyz');
    fs.writeFileSync(filePath, 'some data here');

    const preview = await generateFilePreview(filePath, 'unknown.xyz');
    // .xyz is not in TEXT_EXTENSIONS so it's treated as binary/unknown
    expect(preview).toContain('File saved to disk');
    expect(preview).toContain('.xyz');
  });

  it('empty text file: shows code block', async () => {
    const filePath = path.join(TMP_DIR, 'empty.txt');
    fs.writeFileSync(filePath, '');

    const preview = await generateFilePreview(filePath, 'empty.txt');
    expect(preview).toContain('```');
    expect(preview).toContain('empty.txt');
  });
});
