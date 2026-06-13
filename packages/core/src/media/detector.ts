/**
 * Media Detector — extracts media references from LLM response text
 * and resolves them to files on disk.
 *
 * Shared by all channels (Web, Telegram, WhatsApp) so media detection
 * is consistent. Each channel uses the result to send files via its
 * native API (sendPhoto, sendDocument, etc.).
 *
 * Detects:
 *   - Markdown images: ![alt](url)
 *   - Markdown links to media files: [name.pdf](url)
 *   - Bare file paths: /path/to/file.png
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────

export type MediaType = 'image' | 'document' | 'audio' | 'video' | 'voice';

export interface MediaItem {
  /** Detected media type. */
  type: MediaType;
  /** Resolved absolute path to the file on disk. */
  filePath: string;
  /** Display filename (e.g. "report.pdf", "photo.png"). */
  fileName: string;
  /** MIME type for the file. */
  mimeType: string;
  /** Alt text or caption from the markdown. */
  caption?: string;
  /** The original matched string in the text (for removal). */
  match: string;
}

export interface MediaExtractionResult {
  /** Detected media items. */
  items: MediaItem[];
  /** Text with media references removed (for caption/text message). */
  cleanText: string;
}

// ── MIME / Type mapping ──────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  // Documents
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yml: 'application/x-yaml',
  yaml: 'application/x-yaml',
  xml: 'application/xml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/x-rar-compressed',
  // Audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'flac']);
const VOICE_EXTS = new Set(['ogg']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi']);

function classifyExt(ext: string): MediaType {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VOICE_EXTS.has(ext)) return 'voice';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'document';
}

// ── Path resolution ──────────────────────────────

/**
 * Resolve a media reference to a file path on disk.
 * Handles:
 *   - /api/v1/media/uuid.ext  → stateDir/media/uuid.ext
 *   - absolute paths          → as-is (if within workspace)
 *   - relative paths          → relative to workspace
 */
function resolveMediaPath(
  ref: string,
  stateDir: string,
  workspace: string,
): string | null {
  // Media store URL
  const mediaMatch = ref.match(/\/api\/v1\/media\/([a-f0-9-]+\.[a-z0-9]+)/i);
  if (mediaMatch) {
    const mediaPath = path.join(stateDir, 'media', mediaMatch[1]);
    if (fs.existsSync(mediaPath)) return mediaPath;
    return null;
  }

  // Absolute path — must be within workspace
  if (path.isAbsolute(ref)) {
    const resolved = path.resolve(ref);
    const wsResolved = path.resolve(workspace);
    if (resolved.startsWith(wsResolved + path.sep) || resolved === wsResolved) {
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  }

  // Relative path — resolve against workspace
  const resolved = path.resolve(path.join(workspace, ref));
  const wsResolved = path.resolve(workspace);
  if (resolved.startsWith(wsResolved + path.sep) || resolved === wsResolved) {
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
}

// ── Extraction ───────────────────────────────────

// ReDoS hardening: both the alt/display-text classes AND the URL-body classes
// below exclude the bracket/paren delimiters `[ ] ( )`. With the looser classes
// a long run of `[`/`![`/`[a](` openers would let a greedy class scan across
// many openers and fail at the end, restarting from every position — O(n²)
// backtracking on attacker-influenceable LLM output. Excluding the delimiters
// makes a failed match fail fast (linear). extractMedia() also length-caps its
// input as a backstop. Real media URLs/paths never contain these delimiters.

// Matches: ![alt text](url) or ![](url)
const MARKDOWN_IMAGE_RE = /!\[([^\][]*)\]\(([^)(\][]+)\)/g;

// Matches: [display name](url) where url points to a known file extension,
// allowing an optional trailing query string (signed media URLs carry one, e.g.
// /api/v1/media/x.pdf?expires=..&sig=..). resolveMediaPath ignores the query.
// `?` is also excluded from the URL body so only the query group consumes it.
const ALL_KNOWN_EXTS = Object.keys(EXT_TO_MIME).join('|');
const MARKDOWN_LINK_RE = new RegExp(
  `\\[([^\\][]+)\\]\\(([^)(\\][\\s?]+\\.(?:${ALL_KNOWN_EXTS})(?:\\?[^)(\\][\\s]*)?)\\)`,
  'gi',
);

/**
 * Upper bound on how much response text we scan for media refs. Legitimate
 * references appear early and downstream channels slice captions anyway; the
 * cap is a hard ceiling on regex work for pathological/adversarial input.
 */
const MAX_DETECT_LEN = 256 * 1024;

/**
 * Extract media references from LLM response text.
 *
 * Returns detected media items and cleaned text (media refs removed).
 * Items are deduplicated by file path.
 */
export function extractMedia(
  text: string,
  stateDir: string,
  workspace: string,
): MediaExtractionResult {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const matches: Array<{ match: string; index: number }> = [];

  // Bound regex work; media refs live at the front. cleanText still uses the
  // full text so nothing past the cap is silently dropped from the message.
  const scan = text.length > MAX_DETECT_LEN ? text.slice(0, MAX_DETECT_LEN) : text;

  // 1. Markdown images: ![alt](url)
  for (const m of scan.matchAll(MARKDOWN_IMAGE_RE)) {
    const alt = m[1] || '';
    const ref = m[2];
    const filePath = resolveMediaPath(ref, stateDir, workspace);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    const ext = path.extname(filePath).slice(1).toLowerCase();
    items.push({
      type: classifyExt(ext),
      filePath,
      fileName: path.basename(filePath),
      mimeType: EXT_TO_MIME[ext] || 'application/octet-stream',
      caption: alt || undefined,
      match: m[0],
    });
    matches.push({ match: m[0], index: m.index! });
  }

  // 2. Markdown links to known file types: [name](url.ext)
  for (const m of scan.matchAll(MARKDOWN_LINK_RE)) {
    const display = m[1] || '';
    const ref = m[2];
    // Skip if already captured as an image
    if (matches.some(prev => prev.match.includes(ref))) continue;

    const filePath = resolveMediaPath(ref, stateDir, workspace);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    const ext = path.extname(filePath).slice(1).toLowerCase();
    items.push({
      type: classifyExt(ext),
      filePath,
      fileName: display || path.basename(filePath),
      mimeType: EXT_TO_MIME[ext] || 'application/octet-stream',
      caption: undefined,
      match: m[0],
    });
    matches.push({ match: m[0], index: m.index! });
  }

  // Build clean text by removing all matched media references
  let cleanText = text;
  for (const item of items) {
    cleanText = cleanText.replace(item.match, '');
  }
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { items, cleanText };
}
