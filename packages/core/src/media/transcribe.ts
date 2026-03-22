/**
 * Audio transcription — sends audio files to an OpenAI-compatible
 * speech-to-text endpoint (e.g. self-hosted whisper, OpenAI, Groq).
 *
 * Used by Telegram and WhatsApp voice message handlers to convert
 * voice notes to text before passing to the agent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('tool');

export interface TranscriptionConfig {
  enabled: boolean;
  /** Base URL of the OpenAI-compatible STT service (e.g. http://10.0.2.20:5007). */
  baseUrl: string;
  /** Model name (sent in the request but may be ignored by the server). */
  model: string;
  /** Language hint (ISO 639-1). Empty = auto-detect. */
  language: string;
}

/**
 * Transcribe an audio file using an OpenAI-compatible /v1/audio/transcriptions endpoint.
 *
 * @param filePath — absolute path to the audio file (.ogg, .mp3, .wav, etc.)
 * @param config — transcription endpoint configuration
 * @returns transcribed text, or null if transcription fails or is not configured
 */
export async function transcribeAudio(
  filePath: string,
  config: TranscriptionConfig,
): Promise<string | null> {
  if (!config.enabled || !config.baseUrl) return null;

  try {
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`;
    const fileBuffer = await fs.promises.readFile(filePath);
    const filename = path.basename(filePath);

    // Build multipart form data
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(fileBuffer)]), filename);
    formData.append('model', config.model || 'whisper-small');
    if (config.language) {
      formData.append('language', config.language);
    }

    log.info({ file: filename, size: fileBuffer.length, endpoint: config.baseUrl }, 'Transcribing audio');

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      log.warn({ status: res.status, statusText: res.statusText }, 'Transcription endpoint returned error');
      return null;
    }

    const data = await res.json() as { text?: string };
    const text = data.text?.trim();

    if (!text) {
      log.debug('Transcription returned empty text');
      return null;
    }

    log.info({ chars: text.length, file: filename }, 'Audio transcribed successfully');
    return text;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ err: msg, file: filePath }, 'Audio transcription failed');
    return null;
  }
}
