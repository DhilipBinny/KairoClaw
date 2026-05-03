import crypto from 'node:crypto';
import type { ToolDefinition, ToolResult, ToolExecutionContext, ToolPermissionLevel, JSONSchemaObject, JSONSchemaProperty, ToolProgress } from '@agw/types';
import { isToolResultEnvelope } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { ToolRegistration } from './types.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { checkToolPermission } from './permissions.js';
import type { AuditService } from '../security/audit.js';
import type { LoopDetector } from './loop-detector.js';
import type { ResultStorage } from './result-storage.js';
import type { ProgressBus } from '../agent/progress-bus.js';

/**
 * Internal view of the tool-execution context with Phase 6 services
 * attached. `LoopDetector`, `ResultStorage`, and `ProgressBus` are
 * registry-internal — they're passed via the context as
 * non-type-facing extensions (consistent with how `cronScheduler`,
 * `browserManager`, etc. are already passed through `enrichedCtx`
 * in `createRunner`).
 */
interface Phase6ContextExtensions {
  loopDetector?: LoopDetector;
  resultStorage?: ResultStorage;
  progressBus?: ProgressBus;
}

/** Maximum preview length for args / result in progress events. */
const PREVIEW_MAX_CHARS = 500;

/** Serialize any value to JSON without throwing on circular refs etc. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserialisable]';
    }
  }
}

/** Truncate a string to `max` chars with a trailing ellipsis if longer. */
function truncatePreview(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Render a tool result into a readable preview string. Handles all
 * three return shapes:
 *   - `string` → as-is
 *   - Phase 6 content-block envelope → text blocks joined, non-text
 *     blocks summarised as `[image/jpeg]` / `[persisted 84KB]` / `[link: …]`
 *   - Legacy object → JSON.stringify
 * Mirrors `agent/loop.ts:renderToolResultForLLM` but stays local to
 * avoid a cross-layer import.
 */
function renderPreview(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return safeStringify(result);
  if (isToolResultEnvelope(result)) {
    const parts: string[] = [];
    for (const block of result.content) {
      if (block.type === 'text') {
        parts.push(block.text);
      } else if (block.type === 'image') {
        parts.push(`[${block.source.media_type || 'image'}]`);
      } else if (block.type === 'resource_link') {
        parts.push(`[link: ${block.title || block.uri}]`);
      } else if (block.type === 'persisted_reference') {
        parts.push(
          `[persisted ${block.sizeBytes}B at ${block.path}]\n${block.preview}`,
        );
      }
    }
    return parts.join('\n');
  }
  return safeStringify(result);
}

// ─── Lightweight argument validation ────────────────────────

/**
 * Validate tool arguments against the tool's JSON Schema.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * This is intentionally lightweight — checks required fields and basic
 * types without a full JSON Schema library. The goal is to give the LLM
 * a clear error message so it can self-correct, not strict spec compliance.
 */
function validateArgs(
  args: Record<string, unknown>,
  schema: JSONSchemaObject,
): string[] {
  const errors: string[] = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (args[field] === undefined || args[field] === null) {
        const prop = schema.properties[field];
        const expected = prop?.type || 'value';
        errors.push(`Missing required argument '${field}' (expected ${expected})`);
      }
    }
  }

  // Check types of provided fields
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key] as JSONSchemaProperty | undefined;
    if (!prop) continue; // allow extra fields — LLM sometimes sends unexpected args

    if (value === undefined || value === null) continue; // already checked in required

    const expectedType = prop.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (expectedType === 'string' && actualType !== 'string') {
      errors.push(`Argument '${key}': expected string, got ${actualType}`);
    } else if (expectedType === 'number' && actualType !== 'number') {
      errors.push(`Argument '${key}': expected number, got ${actualType}`);
    } else if (expectedType === 'boolean' && actualType !== 'boolean') {
      errors.push(`Argument '${key}': expected boolean, got ${actualType}`);
    } else if (expectedType === 'array' && actualType !== 'array') {
      errors.push(`Argument '${key}': expected array, got ${actualType}`);
    } else if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
      errors.push(`Argument '${key}': expected object, got ${actualType}`);
    }

    // Check enum values
    if (prop.enum && !prop.enum.includes(value as string)) {
      errors.push(`Argument '${key}': must be one of [${prop.enum.join(', ')}], got '${value}'`);
    }
  }

  return errors;
}

