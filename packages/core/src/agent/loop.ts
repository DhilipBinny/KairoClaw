/**
 * Agent loop — the heart of Kairo.
 *
 * Implements a ReAct-style loop: receive a user message, call the LLM,
 * execute any tool calls, feed results back, and repeat until the LLM
 * produces a final text response or we hit the max-rounds cap.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
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
  MediaAttachment,
} from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { SessionRow } from '../db/repositories/session.js';
import { SessionRepository } from '../db/repositories/session.js';
import { MessageRepository } from '../db/repositories/message.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { buildSystemPrompt } from './prompt.js';
import { checkAndCompact, compactSession } from './compaction.js';
import { handleSlashCommand } from './slash-commands.js';
import { MAX_TOOL_RESULT_CHARS, MAX_TOTAL_TOOL_RESULTS, TOOL_LOOP_THRESHOLD } from '../constants.js';
import { SubAgentRegistry } from './subagent-registry.js';
import { SUBAGENT_PENDING_MARKER } from '../tools/builtin/subagent.js';
import { getModelCapabilities, estimateCost } from '../models/registry.js';
import { createModuleLogger } from '../observability/logger.js';
import { filterOutput, checkOutputSafety } from '../security/output.js';
import { sniffBase64Mime } from '../media/store.js';
import { maybeExtractToProfile } from './auto-memory.js';
import {
  type SessionMemoryState,
  createInitialState,
  loadSessionMemoryState,
  saveSessionMemoryState,
  shouldExtractSessionMemory,
  extractSessionMemory,
} from './session-memory.js';
import { routeModel, stripModelOverride } from './router.js';
import { classifyError, logClassifiedError } from '../providers/errors.js';

/** Sessions currently running memory extraction — prevents concurrent extraction races. */
const _activeExtractions = new Set<string>();

const log = createModuleLogger('llm');

// ─── Types ──────────────────────────────────────────────────

/** Runtime context passed to the agent loop. */
export interface AgentContext {
  db: DatabaseAdapter;
  config: GatewayConfig;
  session: SessionRow;
  tenantId: string;
  userId?: string;
  /** User info for permission checks (role + elevated toggle). */
  user?: { id: string; role: string; elevated: boolean };
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
  /** Check if a tool is safe to run concurrently with other tools. */
  isToolConcurrencySafe?: (name: string) => boolean;
  /** Check if a provider prefix (e.g. "anthropic") is configured and available. */
  isProviderAvailable?: (providerPrefix: string) => boolean;
  /** Model ID override (defaults to config.model.primary). */
  model?: string;
  /** Sub-agent nesting depth (0 = top-level). */
  subagentDepth?: number;
  /** Scope key for per-user memory isolation (e.g., "telegram:8606526093"). */
  scopeKey?: string | null;
  /** Ephemeral mode — skip all DB persistence (for sub-agents). */
  ephemeral?: boolean;
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
  const { onDelta, onThinkingDelta, onToolStart, onToolEnd, onMedia, onRoundStart, onRoundEnd } = callbacks;
  const { db, config, session, tenantId, userId } = context;
  const ephemeral = context.ephemeral ?? false;
  const requestId = `req-${crypto.randomUUID().slice(0, 12)}`;

  const maxToolRounds = config.agent?.maxToolRounds || 25;

  // ── Model routing ───────────────────────────────────────
  // Route the message to the best model tier (fast/standard/powerful).
  // context.model overrides routing (used by sub-agents, ephemeral sessions).
  let model: string;
  if (context.model) {
    model = context.model;
  } else if (config.agent?.routing?.enabled) {
    const routingResult = await routeModel(inbound, context.callLLM, config, context.isProviderAvailable);
    model = routingResult.model;
    log.info({ tier: routingResult.tier, reason: routingResult.reason, stage: routingResult.stage, model: routingResult.model, category: 'routing' }, 'Model routed');
    // Strip @model prefix from message text so the LLM doesn't see it
    if (routingResult.stage === 'rule' && routingResult.reason.startsWith('user override')) {
      inbound = { ...inbound, text: stripModelOverride(inbound.text) };
    }
  } else {
    model = config.model.primary;
  }

  // Child logger with request context — auto-propagated to all log calls
  const reqLog = log.child({ requestId, sessionId: session.id, channel: inbound.channel, model, ephemeral });

