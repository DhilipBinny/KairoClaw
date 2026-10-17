import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ContainerManager } from '@agw/sandbox';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { requireRole } from '../auth/middleware.js';

const _require = createRequire(import.meta.url);
const { WebSocket: WsClient } = _require('ws') as { WebSocket: new (url: string) => WebSocket };

// Workspace auth: one-time codes (exchanged for cookies) + session cookies
const WS_TTL_MS = 5 * 60 * 1000;
const WS_COOKIE = 'kairo_ws';
const workspaceCodes = new Map<string, { userId: string; expiresAt: number }>();
const workspaceSessions = new Map<string, { userId: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of workspaceCodes) { if (now > v.expiresAt) workspaceCodes.delete(k); }
  for (const [k, v] of workspaceSessions) { if (now > v.expiresAt) workspaceSessions.delete(k); }
}, 60_000).unref();

/**
 * Desktop workspace routes — WebSocket proxy for noVNC, terminal, and file API.
 *
 * All routes require admin role. The WebSocket proxy connects to the container's
 * internal IP on the Docker bridge network — no container ports are exposed to
 * the host.
 */
export const registerDesktopRoutes: FastifyPluginAsync<{
  getContainerManager: () => ContainerManager | null;
}> = async (app, opts) => {

  // GET /api/v1/admin/desktop/:userId/status
  app.get('/api/v1/admin/desktop/:userId/status', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return reply.code(503).send({ error: 'Sandbox not initialized' });

    const container = cm.getDesktopContainer(userId);
    if (!container) {
      return { status: 'stopped', userId, desktop: cm.isDesktopEnabled(userId) };
    }

    return {
      status: 'running',
      userId,
      desktop: true,
      containerId: container.containerId.slice(0, 12),
      containerIp: container.containerIp,
      hostPorts: container.hostPorts,
      desktopSecrets: container.desktopSecrets,
      createdAt: container.createdAt,
      uptimeMs: Date.now() - container.createdAt,
    };
  });

  // POST /api/v1/admin/desktop/:userId/start
  app.post('/api/v1/admin/desktop/:userId/start', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return reply.code(500).send({ error: 'Sandbox not initialized' });

    if (!cm.isDesktopEnabled(userId)) {
      return reply.code(403).send({ error: 'Desktop not enabled for this user. Enable it in the user list first.' });
    }

    const config = (request as any).ctx?.config;
    const workspacePath = config?._stateDir ? `${config._stateDir}/workspace` : '/data/workspace';

    try {
      const container = await cm.getOrCreateDesktop({
        userId,
        workspacePath,
        scopeKey: null,
        isAdmin: true,
      });

      return {
        status: 'running',
        containerId: container.containerId.slice(0, 12),
        containerIp: container.containerIp,
        hostPorts: container.hostPorts,
        desktopSecrets: container.desktopSecrets,
      };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /api/v1/admin/desktop/:userId/stop
  app.post('/api/v1/admin/desktop/:userId/stop', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return reply.code(500).send({ error: 'Sandbox not initialized' });

    const container = cm.getDesktopContainer(userId);
    if (!container) return reply.code(404).send({ error: 'No desktop container for this user' });

    await cm.destroyContainer(`desktop:${userId}`);
    return { status: 'stopped' };
  });

  // GET /api/v1/admin/desktop/list — list all desktop containers
  app.get('/api/v1/admin/desktop/list', { preHandler: [requireRole('admin')] }, async () => {
    const cm = opts.getContainerManager();
    if (!cm) return { containers: [] };

    const all = cm.listActive().filter(c => c.desktop);
    return {
      containers: all.map(c => ({
        userId: c.userId,
        containerId: c.containerId.slice(0, 12),
        containerIp: c.containerIp,
        hostPorts: c.hostPorts,
        desktopSecrets: c.desktopSecrets,
        createdAt: c.createdAt,
        uptimeMs: Date.now() - c.createdAt,
      })),
    };
  });

  // ── HTTP proxy routes (workspace + file server) ───────

  function getContainerForHttp(request: FastifyRequest): { ip: string; secrets?: { vncPassword: string; sessionToken: string } } | { error: string } {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return { error: 'Sandbox not initialized' };
    const container = cm.getDesktopContainer(userId);
    if (!container) return { error: 'No desktop container running' };
    if (!container.containerIp) return { error: 'Container IP not available' };
    return { ip: container.containerIp, secrets: container.desktopSecrets };
  }

  // Generate one-time workspace code (admin-only, exchanged for cookie on first use)
  app.post('/api/v1/admin/desktop/:userId/workspace-token', { preHandler: [requireRole('admin')] }, async (request) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return { error: 'Sandbox not initialized' };
    if (!cm.getDesktopContainer(userId)) return { error: 'No desktop container running' };
    const code = randomBytes(32).toString('base64url');
    workspaceCodes.set(code, { userId, expiresAt: Date.now() + 60_000 });
    return { token: code, expiresIn: 60 };
  });

  // Exchange one-time code for HttpOnly session cookie, then redirect to clean URL
  app.get('/api/v1/admin/desktop/:userId/workspace-auth', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const code = (request.query as Record<string, string>).code;
    if (!code) return reply.code(401).send({ error: 'Missing code' });
    const entry = workspaceCodes.get(code);
    if (!entry || entry.userId !== userId || Date.now() > entry.expiresAt) {
      return reply.code(401).send({ error: 'Invalid or expired code' });
    }
    workspaceCodes.delete(code);

    const sessionId = randomBytes(32).toString('base64url');
    workspaceSessions.set(sessionId, { userId, expiresAt: Date.now() + WS_TTL_MS });

    const cookiePath = `/api/v1/admin/desktop/${userId}/`;
    const isSecure = request.headers['x-forwarded-proto'] === 'https' || request.protocol === 'https';
    const maxAge = Math.floor(WS_TTL_MS / 1000);
    const parts = [`${WS_COOKIE}=${sessionId}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (isSecure) parts.push('Secure');
    reply
      .header('set-cookie', parts.join('; '))
      .header('referrer-policy', 'no-referrer')
      .redirect(`/api/v1/admin/desktop/${userId}/workspace/`);
  });

  // Validate workspace session cookie
  async function requireWorkspaceToken(request: FastifyRequest, reply: import('fastify').FastifyReply) {
    const { userId } = request.params as { userId: string };
    const cookies = parseCookies(request.headers.cookie || '');
    const sessionId = cookies[WS_COOKIE];
    if (!sessionId) { reply.code(401).send({ error: 'Workspace session required. Open from the admin Desktop page.' }); return; }
    const session = workspaceSessions.get(sessionId);
    if (!session || session.userId !== userId || Date.now() > session.expiresAt) {
      reply.code(401).send({ error: 'Workspace session expired. Go back to the admin Desktop page and click Open again.' });
      return;
    }
  }

  function parseCookies(header: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return result;
  }

  // Serve custom config.js with proxy URLs (secrets via workspace token, not API key)
  app.get('/api/v1/admin/desktop/:userId/workspace/config.js', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const { userId } = request.params as { userId: string };
    const proxyBase = `/api/v1/admin/desktop/${userId}`;
    const js = `window.DESKTOP_CONFIG = {
  proxyMode: true,
  proxyBase: "${proxyBase}",
  vncPassword: "${target.secrets?.vncPassword || ''}",
  sessionToken: "${target.secrets?.sessionToken || ''}"
};`;
    reply.header('content-type', 'application/javascript').send(js);
  });

  // Proxy workspace static files (HTML, noVNC JS/CSS) from container port 6080
  // CSP sandbox isolates container content from the admin origin's cookies/storage
  const WORKSPACE_CSP = "sandbox allow-scripts allow-same-origin allow-forms; default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'";

  // Redirect /workspace to /workspace/ so relative URLs (config.js, vnc_lite.html) resolve correctly
  app.get('/api/v1/admin/desktop/:userId/workspace', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    reply.redirect(`/api/v1/admin/desktop/${userId}/workspace/`);
  });

  app.get('/api/v1/admin/desktop/:userId/workspace/', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const resp = await fetch(`http://${target.ip}:6080/`);
    reply.code(resp.status)
      .header('content-type', resp.headers.get('content-type') || 'text/html')
      .header('content-security-policy', WORKSPACE_CSP)
      .header('x-content-type-options', 'nosniff');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  });

  app.get('/api/v1/admin/desktop/:userId/workspace/*', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const path = (request.params as Record<string, string>)['*'];
    const resp = await fetch(`http://${target.ip}:6080/${path}`);
    reply.code(resp.status)
      .header('content-type', resp.headers.get('content-type') || 'application/octet-stream')
      .header('content-security-policy', WORKSPACE_CSP)
      .header('x-content-type-options', 'nosniff');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  });

  // Proxy file server operations from container port 8090
  // Root listing — registered at both /files and /files/ since Fastify's
  // wildcard /files/* requires ≥1 char and won't match the trailing slash
  const fileRootHandler = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const resp = await fetch(`http://${target.ip}:8090/`, {
      headers: { 'X-Desktop-Token': target.secrets?.sessionToken || '' },
    });
    reply.code(resp.status).header('content-type', 'application/json').header('x-content-type-options', 'nosniff');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  };
  app.get('/api/v1/admin/desktop/:userId/files', { preHandler: [requireWorkspaceToken] }, fileRootHandler);
  app.get('/api/v1/admin/desktop/:userId/files/', { preHandler: [requireWorkspaceToken] }, fileRootHandler);

  app.get('/api/v1/admin/desktop/:userId/files/*', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const path = (request.params as Record<string, string>)['*'];
    const resp = await fetch(`http://${target.ip}:8090/${path}`, {
      headers: { 'X-Desktop-Token': target.secrets?.sessionToken || '' },
    });
    const isDownload = path.startsWith('download/');
    reply.code(resp.status)
      .header('content-type', isDownload ? 'application/octet-stream' : 'application/json')
      .header('x-content-type-options', 'nosniff');
    if (isDownload) reply.header('content-disposition', 'attachment');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  });

  app.post('/api/v1/admin/desktop/:userId/files/*', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const path = (request.params as Record<string, string>)['*'];
    const headers: Record<string, string> = { 'X-Desktop-Token': target.secrets?.sessionToken || '' };
    const contentType = request.headers['content-type'];
    if (contentType) headers['content-type'] = contentType;
    const resp = await fetch(`http://${target.ip}:8090/${path}`, {
      method: 'POST',
      headers,
      body: request.body as any,
    });
    reply.code(resp.status).header('content-type', 'application/json');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  });

  app.delete('/api/v1/admin/desktop/:userId/files/*', { preHandler: [requireWorkspaceToken] }, async (request, reply) => {
    const target = getContainerForHttp(request);
    if ('error' in target) return reply.code(404).send({ error: target.error });
    const path = (request.params as Record<string, string>)['*'];
    const resp = await fetch(`http://${target.ip}:8090/${path}`, {
      method: 'DELETE',
      headers: { 'X-Desktop-Token': target.secrets?.sessionToken || '' },
    });
    reply.code(resp.status).header('content-type', 'application/json');
    reply.send(Buffer.from(await resp.arrayBuffer()));
  });

  // ── WebSocket proxy routes ────────────────────────────

  /**
   * Proxy WebSocket to a container's internal port.
   * Creates a ws connection to container_ip:port and pipes data bidirectionally.
   */
  function proxyWebSocket(clientSocket: WebSocket, containerIp: string, port: number, path?: string) {
    const targetUrl = `ws://${containerIp}:${port}${path || ''}`;
    const upstream = new WsClient(targetUrl);

    upstream.on('open', () => {
      clientSocket.on('message', (data: Buffer) => {
        if (upstream.readyState === 1) {
          upstream.send(data);
        }
      });

      upstream.on('message', (data: Buffer) => {
        if (clientSocket.readyState === 1) {
          clientSocket.send(data);
        }
      });
    });

    upstream.on('error', () => { try { clientSocket.close(); } catch {} });
    upstream.on('close', () => { try { clientSocket.close(); } catch {} });
    clientSocket.on('close', () => { try { upstream.close(); } catch {} });
    clientSocket.on('error', () => { try { upstream.close(); } catch {} });
  }

  function validateWsOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // Non-browser clients (curl, agents) don't send Origin
    try {
      const parsed = new URL(origin);
      const host = request.headers.host || '';
      return parsed.host === host;
    } catch { return false; }
  }

  function getContainerForWs(request: FastifyRequest): { ip: string } | { error: string } {
    if (!validateWsOrigin(request)) return { error: 'Origin not allowed' };
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return { error: 'Sandbox not initialized' };

    const container = cm.getDesktopContainer(userId);
    if (!container) return { error: 'No desktop container running' };
    if (!container.containerIp) return { error: 'Container IP not available' };

    return { ip: container.containerIp };
  }

  // Accept admin API key OR workspace session cookie for WS routes
  const adminMiddleware = requireRole('admin');
  async function requireAdminOrWorkspaceToken(request: FastifyRequest, reply: import('fastify').FastifyReply) {
    const { userId } = request.params as { userId: string };
    const cookies = parseCookies(request.headers.cookie || '');
    const sessionId = cookies[WS_COOKIE];
    if (sessionId) {
      const session = workspaceSessions.get(sessionId);
      if (session && session.userId === userId && Date.now() <= session.expiresAt) return;
    }
    await adminMiddleware(request, reply);
  }

  // WS /api/v1/admin/desktop/:userId/vnc — noVNC WebSocket proxy
  app.get('/api/v1/admin/desktop/:userId/vnc', { websocket: true, preHandler: [requireAdminOrWorkspaceToken] }, (socket: WebSocket, request: FastifyRequest) => {
    const target = getContainerForWs(request);
    if ('error' in target) { socket.close(1008, target.error); return; }
    proxyWebSocket(socket, target.ip, 6080, '/websockify');
  });

  // WS /api/v1/admin/desktop/:userId/terminal — ttyd WebSocket proxy
  app.get('/api/v1/admin/desktop/:userId/terminal', { websocket: true, preHandler: [requireAdminOrWorkspaceToken] }, (socket: WebSocket, request: FastifyRequest) => {
    const target = getContainerForWs(request);
    if ('error' in target) { socket.close(1008, target.error); return; }
    proxyWebSocket(socket, target.ip, 7681, '/ws');
  });
};
