import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/middleware.js';
import { getConfig } from './utils.js';
import type { ContainerManager } from '@agw/sandbox';

export const registerSandboxRoutes: FastifyPluginAsync<{
  getContainerManager: () => ContainerManager | null;
}> = async (app, opts) => {

  app.get('/api/v1/admin/sandbox/status', { preHandler: [requireRole('admin')] }, async (request) => {
    const cm = opts.getContainerManager();
    const config = getConfig(request);
    const sandboxConfig = config.tools?.sandbox;

    if (!cm || !sandboxConfig?.enabled) {
      return {
        enabled: sandboxConfig?.enabled ?? false,
        ready: false,
        reason: !sandboxConfig?.enabled ? 'Sandbox disabled in config' : 'Container manager not initialized',
        containers: [],
      };
    }

    const readiness = await cm.isReady();
    const active = cm.listActive().map(c => ({
      containerId: c.containerId.slice(0, 12),
      userId: c.userId,
      sessionId: c.sessionId,
      image: c.image,
      network: c.network,
      workspace: c.workspace,
      createdAt: c.createdAt,
      uptimeMs: Date.now() - c.createdAt,
    }));

    return {
      enabled: true,
      ready: readiness.ready,
      reason: readiness.reason,
      image: sandboxConfig.image,
      defaults: sandboxConfig.defaults,
      containers: active,
    };
  });

  app.post('/api/v1/admin/sandbox/stop/:userId/:sessionId', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const cm = opts.getContainerManager();
    if (!cm) {
      return reply.code(503).send({ error: 'Sandbox not available' });
    }

    const { userId, sessionId } = request.params as { userId: string; sessionId: string };
    if (!cm.hasContainer(userId, sessionId)) {
      return reply.code(404).send({ error: 'Container not found' });
    }

    await cm.destroyForSession(userId, sessionId);
    return { ok: true, message: `Container for ${userId}/${sessionId} stopped` };
  });

  app.post('/api/v1/admin/sandbox/stop-all', { preHandler: [requireRole('admin')] }, async (_request, reply) => {
    const cm = opts.getContainerManager();
    if (!cm) {
      return reply.code(503).send({ error: 'Sandbox not available' });
    }

    const count = cm.listActive().length;
    await cm.destroyAll();
    return { ok: true, message: `Stopped ${count} container(s)` };
  });
};
