import crypto from 'node:crypto';
import type { ToolDefinition, ToolResult, ToolExecutionContext, ToolPermissionLevel } from '@agw/types';
import type { DatabaseAdapter } from '../db/index.js';
import type { ToolRegistration } from './types.js';
import { ToolCallRepository } from '../db/repositories/tool-call.js';
import { checkToolPermission } from './permissions.js';
import type { AuditService } from '../security/audit.js';

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

    // Execute with timing
    const start = performance.now();
    let result: ToolResult;
    let status = 'success';

    try {
      result = await registration.executor(args, context);

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
