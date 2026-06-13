/**
 * Signed media URLs carry a `?expires=&sig=` query (#104). Verify the detector
 * still extracts them from both image and link markdown forms, so channel
 * delivery (which reads the resolved file off disk) keeps working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMedia } from '../detector.js';

let stateDir: string;
let workspace: string;
let imgName: string;
let docName: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-signed-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-ws-'));
  fs.mkdirSync(path.join(stateDir, 'media'), { recursive: true });
  imgName = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png';
  docName = 'ffffffff-1111-2222-3333-444444444444.pdf';
  fs.writeFileSync(path.join(stateDir, 'media', imgName), 'x');
  fs.writeFileSync(path.join(stateDir, 'media', docName), 'y');
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('detector handles signed media URLs (#104)', () => {
  it('extracts an image ref with a signed query', () => {
    const text = `Here: ![chart](/api/v1/media/${imgName}?expires=9999999999999&sig=abc-DEF_123)`;
    const { items, cleanText } = extractMedia(text, stateDir, workspace);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('image');
    expect(items[0].fileName).toBe(imgName);
    expect(cleanText).not.toContain('/api/v1/media/');
  });

  it('extracts a link-form document ref with a signed query', () => {
    const text = `Report: [download](/api/v1/media/${docName}?expires=9999999999999&sig=abc-DEF_123)`;
    const { items } = extractMedia(text, stateDir, workspace);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('document');
    expect(items[0].fileName).toBe('download');
    expect(items[0].filePath).toBe(path.join(stateDir, 'media', docName));
  });

  it('still extracts unsigned link-form refs (no regression)', () => {
    const text = `[doc](/api/v1/media/${docName})`;
    const { items } = extractMedia(text, stateDir, workspace);
    expect(items).toHaveLength(1);
    expect(items[0].fileName).toBe('doc');
  });

  // Adversarial inputs that previously caused exponential (query-group overlap)
  // or quadratic (alt-class re-scan on repeated openers) backtracking. All must
  // stay fast now. ~1MB payloads.
  it.each([
    ['query-group overlap', '[link](' + 'x.png?'.repeat(40000)],
    ['bracket run', '['.repeat(200000)],
    ['link-opener run', '[a]('.repeat(100000)],
    ['image-opener run', '!['.repeat(200000)],
    ['image-link-opener run', '![a]('.repeat(100000)],
  ])('does not catastrophically backtrack: %s (ReDoS guard)', (_name, text) => {
    const start = Date.now();
    extractMedia(text, stateDir, workspace);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
