/**
 * Agent loop — the heart of Kairo.
 *
 * Implements a ReAct-style loop: receive a user message, call the LLM,
 * execute any tool calls, feed results back, and repeat until the LLM
 * produces a final text response or we hit the max-rounds cap.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import {
  buildSystemPrompt,
  buildUserContent,
  normalizeMessages,
  renderToolResultForLLM,
  sanitizeMessagesForLog,
  rowToMessage,
} from '@agw/agent-core';
import { checkAndCompact, compactSession } from './compaction.js';
import { handleSlashCommand } from './slash-commands.js';
import { MAX_TOOL_RESULT_CHARS, MAX_TOTAL_TOOL_RESULTS, TOOL_LOOP_THRESHOLD } from '../constants.js';
import { SubAgentRegistry } from './subagent-registry.js';
import { SUBAGENT_PENDING_MARKER } from '../tools/builtin/subagent.js';
import { getModelCapabilities, estimateCost } from '@agw/provider-bridge';
import { createModuleLogger } from '../observability/logger.js';
import { filterOutput, checkOutputSafety } from '@agw/security';
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
import { classifyError, logClassifiedError } from '@agw/provider-bridge';

/** Sessions currently running memory extraction — prevents concurrent extraction races. */
const _activeExtractions = new Set<string>();

// Re-export from @agw/agent-core for backward compatibility
export { sanitizeMessagesForLog, renderToolResultForLLM } from '@agw/agent-core';

