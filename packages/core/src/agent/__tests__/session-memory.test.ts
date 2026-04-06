import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getSessionMemoryPath,
  readSessionMemory,
  getSessionMemoryForCompaction,
  shouldExtractSessionMemory,
  loadSessionMemoryState,
  saveSessionMemoryState,
  createInitialState,
  extractSessionMemory,
  cleanupSessionMemoryFiles,
  SESSION_MEMORY_TEMPLATE,
  type SessionMemoryState,
} from '../session-memory.js';
import type { GatewayConfig } from '@agw/types';
import type { SessionRow } from '../../db/repositories/session.js';

// ── Test helpers ─────────────────────────────────────────

let tmpDir: string;

function makeConfig(overrides: Partial<GatewayConfig['agent']> = {}): GatewayConfig {
  return {
    agent: {
      name: 'Test',
      workspace: tmpDir,
      maxToolRounds: 10,
      compactionThreshold: 0.75,
      softCompactionThreshold: 0.5,
      keepRecentMessages: 10,
      ...overrides,
    },
    model: { primary: 'claude-sonnet-4-20250514', fallback: '', fallbackChain: [] },
    // Minimal stubs for other required fields
    gateway: { port: 3000, host: '0.0.0.0', token: '' },
    providers: {} as any,
    channels: {} as any,
    session: { resetHour: 4, idleMinutes: 240 },
    tools: {} as any,
    models: { catalog: {} },
    mcp: { servers: {} },
  } as GatewayConfig;
}

