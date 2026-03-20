import OpenAI from 'openai';
import type { ProviderInterface, ProviderResponse, ChatArgs } from './types.js';
import type { ProviderOptions } from './types.js';
import type { GatewayConfig, ToolCall } from '@agw/types';
import { getModelCapabilities } from '../models/registry.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('llm');

/**
 * OpenAI-compatible provider.
 *
 * Works for both OpenAI (standard API) and Ollama (same SDK, different baseUrl).
 * The provider name is set based on whether a custom baseUrl is provided.
 */
export class OpenAIProvider implements ProviderInterface {
  readonly name: string;
  private client: OpenAI;
  private defaultModel: string;
  private config?: GatewayConfig;

  constructor(options: ProviderOptions, config?: GatewayConfig) {
    const { apiKey, baseUrl, defaultModel } = options;
    this.config = config;

    this.client = new OpenAI({
      apiKey: apiKey || 'ollama',
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    this.defaultModel = defaultModel || 'gpt-4o';
    this.name = baseUrl ? 'ollama' : 'openai';
  }

  async chat(args: ChatArgs): Promise<ProviderResponse> {
    const { messages, tools, model, systemPrompt, onDelta, signal } = args;
    const modelId = model || this.defaultModel;

    // Build messages with system prompt
    const apiMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'system') continue; // Already added
      if (m.role === 'tool') {
        apiMessages.push({
          role: 'tool',
          tool_call_id: m.tool_call_id!,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      } else if (m.role === 'assistant' && m.tool_calls) {
        apiMessages.push({
          role: 'assistant',
          content: (typeof m.content === 'string' ? m.content : '') || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });
      } else if (Array.isArray(m.content)) {
        // Handle multimodal content — convert to OpenAI format
        const parts: OpenAI.ChatCompletionContentPart[] = m.content.map((part) => {
          if (part.type === 'image') {
            return {
              type: 'image_url' as const,
              image_url: {
                url: `data:${part.source.media_type};base64,${part.source.data}`,
              },
            };
          }
          return { type: 'text' as const, text: part.text };
        });
        // Multimodal messages are always user messages
        apiMessages.push({
          role: 'user' as const,
          content: parts,
        });
      } else {
        apiMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
      }
    }

    // Build tool definitions
    const openaiTools: OpenAI.ChatCompletionTool[] = (tools || []).map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelId,
      messages: apiMessages,
      stream: true,
    };
    if (openaiTools.length > 0) {
      params.tools = openaiTools;
    }

    const caps = getModelCapabilities(modelId, this.config);
    const timeoutMs = caps.timeoutMs;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    const effectiveSignal = signal || abortController.signal;

    try {
      const stream = await this.client.chat.completions.create(params, {
        signal: effectiveSignal,
      });
      let text = '';
      const toolCalls: ToolCall[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let thinkingText = '';

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle reasoning_content from Ollama thinking models (qwen3, deepseek-r1)
        const reasoningContent = (delta as any).reasoning_content as string | undefined;
        if (reasoningContent) {
          thinkingText += reasoningContent;
          if (args.onThinkingDelta) args.onThinkingDelta(reasoningContent);
        }

        if (delta.content) {
          text += delta.content;
          if (onDelta) onDelta(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              while (toolCalls.length <= tc.index) {
                toolCalls.push({ id: '', function: { name: '', arguments: '' } });
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments)
                toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }
      }

      clearTimeout(timeoutId);

      return {
        text: text || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        usage: { inputTokens, outputTokens },
        thinkingText: thinkingText || null,
      };
    } catch (e: unknown) {
      clearTimeout(timeoutId);
      const err = e as Error & { status?: number };
      if (err.name === 'AbortError') throw new Error('Request timed out');
      log.error({ err: err.message, model: modelId }, 'OpenAI API error');
      throw e;
    }
  }
}