/** Append one LLM round entry to the daily JSONL debug log. */
export function appendDebugLog(workspace: string, entry: Record<string, unknown>): void {
  try {
    const dir = path.resolve(workspace, 'debug', 'llm-requests');
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const file = path.join(dir, `${date}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Non-critical — never crash the agent loop for a debug write failure
  }
}

const log = createModuleLogger('llm');

/** Approximate character-length of a message content field. */
function contentLen(c: string | MessageContentPart[]): number {
  return typeof c === 'string' ? c.length : JSON.stringify(c).length;
}


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
  /**
   * Phase 8: optional callback to re-fetch the session's current tool
   * surface. When deferred tool loading is enabled, `tool_search` can
   * add more tools to the session's loaded set mid-turn; the agent
   * loop calls this at the start of each LLM round so newly loaded
   * tools are visible on the next provider call.
   *
   * When omitted (deferred loading disabled or ephemeral sub-agent),
   * the loop uses the initial `tools` list for all rounds.
   */
  refreshTools?: () => Promise<ToolDefinition[]>;
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
  /**
   * Cancellation signal. Checked between rounds and tool calls, and passed to
   * the provider so the in-flight LLM request aborts. When it fires the loop
   * stops promptly and returns the partial result with `aborted: true`.
   */
  signal?: AbortSignal;
}

/** Observability callbacks fired around each round. */
export interface AgentRoundCallbacks extends AgentCallbacks {
  onRoundStart?: (round: number, maxRounds: number) => void;
  onRoundEnd?: (round: number, maxRounds: number) => void;
}

// ─── Shared mutable state for a single agent turn ───────────

interface ParsedToolCall {
  tc: ToolCall;
  toolName: string;
  toolArgs: Record<string, unknown>;
  skipped?: string;
}

interface RunState {
  inbound: InboundMessage;
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  systemPrompt: import('@agw/types').StructuredSystemPrompt;
  caps: ReturnType<typeof getModelCapabilities>;
  totalInputTokens: number;
  totalOutputTokens: number;
  fullText: string;
  finalThinkingText: string | null;
  collectedMedia: MediaAttachment[];
  toolCallCounts: Map<string, number>;
  subagentRegistry: SubAgentRegistry;
  sessionMemoryState: SessionMemoryState | null;
  userMsgResult: { id: number } | null;
  totalContentSize: number;
  reactiveCompactFailures: number;
  round: number;
  aborted: boolean;
  hasContextSummary: boolean;
  userContent: string | MessageContentPart[];
  thinkingConfig?: { enabled: true; mode: string; budgetTokens?: number };
  sdkToolExecutor?: (name: string, args: Record<string, unknown>) => Promise<string>;
  reqLog: typeof log;
  sessionRepo: InstanceType<typeof SessionRepository> | null;
  messageRepo: InstanceType<typeof MessageRepository> | null;
  usageRepo: InstanceType<typeof UsageRepository> | null;
  toolCallRepo: InstanceType<typeof ToolCallRepository> | null;
}

// ─── Stage: Model routing ────────────────────────────────────

async function resolveModel(
  inbound: InboundMessage,
  context: AgentContext,
): Promise<{ model: string; inbound: InboundMessage }> {
  if (context.model) return { model: context.model, inbound };
  if (context.config.agent?.routing?.enabled) {
    const result = await routeModel(inbound, context.callLLM, context.config, context.isProviderAvailable);
    log.info({ tier: result.tier, reason: result.reason, stage: result.stage, model: result.model, category: 'routing' }, 'Model routed');
    if (result.stage === 'rule' && result.reason.startsWith('user override')) {
      return { model: result.model, inbound: { ...inbound, text: stripModelOverride(inbound.text) } };
    }
    return { model: result.model, inbound };
  }
  return { model: context.config.model.primary, inbound };
}

// ─── Stage: SessionStart hooks ───────────────────────────────

async function runSessionStartHooksStage(
  inbound: InboundMessage,
  historyRows: unknown[],
  config: GatewayConfig,
  session: { id: string },
  scopeKey: string | null,
  ephemeral: boolean,
  reqLog: RunState['reqLog'],
): Promise<InboundMessage> {
  if (ephemeral || historyRows.length > 0) return inbound;
  const hooks = (config as unknown as { hooks?: import('@agw/tool-platform').HooksConfig }).hooks;
  const ssHooks = hooks?.SessionStart;
  if (!ssHooks || ssHooks.length === 0) return inbound;
  try {
    const { runSessionStartHooks } = await import('@agw/tool-platform');
    const outputs = await runSessionStartHooks(ssHooks, session.id, scopeKey);
    if (outputs.length > 0) {
      const prefix = outputs.map((o) => `[hook output]\n${o}`).join('\n\n');
      reqLog.info({ hookCount: ssHooks.length, outputCount: outputs.length }, 'SessionStart hooks injected');
      return { ...inbound, text: `${prefix}\n\n---\n\n${inbound.text}` };
    }
  } catch (e: unknown) {
    reqLog.warn({ err: (e as Error).message }, 'SessionStart hook runner crashed');
  }
  return inbound;
}


// ─── Stage: Save images to disk ──────────────────────────────

async function saveImagesToDisk(
  inbound: InboundMessage,
  config: GatewayConfig,
  userIdStr: string,
): Promise<string[]> {
  if (!inbound.images || inbound.images.length === 0) return [];
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const safeUserId = userIdStr.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const mediaDir = pathMod.default.join(config.agent.workspace, 'scopes', safeUserId, 'media');
  fsMod.default.mkdirSync(mediaDir, { recursive: true });
  const paths: string[] = [];
  for (const img of inbound.images) {
    const ext = img.mimeType?.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    try {
      fsMod.default.writeFileSync(pathMod.default.join(mediaDir, filename), Buffer.from(img.data, 'base64'));
      paths.push(filename);
    } catch { /* non-fatal */ }
  }
  return paths;
}

// ─── Stage: Execute a single tool call ───────────────────────

async function executeSingleTool(
  p: ParsedToolCall,
  s: RunState,
  context: AgentContext,
  callbacks: AgentRoundCallbacks,
): Promise<{ toolCallId: string; content: string }> {
  if (p.skipped) return { toolCallId: p.tc.id, content: p.skipped };

  if (callbacks.onToolStart) {
    try { callbacks.onToolStart(p.toolName, p.toolArgs); } catch { /* ignore */ }
  }

  const toolStartTime = Date.now();
  let result: unknown;
  let toolStatus = 'success';

  try {
    if (context.executeTool) {
      result = await context.executeTool(p.toolName, p.toolArgs, {
        session: context.session, subagentRegistry: s.subagentRegistry,
        user: context.user, scopeKey: context.scopeKey,
      } as any);
    } else {
      result = { error: 'No tool executor configured' };
      toolStatus = 'error';
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    s.reqLog.error({ tool: p.toolName, err: errMsg, category: 'tool' }, 'Tool execution failed');
    result = { error: `Tool execution failed: ${errMsg}` };
    toolStatus = 'error';
  }

  const durationMs = Date.now() - toolStartTime;

  if (s.toolCallRepo) {
    try {
      await s.toolCallRepo.record({
        id: p.tc.id || crypto.randomUUID(),
        sessionId: context.session.id, tenantId: context.tenantId,
        userId: context.userId, toolName: p.toolName,
        arguments: p.toolArgs,
        result: typeof result === 'string' ? filterOutput(result) : result,
        status: toolStatus, durationMs,
      });
    } catch (e: unknown) {
      s.reqLog.warn({ err: e instanceof Error ? e.message : String(e), tool: p.toolName }, 'Failed to record tool call (non-critical)');
    }
  }

  // Collect _media attachments
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    const mediaArr = resultObj._media;
    if (Array.isArray(mediaArr)) {
      for (const item of mediaArr) {
        if (!item || typeof item !== 'object') continue;
        const m = item as Record<string, unknown>;
        if (typeof m.filePath === 'string' && typeof m.fileName === 'string' &&
            typeof m.mimeType === 'string' && typeof m.type === 'string' && fs.existsSync(m.filePath)) {
          const stateDir = context.config._stateDir || process.env.AGW_STATE_DIR || '';
          const resolvedMedia = path.resolve(m.filePath);
          if (stateDir && !resolvedMedia.startsWith(path.resolve(stateDir))) continue;
          const attachment = item as MediaAttachment;
          s.collectedMedia.push(attachment);
          if (callbacks.onMedia) {
            try { callbacks.onMedia(attachment); } catch { /* ignore */ }
          }
        }
      }
      delete resultObj._media;
    }
  }

  const resultStr = renderToolResultForLLM(result);
  const safePreview = filterOutput(resultStr.slice(0, 500));
  s.reqLog.info({ tool: p.toolName, resultPreview: safePreview.slice(0, 200), resultLen: resultStr.length, durationMs, category: 'tool' }, 'Tool completed');

  if (callbacks.onToolEnd) {
    try { callbacks.onToolEnd(p.toolName, safePreview); } catch { /* ignore */ }
  }

  let cappedResult = resultStr;
  if (cappedResult.length > MAX_TOOL_RESULT_CHARS) {
    cappedResult = cappedResult.slice(0, MAX_TOOL_RESULT_CHARS) +
      `\n\n[... truncated ${resultStr.length - MAX_TOOL_RESULT_CHARS} chars. Ask the user to narrow the query if more detail is needed.]`;
  }

  return { toolCallId: p.tc.id, content: `<tool_result name="${p.toolName}">\n${cappedResult}\n</tool_result>` };
}

// ─── Stage: Execute all tool calls with concurrency strategy ─

async function executeToolCalls(
  toolCalls: ToolCall[],
  s: RunState,
  context: AgentContext,
  callbacks: AgentRoundCallbacks,
): Promise<void> {
  let totalToolResultSize = 0;

  const parsed: ParsedToolCall[] = [];
  for (const tc of toolCalls) {
    const toolName = tc.function?.name || 'unknown';
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(tc.function?.arguments || '{}') as Record<string, unknown>;
    } catch {
      s.reqLog.warn({ tool: toolName }, 'Invalid tool arguments JSON');
      toolArgs = {};
    }
    if (typeof toolArgs !== 'object' || toolArgs === null) toolArgs = {};

    const argSummary = Object.entries(toolArgs).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
    s.reqLog.info({ tool: toolName, category: 'tool' }, 'Tool called');
    s.reqLog.debug({ tool: toolName, args: argSummary, category: 'tool' }, 'Tool args');

    const toolHash = `${toolName}:${JSON.stringify(toolArgs).slice(0, 100)}`;
    const callCount = (s.toolCallCounts.get(toolHash) ?? 0) + 1;
    s.toolCallCounts.set(toolHash, callCount);
    if (callCount > TOOL_LOOP_THRESHOLD) {
      s.reqLog.warn({ tool: toolName, callCount, threshold: TOOL_LOOP_THRESHOLD }, 'Tool loop detected — skipping execution');
      parsed.push({ tc, toolName, toolArgs, skipped: `[Tool loop detected: "${toolName}" called ${callCount} times with similar arguments. Try a different approach or tool.]` });
    } else {
      parsed.push({ tc, toolName, toolArgs });
    }
  }

  const isSafe = (name: string) => context.isToolConcurrencySafe?.(name) ?? false;
  let i = 0;
  while (i < parsed.length) {
    // Stop launching further tool calls once cancellation is requested. Tools
    // already in flight finish; the loop won't start another round.
    if (context.signal?.aborted) { s.aborted = true; break; }
    if (!parsed[i].skipped && isSafe(parsed[i].toolName)) {
      const batch: ParsedToolCall[] = [];
      while (i < parsed.length && (parsed[i].skipped || isSafe(parsed[i].toolName))) {
        batch.push(parsed[i]);
        i++;
      }
      if (batch.length > 1) {
        s.reqLog.info({ tools: batch.map(b => b.toolName), count: batch.length, category: 'tool' }, 'Executing tools in parallel');
      }
      const results = await Promise.all(batch.map(p => executeSingleTool(p, s, context, callbacks)));
      for (const r of results) {
        if (totalToolResultSize + r.content.length > MAX_TOTAL_TOOL_RESULTS) {
          r.content = `[Result omitted — total tool output budget (${MAX_TOTAL_TOOL_RESULTS / 1000}KB) exceeded this round. Summarize what you have so far and ask the user if they need more.]`;
        }
        totalToolResultSize += r.content.length;
        const msg: Message = { role: 'tool', tool_call_id: r.toolCallId, content: r.content };
        s.messages.push(msg);
        s.totalContentSize += contentLen(msg.content);
      }
    } else {
      const r = await executeSingleTool(parsed[i], s, context, callbacks);
      if (totalToolResultSize + r.content.length > MAX_TOTAL_TOOL_RESULTS) {
        r.content = `[Result omitted — total tool output budget (${MAX_TOTAL_TOOL_RESULTS / 1000}KB) exceeded this round. Summarize what you have so far and ask the user if they need more.]`;
      }
      totalToolResultSize += r.content.length;
      const msg: Message = { role: 'tool', tool_call_id: r.toolCallId, content: r.content };
      s.messages.push(msg);
      s.totalContentSize += contentLen(msg.content);
      i++;
    }
  }
}

// ─── Stage: Wait for sub-agents ──────────────────────────────

async function drainSubAgents(s: RunState): Promise<void> {
  if (!s.subagentRegistry.hasPending()) return;
  s.reqLog.info({ pending: s.subagentRegistry.size }, 'Waiting for sub-agents to complete');
  await s.subagentRegistry.waitForAll();
  const summaries = s.subagentRegistry.buildResultSummaries();
  for (const summary of summaries) {
    const spawnMsg = s.messages.find(
      m => m.role === 'tool' && typeof m.content === 'string' &&
           m.content.includes(summary.childId) && m.content.includes(SUBAGENT_PENDING_MARKER),
    );
    if (spawnMsg) spawnMsg.content = JSON.stringify(summary.result);
  }
  s.reqLog.info({ completed: summaries.length }, 'Sub-agent results injected');
}

// ─── Stage: Persist results ──────────────────────────────────

async function persistResults(s: RunState, context: AgentContext): Promise<void> {
  if ((s.fullText.trim() || s.collectedMedia.length > 0) && s.messageRepo) {
    const msgMetadata: Record<string, unknown> = {};
    if (s.collectedMedia.length > 0) {
      msgMetadata.media = s.collectedMedia.map(m => ({ type: m.type, fileName: m.fileName, mimeType: m.mimeType }));
    }
    await s.messageRepo.create({
      sessionId: context.session.id, tenantId: context.tenantId,
      role: 'assistant', content: s.fullText || '',
      metadata: Object.keys(msgMetadata).length > 0 ? JSON.stringify(msgMetadata) : undefined,
    });
  }
  if (s.sessionRepo) {
    await s.sessionRepo.addUsage(context.session.id, s.totalInputTokens, s.totalOutputTokens);
    await s.sessionRepo.incrementTurns(context.session.id);
  }
}

// ─── Stage: Memory extraction (fire-and-forget) ──────────────

function triggerMemoryExtraction(s: RunState, context: AgentContext): void {
  const ephemeral = context.ephemeral ?? false;
  if (ephemeral || !s.sessionMemoryState || s.totalInputTokens + s.totalOutputTokens === 0) return;

  const isGroupScope = context.scopeKey?.startsWith('group_') ?? false;
  const userRole = context.user?.role || 'user';
  if (isGroupScope && userRole !== 'admin' && userRole !== 'power_user') return;

  const check = shouldExtractSessionMemory(s.totalInputTokens, s.sessionMemoryState, context.config);
  if (!check.shouldExtract) {
    if (s.sessionMemoryState.extractionCount === 0 && s.sessionRepo) {
      saveSessionMemoryState(context.session.id, s.sessionMemoryState, s.sessionRepo).catch(() => {});
    }
    return;
  }

  if (_activeExtractions.has(context.session.id)) {
    s.reqLog.debug({ category: 'memory' }, 'Session memory extraction already in progress — skipping');
    return;
  }

  s.reqLog.info({ reason: check.reason, category: 'memory' }, 'Session memory extraction triggered');
  _activeExtractions.add(context.session.id);
  const state = s.sessionMemoryState;

  extractSessionMemory({
    sessionId: context.session.id,
    scopeKey: context.scopeKey ?? null,
    db: context.db, config: context.config,
    state, currentTokens: s.totalInputTokens,
    callLLM: context.callLLM,
  }).then((newState) => {
    if (s.sessionRepo) {
      saveSessionMemoryState(context.session.id, newState, s.sessionRepo).catch((e) => {
        s.reqLog.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to persist session memory state');
      });
    }
    return maybeExtractToProfile({
      sessionId: context.session.id, channel: s.inbound.channel,
      scopeKey: context.scopeKey, db: context.db,
      config: context.config, callLLM: context.callLLM, minTurns: 5,
    });
  }).catch((e) => {
    s.reqLog.warn({ err: e instanceof Error ? e.message : String(e), category: 'memory' }, 'Session memory extraction or profile extraction failed');
  }).finally(() => {
    _activeExtractions.delete(context.session.id);
  });
}

// ─── Agent loop ─────────────────────────────────────────────

export async function runAgent(
  inboundParam: InboundMessage,
  callbacks: AgentRoundCallbacks,
  context: AgentContext,
): Promise<AgentResult> {
  const { onDelta, onThinkingDelta, onRoundStart, onRoundEnd } = callbacks;
  const { db, config, session, tenantId, userId } = context;
  const ephemeral = context.ephemeral ?? false;
  const requestId = `req-${crypto.randomUUID().slice(0, 12)}`;
  const maxToolRounds = config.agent?.maxToolRounds || 25;

  // ── Model routing ───────────────────────────────────────
  const routing = await resolveModel(inboundParam, context);
  const model = routing.model;
  let inbound = routing.inbound;

  // SDK/CLI tool executor bridge
  const sdkToolExecutor = context.executeTool
    ? async (name: string, args: Record<string, unknown>): Promise<string> => {
        try {
          const result = await context.executeTool!(name, args, { session, user: context.user, scopeKey: context.scopeKey } as any);
          return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ error: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
    : undefined;

  const reqLog = log.child({ requestId, sessionId: session.id, channel: inbound.channel, model, ephemeral });
  const sessionRepo = !ephemeral ? new SessionRepository(db) : null;
  const messageRepo = !ephemeral ? new MessageRepository(db) : null;
  const usageRepo = !ephemeral ? new UsageRepository(db) : null;
  const toolCallRepo = !ephemeral ? new ToolCallRepository(db) : null;

  // ── Slash commands ──────────────────────────────────────
  const trimmed = inbound.text.trim();
  if (!ephemeral && trimmed.startsWith('/')) {
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const slashResult = await handleSlashCommand(cmd!, rest.join(' '), {
      db, config, session, tenantId, userId, callLLM: context.callLLM,
    });
    if (slashResult) return { text: slashResult.text, slashResult: true };
  }

  if (!trimmed) return { text: null };

  // ── Session memory ──────────────────────────────────────
  let sessionMemoryState: SessionMemoryState | null = null;
  if (!ephemeral && config.agent?.sessionMemory?.enabled !== false) {
    sessionMemoryState = loadSessionMemoryState(session) ?? createInitialState();
  }

  // ── Pre-turn compaction ─────────────────────────────────
  if (!ephemeral) {
    try {
      await checkAndCompact(session.id, model, db, config, context.callLLM, tenantId, context.scopeKey);
    } catch (e: unknown) {
      reqLog.warn({ err: e instanceof Error ? e.message : String(e) }, 'Compaction check failed');
    }
  }

  // ── Load history + SessionStart hooks ───────────────────
  const historyRows = messageRepo ? await messageRepo.listBySession(session.id) : [];
  inbound = await runSessionStartHooksStage(inbound, historyRows, config, session, context.scopeKey ?? null, ephemeral, reqLog);

  // ── Build prompt + messages ─────────────────────────────
  const hasContextSummary = historyRows.some(
    r => r.role === 'user' && typeof r.content === 'string' && r.content.startsWith('[Context Summary'),
  );
  const tools = context.tools ?? [];
  const caps = getModelCapabilities(model, config);
  const systemPrompt = buildSystemPrompt(config, tools, context.scopeKey, inbound.channel, session.id, hasContextSummary, { supportsVision: caps.supportsVision });
  const history: Message[] = historyRows.map(rowToMessage);
  const userContent = buildUserContent(inbound.text, inbound.images, caps.supportsVision, sniffBase64Mime);
  const messages = normalizeMessages(history, userContent);

  // ── Save images + persist user message ──────────────────
  const savedImagePaths = await saveImagesToDisk(inbound, config, context.user?.id || 'anonymous');
  const persistText = typeof userContent === 'string' ? userContent : inbound.text;
  const userMsgResult = messageRepo ? await messageRepo.create({
    sessionId: session.id, tenantId, role: 'user', content: persistText,
    metadata: JSON.stringify({
      channel: inbound.channel, sender: inbound.senderName,
      ...(inbound.images && inbound.images.length > 0 ? { imageCount: inbound.images.length } : {}),
      ...(savedImagePaths.length > 0 ? { images: savedImagePaths } : {}),
    }),
  }) : null;

  // ── Thinking config ─────────────────────────────────────
  const thinkingCfg = config.agent?.thinking;
  const thinkingConfig = (thinkingCfg?.enabled && caps.supportsThinking)
    ? { enabled: true as const, mode: thinkingCfg.mode || ('adaptive' as const), budgetTokens: thinkingCfg.budgetTokens }
    : undefined;

  // ── Shared state for the ReAct loop ─────────────────────
  const initialContentSize = messages.reduce((sum, m) => sum + contentLen(m.content), 0);
  const s: RunState = {
    inbound, model, messages, tools, systemPrompt, caps,
    totalInputTokens: 0, totalOutputTokens: 0,
    fullText: '', finalThinkingText: null,
    collectedMedia: [], toolCallCounts: new Map(),
    subagentRegistry: new SubAgentRegistry(),
    sessionMemoryState, userMsgResult,
    totalContentSize: initialContentSize,
    reactiveCompactFailures: 0, round: 0, aborted: false,
    hasContextSummary, userContent, thinkingConfig,
    sdkToolExecutor, reqLog,
    sessionRepo, messageRepo, usageRepo, toolCallRepo,
  };

  // ── ReAct loop ──────────────────────────────────────────
  const MAX_REACTIVE_COMPACT_FAILURES = 3;
  while (s.round < maxToolRounds) {
    // Stop before doing any more work if cancellation was requested.
    if (context.signal?.aborted) { s.aborted = true; break; }
    s.round++;
    if (onRoundStart) onRoundStart(s.round, maxToolRounds);

    // Refresh tools mid-turn (Phase 8)
    if (context.refreshTools) {
      try {
        const fresh = await context.refreshTools();
        if (fresh.length !== s.tools.length) {
          s.tools = fresh;
          s.systemPrompt = buildSystemPrompt(config, s.tools, context.scopeKey, inbound.channel, session.id, s.hasContextSummary, { supportsVision: s.caps.supportsVision });
        }
      } catch { /* keep existing tools */ }
    }

    // Log round info
    reqLog.info({ round: s.round, maxRounds: maxToolRounds, messageCount: s.messages.length, toolCount: s.tools.length, contentKB: +(s.totalContentSize / 1024).toFixed(1) }, 'Agent round started');

    // ── Call LLM ──────────────────────────────────────────
    const debugEnabled = !ephemeral && (config.agent as unknown as { debug?: { recordPrompt?: boolean } })?.debug?.recordPrompt === true;
    const debugTurnIndex = (session.turns ?? 0) + 1;

    let response: ProviderResponse;
    const llmStart = Date.now();
    try {
      response = await context.callLLM({
        messages: s.messages, tools: s.tools.length > 0 ? s.tools : undefined,
        model, systemPrompt: s.systemPrompt, onDelta, onThinkingDelta, thinkingConfig,
        signal: context.signal,
        _executeTool: s.sdkToolExecutor, _maxToolRounds: maxToolRounds,
      });
    } catch (e: unknown) {
      // Cancellation surfaces as an abort error from the provider — treat it as
      // a clean stop, not a failure, and keep whatever streamed so far.
      if (context.signal?.aborted) { s.aborted = true; break; }
      const classified = classifyError(e);
      logClassifiedError(classified, { round: s.round, requestId, sessionId: session.id });

      if (classified.type === 'prompt_too_long' && !ephemeral && s.reactiveCompactFailures < MAX_REACTIVE_COMPACT_FAILURES) {
        s.reactiveCompactFailures++;
        reqLog.warn({ round: s.round, attempt: s.reactiveCompactFailures, errorType: classified.type }, 'Context overflow — starting reactive compact recovery');

        // Stage 1: Strip images
        let strippedImages = false;
        for (const m of s.messages) {
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

        // Stage 2: Force hard compaction
        if (s.messageRepo) {
          try {
            reqLog.info('Stage 2: Forcing hard compaction');
            await compactSession(session.id, tenantId, model, db, config, context.callLLM);
            const freshRows = await s.messageRepo.listBySession(session.id);
            s.messages.splice(0, s.messages.length, ...freshRows.map(rowToMessage));
            s.totalContentSize = s.messages.reduce((sum, m) => sum + contentLen(m.content), 0);
          } catch (compactErr: unknown) {
            reqLog.warn({ err: compactErr instanceof Error ? compactErr.message : String(compactErr) }, 'Stage 2 compaction failed');
          }
        }

        // Stage 3: Retry
        try {
          response = await context.callLLM({
            messages: s.messages, tools: s.tools.length > 0 ? s.tools : undefined,
            model, systemPrompt: s.systemPrompt, onDelta, onThinkingDelta, thinkingConfig,
            signal: context.signal,
            _executeTool: s.sdkToolExecutor, _maxToolRounds: maxToolRounds,
          });
          reqLog.info({ round: s.round, attempt: s.reactiveCompactFailures }, 'LLM call succeeded after reactive compact');
          s.reactiveCompactFailures = 0;
        } catch (retryErr: unknown) {
          if (context.signal?.aborted) { s.aborted = true; break; }
          const retryClassified = classifyError(retryErr);
          if (retryClassified.type === 'prompt_too_long' && s.reactiveCompactFailures < MAX_REACTIVE_COMPACT_FAILURES) {
            reqLog.warn({ attempt: s.reactiveCompactFailures }, 'Still overflowing after compact — will retry');
            continue;
          }
          reqLog.error({ attempt: s.reactiveCompactFailures, errorType: retryClassified.type }, 'LLM call failed after reactive compact — giving up');
          if (s.userMsgResult?.id) { try { s.messageRepo?.deleteById(s.userMsgResult.id); } catch { /* best effort */ } }
          return { text: retryClassified.userMessage || 'Your conversation is too long even after compaction. Please start a new session with /new.', error: true };
        }
      } else if (classified.type === 'auth_error') {
        if (s.userMsgResult?.id) { try { s.messageRepo?.deleteById(s.userMsgResult.id); } catch { /* best effort */ } }
        return { text: classified.userMessage || 'Authentication failed. Please check your API key configuration.', error: true };
      } else {
        reqLog.error({ latencyMs: Date.now() - llmStart, errorType: classified.type, action: classified.action }, 'LLM call failed');
        if (s.userMsgResult?.id) { try { s.messageRepo?.deleteById(s.userMsgResult.id); } catch { /* best effort */ } }
        if (classified.type === 'prompt_too_long') {
          return { text: 'Your conversation is too long even after multiple compaction attempts. Please start a new session with /new.', error: true };
        }
        return { text: classified.userMessage || 'Something went wrong processing your request. Please try again.', error: true };
      }
    }

    const llmLatencyMs = Date.now() - llmStart;

    // Debug JSONL logging
    if (debugEnabled) {
      appendDebugLog(config.agent.workspace, {
        ts: new Date().toISOString(), sessionId: session.id, messageId: s.userMsgResult?.id ?? null,
        turn: debugTurnIndex, round: s.round, model,
        systemPrompt: { cached: s.systemPrompt.cached, dynamic: s.systemPrompt.dynamic },
        messages: sanitizeMessagesForLog(s.messages),
        response: { text: response.text || null, toolCalls: response.toolCalls ?? null, usage: response.usage ?? null, latencyMs: llmLatencyMs },
      });
    }

    // Track tokens + log
    const inTok = response.usage?.inputTokens ?? 0;
    const outTok = response.usage?.outputTokens ?? 0;
    s.totalInputTokens += inTok;
    s.totalOutputTokens += outTok;

    const toolCount = response.toolCalls?.length ?? 0;
    reqLog.info({
      round: s.round, inputTokens: inTok, outputTokens: outTok, toolCalls: toolCount, latencyMs: llmLatencyMs,
      stopReason: ('stopReason' in response ? (response as Record<string, unknown>).stopReason : undefined) || (toolCount > 0 ? 'tool_use' : 'end_turn'),
    }, 'LLM call completed');

    if (response.text) {
      reqLog.info({ round: s.round, responsePreview: response.text.slice(0, 300), responseLen: response.text.length, category: 'llm' }, 'LLM response text');
    }

    // Record usage
    const provider = model.split('/')[0] ?? 'unknown';
    const costUsd = estimateCost(model, inTok, outTok, config)?.total ?? 0;
    if (costUsd > 0) reqLog.info({ round: s.round, costUsd: +costUsd.toFixed(6), category: 'llm' }, 'Round cost');
    if (s.usageRepo) {
      try {
        await s.usageRepo.record({ tenantId, userId, sessionId: session.id, model, provider, inputTokens: inTok, outputTokens: outTok, costUsd });
      } catch (e: unknown) { reqLog.warn({ err: e instanceof Error ? e.message : String(e) }, 'Failed to record usage (non-critical)'); }
    }

    // No tool calls → done
    if (!response.toolCalls) {
      s.fullText = response.text || '';
      s.finalThinkingText = response.thinkingText || null;
      if (s.finalThinkingText) {
        reqLog.info({ thinkingLen: s.finalThinkingText.length }, 'Thinking complete');
        reqLog.debug({ thinking: s.finalThinkingText.slice(0, 2000) }, 'Thinking content');
      }
      if (onRoundEnd) onRoundEnd(s.round, maxToolRounds);
      break;
    }

    // Append assistant message + execute tools. If cancellation arrived during
    // the LLM call, stop here rather than kicking off a new batch of tools.
    const assistantMsg: Message = { role: 'assistant', content: response.text || '', tool_calls: response.toolCalls, thinking_blocks: response.thinkingBlocks };
    s.messages.push(assistantMsg);
    s.totalContentSize += contentLen(assistantMsg.content);
    if (context.signal?.aborted) { s.aborted = true; if (onRoundEnd) onRoundEnd(s.round, maxToolRounds); break; }
    await executeToolCalls(response.toolCalls, s, context, callbacks);
    await drainSubAgents(s);

    if (onRoundEnd) onRoundEnd(s.round, maxToolRounds);
  }

  // ── Post-loop finalization ──────────────────────────────
  // On cancellation, kill any in-flight sub-agents before draining so they
  // don't keep burning tokens after the parent turn was stopped.
  if (s.aborted && s.subagentRegistry.size > 0) {
    const killed = s.subagentRegistry.abortAll();
    if (killed > 0) reqLog.info({ killed }, 'Cancelled in-flight sub-agents after abort');
  }
  if (s.subagentRegistry.size > 0) await s.subagentRegistry.drainAll();
  if (s.aborted) reqLog.info({ round: s.round }, 'Agent turn cancelled');
  if (s.round >= maxToolRounds) s.fullText += '\n\nReached maximum tool call rounds.';
  if (s.fullText.trim() === 'NO_REPLY') s.fullText = '';

  // Output filtering
  if (s.fullText) {
    s.fullText = filterOutput(s.fullText);
    const safety = checkOutputSafety(s.fullText);
    if (!safety.safe) reqLog.warn({ flags: safety.flags }, 'Output safety flags detected');
  }

  reqLog.info({
    totalRounds: s.round, totalInputTokens: s.totalInputTokens, totalOutputTokens: s.totalOutputTokens,
    responseLen: s.fullText.length, responsePreview: s.fullText.slice(0, 200), mediaCount: s.collectedMedia.length, category: 'llm',
  }, 'Agent turn completed');

  await persistResults(s, context);
  triggerMemoryExtraction(s, context);

  return {
    text: s.fullText || null,
    thinkingText: s.finalThinkingText,
    usage: { inputTokens: s.totalInputTokens, outputTokens: s.totalOutputTokens },
    ...(s.collectedMedia.length > 0 ? { media: s.collectedMedia } : {}),
    ...(s.aborted ? { aborted: true } : {}),
    model,
    userRole: context.user?.role,
  };
}

