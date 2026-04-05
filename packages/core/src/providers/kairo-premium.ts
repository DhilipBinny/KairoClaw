/**
 * Kairo Premium Provider — calls the kairo-auth binary for proprietary auth.
 *
 * This provider implements the standard ProviderInterface by spawning
 * the kairo-auth binary and communicating via stdin/stdout JSON.
 * The binary handles OAuth, CLI proxy, and other premium auth methods.
 *
 * If the binary is not present, this provider is not registered —
 * KairoClaw falls back to standard API key auth.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { ProviderInterface, ProviderResponse, ChatArgs } from './types.js';
import type { GatewayConfig } from '@agw/types';
import type { ToolCall } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

// Binary search paths (checked in order)
const BINARY_SEARCH_PATHS = [
  process.env.KAIRO_AUTH_PATH,
  './kairo-auth',
  '/app/kairo-auth',
  `${process.env.HOME}/.kairo/kairo-auth`,
].filter(Boolean) as string[];

/** Find the kairo-auth binary on disk. Returns path or null. */
function findBinary(): string | null {
  for (const p of BINARY_SEARCH_PATHS) {
    if (fs.existsSync(p)) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        log.warn({ path: p }, 'kairo-auth found but not executable');
      }
    }
  }
  return null;
}

/** Check if kairo-auth binary is available. */
export function isKairoPremiumAvailable(): boolean {
  return findBinary() !== null;
}

/**
 * Kairo Premium LLM Provider.
 *
 * Spawns the kairo-auth binary per request, sends the chat args as JSON
 * to stdin, and reads NDJSON responses from stdout for streaming.
 */
export class KairoPremiumProvider implements ProviderInterface {
  name = 'kairo-premium';
  private binaryPath: string;
  private licenseKey: string;
  private mode: string;
  private defaultModel: string;

  constructor(config: GatewayConfig, licenseKey: string) {
    const binary = findBinary();
    if (!binary) throw new Error('kairo-auth binary not found');
    this.binaryPath = binary;
    this.licenseKey = licenseKey;
    this.mode = config.providers?.kairoPremium?.mode || 'oauth';
    this.defaultModel = config.providers?.kairoPremium?.defaultModel || config.model?.primary || 'sonnet';
  }

  async chat(args: ChatArgs): Promise<ProviderResponse> {
    const modelId = args.model || this.defaultModel;
    // Normalize model name for binary (sonnet, opus, haiku)
    const modelShort = modelId.includes('opus') ? 'opus'
      : modelId.includes('haiku') ? 'haiku'
      : 'sonnet';

    // Flatten structured system prompt for the binary
    const systemPrompt = typeof args.systemPrompt === 'string'
      ? args.systemPrompt
      : `${args.systemPrompt.cached}\n\n${args.systemPrompt.dynamic}`;

    const request = {
      messages: args.messages,
      systemPrompt,
      tools: args.tools || [],
      model: modelShort,
      stream: true,
    };

    const child = spawn(this.binaryPath, [
      this.mode,
      '--license', this.licenseKey,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000, // 2 minute hard timeout
    });

    // Send request to stdin
    child.stdin!.write(JSON.stringify(request));
    child.stdin!.end();

    // Handle abort signal
    if (args.signal) {
      args.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      }, { once: true });
    }

    // Collect stderr for error reporting
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    // Read NDJSON from stdout
    const rl = readline.createInterface({ input: child.stdout! });

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let thinkingText = '';

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        switch (event.type) {
          case 'init':
            log.info({ mode: event.mode, model: event.model, version: event.version, category: 'llm' },
              'Kairo Premium: connected');
            break;

          case 'delta':
            if (event.text && args.onDelta) args.onDelta(event.text);
            fullText += event.text || '';
            break;

          case 'thinking_delta':
            if (event.text && args.onThinkingDelta) args.onThinkingDelta(event.text);
            thinkingText += event.text || '';
            break;

          case 'tool_call':
            toolCalls.push({
              id: event.id || `tc-${Date.now()}`,
              function: {
                name: event.name,
                arguments: typeof event.arguments === 'string'
                  ? event.arguments
                  : JSON.stringify(event.arguments || {}),
              },
            });
            break;

          case 'result':
            usage = {
              inputTokens: event.usage?.inputTokens || 0,
              outputTokens: event.usage?.outputTokens || 0,
            };
            fullText = event.text || fullText;
            return {
              text: fullText || null,
              toolCalls: toolCalls.length > 0 ? toolCalls : null,
              usage,
              thinkingText: thinkingText || null,
            };

          case 'error':
            throw new Error(`kairo-auth: ${event.message || event.code || 'unknown error'}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // skip malformed JSON
        throw e;
      }
    }

    // Process ended without result event — wait for exit code
    const code = await new Promise<number | null>((res) => (child as unknown as NodeJS.EventEmitter).on('close', res));
    if (code !== 0) {
      throw new Error(`kairo-auth exited with code ${code}: ${stderr.slice(0, 500)}`);
    }

    // Return whatever we collected
    return {
      text: fullText || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage,
      thinkingText: thinkingText || null,
    };
  }
}
