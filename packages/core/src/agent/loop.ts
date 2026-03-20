/**
 * Agent loop — the heart of Kairo.
 *
 * Implements a ReAct-style loop: receive a user message, call the LLM,
 * execute any tool calls, feed results back, and repeat until the LLM
 * produces a final text response or we hit the max-rounds cap.
 */

import crypto from 'node:crypto';
import type {
  InboundMessage,
  AgentCallbacks,
  AgentResult,
  GatewayConfig,
  ChatArgs,
  ProviderResponse,
  ToolDefinition,
  Message,
  MessageContentPart,
  ToolCall,
} from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { SessionRow } from '../db/repositories/session.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { buildSystemPrompt } from './prompt.js';
import { checkAndCompact } from './compaction.js';
import { handleSlashCommand } from './slash-commands.js';
import { MAX_TOOL_RESULT_CHARS, MAX_TOTAL_TOOL_RESULTS } from '../constants.js';
import { getModelCapabilities, estimateCost } from '../models/registry.js';
import { createModuleLogger } from '../observability/logger.js';
import { filterOutput, checkOutputSafety } from '../security/output.js';
import { autoSummarizeToMemory } from './auto-memory.js';

const log = createModuleLogger('llm');

// ─── Types ──────────────────────────────────────────────────

/** Runtime context passed to the agent loop. */
export interface AgentContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
  session: SessionRow;
  tenantId: string;
  userId?: string;
  /** Generic LLM call function — decoupled from specific providers. */
  callLLM: (args: ChatArgs) => Promise<ProviderResponse>;
  /** Tool definitions available for this turn. */
  tools?: ToolDefinition[];
  /** Tool executor function. */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    ctx: { session: SessionRow },
  ) => Promise<unknown>;
  /** Model ID override (defaults to config.model.primary). */
  model?: string;
}

/** Observability callbacks fired around each round. */
export interface AgentRoundCallbacks extends AgentCallbacks {
  onRoundStart?: (round: number, maxRounds: number) => void;
  onRoundEnd?: (round: number, maxRounds: number) => void;
}

// ─── Agent loop ─────────────────────────────────────────────

/**
 * Run the agent loop for an inbound message.
 *
 * @returns AgentResult with the assistant's text, usage, and metadata.
 */
