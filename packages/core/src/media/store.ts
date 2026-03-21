/**
 * Media Store — save, serve, and clean up generated media files.
 *
 * Files are stored in ~/.agw/media/ with UUID filenames.
 * Auto-cleanup deletes files older than the configured retention period.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MEDIA_RETENTION_DAYS, MEDIA_CLEANUP_INTERVAL_MS } from '../constants.js';

export class MediaStore {
  private mediaDir: string;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(stateDir: string) {
    this.mediaDir = path.join(stateDir, 'media');
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  /** Get the media directory path. */
  get dir(): string {
    return this.mediaDir;
  }

  /**
   * Save binary data to the media store.
   * Returns the filename (uuid.ext).
   */
  save(data: Buffer, ext: string): string {
    const sanitizedExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'bin';
    const filename = `${crypto.randomUUID()}.${sanitizedExt}`;
    const filePath = path.join(this.mediaDir, filename);
    fs.writeFileSync(filePath, new Uint8Array(data));
    return filename;
  }

  /**
   * Save base64-encoded data to the media store.
   * Returns the filename (uuid.ext).
   */
  saveBase64(base64Data: string, ext: string): string {
    const buffer = Buffer.from(base64Data, 'base64');
    return this.save(buffer, ext);
  }

  /** Get the full filesystem path for a media file. */
  getPath(filename: string): string | null {
    // Prevent path traversal
    const safe = path.basename(filename);
    const filePath = path.join(this.mediaDir, safe);
    if (fs.existsSync(filePath)) return filePath;
    return null;
  }

  /**
   * Build a URL for a media file.
   * Uses the gateway's host:port from config.
   */
  getUrl(filename: string, baseUrl?: string): string {
    const base = baseUrl || '';
    return `${base}/api/v1/media/${encodeURIComponent(filename)}`;
  }

  /**
   * Delete files older than maxAgeDays.
   * Returns the number of files deleted.
   */
  cleanup(maxAgeDays?: number): { deleted: number; freedBytes: number } {
    const maxAge = (maxAgeDays ?? MEDIA_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAge;
    let deleted = 0;
    let freedBytes = 0;

    try {
      const files = fs.readdirSync(this.mediaDir);
      for (const file of files) {
        const filePath = path.join(this.mediaDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            freedBytes += stat.size;
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* skip files we can't stat/delete */ }
      }
    } catch { /* directory may not exist yet */ }

    return { deleted, freedBytes };
  }

  /** Get storage stats. */
  stats(): { count: number; totalBytes: number } {
    let count = 0;
    let totalBytes = 0;

    try {
      const files = fs.readdirSync(this.mediaDir);
      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(this.mediaDir, file));
          if (stat.isFile()) {
            count++;
            totalBytes += stat.size;
          }
        } catch { /* skip */ }
      }
    } catch { /* directory may not exist */ }

    return { count, totalBytes };
  }

  /** Start periodic cleanup. */
  startCleanup(): void {
    // Run once immediately
    const result = this.cleanup();
    if (result.deleted > 0) {
      console.log(`[media] Cleanup: deleted ${result.deleted} expired files (${(result.freedBytes / 1024 / 1024).toFixed(1)} MB)`);
    }

    // Schedule periodic cleanup
    this.cleanupTimer = setInterval(() => {
      const r = this.cleanup();
      if (r.deleted > 0) {
        console.log(`[media] Cleanup: deleted ${r.deleted} expired files (${(r.freedBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
    }, MEDIA_CLEANUP_INTERVAL_MS);
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// ── Base64 image detection helpers ──────────────

/** Known base64 magic bytes for image formats. */
const BASE64_IMAGE_SIGNATURES: Array<{ prefix: string; ext: string; mime: string }> = [
  { prefix: 'iVBOR', ext: 'png', mime: 'image/png' },
  { prefix: '/9j/', ext: 'jpg', mime: 'image/jpeg' },
  { prefix: 'R0lG', ext: 'gif', mime: 'image/gif' },
  { prefix: 'UklG', ext: 'webp', mime: 'image/webp' },
];

/**
 * Detect if a string value is likely a base64-encoded image.
 * Returns the format info if detected, null otherwise.
 */
export function detectBase64Image(value: string): { ext: string; mime: string } | null {
  if (typeof value !== 'string' || value.length < 1000) return null;

  for (const sig of BASE64_IMAGE_SIGNATURES) {
    if (value.startsWith(sig.prefix)) {
      return { ext: sig.ext, mime: sig.mime };
    }
  }
  return null;
}

/**
 * Detect image format from Content-Type header.
 */
export function extFromContentType(contentType: string): string | null {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
  };
  for (const [mime, ext] of Object.entries(map)) {
    if (contentType.includes(mime)) return ext;
  }
  return null;
}
