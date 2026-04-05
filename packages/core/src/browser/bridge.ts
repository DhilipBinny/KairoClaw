/**
 * Browser Bridge — WebSocket relay between the AI agent and the user's Chrome extension.
 *
 * Each authenticated user can have one connected browser extension.
 * The browse tool sends commands here; this relays them to the extension and returns results.
 */

import type { WebSocket } from '@fastify/websocket';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { hashApiKey } from '../auth/keys.js';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('browser');

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  userId: string;
}

/** Connected browser extensions, keyed by userId */
const connections = new Map<string, WebSocket>();
/** Pending command responses, keyed by command ID */
const pendingCommands = new Map<string, PendingCommand>();

const COMMAND_TIMEOUT_MS = 60_000; // 60 seconds per command
const AUTH_RATE_LIMIT = 5; // max auth attempts per minute per connection
const AUTH_RATE_WINDOW_MS = 60_000;

/**
 * Check if a user has a remote browser connected.
 */
export function hasRemoteBrowser(userId: string): boolean {
  const ws = connections.get(userId);
  return !!ws && ws.readyState === 1; // WebSocket.OPEN
}

/**
 * Send a command to the user's connected browser extension and wait for result.
 */
export async function sendBrowserCommand(
  userId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const ws = connections.get(userId);
  if (!ws || ws.readyState !== 1) {
    throw new Error('No browser extension connected. Install the KairoClaw Chrome extension and connect it.');
  }

  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Browser command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(id, { resolve, reject, timeout, userId });

    log.debug({ userId, action, cmdId: id, category: 'browser' }, 'Extension command dispatched');
    ws.send(JSON.stringify({ type: 'command', id, action, params }));
  });
}

/**
 * Fastify plugin that registers the /ws/browser-bridge WebSocket endpoint.
 */
export const browserBridgePlugin: FastifyPluginAsync<{ db: DatabaseAdapter }> = async (app, opts) => {
  const { db } = opts;

  app.get('/ws/browser-bridge', { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    let userId: string | null = null;
    let authenticated = false;
    const authAttempts: number[] = []; // timestamps of auth attempts

    socket.on('message', async (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // Auth
      if (msg.type === 'auth') {
        // Rate limit auth attempts
        const now = Date.now();
        authAttempts.push(now);
        // Remove attempts outside window
        while (authAttempts.length > 0 && authAttempts[0] < now - AUTH_RATE_WINDOW_MS) {
          authAttempts.shift();
        }
        if (authAttempts.length > AUTH_RATE_LIMIT) {
          log.warn({ category: 'browser' }, 'Extension auth rate limited');
          socket.send(JSON.stringify({ type: 'auth.error', message: 'Too many auth attempts. Wait a minute.' }));
          return;
        }

        const token = msg.token as string | undefined;
        if (!token) {
          socket.send(JSON.stringify({ type: 'auth.error', message: 'Token required' }));
          return;
        }

        const keyHash = hashApiKey(token);
        const user = await db.get<{ id: string; role: string; active: number }>(
          'SELECT id, role, active FROM users WHERE api_key_hash = ?',
          [keyHash],
        );

        if (!user || !user.active) {
          log.warn({ category: 'browser' }, 'Extension auth failed: invalid or inactive API key');
          socket.send(JSON.stringify({ type: 'auth.error', message: 'Invalid or inactive API key' }));
          return;
        }

        // Only admin can use remote browser (beta feature)
        if (user.role !== 'admin') {
          log.warn({ userId: user.id, role: user.role, category: 'browser' }, 'Extension auth rejected: non-admin user');
          socket.send(JSON.stringify({ type: 'auth.error', message: 'Remote browser is admin-only (beta)' }));
          return;
        }

        userId = user.id;
        authenticated = true;

        // Close existing connection for this user (one extension per user)
        const existing = connections.get(userId);
        if (existing && existing !== socket) {
          try { existing.close(1000, 'Replaced by new connection'); } catch { /* ignore */ }
        }
        connections.set(userId, socket);

        socket.send(JSON.stringify({ type: 'auth.ok' }));
        log.info({ userId }, 'Browser extension connected');
        return;
      }

      if (!authenticated || !userId) {
        socket.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
        return;
      }

      // Command result from extension
      if (msg.type === 'result') {
        const cmdId = msg.id as string;
        const pending = pendingCommands.get(cmdId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCommands.delete(cmdId);
          const resultStr = JSON.stringify(msg.result);
          log.debug({ userId, cmdId, resultLen: resultStr.length, category: 'browser' }, 'Extension command result received');
          pending.resolve(msg.result);
        }
        return;
      }
    });

    socket.on('close', () => {
      if (userId) {
        connections.delete(userId);
        // Reject pending commands for this user — don't let them hang until timeout
        for (const [cmdId, pending] of pendingCommands) {
          if (pending.userId === userId) {
            clearTimeout(pending.timeout);
            pendingCommands.delete(cmdId);
            pending.reject(new Error('Browser extension disconnected while command was in progress'));
          }
        }
        log.info({ userId }, 'Browser extension disconnected');
      }
    });

    socket.on('error', () => {
      if (userId) connections.delete(userId);
    });
  });
};
