import Anthropic from '@anthropic-ai/sdk';
import type { ProviderInterface, ProviderResponse, ChatArgs } from './types.js';
import type { ProviderOptions } from './types.js';
import type { GatewayConfig, ToolCall, ThinkingBlock, StructuredSystemPrompt } from '@agw/types';
import { getModelCapabilities } from '../models/registry.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

/**
 * Anthropic provider — standard API key authentication.
 *
 * Uses ANTHROPIC_API_KEY for pay-per-token billing.
 * For subscription-based auth (OAuth, CLI), use the Kairo Premium provider.
 */
export class AnthropicProvider implements ProviderInterface {
  readonly name = 'anthropic';
  private client: Anthropic;
  private defaultModel: string;
  readonly authType: string;
  private config?: GatewayConfig;

  constructor(options: ProviderOptions, config?: GatewayConfig) {
    const { apiKey, baseUrl, defaultModel } = options;
    this.config = config;

    const clientOpts: Record<string, unknown> = {};

    // Standard API key auth only
    // For OAuth/subscription auth, use the Kairo Premium provider (kairo-auth binary)
    if (apiKey) {
      clientOpts.apiKey = apiKey;
      this.authType = 'api-key';
    } else {
      const envKey = process.env.ANTHROPIC_API_KEY;
      this.authType = envKey ? 'api-key' : 'unknown';
    }

    // Custom base URL for proxies
    if (baseUrl) {
      clientOpts.baseURL = baseUrl;
    }

    this.client = new Anthropic(clientOpts as ConstructorParameters<typeof Anthropic>[0]);
    this.defaultModel = defaultModel || 'claude-sonnet-4-20250514';
  }

