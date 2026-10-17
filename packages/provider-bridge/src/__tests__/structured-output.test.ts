import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatArgs, ResponseFormat } from '@agw/types';

const BASE_ARGS: ChatArgs = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  systemPrompt: 'You are helpful.',
};

describe('structured output types', () => {
  it('JsonSchemaResponseFormat has required fields', () => {
    const fmt: ResponseFormat = {
      type: 'json_schema',
      name: 'test_schema',
      schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    };
    expect(fmt.type).toBe('json_schema');
    expect((fmt as { name: string }).name).toBe('test_schema');
  });

  it('JsonObjectResponseFormat has type field only', () => {
    const fmt: ResponseFormat = { type: 'json_object' };
    expect(fmt.type).toBe('json_object');
  });

  it('ChatArgs accepts responseFormat', () => {
    const args: ChatArgs = {
      ...BASE_ARGS,
      responseFormat: { type: 'json_object' },
    };
    expect(args.responseFormat?.type).toBe('json_object');
  });
});

describe('Anthropic adapter — structured output mapping', () => {
  beforeEach(() => { vi.resetModules(); });

  function makeAnthropicMock(streamText: string) {
    let capturedParams: Record<string, unknown> | null = null;
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { usage: { input_tokens: 10 } } };
        yield { type: 'content_block_start', content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: streamText } };
        yield { type: 'message_delta', usage: { output_tokens: 5 } };
      },
    };
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = {
          stream: (params: Record<string, unknown>) => {
            capturedParams = params;
            return mockStream;
          },
        };
      },
    }));
    return () => capturedParams;
  }

  it('maps json_schema to output_config on params', async () => {
    const getParams = makeAnthropicMock('{"name":"test"}');
    const { AnthropicProvider } = await import('../anthropic.js');
    const provider = new AnthropicProvider({ apiKey: 'test-key', defaultModel: 'claude-sonnet-4-6' });

    const response = await provider.chat({
      ...BASE_ARGS,
      responseFormat: {
        type: 'json_schema',
        name: 'test_output',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    });

    const params = getParams();
    expect(params).toBeTruthy();
    expect((params as any).output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    });
    expect(response.parsedOutput).toEqual({ name: 'test' });
  });

  it('ignores json_object with a warning', async () => {
    const warnSpy = vi.fn();
    makeAnthropicMock('hello');
    const { AnthropicProvider } = await import('../anthropic.js');
    const provider = new AnthropicProvider(
      { apiKey: 'test-key', defaultModel: 'claude-sonnet-4-6' },
      undefined,
      { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as any,
    );

    const response = await provider.chat({
      ...BASE_ARGS,
      responseFormat: { type: 'json_object' },
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('json_object'));
    expect(response.parsedOutput).toBeUndefined();
  });

  it('does not set output_config when responseFormat is undefined', async () => {
    const getParams = makeAnthropicMock('hello world');
    const { AnthropicProvider } = await import('../anthropic.js');
    const provider = new AnthropicProvider({ apiKey: 'test-key', defaultModel: 'claude-sonnet-4-6' });

    await provider.chat(BASE_ARGS);

    const params = getParams();
    expect(params).toBeTruthy();
    expect((params as any).output_config).toBeUndefined();
  });
});

describe('OpenAI adapter — structured output mapping', () => {
  beforeEach(() => { vi.resetModules(); });

  function makeOpenAIMock(streamText: string) {
    let capturedParams: Record<string, unknown> | null = null;
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: streamText } }] };
        yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    };
    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: async (params: Record<string, unknown>) => {
              capturedParams = params;
              return mockStream;
            },
          },
        };
      },
    }));
    return () => capturedParams;
  }

  it('maps json_schema to response_format with json_schema type', async () => {
    const getParams = makeOpenAIMock('{"count":42}');
    const { OpenAIProvider } = await import('../openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key', defaultModel: 'gpt-4o' });

    const response = await provider.chat({
      ...BASE_ARGS,
      responseFormat: {
        type: 'json_schema',
        name: 'counter',
        schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
        strict: true,
      },
    });

    const params = getParams();
    expect(params).toBeTruthy();
    expect((params as any).response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'counter',
        schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] },
        strict: true,
      },
    });
    expect(response.parsedOutput).toEqual({ count: 42 });
  });

  it('maps json_object to response_format with json_object type', async () => {
    const getParams = makeOpenAIMock('{"ok":true}');
    const { OpenAIProvider } = await import('../openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key', defaultModel: 'gpt-4o' });

    const response = await provider.chat({
      ...BASE_ARGS,
      responseFormat: { type: 'json_object' },
    });

    const params = getParams();
    expect(params).toBeTruthy();
    expect((params as any).response_format).toEqual({ type: 'json_object' });
    expect(response.parsedOutput).toEqual({ ok: true });
  });

  it('does not set response_format when responseFormat is undefined', async () => {
    const getParams = makeOpenAIMock('hello');
    const { OpenAIProvider } = await import('../openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key', defaultModel: 'gpt-4o' });

    await provider.chat(BASE_ARGS);

    const params = getParams();
    expect(params).toBeTruthy();
    expect((params as any).response_format).toBeUndefined();
  });
});

describe('parsedOutput handling', () => {
  beforeEach(() => { vi.resetModules(); });

  function makeOpenAIMock(streamText: string) {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: streamText } }] };
        yield { usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    };
    vi.doMock('openai', () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: async () => mockStream,
          },
        };
      },
    }));
  }

  it('sets parsedOutput to undefined when response is not valid JSON', async () => {
    makeOpenAIMock('not json at all');
    const { OpenAIProvider } = await import('../openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key', defaultModel: 'gpt-4o' });

    const response = await provider.chat({
      ...BASE_ARGS,
      responseFormat: { type: 'json_object' },
    });

    expect(response.text).toBe('not json at all');
    expect(response.parsedOutput).toBeUndefined();
  });

  it('does not attempt JSON parse when no responseFormat is set', async () => {
    makeOpenAIMock('{"valid":"json"}');
    const { OpenAIProvider } = await import('../openai.js');
    const provider = new OpenAIProvider({ apiKey: 'test-key', defaultModel: 'gpt-4o' });

    const response = await provider.chat(BASE_ARGS);

    expect(response.text).toBe('{"valid":"json"}');
    expect(response.parsedOutput).toBeUndefined();
  });
});
