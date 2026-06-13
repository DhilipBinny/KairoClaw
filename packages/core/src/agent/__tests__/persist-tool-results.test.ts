import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { runAgent, type AgentContext } from '../loop.js';
import { MessageRepository } from '../../db/repositories/message.js';
import { createTestDb, type TestDb } from '../../db/__tests__/test-db.js';
import { rowToMessage, normalizeMessages } from '@agw/agent-core';
import type { InboundMessage, GatewayConfig, ProviderResponse } from '@agw/types';

function makeConfig(): GatewayConfig {
  return {
    model: { primary: 'anthropic/claude-sonnet-4-20250514', fallback: '', fallbackChain: [] },
    agent: {
      name: 'Test', workspace: os.tmpdir(), maxToolRounds: 10,
      compactionThreshold: 0.75, softCompactionThreshold: 0.5, keepRecentMessages: 10,
      routing: { enabled: false }, sessionMemory: { enabled: false },
    },
    gateway: { port: 3000, host: '0.0.0.0', token: '' },
    providers: {} as any,
  } as unknown as GatewayConfig;
}

async function seedSession(db: TestDb, id: string): Promise<AgentContext['session']> {
  await db.run(
    `INSERT INTO sessions (id, tenant_id, channel, model) VALUES (?, 'test-tenant', 'web', ?)`,
    [id, 'anthropic/claude-sonnet-4-20250514'],
  );
  return (await db.get<AgentContext['session']>('SELECT * FROM sessions WHERE id = ?', [id]))!;
}

const TOOL_CALL = (name: string, id: string) => ([{ id, type: 'function', function: { name, arguments: '{}' } }]);

function baseContext(db: TestDb, session: AgentContext['session'], overrides: Partial<AgentContext>): AgentContext {
  return {
    db: db as any, config: makeConfig(), session, tenantId: 'test-tenant',
    model: 'anthropic/claude-sonnet-4-20250514', ephemeral: false, tools: [],
    callLLM: async () => ({ text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse),
    ...overrides,
  };
}

describe('tool-result persistence (#184)', () => {
  it('persists assistant tool_use + tool results, ordered, and reloadable as valid pairs', async () => {
    const db = createTestDb();
    try {
      const session = await seedSession(db, 's1');
      const repo = new MessageRepository(db as any);
      let round = 0;

      const result = await runAgent(
        { text: 'use the tool', channel: 'web', chatId: 'web:s1', chatType: 'private' } as InboundMessage,
        {},
        baseContext(db, session, {
          callLLM: async () => {
            round++;
            if (round === 1) {
              return { text: 'let me check', usage: { inputTokens: 5, outputTokens: 5 }, toolCalls: TOOL_CALL('lookup', 'tc1') } as unknown as ProviderResponse;
            }
            return { text: 'final answer', usage: { inputTokens: 5, outputTokens: 5 } } as unknown as ProviderResponse;
          },
          executeTool: async () => 'LOOKUP_RESULT_PAYLOAD',
        }),
      );

      expect(result.text).toBe('final answer');

      const rows = await repo.listBySession('s1');
      const seq = rows.map(r => r.role);
      // user → assistant(tool_use) → tool result → assistant(final)
      expect(seq).toEqual(['user', 'assistant', 'tool', 'assistant']);

      const toolUse = rows[1];
      expect(toolUse.tool_calls).toBeTruthy();
      expect(JSON.parse(toolUse.tool_calls!)[0].id).toBe('tc1');

      const toolResult = rows[2];
      expect(toolResult.tool_call_id).toBe('tc1');
      expect(toolResult.content).toContain('LOOKUP_RESULT_PAYLOAD');

      // Reloading the persisted rows yields a valid, paired message list (no
      // orphaned tool_use / tool_result) — what the next turn would send.
      const reloaded = normalizeMessages(rows.map(rowToMessage), 'next question');
      const asstWithTools = reloaded.find(m => m.role === 'assistant' && m.tool_calls);
      expect(asstWithTools).toBeTruthy();
      const toolMsgIdx = reloaded.findIndex(m => m.role === 'tool');
      // every tool message is immediately preceded by an assistant with tool_calls
      expect(reloaded[toolMsgIdx - 1].role).toBe('assistant');
      expect(reloaded[toolMsgIdx - 1].tool_calls).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('keeps insertion order for a same-millisecond parallel tool batch (stable id tiebreak)', async () => {
    const db = createTestDb();
    try {
      await seedSession(db, 's2');
      const repo = new MessageRepository(db as any);
      const now = new Date().toISOString();
      // Force identical created_at to simulate a parallel batch within one ms.
      for (const [role, tcid, content] of [
        ['assistant', null, ''],
        ['tool', 'a', 'first'],
        ['tool', 'b', 'second'],
        ['tool', 'c', 'third'],
      ] as Array<[string, string | null, string]>) {
        await db.run(
          `INSERT INTO messages (session_id, tenant_id, role, content, tool_call_id, created_at) VALUES ('s2','test-tenant',?,?,?,?)`,
          [role, content, tcid, now],
        );
      }
      const rows = await repo.listBySession('s2');
      expect(rows.map(r => r.content)).toEqual(['', 'first', 'second', 'third']);
    } finally {
      db.close();
    }
  });
});