export async function runAgent(
  inbound: InboundMessage,
  callbacks: AgentRoundCallbacks,
  context: AgentContext,
): Promise<AgentResult> {
  const { onDelta, onToolStart, onToolEnd, onRoundStart, onRoundEnd } = callbacks;
  const { db, config, session, tenantId, userId } = context;
  const requestId = `req-${Date.now().toString(36)}`;

  const maxToolRounds = config.agent?.maxToolRounds || 25;
  const model = context.model || config.model.primary;

  // Child logger with request context — auto-propagated to all log calls
  const reqLog = log.child({ requestId, sessionId: session.id, channel: inbound.channel, model });

  const sessionRepo = new SessionRepository(db);
  const messageRepo = new MessageRepository(db);
  const usageRepo = new UsageRepository(db);
  const toolCallRepo = new ToolCallRepository(db);

  // ── Slash commands ──────────────────────────────────────
  const trimmed = inbound.text.trim();
  if (trimmed.startsWith('/')) {
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const slashResult = await handleSlashCommand(cmd!, rest.join(' '), {
      db,
      config,
      session,
      tenantId,
      userId,
      callLLM: context.callLLM,
    });
    if (slashResult) {
      return { text: slashResult.text, slashResult: true };
    }
  }

  // ── Empty message guard ─────────────────────────────────
  if (!trimmed) {
    return { text: null };
  }

  // ── Pre-turn compaction check ───────────────────────────
  try {
    await checkAndCompact(session.id, model, db, config, context.callLLM, tenantId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    reqLog.warn({ err: msg }, 'Compaction check failed');
  }

  // ── Build system prompt ─────────────────────────────────
  const tools = context.tools ?? [];
  const systemPrompt = buildSystemPrompt(config, tools);

  // ── Load conversation history ───────────────────────────
  const historyRows = messageRepo.listBySession(session.id);
  const history: Message[] = historyRows.map(rowToMessage);

  // ── Build the user message content (text or multimodal) ──
  const caps = getModelCapabilities(model, config);
  let userContent: string | MessageContentPart[];
  let userTextForLog = inbound.text;

  if (inbound.images && inbound.images.length > 0) {
    if (caps.supportsVision) {
      // Build multimodal content array
      const parts: MessageContentPart[] = [];
      for (const img of inbound.images) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.data },
        });
      }
      parts.push({ type: 'text', text: inbound.text });
      userContent = parts;
    } else {
      // Model doesn't support vision — append note to text
      userContent = inbound.text +
        '\n\n[Note: Images were sent but the current model does not support vision. Please switch to a vision-capable model like Claude or GPT-4o.]';
      userTextForLog = userContent;
    }
  } else {
    userContent = inbound.text;
  }

  // ── Build messages array (normalize: merge consecutive same-role messages) ──
  const rawMessages: Message[] = [...history, { role: 'user', content: userContent }];
  const messages: Message[] = [];
  for (const msg of rawMessages) {
    const last = messages[messages.length - 1];
    if (last && last.role === msg.role && msg.role === 'user' && typeof last.content === 'string' && typeof msg.content === 'string') {
      // Merge consecutive user messages (only when both are plain text)
      last.content = last.content + '\n' + msg.content;
    } else {
      messages.push({ ...msg });
    }
  }

  // ── Persist inbound user message (track ID so we can delete on error) ──
  // Store text-only content in DB (images are not persisted in message history)
  const persistText = typeof userContent === 'string' ? userContent : inbound.text;
  const userMsgResult = messageRepo.create({
    sessionId: session.id,
    tenantId,
    role: 'user',
    content: persistText,
    metadata: JSON.stringify({
      channel: inbound.channel,
      sender: inbound.senderName,
      ...(inbound.images && inbound.images.length > 0 ? { imageCount: inbound.images.length } : {}),
    }),
  });
  let userMsgPersisted = true;

  // ── ReAct loop ──────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let fullText = '';
  let round = 0;
  let lastResponseHadToolCalls = false;

  while (round < maxToolRounds) {
    round++;
    if (onRoundStart) onRoundStart(round, maxToolRounds);

    // Log detailed request info for debugging
    const contentLen = (c: string | MessageContentPart[]) =>
      typeof c === 'string' ? c.length : JSON.stringify(c).length;
    const msgSummary = messages.map((m) => `${m.role}(${contentLen(m.content)}c)`).join(', ');
    const totalContentSize = messages.reduce((sum, m) => sum + contentLen(m.content), 0);
    reqLog.info({
      round, maxRounds: maxToolRounds,
      messageCount: messages.length, toolCount: tools.length,
      contentKB: +(totalContentSize / 1024).toFixed(1),
    }, 'Agent round started');

    // ── Call LLM ──────────────────────────────────────────
    let response: ProviderResponse;
    const llmStart = Date.now();
    try {
      response = await context.callLLM({
        messages,
        tools: tools.length > 0 ? tools : undefined,
        model,
        systemPrompt,
        onDelta,  // Always stream — providers only call onDelta for text, not tool calls
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reqLog.error({ err: msg, latencyMs: Date.now() - llmStart }, 'LLM call failed');
      // Clean up orphaned user message so it doesn't pollute future conversations
      if (userMsgPersisted && userMsgResult?.id) {
        try {
          db.run('DELETE FROM messages WHERE id = ?', [userMsgResult.id]);
        } catch { /* best effort cleanup */ }
      }
      return { text: `LLM error: ${msg}`, error: true };
    }

    const llmLatencyMs = Date.now() - llmStart;
    const inTok = response.usage?.inputTokens ?? 0;
    const outTok = response.usage?.outputTokens ?? 0;
    totalInputTokens += inTok;
    totalOutputTokens += outTok;

    const toolCount = response.toolCalls?.length ?? 0;
    reqLog.info({
      round, inputTokens: inTok, outputTokens: outTok,
      toolCalls: toolCount, latencyMs: llmLatencyMs,
      stopReason: (response as any).stopReason || (toolCount > 0 ? 'tool_use' : 'end_turn'),
    }, 'LLM call completed');

    // Record per-round usage with cost estimate
    const provider = model.split('/')[0] ?? 'unknown';
    const costUsd = estimateCost(model, inTok, outTok, config)?.total ?? 0;
    usageRepo.record({
      tenantId, userId,
      sessionId: session.id,
      model, provider,
      inputTokens: inTok, outputTokens: outTok,
      costUsd,
    });

    lastResponseHadToolCalls = !!response.toolCalls;

    // If no tool calls, we're done
    if (!response.toolCalls) {
      fullText = response.text || '';
      if (onRoundEnd) onRoundEnd(round, maxToolRounds);
      break;
    }

    // ── Append assistant message with tool calls ──────────
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.text || '',
      tool_calls: response.toolCalls,
    };
    messages.push(assistantMsg);

    // ── Execute each tool call ────────────────────────────
    // Tool result budgets from constants.ts
    let totalToolResultSize = 0;

    for (const tc of response.toolCalls) {
      const toolName = tc.function?.name || 'unknown';
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function?.arguments || '{}') as Record<
          string,
          unknown
        >;
      } catch {
        reqLog.warn({ tool: toolName }, 'Invalid tool arguments JSON');
        toolArgs = {};
      }

      if (typeof toolArgs !== 'object' || toolArgs === null) {
        toolArgs = {};
      }

      // Compact tool log: name + key args on one line
      const argSummary = Object.entries(toolArgs)
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${val}`;
        })
        .join(', ');
      reqLog.info({ tool: toolName, args: argSummary, category: 'tool' }, 'Tool called');

      if (onToolStart) {
        try {
          onToolStart(toolName, toolArgs);
        } catch {
          // ignore callback errors
        }
      }

      const toolStartTime = Date.now();
      let result: unknown;
      let toolStatus = 'success';

      try {
        if (context.executeTool) {
          result = await context.executeTool(toolName, toolArgs, { session });
        } else {
          result = { error: 'No tool executor configured' };
          toolStatus = 'error';
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        reqLog.error({ tool: toolName, err: errMsg, category: 'tool' }, 'Tool execution failed');
        result = { error: `Tool execution failed: ${errMsg}` };
        toolStatus = 'error';
      }

      const durationMs = Date.now() - toolStartTime;

      // Record tool call in the database
      toolCallRepo.record({
        id: tc.id || crypto.randomUUID(),
        sessionId: session.id,
        tenantId,
        userId,
        toolName,
        arguments: toolArgs,
        result,
        status: toolStatus,
        durationMs,
      });

      const resultStr =
        typeof result === 'string' ? result : JSON.stringify(result);
      reqLog.debug({ tool: toolName, resultLen: resultStr.length, durationMs, category: 'tool' }, 'Tool completed');

      if (onToolEnd) {
        try {
          onToolEnd(toolName, resultStr.slice(0, 500));
        } catch {
          // ignore callback errors
        }
      }

      // Cap tool results to prevent context overflow
      const MAX_TOOL_RESULT = MAX_TOOL_RESULT_CHARS;
      let cappedResult = resultStr;
      if (cappedResult.length > MAX_TOOL_RESULT) {
        cappedResult = cappedResult.slice(0, MAX_TOOL_RESULT) +
          `\n\n[... truncated ${resultStr.length - MAX_TOOL_RESULT} chars. Ask the user to narrow the query if more detail is needed.]`;
      }

      // Track total result size this round — check BEFORE accumulating
      if (totalToolResultSize + cappedResult.length > MAX_TOTAL_TOOL_RESULTS) {
        cappedResult = `[Result omitted — total tool output budget (${MAX_TOTAL_TOOL_RESULTS / 1000}KB) exceeded this round. Summarize what you have so far and ask the user if they need more.]`;
      }
      totalToolResultSize += cappedResult.length;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: cappedResult,
      });
    }

    if (onRoundEnd) onRoundEnd(round, maxToolRounds);
  }

  if (round >= maxToolRounds) {
    fullText += '\n\nReached maximum tool call rounds.';
  }

  // ── Handle NO_REPLY ───────────────────────────────────────
  if (fullText.trim() === 'NO_REPLY') {
    fullText = '';
  }

  // ── Output filtering: redact secrets and check safety ─────
  if (fullText) {
    fullText = filterOutput(fullText);
    const safety = checkOutputSafety(fullText);
    if (!safety.safe) {
      reqLog.warn({ flags: safety.flags }, 'Output safety flags detected');
    }
  }

  // ── Persist assistant message ─────────────────────────────
  if (fullText) {
    messageRepo.create({
      sessionId: session.id,
      tenantId,
      role: 'assistant',
      content: fullText,
    });
  }

  // ── Update session usage ──────────────────────────────────
  sessionRepo.addUsage(session.id, totalInputTokens, totalOutputTokens);
  sessionRepo.incrementTurns(session.id);

  // ── Auto-summarize to memory (fire-and-forget, don't block response) ──
  if (totalInputTokens + totalOutputTokens > 0) {
    autoSummarizeToMemory({
      sessionId: session.id,
      channel: inbound.channel,
      db,
      config,
      callLLM: context.callLLM,
      minTurns: 5,
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      reqLog.error({ err: msg, category: 'memory' }, 'Auto-memory summarization failed');
    });
  }

  return {
    text: fullText || null,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}

// ─── Helpers ────────────────────────────────────────────────

/** Convert a MessageRow to the Message format used by providers. */
function rowToMessage(row: {
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
}): Message {
  const msg: Message = {
    role: row.role as Message['role'],
    content: row.content,
  };
  if (row.tool_calls) {
    try {
      msg.tool_calls = JSON.parse(row.tool_calls) as ToolCall[];
    } catch {
      // skip malformed
    }
  }
  if (row.tool_call_id) {
    msg.tool_call_id = row.tool_call_id;
  }
  return msg;
}