  const sessionRepo = !ephemeral ? new SessionRepository(db) : null;
  const messageRepo = !ephemeral ? new MessageRepository(db) : null;
  const usageRepo = !ephemeral ? new UsageRepository(db) : null;
  const toolCallRepo = !ephemeral ? new ToolCallRepository(db) : null;

  // ── Slash commands (skip for ephemeral/sub-agent sessions) ──
  const trimmed = inbound.text.trim();
  if (!ephemeral && trimmed.startsWith('/')) {
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

  // ── Initialize session memory state ─────────────────────
  let sessionMemoryState: SessionMemoryState | null = null;
  if (!ephemeral && config.agent?.sessionMemory?.enabled !== false) {
    sessionMemoryState = loadSessionMemoryState(session) ?? createInitialState();
  }

  // ── Pre-turn compaction check (skip for ephemeral) ──────
  if (!ephemeral) {
    try {
      await checkAndCompact(session.id, model, db, config, context.callLLM, tenantId, context.scopeKey);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      reqLog.warn({ err: msg }, 'Compaction check failed');
    }
  }

  // ── Load conversation history (empty for ephemeral) ─────
  const historyRows = messageRepo ? await messageRepo.listBySession(session.id) : [];

  // ── Build system prompt ─────────────────────────────────
  // Skip session memory injection when a [Context Summary] compaction message exists —
  // the summary already contains session memory content; injecting both wastes tokens.
  const hasContextSummary = historyRows.some(
    r => r.role === 'system' && typeof r.content === 'string' && r.content.startsWith('[Context Summary]'),
  );
  const tools = context.tools ?? [];
  const systemPrompt = buildSystemPrompt(config, tools, context.scopeKey, inbound.channel, session.id, hasContextSummary);
  const history: Message[] = historyRows.map(rowToMessage);

  // ── Build the user message content (text or multimodal) ──
  const caps = getModelCapabilities(model, config);
  let userContent: string | MessageContentPart[];
  if (inbound.images && inbound.images.length > 0) {
    if (caps.supportsVision) {
      // Build multimodal content array
      const parts: MessageContentPart[] = [];
      for (const img of inbound.images) {
        // Sniff actual MIME from base64 magic bytes — channels may report wrong type
        const sniffed = sniffBase64Mime(img.data);
        const mimeType = sniffed?.mime || img.mimeType;

        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: img.data },
        });
      }
      parts.push({ type: 'text', text: inbound.text });
      userContent = parts;
    } else {
      // Model doesn't support vision — append note to text
      userContent = inbound.text +
        '\n\n[Note: Images were sent but the current model does not support vision. Please switch to a vision-capable model like Claude or GPT-4o.]';
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

  // ── Persist inbound user message (skip for ephemeral) ──
  const persistText = typeof userContent === 'string' ? userContent : inbound.text;
  const userMsgResult = messageRepo ? await messageRepo.create({
    sessionId: session.id,
    tenantId,
    role: 'user',
    content: persistText,
    metadata: JSON.stringify({
      channel: inbound.channel,
      sender: inbound.senderName,
      ...(inbound.images && inbound.images.length > 0 ? { imageCount: inbound.images.length } : {}),
    }),
  }) : null;
  // ── Build thinking config if enabled + model supports it ──
  const thinkingCfg = config.agent?.thinking;
  const thinkingConfig = (thinkingCfg?.enabled && caps.supportsThinking)
    ? { enabled: true as const, mode: thinkingCfg.mode || ('adaptive' as const), budgetTokens: thinkingCfg.budgetTokens }
    : undefined;

  // ── ReAct loop ──────────────────────────────────────────
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let fullText = '';
  let finalThinkingText: string | null = null;
  const collectedMedia: MediaAttachment[] = [];
  const toolCallCounts = new Map<string, number>();
  const subagentRegistry = new SubAgentRegistry();
  const MAX_REACTIVE_COMPACT_FAILURES = 3; // circuit breaker: stop after 3 consecutive compact attempts
  let reactiveCompactFailures = 0;
  let round = 0;
  while (round < maxToolRounds) {
    round++;
    if (onRoundStart) onRoundStart(round, maxToolRounds);

    // Log detailed request info for debugging
    const contentLen = (c: string | MessageContentPart[]) =>
      typeof c === 'string' ? c.length : JSON.stringify(c).length;
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
        onDelta,
        onThinkingDelta,
        thinkingConfig,
      });
    } catch (e: unknown) {
      // ── Classify the error and determine recovery action ──
      const classified = classifyError(e);
      logClassifiedError(classified, { round, requestId, sessionId: session.id });

      // ── prompt_too_long → reactive compact recovery ──
      if (classified.type === 'prompt_too_long' && !ephemeral && reactiveCompactFailures < MAX_REACTIVE_COMPACT_FAILURES) {
        reactiveCompactFailures++;
        reqLog.warn({ round, attempt: reactiveCompactFailures, errorType: classified.type }, 'Context overflow — starting reactive compact recovery');

        // Stage 1: Strip images from messages (cheapest — no LLM call)
        let strippedImages = false;
        for (const m of messages) {
          if (Array.isArray(m.content)) {
            const textParts = (m.content as MessageContentPart[]).filter(p => p.type !== 'image');
            if (textParts.length < (m.content as MessageContentPart[]).length) {
              m.content = textParts.length === 1 && textParts[0].type === 'text'
                ? textParts[0].text
                : textParts.length > 0 ? textParts as any : '[images removed to reduce context]';
              strippedImages = true;
            }
          }
        }
        if (strippedImages) reqLog.info('Stage 1: Stripped images from messages');

        // Stage 2: Force hard compaction (LLM summarization)
        if (messageRepo) {
          try {
            reqLog.info('Stage 2: Forcing hard compaction');
            await compactSession(session.id, tenantId, model, db, config, context.callLLM);
            const freshRows = await messageRepo.listBySession(session.id);
            messages.splice(0, messages.length, ...freshRows.map(rowToMessage), { role: 'user', content: userContent });
          } catch (compactErr: unknown) {
            reqLog.warn({ err: compactErr instanceof Error ? compactErr.message : String(compactErr) }, 'Stage 2 compaction failed');
          }
        }

        // Stage 3: Retry the LLM call
        try {
          response = await context.callLLM({
            messages, tools: tools.length > 0 ? tools : undefined,
            model, systemPrompt, onDelta, onThinkingDelta, thinkingConfig,
          });
          reqLog.info({ round, attempt: reactiveCompactFailures }, 'LLM call succeeded after reactive compact');
          reactiveCompactFailures = 0;
        } catch (retryErr: unknown) {
          const retryClassified = classifyError(retryErr);
          if (retryClassified.type === 'prompt_too_long' && reactiveCompactFailures < MAX_REACTIVE_COMPACT_FAILURES) {
            reqLog.warn({ attempt: reactiveCompactFailures }, 'Still overflowing after compact — will retry');
            continue;
          }
          reqLog.error({ attempt: reactiveCompactFailures, errorType: retryClassified.type }, 'LLM call failed after reactive compact — giving up');
          if (userMsgResult?.id) {
            try { messageRepo?.deleteById(userMsgResult.id); } catch { /* best effort */ }
          }
          return { text: retryClassified.userMessage || 'Your conversation is too long even after compaction. Please start a new session with /new.', error: true };
        }

      // ── auth_error → clear message, don't retry ──
      } else if (classified.type === 'auth_error') {
        if (userMsgResult?.id) {
          try { messageRepo?.deleteById(userMsgResult.id); } catch { /* best effort */ }
        }
        return { text: classified.userMessage || 'Authentication failed. Please check your API key configuration.', error: true };

      // ── All other errors → generic failure ──
      } else {
        reqLog.error({ latencyMs: Date.now() - llmStart, errorType: classified.type, action: classified.action }, 'LLM call failed');
        if (userMsgResult?.id) {
          try { messageRepo?.deleteById(userMsgResult.id); } catch { /* best effort */ }
        }
        if (classified.type === 'prompt_too_long') {
          return { text: 'Your conversation is too long even after multiple compaction attempts. Please start a new session with /new.', error: true };
        }
        return { text: classified.userMessage || 'Something went wrong processing your request. Please try again.', error: true };
      }
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
      stopReason: ('stopReason' in response ? (response as Record<string, unknown>).stopReason : undefined) || (toolCount > 0 ? 'tool_use' : 'end_turn'),
    }, 'LLM call completed');

    // Log LLM response preview
    if (response.text) {
      reqLog.info({
        round,
        responsePreview: response.text.slice(0, 300),
        responseLen: response.text.length,
        category: 'llm',
      }, 'LLM response text');
    }

    // Record per-round usage with cost estimate (skip for ephemeral)
    const provider = model.split('/')[0] ?? 'unknown';
    const costUsd = estimateCost(model, inTok, outTok, config)?.total ?? 0;
    if (costUsd > 0) {
      reqLog.info({ round, costUsd: +costUsd.toFixed(6), category: 'llm' }, 'Round cost');
    }
    if (usageRepo) {
      try {
        await usageRepo.record({
          tenantId, userId,
          sessionId: session.id,
          model, provider,
          inputTokens: inTok, outputTokens: outTok,
          costUsd,
        });
      } catch (e: unknown) {
        reqLog.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to record usage (non-critical)');
      }
    }

    // If no tool calls, we're done
    if (!response.toolCalls) {
      fullText = response.text || '';
      finalThinkingText = response.thinkingText || null;
      if (finalThinkingText) {
        reqLog.info({ thinkingLen: finalThinkingText.length }, 'Thinking complete');
        reqLog.debug({ thinking: finalThinkingText.slice(0, 2000) }, 'Thinking content');
      }
      if (onRoundEnd) onRoundEnd(round, maxToolRounds);
      break;
    }

    // ── Append assistant message with tool calls ──────────
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.text || '',
      tool_calls: response.toolCalls,
      thinking_blocks: response.thinkingBlocks,
    };
    messages.push(assistantMsg);

    // ── Execute tool calls (parallel for safe tools, sequential for others) ──
    // Tool result budgets from constants.ts
    let totalToolResultSize = 0;

    // Pre-parse all tool calls and run pre-execution checks
    interface ParsedToolCall {
      tc: ToolCall;
      toolName: string;
      toolArgs: Record<string, unknown>;
      skipped?: string; // reason if skipped (loop detection)
    }
    const parsed: ParsedToolCall[] = [];
    for (const tc of response.toolCalls) {
      const toolName = tc.function?.name || 'unknown';
      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
      } catch {
        reqLog.warn({ tool: toolName }, 'Invalid tool arguments JSON');
        toolArgs = {};
      }
      if (typeof toolArgs !== 'object' || toolArgs === null) {
        toolArgs = {};
      }

      // Compact tool log
      const argSummary = Object.entries(toolArgs)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ');
      reqLog.info({ tool: toolName, args: argSummary, category: 'tool' }, 'Tool called');

      // Tool loop detection
      const toolHash = `${toolName}:${JSON.stringify(toolArgs).slice(0, 100)}`;
      const callCount = (toolCallCounts.get(toolHash) ?? 0) + 1;
      toolCallCounts.set(toolHash, callCount);
      if (callCount > TOOL_LOOP_THRESHOLD) {
        reqLog.warn({ tool: toolName, callCount, threshold: TOOL_LOOP_THRESHOLD }, 'Tool loop detected — skipping execution');
        parsed.push({ tc, toolName, toolArgs, skipped: `[Tool loop detected: "${toolName}" called ${callCount} times with similar arguments. Try a different approach or tool.]` });
      } else {
        parsed.push({ tc, toolName, toolArgs });
      }
    }

    // Execute a single tool call and return the result message
    const executeSingleTool = async (p: ParsedToolCall): Promise<{ toolCallId: string; content: string }> => {
      if (p.skipped) {
        return { toolCallId: p.tc.id, content: p.skipped };
      }

      if (onToolStart) {
        try { onToolStart(p.toolName, p.toolArgs); } catch { /* ignore */ }
      }

      const toolStartTime = Date.now();
      let result: unknown;
      let toolStatus = 'success';

      try {
        if (context.executeTool) {
          result = await context.executeTool(p.toolName, p.toolArgs, { session, subagentRegistry, user: context.user, scopeKey: context.scopeKey } as any);
        } else {
          result = { error: 'No tool executor configured' };
          toolStatus = 'error';
        }
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        reqLog.error({ tool: p.toolName, err: errMsg, category: 'tool' }, 'Tool execution failed');
        result = { error: `Tool execution failed: ${errMsg}` };
        toolStatus = 'error';
      }

      const durationMs = Date.now() - toolStartTime;

      // Record tool call in the database (skip for ephemeral, non-critical)
      if (toolCallRepo) {
        try {
          await toolCallRepo.record({
            id: p.tc.id || crypto.randomUUID(),
            sessionId: session.id,
            tenantId,
            userId,
            toolName: p.toolName,
            arguments: p.toolArgs,
            result,
            status: toolStatus,
            durationMs,
          });
        } catch (e: unknown) {
          reqLog.warn({ err: e instanceof Error ? e.message : String(e), tool: p.toolName }, 'Failed to record tool call (non-critical)');
        }
      }

      // Collect _media attachments from tool results
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const resultObj = result as Record<string, unknown>;
        const mediaArr = resultObj._media;
        if (Array.isArray(mediaArr)) {
          for (const item of mediaArr) {
            if (!item || typeof item !== 'object') continue;
            const m = item as Record<string, unknown>;
            if (
              typeof m.filePath === 'string' &&
              typeof m.fileName === 'string' &&
              typeof m.mimeType === 'string' &&
              typeof m.type === 'string' &&
              fs.existsSync(m.filePath)
            ) {
              const attachment = item as MediaAttachment;
              collectedMedia.push(attachment);
              if (onMedia) {
                try { onMedia(attachment); } catch { /* ignore callback errors */ }
              }
            }
          }
          delete resultObj._media;
        }
      }

      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      reqLog.info({
        tool: p.toolName,
        resultPreview: resultStr.slice(0, 200),
        resultLen: resultStr.length,
        durationMs,
        category: 'tool',
      }, 'Tool completed');

      if (onToolEnd) {
        try { onToolEnd(p.toolName, resultStr.slice(0, 500)); } catch { /* ignore */ }
      }

      // Cap tool results to prevent context overflow
      let cappedResult = resultStr;
      if (cappedResult.length > MAX_TOOL_RESULT_CHARS) {
        cappedResult = cappedResult.slice(0, MAX_TOOL_RESULT_CHARS) +
          `\n\n[... truncated ${resultStr.length - MAX_TOOL_RESULT_CHARS} chars. Ask the user to narrow the query if more detail is needed.]`;
      }

      return { toolCallId: p.tc.id, content: cappedResult };
    };

    // Split into concurrent-safe and sequential tools, preserving order.
    // Strategy: batch consecutive concurrent-safe tools, execute sequentially otherwise.
    const isSafe = (name: string) => context.isToolConcurrencySafe?.(name) ?? false;
    let i = 0;
    while (i < parsed.length) {
      if (!parsed[i].skipped && isSafe(parsed[i].toolName)) {
        // Collect consecutive concurrent-safe tools into a batch
        const batch: ParsedToolCall[] = [];
        while (i < parsed.length && (parsed[i].skipped || isSafe(parsed[i].toolName))) {
          batch.push(parsed[i]);
          i++;
        }
        if (batch.length > 1) {
          reqLog.info({ tools: batch.map(b => b.toolName), count: batch.length, category: 'tool' }, 'Executing tools in parallel');
        }
        // Execute batch concurrently
        const results = await Promise.all(batch.map(executeSingleTool));
        for (const r of results) {
          // Apply total budget check
          if (totalToolResultSize + r.content.length > MAX_TOTAL_TOOL_RESULTS) {
            r.content = `[Result omitted — total tool output budget (${MAX_TOTAL_TOOL_RESULTS / 1000}KB) exceeded this round. Summarize what you have so far and ask the user if they need more.]`;
          }
          totalToolResultSize += r.content.length;
          messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        }
      } else {
        // Execute sequentially
        const r = await executeSingleTool(parsed[i]);
        if (totalToolResultSize + r.content.length > MAX_TOTAL_TOOL_RESULTS) {
          r.content = `[Result omitted — total tool output budget (${MAX_TOTAL_TOOL_RESULTS / 1000}KB) exceeded this round. Summarize what you have so far and ask the user if they need more.]`;
        }
        totalToolResultSize += r.content.length;
        messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        i++;
      }
    }

    // ── Wait for pending sub-agents and inject results ──────
    if (subagentRegistry.hasPending()) {
      reqLog.info({ pending: subagentRegistry.size }, 'Waiting for sub-agents to complete');
      await subagentRegistry.waitForAll();

      // Build lightweight result summaries and inject as tool results
      // We need to match childId → toolCallId from the spawn_agent calls
      const summaries = subagentRegistry.buildResultSummaries();
      for (const summary of summaries) {
        // Find the tool message that spawned this child (by matching childId in content)
        const spawnMsg = messages.find(
          m => m.role === 'tool' && typeof m.content === 'string' &&
               m.content.includes(summary.childId) && m.content.includes(SUBAGENT_PENDING_MARKER),
        );
        if (spawnMsg) {
          // Replace the pending placeholder with the actual result
          spawnMsg.content = JSON.stringify(summary.result);
        }
      }
      reqLog.info({ completed: summaries.length }, 'Sub-agent results injected');
    }

    if (onRoundEnd) onRoundEnd(round, maxToolRounds);
  }

  // Drain all sub-agent promises (including killed ones) to prevent floating promises
  if (subagentRegistry.size > 0) {
    await subagentRegistry.drainAll();
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

  // ── Agent turn summary ──────────────────────────────────
  reqLog.info({
    totalRounds: round,
    totalInputTokens,
    totalOutputTokens,
    responseLen: fullText.length,
    responsePreview: fullText.slice(0, 200),
    mediaCount: collectedMedia.length,
    category: 'llm',
  }, 'Agent turn completed');

  // ── Persist assistant message (skip for ephemeral) ───────
  if ((fullText || collectedMedia.length > 0) && messageRepo) {
    const msgMetadata: Record<string, unknown> = {};
    if (collectedMedia.length > 0) {
      msgMetadata.media = collectedMedia.map(m => ({
        type: m.type,
        fileName: m.fileName,
        mimeType: m.mimeType,
      }));
    }
    await messageRepo.create({
      sessionId: session.id,
      tenantId,
      role: 'assistant',
      content: fullText || '',
      metadata: Object.keys(msgMetadata).length > 0 ? JSON.stringify(msgMetadata) : undefined,
    });
  }

  // ── Update session usage (skip for ephemeral) ─────────────
  if (sessionRepo) {
    await sessionRepo.addUsage(session.id, totalInputTokens, totalOutputTokens);
    await sessionRepo.incrementTurns(session.id);
  }

  // ── Session memory extraction (fire-and-forget) ──────────────
  // When extraction threshold is met:
  //   1. Extract session memory (Haiku updates structured notes file)
  //   2. Then extract long-term facts to profile (Haiku reads session notes → daily file)
  // Profile extraction only runs when session memory was just updated —
  // no point re-reading the same file every turn.
  if (!ephemeral && sessionMemoryState && totalInputTokens + totalOutputTokens > 0) {
    const currentTokens = totalInputTokens;
    const check = shouldExtractSessionMemory(currentTokens, sessionMemoryState, config);
    if (check.shouldExtract) {
      // Skip if extraction is already in progress for this session (prevents race on rapid messages)
      if (_activeExtractions.has(session.id)) {
        reqLog.debug({ category: 'memory' }, 'Session memory extraction already in progress — skipping');
      } else {
        reqLog.info({ reason: check.reason, category: 'memory' }, 'Session memory extraction triggered');
        _activeExtractions.add(session.id);
        extractSessionMemory({
          sessionId: session.id,
          scopeKey: context.scopeKey ?? null,
          db,
          config,
          state: sessionMemoryState,
          currentTokens,
          callLLM: context.callLLM,
        }).then((newState) => {
          sessionMemoryState = newState;
          // Persist updated state to session metadata
          if (sessionRepo) {
            saveSessionMemoryState(session.id, newState, sessionRepo).catch((e) => {
              reqLog.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to persist session memory state');
            });
          }
          // Session memory just updated → extract long-term facts to profile
          return maybeExtractToProfile({
            sessionId: session.id,
            channel: inbound.channel,
            scopeKey: context.scopeKey,
            db,
            config,
            callLLM: context.callLLM,
            minTurns: 5,
          });
        }).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          reqLog.warn({ err: msg, category: 'memory' }, 'Session memory extraction or profile extraction failed');
        }).finally(() => {
          _activeExtractions.delete(session.id);
        });
      }
    } else {
      // Persist state even if no extraction (in case state was just initialized)
      if (sessionMemoryState.extractionCount === 0 && sessionRepo) {
        saveSessionMemoryState(session.id, sessionMemoryState, sessionRepo).catch(() => {});
      }
    }
  }

  return {
    text: fullText || null,
    thinkingText: finalThinkingText,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    ...(collectedMedia.length > 0 ? { media: collectedMedia } : {}),
    model,
    userRole: context.user?.role,
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