/**
 * Central tool registry.
 *
 * Manages tool registrations, checks RBAC permissions before execution,
 * and records every tool call in the audit log (tool_calls table).
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();
  private auditService?: AuditService;

  /** Attach an AuditService for recording tool execution audit events. */
  setAuditService(audit: AuditService): void {
    this.auditService = audit;
  }

  /**
   * Register a tool. Overwrites any existing tool with the same name.
   */
  register(tool: ToolRegistration): void {
    this.tools.set(tool.definition.name, tool);
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get all tool definitions, optionally filtered by RBAC permissions.
   *
   * When `userRole` is provided along with `db` and `tenantId`, tools
   * the role is denied access to are excluded from the returned list.
   */
  async getDefinitions(opts?: {
    userRole?: string;
    db?: DatabaseAdapter;
    tenantId?: string;
    elevated?: boolean;
  }): Promise<ToolDefinition[]> {
    const definitions: ToolDefinition[] = [];

    for (const reg of this.tools.values()) {
      if (opts?.userRole && opts.db && opts.tenantId) {
        const perm = await checkToolPermission(
          reg.definition.name,
          opts.userRole,
          opts.db,
          opts.tenantId,
          opts.elevated ?? false,
        );
        if (perm === 'deny') continue;
      }
      definitions.push(reg.definition);
    }

    return definitions;
  }

  /**
   * Execute a tool by name.
   *
   * 1. Checks RBAC permission (deny throws, confirm sets a flag)
   * 2. Runs the executor
   * 3. Records the call in tool_calls audit table
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const registration = this.tools.get(name);
    if (!registration) {
      return { error: `Unknown tool: ${name}` };
    }

    // RBAC check
    let permission: ToolPermissionLevel = 'allow';
    const db = context.db as DatabaseAdapter | undefined;
    const tenantId = context.tenant || (context as Record<string, unknown>).tenantId as string || 'default';
    const userRole = context.user?.role || 'user';
    const userElevated = !!context.user?.elevated;

    if (db) {
      permission = await checkToolPermission(name, userRole, db, tenantId, userElevated);
      if (permission === 'deny') {
        // Audit: tool denied by RBAC
        try {
          await this.auditService?.log({
            tenantId,
            userId: context.user?.id,
            action: 'tool.denied',
            resource: name,
            details: { role: userRole, args: Object.keys(args) },
          });
        } catch { /* audit should not break execution */ }
        return { error: `Permission denied: tool "${name}" is not allowed for role "${userRole}"` };
      }
    }

    // Argument validation — catch type errors before execution
    const validationErrors = validateArgs(args, registration.definition.parameters);
    if (validationErrors.length > 0) {
      return { error: `Invalid arguments for tool "${name}": ${validationErrors.join('; ')}` };
    }

    // Phase 6 registration-level input validation hook — semantic checks
    // that JSON Schema can't express (e.g. "old_string !== new_string").
    if (registration.validateInput) {
      const check = registration.validateInput(args);
      if (!check.ok) {
        return { error: `Invalid input for tool "${name}": ${check.error}` };
      }
    }

    // Confirmation check — must happen BEFORE execution
    const callId = crypto.randomUUID();
    if (permission === 'confirm') {
      try {
        await this.auditService?.log({
          tenantId,
          userId: context.user?.id,
          action: 'tool.confirm_required',
          resource: name,
          details: { role: userRole, args: Object.keys(args), callId },
        });
      } catch { /* audit should not break execution */ }
      return { _requiresConfirmation: true, _callId: callId, tool: name, args } as unknown as ToolResult;
    }

    // ── Phase 6: tool-call loop detection ───────────────────
    // Runs AFTER RBAC + validation but BEFORE execution so denied /
    // malformed calls don't poison the detector's ring buffer.
    const ctxExt = context as Phase6ContextExtensions & ToolExecutionContext;
    const loopDetector = ctxExt.loopDetector;
    if (loopDetector) {
      const loopError = loopDetector.record(name, args);
      if (loopError) {
        try {
          await this.auditService?.log({
            tenantId,
            userId: context.user?.id,
            action: 'tool.loop_detected',
            resource: name,
            details: { tool: name, callId },
          });
        } catch { /* non-critical */ }
        return { error: loopError };
      }
    }

    // ── Phase 6.5: emit tool.start progress event ───────────
    // Published to the ProgressBus so SSE subscribers for this
    // session see a live "running <tool>" notification before the
    // executor blocks. No-op when no one is subscribed.
    const progressBus = ctxExt.progressBus;
    // The runtime `session` object is the DB SessionRow (has `id`),
    // not the `Session` type from `@agw/types` (which declares
    // `sessionId`). The codebase reads `session.id` everywhere at
    // runtime; the type mismatch is a pre-existing issue. Prefer the
    // runtime field and fall back to the typed name for safety.
    const progressSessionId =
      (context.session as unknown as { id?: string })?.id
      ?? context.session?.sessionId;
    if (progressBus && progressSessionId) {
      const argsJson = safeStringify(args);
      progressBus.emit({
        sessionId: progressSessionId,
        timestamp: Date.now(),
        kind: 'tool.start',
        toolName: name,
        toolCallId: callId,
        message: registration.getActivityDescription
          ? registration.getActivityDescription(args)
          : `Running ${name}`,
        argsPreview: truncatePreview(argsJson, PREVIEW_MAX_CHARS),
        argsLen: argsJson.length,
      });
    }

    // ── Phase 6.5: wrap context.progress for this call ──────
    // Tool authors call `context.progress({ message, fraction, ... })`
    // without knowing their own name or callId. Wrap their callback
    // so the registry injects those fields automatically and forwards
    // to the bus as tool.progress events.
    let wrappedContext: ToolExecutionContext = context;
    if (progressBus && progressSessionId) {
      wrappedContext = {
        ...context,
        progress: (event: ToolProgress) => {
          progressBus.emit({
            sessionId: progressSessionId,
            timestamp: Date.now(),
            kind: 'tool.progress',
            toolName: name,
            toolCallId: callId,
            message: event.message,
            fraction: event.fraction,
            data: event.data,
          });
        },
      };
    }

    // Execute with timing
    const start = performance.now();
    let result: ToolResult;
    let status = 'success';

    try {
      result = await registration.executor(args, wrappedContext);

      // Check if the result itself indicates an error
      if (typeof result === 'object' && result !== null && 'error' in result) {
        status = 'error';
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      result = { error: message };
      status = 'error';
    }

    const durationMs = Math.round(performance.now() - start);

    // ── Phase 6.5: emit tool.complete / tool.error ──────────
    // Includes a rendered preview of the result so the admin UI can
    // show what the tool actually returned without a separate fetch.
    if (progressBus && progressSessionId) {
      const rendered = renderPreview(result);
      const isEnvelope = isToolResultEnvelope(result);
      progressBus.emit({
        sessionId: progressSessionId,
        timestamp: Date.now(),
        kind: status === 'error' ? 'tool.error' : 'tool.complete',
        toolName: name,
        toolCallId: callId,
        durationMs,
        resultPreview: truncatePreview(rendered, PREVIEW_MAX_CHARS),
        resultLen: rendered.length,
        resultPersisted: isEnvelope ? !!(result as { persisted?: boolean }).persisted : false,
      });
    }

    // ── Phase 6: result persistence ─────────────────────────
    // If the tool returned an envelope and its content is over the
    // per-tool threshold (or the default 16 KB), offload the full
    // content to disk via result-storage and replace it with a single
    // `persisted_reference` block containing a preview + path +
    // sizeBytes. The LLM still sees enough to decide whether to
    // retrieve the full content later.
    //
    // Legacy string / object returns are not auto-persisted — that
    // would change the caller-visible shape. Tools that want
    // persistence must return an envelope.
    const storage = ctxExt.resultStorage;
    if (storage && isToolResultEnvelope(result)) {
      const threshold = registration.maxResultSizeChars;
      const persisted = storage.maybePersist(result.content, callId, threshold);
      if (persisted) {
        result = { ...result, content: persisted, persisted: true };
      }
    }

    // ── Phase 6: result-budget tracking (non-blocking) ──────
    // Best-effort byte accounting so the agent loop can trigger early
    // compaction when the per-turn cap is exceeded. Runs AFTER
    // persistence so the budget reflects post-persist sizes.
    // Never fails execution.
    const budget = context.resultBudget;
    if (budget) {
      let bytes = 0;
      try {
        if (typeof result === 'string') {
          bytes = Buffer.byteLength(result, 'utf8');
        } else if (result && typeof result === 'object') {
          bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        }
      } catch { /* ignore */ }
      budget.add(bytes);
    }

    // Record in audit log
    if (db) {
      try {
        const repo = new ToolCallRepository(db);
        await repo.record({
          id: callId,
          sessionId: context.session?.sessionId || 'unknown',
          tenantId,
          userId: context.user?.id,
          toolName: name,
          arguments: args,
          result,
          status,
          durationMs,
        });
      } catch {
        // Audit logging should not break tool execution
      }
    }

    // Audit: tool executed
    try {
      await this.auditService?.log({
        tenantId,
        userId: context.user?.id,
        action: 'tool.execute',
        resource: name,
        details: { status, durationMs, callId },
      });
    } catch { /* audit should not break execution */ }

    return result;
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Get a tool registration by name.
   */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is safe to run concurrently with other tools.
   * Returns false (sequential) for unknown tools — fail-safe.
   */
  isConcurrencySafe(name: string): boolean {
    return this.tools.get(name)?.concurrencySafe ?? false;
  }
}
