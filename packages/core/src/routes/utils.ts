/**
 * Shared utilities for route handlers.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import type { GatewayConfig } from '@agw/types';

// ── Request context helpers ─────────────────────────────────

/** Extract database adapter from request context. */
export function getDb(request: FastifyRequest): DatabaseAdapter {
  return (request as unknown as { ctx: { db: DatabaseAdapter } }).ctx.db;
}

/** Extract tenant ID from authenticated request (falls back to 'default'). */
export function getTenantId(request: FastifyRequest): string {
  return request.tenantId || 'default';
}

/** Extract config from request context. */
export function getConfig(request: FastifyRequest): GatewayConfig {
  return (request as unknown as { ctx: { config: GatewayConfig } }).ctx.config;
}

// ── Ownership helpers ───────────────────────────────────────

/**
 * Assert the authenticated user can access a session.
 * Admin can access any session; non-admin can only access their own.
 * Returns true if access is allowed, sends 403 and returns false if denied.
 */
export function assertSessionAccess(
  session: { user_id?: string | null },
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (request.user?.role === 'admin') return true;
  if (request.user?.id && session.user_id && session.user_id !== request.user.id) {
    reply.code(403).send({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// ── Existing utilities ──────────────────────────────────────

/**
 * Set a nested property on an object by dot-separated path.
 * e.g. setNestedPath(obj, "model.primary", "claude-sonnet-4-6")
 */
export function setNestedPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  const dangerous = ['__proto__', 'constructor', 'prototype'];
  if (parts.some((p) => dangerous.includes(p))) {
    throw new Error(`Invalid path: "${dotPath}"`);
  }
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