function makeSessionRow(metadata: Record<string, unknown> = {}): SessionRow {
  return {
    id: 'sess-test-123',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    channel: 'web',
    chat_id: null,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    turns: 0,
    metadata: JSON.stringify(metadata),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
  };
}

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-memory-test-'));
  // Create the scoped memory directory structure
  fs.mkdirSync(path.join(tmpDir, 'memory', 'session-context'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'scopes', 'user-1', 'memory', 'session-context'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── getSessionMemoryPath ──────────────────────────────────

describe('getSessionMemoryPath', () => {
  it('returns correct path for global scope', () => {
    const p = getSessionMemoryPath(tmpDir, null, 'sess-abc');
    expect(p).toBe(path.join(tmpDir, 'memory', 'session-context', 'sess-abc.md'));
  });

  it('returns correct path for user scope', () => {
    const p = getSessionMemoryPath(tmpDir, 'user-1', 'sess-abc');
    expect(p).toBe(path.join(tmpDir, 'scopes', 'user-1', 'memory', 'session-context', 'sess-abc.md'));
  });
});

// ─── readSessionMemory ─────────────────────────────────────

describe('readSessionMemory', () => {
  it('returns empty string when file does not exist', () => {
    expect(readSessionMemory(tmpDir, null, 'nonexistent')).toBe('');
  });

  it('reads existing session memory file', () => {
    writeFile('memory/session-context/sess-abc.md', '## Current State\nDoing stuff');
    expect(readSessionMemory(tmpDir, null, 'sess-abc')).toBe('## Current State\nDoing stuff');
  });

  it('reads from scoped directory', () => {
    writeFile('scopes/user-1/memory/session-context/sess-abc.md', '## Current State\nUser stuff');
    expect(readSessionMemory(tmpDir, 'user-1', 'sess-abc')).toBe('## Current State\nUser stuff');
  });
});

// ─── getSessionMemoryForCompaction ─────────────────────────

describe('getSessionMemoryForCompaction', () => {
  it('returns null when file does not exist', () => {
    expect(getSessionMemoryForCompaction(tmpDir, null, 'nonexistent')).toBeNull();
  });

  it('returns null for empty file', () => {
    writeFile('memory/session-context/sess-abc.md', '');
    expect(getSessionMemoryForCompaction(tmpDir, null, 'sess-abc')).toBeNull();
  });

  it('returns null for template-only content (no real activity)', () => {
    writeFile('memory/session-context/sess-abc.md', SESSION_MEMORY_TEMPLATE);
    expect(getSessionMemoryForCompaction(tmpDir, null, 'sess-abc')).toBeNull();
  });

  it('returns null when fewer than 2 section headings present', () => {
    writeFile('memory/session-context/sess-abc.md', '## Current State\nSome content but only one heading');
    expect(getSessionMemoryForCompaction(tmpDir, null, 'sess-abc')).toBeNull();
  });

  it('returns content when valid structured notes exist', () => {
    const content = `## Current State
Researching Dubai Marina villas

## Task / Request
Compare 3BR villa prices across areas

## Key Information
- Dubai Marina avg: 3.2M AED
- Budget: under 4M

## Decisions Made
Excluded off-plan properties

## Files Touched
listings/dubai-marina.json

## Errors & Corrections
None

## Worklog
- [10:15] Started research`;

    writeFile('memory/session-context/sess-abc.md', content);
    const result = getSessionMemoryForCompaction(tmpDir, null, 'sess-abc');
    expect(result).toBe(content);
  });

  it('truncates content exceeding maxChars', () => {
    const longContent = '## Current State\nA\n## Task / Request\nB\n' + 'x'.repeat(15000);
    writeFile('memory/session-context/sess-abc.md', longContent);
    const result = getSessionMemoryForCompaction(tmpDir, null, 'sess-abc', 500);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(550); // 500 + truncation message
    expect(result).toContain('[... session memory truncated ...]');
  });
});

// ─── shouldExtractSessionMemory ────────────────────────────

describe('shouldExtractSessionMemory', () => {
  const config = makeConfig();

  it('should not extract when disabled', () => {
    const disabledConfig = makeConfig({ sessionMemory: { enabled: false } });
    const state = createInitialState();
    expect(shouldExtractSessionMemory(10000, state, disabledConfig).shouldExtract).toBe(false);
  });

  it('should not extract when below init threshold (first time)', () => {
    const state = createInitialState();
    expect(shouldExtractSessionMemory(5000, state, config).shouldExtract).toBe(false);
  });

  it('should extract when at init threshold (first time)', () => {
    const state = createInitialState();
    const result = shouldExtractSessionMemory(8000, state, config);
    expect(result.shouldExtract).toBe(true);
    expect(result.reason).toContain('init threshold');
  });

  it('should extract when above init threshold (first time)', () => {
    const state = createInitialState();
    expect(shouldExtractSessionMemory(12000, state, config).shouldExtract).toBe(true);
  });

  it('should not extract when growth is below threshold (subsequent)', () => {
    const state: SessionMemoryState = {
      lastExtractedMessageId: 10,
      tokensAtLastExtraction: 10000,
      extractionCount: 1,
    };
    expect(shouldExtractSessionMemory(12000, state, config).shouldExtract).toBe(false);
  });

  it('should extract when growth meets threshold (subsequent)', () => {
    const state: SessionMemoryState = {
      lastExtractedMessageId: 10,
      tokensAtLastExtraction: 10000,
      extractionCount: 1,
    };
    const result = shouldExtractSessionMemory(14000, state, config);
    expect(result.shouldExtract).toBe(true);
    expect(result.reason).toContain('growth threshold');
  });

  it('respects custom thresholds from config', () => {
    const customConfig = makeConfig({
      sessionMemory: { initTokenThreshold: 5000, growthTokenThreshold: 2000 },
    });
    const state = createInitialState();
    expect(shouldExtractSessionMemory(5000, state, customConfig).shouldExtract).toBe(true);
  });
});

// ─── State Management ──────────────────────────────────────

describe('loadSessionMemoryState', () => {
  it('returns null when no session memory state in metadata', () => {
    const session = makeSessionRow({});
    expect(loadSessionMemoryState(session)).toBeNull();
  });

  it('returns null for invalid metadata JSON', () => {
    const session = { ...makeSessionRow(), metadata: 'invalid json' };
    expect(loadSessionMemoryState(session)).toBeNull();
  });

  it('loads state from metadata', () => {
    const state: SessionMemoryState = {
      lastExtractedMessageId: 42,
      tokensAtLastExtraction: 12500,
      extractionCount: 3,
    };
    const session = makeSessionRow({ sessionMemory: state });
    const loaded = loadSessionMemoryState(session);
    expect(loaded).toEqual(state);
  });
});

describe('saveSessionMemoryState', () => {
  it('saves state to session metadata', async () => {
    const state: SessionMemoryState = {
      lastExtractedMessageId: 42,
      tokensAtLastExtraction: 12500,
      extractionCount: 3,
    };

    let savedMetadata = '';
    const mockSessionRepo = {
      getById: vi.fn().mockResolvedValue(makeSessionRow({ existingField: 'kept' })),
      update: vi.fn().mockImplementation((_id: string, data: { metadata: string }) => {
        savedMetadata = data.metadata;
        return Promise.resolve();
      }),
    } as any;

    await saveSessionMemoryState('sess-test-123', state, mockSessionRepo);

    expect(mockSessionRepo.update).toHaveBeenCalledWith('sess-test-123', expect.objectContaining({
      metadata: expect.any(String),
    }));

    const parsed = JSON.parse(savedMetadata);
    expect(parsed.sessionMemory).toEqual(state);
    expect(parsed.existingField).toBe('kept'); // preserves existing metadata
  });

  it('handles missing session gracefully', async () => {
    const mockSessionRepo = {
      getById: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    } as any;

    await saveSessionMemoryState('nonexistent', createInitialState(), mockSessionRepo);
    expect(mockSessionRepo.update).not.toHaveBeenCalled();
  });
});

// ─── extractSessionMemory ──────────────────────────────────

describe('extractSessionMemory', () => {
  it('returns unchanged state when no new messages', async () => {
    const state = createInitialState();
    const mockDb = {
      query: vi.fn().mockResolvedValue([]),
    } as any;

    const result = await extractSessionMemory({
      sessionId: 'sess-test',
      scopeKey: null,
      db: mockDb,
      config: makeConfig(),
      state,
      currentTokens: 10000,
      callLLM: vi.fn(),
    });

    expect(result).toEqual(state);
  });

  it('calls LLM and writes file on first extraction', async () => {
    const state = createInitialState();
    const mockMessages = [
      { id: 1, session_id: 'sess-test', tenant_id: 't', role: 'user', content: 'Hello', tool_calls: null, tool_call_id: null, metadata: null, created_at: '2026-04-06T10:00:00Z' },
      { id: 2, session_id: 'sess-test', tenant_id: 't', role: 'assistant', content: 'Hi there!', tool_calls: null, tool_call_id: null, metadata: null, created_at: '2026-04-06T10:00:01Z' },
    ];

    const mockDb = {
      query: vi.fn().mockResolvedValue(mockMessages),
    } as any;

    const llmResponse = `## Current State
User greeted the agent

## Task / Request
None yet

## Key Information
None

## Decisions Made
None

## Files Touched
None

## Errors & Corrections
None

## Worklog
- [10:00] User said hello`;

    const mockCallLLM = vi.fn().mockResolvedValue({ text: llmResponse });

    const result = await extractSessionMemory({
      sessionId: 'sess-test',
      scopeKey: null,
      db: mockDb,
      config: makeConfig(),
      state,
      currentTokens: 10000,
      callLLM: mockCallLLM,
    });

    // State updated
    expect(result.lastExtractedMessageId).toBe(2);
    expect(result.tokensAtLastExtraction).toBe(10000);
    expect(result.extractionCount).toBe(1);

    // LLM was called
    expect(mockCallLLM).toHaveBeenCalledOnce();
    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('(empty — first extraction)');
    expect(callArgs.messages[0].content).toContain('[User]: Hello');

    // File was written
    const written = readSessionMemory(tmpDir, null, 'sess-test');
    expect(written).toBe(llmResponse);
  });

  it('passes existing memory to LLM on subsequent extractions', async () => {
    // Pre-populate session memory file
    const existingContent = '## Current State\nPrevious state\n## Task / Request\nOld task';
    writeFile('memory/session-context/sess-test.md', existingContent);

    const state: SessionMemoryState = {
      lastExtractedMessageId: 5,
      tokensAtLastExtraction: 8000,
      extractionCount: 1,
    };

    const mockMessages = [
      { id: 6, session_id: 'sess-test', tenant_id: 't', role: 'user', content: 'New message', tool_calls: null, tool_call_id: null, metadata: null, created_at: '2026-04-06T11:00:00Z' },
    ];

    const mockDb = {
      query: vi.fn().mockResolvedValue(mockMessages),
    } as any;

    const updatedContent = `## Current State
Updated state

## Task / Request
Updated task

## Key Information
New info

## Decisions Made
None

## Files Touched
None

## Errors & Corrections
None

## Worklog
- [11:00] New message received`;

    const mockCallLLM = vi.fn().mockResolvedValue({ text: updatedContent });

    const result = await extractSessionMemory({
      sessionId: 'sess-test',
      scopeKey: null,
      db: mockDb,
      config: makeConfig(),
      state,
      currentTokens: 12000,
      callLLM: mockCallLLM,
    });

    expect(result.extractionCount).toBe(2);
    expect(result.lastExtractedMessageId).toBe(6);

    // LLM received existing memory
    const callArgs = mockCallLLM.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('Previous state');
    expect(callArgs.messages[0].content).not.toContain('(empty — first extraction)');
  });

  it('discards LLM output with too few section headings', async () => {
    const state = createInitialState();
    const mockDb = {
      query: vi.fn().mockResolvedValue([
        { id: 1, session_id: 'sess-test', tenant_id: 't', role: 'user', content: 'Hello', tool_calls: null, tool_call_id: null, metadata: null, created_at: '2026-04-06T10:00:00Z' },
      ]),
    } as any;

    const mockCallLLM = vi.fn().mockResolvedValue({
      text: 'Some random text without proper headings',
    });

    const result = await extractSessionMemory({
      sessionId: 'sess-test',
      scopeKey: null,
      db: mockDb,
      config: makeConfig(),
      state,
      currentTokens: 10000,
      callLLM: mockCallLLM,
    });

    // State unchanged — extraction discarded
    expect(result).toEqual(state);
    // No file written
    expect(readSessionMemory(tmpDir, null, 'sess-test')).toBe('');
  });

  it('uses configured extraction model', async () => {
    const config = makeConfig({
      sessionMemory: { extractionModel: 'claude-haiku-4-5-20251001' },
    });

    const mockDb = {
      query: vi.fn().mockResolvedValue([
        { id: 1, session_id: 'sess-test', tenant_id: 't', role: 'user', content: 'Hello', tool_calls: null, tool_call_id: null, metadata: null, created_at: '2026-04-06T10:00:00Z' },
      ]),
    } as any;

    const validResponse = SESSION_MEMORY_TEMPLATE.replace('(No activity yet)', 'Active');
    const mockCallLLM = vi.fn().mockResolvedValue({ text: validResponse });

    await extractSessionMemory({
      sessionId: 'sess-test',
      scopeKey: null,
      db: mockDb,
      config,
      state: createInitialState(),
      currentTokens: 10000,
      callLLM: mockCallLLM,
    });

    expect(mockCallLLM.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });
});

// ─── cleanupSessionMemoryFiles ─────────────────────────────

describe('cleanupSessionMemoryFiles', () => {
  it('returns 0 when directory does not exist', () => {
    expect(cleanupSessionMemoryFiles(tmpDir, 'nonexistent-scope')).toBe(0);
  });

  it('removes files older than maxAgeDays', () => {
    const dir = path.join(tmpDir, 'memory', 'session-context');

    // Write a file and backdate it
    const oldFile = path.join(dir, 'old-session.md');
    fs.writeFileSync(oldFile, 'old content');
    const oldTime = Date.now() - 10 * 86_400_000; // 10 days ago
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

    // Write a recent file
    fs.writeFileSync(path.join(dir, 'new-session.md'), 'new content');

    const removed = cleanupSessionMemoryFiles(tmpDir, null, 7);
    expect(removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new-session.md'))).toBe(true);
  });

  it('leaves non-md files alone', () => {
    const dir = path.join(tmpDir, 'memory', 'session-context');
    const txtFile = path.join(dir, 'notes.txt');
    fs.writeFileSync(txtFile, 'not a session memory file');
    const oldTime = Date.now() - 10 * 86_400_000;
    fs.utimesSync(txtFile, new Date(oldTime), new Date(oldTime));

    const removed = cleanupSessionMemoryFiles(tmpDir, null, 7);
    expect(removed).toBe(0);
    expect(fs.existsSync(txtFile)).toBe(true);
  });
});

// ─── createInitialState ────────────────────────────────────

describe('createInitialState', () => {
  it('returns zeroed state', () => {
    const state = createInitialState();
    expect(state.lastExtractedMessageId).toBe(0);
    expect(state.tokensAtLastExtraction).toBe(0);
    expect(state.extractionCount).toBe(0);
  });
});
