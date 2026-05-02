/**
 * Live progress streaming endpoint.
 *
 *   GET /api/v1/sessions/:id/progress
 *
 * Admin only. Streams tool-execution progress events for a specific
 * session as Server-Sent Events (SSE). Each event is a JSON payload
 * produced by the ProgressBus — `tool.start`, `tool.progress`,
 * `tool.complete`, `tool.error`, etc.
 *
 * Client usage (browser):
 *
 *   const es = new EventSource(
 *     `/api/v1/sessions/${id}/progress?token=${apiKey}`
 *   );
 *   es.onmessage = (e) => {
 *     const evt = JSON.parse(e.data);
 *     // render evt.kind / toolName / message / durationMs
 *   };
 *
 * EventSource doesn't support custom headers, so we accept the API
 * key via `?token=` query param — the same fallback the main auth
 * middleware already honours.
 *
 * Security trade-off (admin-only stream, accepted):
 *   ?token=<api-key> in the URL means the key shows up in:
 *     - server access logs (nginx, cloudflare, fastify)
 *     - browser history / referrer headers on cross-origin links
 *     - any HTTP cache that logs the request line
 *   The endpoint is gated by `requireRole('admin')` so this only
 *   exposes admin-tier keys to operators who already have admin
 *   access to the box. If you ever expose this stream to non-admin
 *   clients, swap to a short-lived single-use SSE ticket fetched
 *   over an authenticated POST instead of reusing the long-lived
 *   API key.
 */

import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { createModuleLogger } from '../observability/logger.js';
import type { ProgressBus } from '../agent/progress-bus.js';

interface Options {
  progressBus: ProgressBus;
}

const log = createModuleLogger('http');

/** Send a keepalive ping this often so reverse proxies don't close idle SSE connections. */
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Cloudflare tunnels, corporate proxies, and some CDN edge nodes buffer
 * SSE responses until they've accumulated a minimum byte chunk —
 * typically in the 1–4 KB range — before flushing anything to the
 * client. The user ships kairobm behind a `*.trycloudflare.com` quick
 * tunnel, so the initial stream.open + first few tool events get held
 * until enough bytes accumulate, and the browser sees an empty feed.
 *
 * Trick: prefix the stream with a 4 KB SSE comment (ignored by clients
 * per the spec — comments start with `:` and run to the next blank
 * line). That forces CF to flush its buffer immediately, and every
 * subsequent write-and-flush reaches the browser live.
 */
const CF_FLUSH_PADDING = ': ' + '.'.repeat(4096) + '\n\n';

export const registerProgressRoutes: FastifyPluginAsync<Options> = async (app, opts) => {
  const { progressBus } = opts;

  app.get(
    '/api/v1/sessions/:id/progress',
    { preHandler: [requireRole('admin')] },
    async (request, reply) => {
      const { id: sessionId } = request.params as { id: string };
      if (!sessionId) {
        reply.code(400).send({ error: 'session id required' });
        return;
      }

      // Special sentinel: "*" means "tail every session in this
      // process" — uses ProgressBus.subscribeAll() instead of
      // subscribing to a specific bucket. Useful for single-owner
      // admin UIs that want to watch everything live.
      const isWildcard = sessionId === '*';

      log.info(
        {
          sessionId: isWildcard ? '*' : sessionId,
          wildcard: isWildcard,
          userAgent: request.headers['user-agent'],
        },
        'SSE progress subscribe',
      );

      // Establish the SSE stream. writeHead bypasses Fastify's default
      // JSON serialisation. Headers:
      //  - Content-Type: text/event-stream (the SSE contract)
      //  - Cache-Control: no-cache, no-transform (stop CF/nginx from
      //    caching or rewriting the body)
      //  - X-Accel-Buffering: no (disable nginx's proxy buffer)
      //  - Connection: keep-alive (long-lived stream)
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Prime CF/corporate proxy buffers with a padded comment so they
      // flush instead of waiting for the first ~2 KB to accumulate.
      // Without this, tunnels like *.trycloudflare.com sit on the
      // first tool events and the browser sees nothing until minutes
      // later when enough data has accumulated.
      reply.raw.write(CF_FLUSH_PADDING);
      reply.raw.write(': connected\n\n');

      // Synthetic `stream.open` event so the UI has an immediate
      // signal that the backend is subscribed.
      reply.raw.write(
        `data: ${JSON.stringify({
          sessionId: isWildcard ? '*' : sessionId,
          timestamp: Date.now(),
          kind: 'stream.open',
          message: isWildcard
            ? 'Subscribed to ALL sessions (wildcard tail)'
            : `Subscribed to session ${sessionId}`,
        })}\n\n`,
      );

      // TC-4: replay the ring buffer history before entering live
      // mode so a new subscriber lands on "last ~200 events" instead
      // of an empty feed. Events are emitted in chronological order;
      // each one gets a `replayed: true` flag so the UI can render
      // them with a subtle visual marker if it wants to.
      const history = progressBus.getHistory(isWildcard ? undefined : sessionId);
      if (history.length > 0) {
        reply.raw.write(
          `data: ${JSON.stringify({
            sessionId: isWildcard ? '*' : sessionId,
            timestamp: Date.now(),
            kind: 'stream.replay.begin',
            message: `Replaying last ${history.length} events from history buffer`,
            data: { count: history.length },
          })}\n\n`,
        );
        for (const evt of history) {
          try {
            reply.raw.write(`data: ${JSON.stringify({ ...evt, replayed: true })}\n\n`);
          } catch {
            /* client gone — abort replay, live-mode branch will clean up */
            break;
          }
        }
        reply.raw.write(
          `data: ${JSON.stringify({
            sessionId: isWildcard ? '*' : sessionId,
            timestamp: Date.now(),
            kind: 'stream.replay.end',
            message: 'Replay complete — now live',
          })}\n\n`,
        );
      }

      // Subscribe — either to the specific session bucket or the
      // wildcard fan-out.
      const writeEvent = (event: Parameters<Parameters<typeof progressBus.subscribe>[1]>[0]) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          /* client gone — next keepalive will detect + clean up */
        }
      };
      const unsubscribe = isWildcard
        ? progressBus.subscribeAll(writeEvent)
        : progressBus.subscribe(sessionId, writeEvent);

      // Keepalive ping so reverse proxies (nginx, cloudflare) don't
      // close the connection during quiet periods.
      const keepalive = setInterval(() => {
        try {
          reply.raw.write(': keepalive\n\n');
        } catch {
          clearInterval(keepalive);
          unsubscribe();
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepalive.unref();

      // Clean up when the client disconnects.
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        log.info({ sessionId: isWildcard ? '*' : sessionId }, 'SSE progress unsubscribe');
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      };
      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      // Keep the handler alive — Fastify treats the response as "done"
      // when the handler function returns. Returning a never-resolving
      // promise holds the connection open for the lifetime of the SSE
      // stream. Client disconnect resolves via the cleanup path above.
      await new Promise<void>((resolve) => {
        request.raw.on('close', () => resolve());
      });
    },
  );
};
