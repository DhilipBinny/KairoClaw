import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ContainerManager } from '@agw/sandbox';
import { requireRole } from '../auth/middleware.js';

// ws is a transitive dependency via @fastify/websocket — used for upstream proxy connections.
const { WebSocket: WsClient } = require('ws') as { WebSocket: new (url: string) => WebSocket };

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
  app.get('/api/v1/admin/desktop/:userId/status', { preHandler: [requireRole('admin')] }, async (request) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return { error: 'Sandbox not initialized' };

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
      createdAt: container.createdAt,
      uptimeMs: Date.now() - container.createdAt,
    };
  });

  // POST /api/v1/admin/desktop/:userId/start
  app.post('/api/v1/admin/desktop/:userId/start', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const cm = opts.getContainerManager();
    if (!cm) return reply.code(500).send({ error: 'Sandbox not initialized' });

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
        createdAt: c.createdAt,
        uptimeMs: Date.now() - c.createdAt,
      })),
    };
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

  // WS /api/v1/admin/desktop/:userId/vnc — noVNC WebSocket proxy
  app.get('/api/v1/admin/desktop/:userId/vnc', { websocket: true, preHandler: [requireRole('admin')] }, (socket: WebSocket, request: FastifyRequest) => {
    const target = getContainerForWs(request);
    if ('error' in target) { socket.close(1008, target.error); return; }
    proxyWebSocket(socket, target.ip, 6080, '/websockify');
  });

  // WS /api/v1/admin/desktop/:userId/terminal — ttyd WebSocket proxy
  app.get('/api/v1/admin/desktop/:userId/terminal', { websocket: true, preHandler: [requireRole('admin')] }, (socket: WebSocket, request: FastifyRequest) => {
    const target = getContainerForWs(request);
    if ('error' in target) { socket.close(1008, target.error); return; }
    proxyWebSocket(socket, target.ip, 7681, '/ws');
  });
};
