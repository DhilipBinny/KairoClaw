/**
 * Media detection utilities — exact copies from packages/core/src/media/store.ts.
 * Duplicated here so @agw/plugins doesn't depend on core's media module.
 */

/** Known base64 magic bytes for image formats. */
const BASE64_IMAGE_SIGNATURES: Array<{ prefix: string; ext: string; mime: string }> = [
  { prefix: 'iVBOR', ext: 'png', mime: 'image/png' },
  { prefix: '/9j/', ext: 'jpg', mime: 'image/jpeg' },
  { prefix: 'R0lG', ext: 'gif', mime: 'image/gif' },
  { prefix: 'UklG', ext: 'webp', mime: 'image/webp' },
];

const DATA_URI_RE = /^data:image\/[a-z+]+;base64,/i;

/**
 * Detect if a string value is likely a base64-encoded image.
 * Returns the format info if detected, null otherwise.
 * Requires minimum length (designed for detecting base64 blobs in JSON).
 */
export function detectBase64Image(value: string): { ext: string; mime: string } | null {
  if (typeof value !== 'string' || value.length < 1000) return null;
  return sniffBase64Mime(stripDataUri(value));
}

/**
 * Sniff the actual MIME type from a base64-encoded image string
 * by checking magic byte prefixes. Returns null if unrecognized.
 *
 * Use this to correct MIME types reported by channels — prevents
 * Anthropic API 400 errors from type mismatches.
 */
export function sniffBase64Mime(base64Data: string): { ext: string; mime: string } | null {
  if (!base64Data) return null;
  for (const sig of BASE64_IMAGE_SIGNATURES) {
    if (base64Data.startsWith(sig.prefix)) {
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
  if (contentType.startsWith('image/')) return contentType.split('/')[1]?.split(';')[0] || 'bin';
  return null;
}

/**
 * Strip data URI prefix (e.g., "data:image/png;base64,") from a base64 string.
 * Many image generation APIs return base64 with this prefix.
 */
export function stripDataUri(value: string): string {
  return value.replace(DATA_URI_RE, '');
}