  async chat(args: ChatArgs): Promise<ProviderResponse> {
    const { messages, tools, model, systemPrompt, onDelta, signal } = args;
    const modelId = model || this.defaultModel;

    // Convert tools to Anthropic format
    const anthropicTools = (tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    // Build messages (separate system from conversation)
    const apiMessages: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: m.tool_call_id!,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              },
            ],
          };
        }
        if (m.role === 'assistant' && m.tool_calls) {
          const content: Anthropic.ContentBlockParam[] = [];
          // Thinking blocks must come first for multi-turn tool-use continuity
          if (m.thinking_blocks) {
            for (const tb of m.thinking_blocks) {
              content.push({ type: 'thinking' as any, thinking: tb.thinking, signature: tb.signature } as any);
            }
          }
          if (m.content) content.push({ type: 'text' as const, text: typeof m.content === 'string' ? m.content : '' });
          for (const tc of m.tool_calls) {
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            } catch {
              log.warn({ tool: tc.function.name, id: tc.id }, 'Malformed tool call arguments JSON, using empty object');
              input = {};
            }
            content.push({
              type: 'tool_use' as const,
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
          return { role: 'assistant' as const, content };
        }
        // Handle multimodal content (array of content parts)
        if (Array.isArray(m.content)) {
          const content: Anthropic.ContentBlockParam[] = m.content.map((part) => {
            if (part.type === 'image') {
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: part.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: part.source.data,
                },
              };
            }
            return { type: 'text' as const, text: part.text };
          });
          return { role: m.role as 'user' | 'assistant', content };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content as string };
      });

    const caps = getModelCapabilities(modelId, this.config);

    // Build system content as array with cache_control for prompt caching.
    // Anthropic caches marked blocks for 5 min — saves ~90% on input tokens
    // for repeat turns within the same session.
    //
    // When a StructuredSystemPrompt is passed, the cached prefix (identity,
    // tools, safety, persona files) gets cache_control and stays stable across
    // turns. The dynamic suffix (time, memory) changes every call but is small.
    const structured = typeof systemPrompt === 'object' && systemPrompt !== null && 'cached' in systemPrompt
      ? systemPrompt as StructuredSystemPrompt
      : null;

    let systemContent: string | Anthropic.TextBlockParam[];
    if (structured) {
      // API key mode with structured prompt: cache the stable prefix
      const blocks: Anthropic.TextBlockParam[] = [
        { type: 'text' as const, text: structured.cached, cache_control: { type: 'ephemeral' as const } },
      ];
      if (structured.dynamic) {
        blocks.push({ type: 'text' as const, text: structured.dynamic });
      }
      systemContent = blocks;
    } else if (systemPrompt) {
      // API key mode with plain string: cache the whole thing (backwards compat)
      systemContent = [
        { type: 'text' as const, text: systemPrompt as string, cache_control: { type: 'ephemeral' as const } },
      ];
    } else {
      systemContent = '';
    }

    const params: Anthropic.MessageCreateParams = {
      model: modelId,
      max_tokens: caps.maxOutputTokens,
      system: systemContent,
      messages: apiMessages,
    };
    if (anthropicTools.length > 0) {
      params.tools = anthropicTools;
    }

    // ── Extended thinking ────────────────────────────────
    if (args.thinkingConfig?.enabled) {
      (params as any).thinking = { type: 'enabled', budget_tokens: args.thinkingConfig.budgetTokens || 10000 };
      // max_tokens must cover both thinking + output
      params.max_tokens = Math.max(params.max_tokens, (args.thinkingConfig.budgetTokens || 10000) + caps.maxOutputTokens);
      // Thinking + tools requires tool_choice "auto"
      if (params.tools) {
        params.tool_choice = { type: 'auto' };
      }
    }

    // ── Detailed request logging ──────────────────────────
    const systemLen = structured
      ? structured.cached.length + structured.dynamic.length
      : (typeof systemPrompt === 'string' ? systemPrompt.length : 0);
    const msgsInfo = apiMessages.map((m) => {
      const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
      return `${m.role}(${contentLen}c)`;
    }).join(', ');
    const toolNames = anthropicTools.map((t) => t.name).join(', ');
    const toolSchemaSize = JSON.stringify(anthropicTools).length;
    log.info({
      model: modelId,
      authType: this.authType,
      maxTokens: caps.maxOutputTokens,
      systemPromptLen: systemLen,
      messageCount: apiMessages.length,
      toolCount: anthropicTools.length,
      toolSchemaKB: (toolSchemaSize / 1024).toFixed(1),
    }, `Anthropic request: ${apiMessages.length} msgs, ${anthropicTools.length} tools (${(toolSchemaSize / 1024).toFixed(1)}KB schema)`);
    log.debug(`  messages: [${msgsInfo}]`);
    if (anthropicTools.length > 0) {
      log.debug(`  tools: [${toolNames}]`);
    }

    // Timeout handling
    const timeoutMs = caps.timeoutMs;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    const effectiveSignal = signal || abortController.signal;

    try {
      const stream = this.client.messages.stream(params, { signal: effectiveSignal });
      let text = '';
      const toolCalls: (ToolCall & { _rawArgs?: string })[] = [];
      let inputTokens = 0;
      let outputTokens = 0;

      // Extended thinking state
      let thinkingText = '';
      const thinkingBlocks: ThinkingBlock[] = [];
      let currentThinkingBlock: { thinking: string; signature: string } | null = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            toolCalls.push({
              id: event.content_block.id,
              function: { name: event.content_block.name, arguments: '' },
              _rawArgs: '',
            });
          } else if ((event.content_block as any).type === 'thinking') {
            currentThinkingBlock = { thinking: '', signature: '' };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta as any;
          if (delta.type === 'text_delta') {
            text += delta.text;
            if (onDelta) onDelta(delta.text);
          } else if (delta.type === 'input_json_delta') {
            const tc = toolCalls[toolCalls.length - 1];
            if (tc) tc._rawArgs = (tc._rawArgs || '') + delta.partial_json;
          } else if (delta.type === 'thinking_delta') {
            const chunk = delta.thinking as string;
            thinkingText += chunk;
            if (currentThinkingBlock) currentThinkingBlock.thinking += chunk;
            if (args.onThinkingDelta) args.onThinkingDelta(chunk);
          } else if (delta.type === 'signature_delta') {
            if (currentThinkingBlock) currentThinkingBlock.signature += delta.signature as string;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentThinkingBlock) {
            thinkingBlocks.push({
              type: 'thinking',
              thinking: currentThinkingBlock.thinking,
              signature: currentThinkingBlock.signature,
            });
            currentThinkingBlock = null;
          }
        } else if (event.type === 'message_delta') {
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
        } else if (event.type === 'message_start') {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
            // Log prompt cache metrics when available
            const usage = event.message.usage as unknown as Record<string, unknown>;
            const cacheRead = usage.cache_read_input_tokens as number | undefined;
            const cacheCreate = usage.cache_creation_input_tokens as number | undefined;
            if (cacheRead || cacheCreate) {
              log.info({
                cacheReadTokens: cacheRead || 0,
                cacheCreationTokens: cacheCreate || 0,
                inputTokens: inputTokens,
                cacheHitRate: inputTokens > 0
                  ? `${(((cacheRead || 0) / inputTokens) * 100).toFixed(1)}%`
                  : '0%',
                category: 'llm',
              }, `Prompt cache: ${cacheRead || 0} read, ${cacheCreate || 0} created`);
            }
          }
        }
      }

      // Finalize tool call arguments
      for (const tc of toolCalls) {
        tc.function.arguments = tc._rawArgs || '{}';
        delete tc._rawArgs;
      }

      clearTimeout(timeoutId);

      return {
        text: text || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        usage: { inputTokens, outputTokens },
        thinkingText: thinkingText || null,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      };
    } catch (e: unknown) {
      clearTimeout(timeoutId);
      const err = e as Error & { status?: number };
      if (err.name === 'AbortError') throw new Error('Request timed out');

      // Provide helpful error messages for auth issues
      if (err.status === 401) {
        const hint = 'API key is invalid. Check your ANTHROPIC_API_KEY.';
        log.error({ err: err.message, authType: this.authType }, `Anthropic auth error: ${hint}`);
        throw new Error(`Anthropic 401: ${hint}`);
      }

      // Extract full error details from Anthropic's response
      const errAny = e as Record<string, unknown>;
      const status = err.status || (errAny as any)?.status;
      const errorBody = (errAny as any)?.error || (errAny as any)?.body || (errAny as any)?.response;
      const headers = (errAny as any)?.headers;
      const retryAfter = headers?.['retry-after'];
      const rateLimitRemaining = headers?.['x-ratelimit-limit-requests'] || headers?.['anthropic-ratelimit-requests-remaining'];

      log.error({
        status,
        model: modelId,
        authType: this.authType,
        errorMessage: err.message,
        errorBody: typeof errorBody === 'object' ? JSON.stringify(errorBody)?.slice(0, 500) : String(errorBody || ''),
        retryAfter,
        rateLimitRemaining,
        messageCount: apiMessages.length,
        toolCount: anthropicTools.length,
        toolSchemaKB: (toolSchemaSize / 1024).toFixed(1),
        systemPromptLen: systemLen,
      }, `Anthropic API error ${status}: ${err.message?.slice(0, 200)}`);

      throw e;
    }
  }
}
