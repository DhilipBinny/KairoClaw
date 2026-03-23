import type { FastifyPluginAsync } from 'fastify';
import type { MCPServerConfig } from '@agw/types';
import { MCPBridge } from '../mcp/bridge.js';
import { searchMCPRegistry } from '../mcp/catalog.js';
import type { AuditService } from '../security/audit.js';
import { requireRole } from '../auth/middleware.js';

export const registerMCPRoutes: FastifyPluginAsync<{ auditService?: AuditService; mcpBridge?: MCPBridge }> = async (app, opts) => {
  const auditService = opts?.auditService;
  const bridge = opts?.mcpBridge;

  if (!bridge) {
    throw new Error('mcpBridge must be provided to MCP routes');
  }

  // GET /api/v1/mcp/servers — list servers with status
  app.get('/api/v1/mcp/servers', { preHandler: [requireRole('admin')] }, async () => {
    return bridge.getStatus();
  });

  // POST /api/v1/mcp/servers — install/enable a server
  app.post('/api/v1/mcp/servers', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const body = request.body as { id?: string } & Partial<MCPServerConfig> & { _fromCatalog?: string };
    const id = body.id;
    if (!id) {
      return reply.code(400).send({ error: 'id is required' });
    }

    // Separate user-provided env values from template config
    const userEnv = body.env || {};

    const serverConfig: MCPServerConfig = {
      enabled: true,
      transport: body.transport || 'stdio',
      command: body.command,
      args: body.args,
      url: body.url,
      env: {},
      headers: body.headers,
    };

    if (!serverConfig.command && !serverConfig.url) {
      return reply.code(400).send({ error: 'Server config must have "command" (stdio) or "url" (sse)' });
    }

    // Save user-provided env values to secrets file (not config)
    if (Object.keys(userEnv).length > 0 && bridge.secretsStore) {
      bridge.secretsStore.setServerSecrets(id, userEnv);
    }

    try {
      const tenantId = request.tenantId || 'default';
      const status = await bridge.enableServer(id, serverConfig);
      // Audit: mcp.install
      try {
        auditService?.log({
          tenantId,
          userId: request.user?.id,
          action: 'mcp.install',
          resource: id,
          details: { transport: serverConfig.transport },
          ipAddress: request.ip,
        });
      } catch { /* audit should not break MCP install */ }
      return { success: true, installing: true, status };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // DELETE /api/v1/mcp/servers/:id — remove server
  app.delete('/api/v1/mcp/servers/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await bridge.removeServer(id);
      return { success: true };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // POST /api/v1/mcp/servers/:id/reconnect — reconnect
  app.post('/api/v1/mcp/servers/:id/reconnect', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const status = await bridge.reconnectServer(id);
      return { success: true, status };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // POST /api/v1/mcp/servers/:id/disable — disable an MCP server
  app.post('/api/v1/mcp/servers/:id/disable', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await bridge.disableServer(id);
      return { success: true };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // POST /api/v1/mcp/servers/:id/enable — re-enable a disabled MCP server
  app.post('/api/v1/mcp/servers/:id/enable', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const serverConfig = bridge.getServerConfig(id);
      if (!serverConfig) {
        return reply.code(404).send({ error: `Server "${id}" not found` });
      }
      const status = await bridge.enableServer(id, { ...serverConfig, enabled: true });
      return { success: true, status };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // PATCH /api/v1/mcp/servers/:id — update server env vars (saved to secrets file)
  app.patch('/api/v1/mcp/servers/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { env?: Record<string, string> };

    const serverConfig = bridge.getServerConfig(id);
    if (!serverConfig) {
      return reply.code(404).send({ error: `Server "${id}" not found` });
    }

    // Save env values to secrets file
    if (body.env && bridge.secretsStore) {
      bridge.secretsStore.setServerSecrets(id, body.env);
    }

    // Reconnect with new env if server was enabled
    if (serverConfig.enabled) {
      try {
        await bridge.reconnectServer(id);
      } catch {
        // Reconnect fires in background, ignore
      }
    }

    return { success: true };
  });

  // GET /api/v1/mcp/marketplace — registry search (also serves as default listing)
  app.get('/api/v1/mcp/marketplace', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const query = (request.query as any)?.search || '';
    const limit = Math.min(parseInt((request.query as any)?.limit || '20'), 50);
    const cursor = (request.query as any)?.cursor || undefined;

    try {
      const result = await searchMCPRegistry(query, limit, cursor);
      return result;
    } catch (e) {
      const err = e as Error;
      if (err.message === 'Registry request timed out') {
        return reply.code(504).send({ error: 'Registry request timed out' });
      }
      return reply.code(500).send({ error: err.message });
    }
  });
};
