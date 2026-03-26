import type { FastifyPluginAsync } from 'fastify';
import type { MCPServerConfig } from '@agw/types';
import { MCPBridge } from '../mcp/bridge.js';
import { MCP_CATALOG, searchMCPRegistry } from '../mcp/catalog.js';
import type { AuditService } from '../security/audit.js';
import { requireRole } from '../auth/middleware.js';
import { getTenantId } from './utils.js';

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
    const body = request.body as { id?: string } & Partial<MCPServerConfig>;
    const id = body.id;
    if (!id) {
      return reply.code(400).send({ error: 'id is required' });
    }

    // Separate user-provided env values from template config
    const userEnv = body.env || {};

    // If from catalog, use catalog defaults for command/args
    const catalogEntry = MCP_CATALOG[id];
    let serverConfig: MCPServerConfig;

    if (catalogEntry && !body.command && !body.url) {
      // Build env template with ${VAR} placeholders for config.json
      const envTemplate: Record<string, string> = {};
      for (const spec of catalogEntry.envVars) {
        envTemplate[spec.key] = `\${${spec.key}}`;
      }
      serverConfig = {
        enabled: true,
        transport: catalogEntry.transport,
        command: catalogEntry.command,
        args: [...catalogEntry.args],
        env: envTemplate,
      };
    } else {
      serverConfig = {
        enabled: true,
        transport: body.transport || 'stdio',
        command: body.command,
        args: body.args,
        url: body.url,
        env: {},
        headers: body.headers,
      };
    }

    if (!serverConfig.command && !serverConfig.url) {
      return reply.code(400).send({ error: 'Server config must have "command" (stdio) or "url" (sse)' });
    }

    // Save user-provided env values to encrypted secrets store
    if (Object.keys(userEnv).length > 0 && bridge.secretsStore) {
      await bridge.secretsStore.setServerSecrets(id, userEnv);
    }

    // Validate required env vars (from catalog spec)
    if (catalogEntry?.envVars) {
      const secretsSet = bridge.secretsStore?.getServerSecrets(id) || {};
      const missing = catalogEntry.envVars
        .filter(v => v.required)
        .filter(v => !userEnv[v.key] && !secretsSet[v.key] && !process.env[v.key]);
      if (missing.length > 0) {
        return reply.code(400).send({
          error: `Missing required: ${missing.map(v => v.label).join(', ')}`,
          missingEnvVars: missing.map(v => ({ key: v.key, label: v.label })),
        });
      }
    }

    try {
      const tenantId = getTenantId(request);
      const status = await bridge.enableServer(id, serverConfig);
      try {
        await auditService?.log({
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

  // POST /api/v1/mcp/servers/:id/reconnect
  app.post('/api/v1/mcp/servers/:id/reconnect', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const status = await bridge.reconnectServer(id);
      return { success: true, status };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // POST /api/v1/mcp/servers/:id/disable
  app.post('/api/v1/mcp/servers/:id/disable', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await bridge.disableServer(id);
      return { success: true };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // POST /api/v1/mcp/servers/:id/enable
  app.post('/api/v1/mcp/servers/:id/enable', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const serverConfig = bridge.getServerConfig(id);
      if (!serverConfig) return reply.code(404).send({ error: `Server "${id}" not found` });
      const status = await bridge.enableServer(id, { ...serverConfig, enabled: true });
      return { success: true, status };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // PATCH /api/v1/mcp/servers/:id — update server env vars
  app.patch('/api/v1/mcp/servers/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { env?: Record<string, string> };
    const serverConfig = bridge.getServerConfig(id);
    if (!serverConfig) return reply.code(404).send({ error: `Server "${id}" not found` });

    if (body.env && bridge.secretsStore) {
      await bridge.secretsStore.setServerSecrets(id, body.env);
    }

    if (serverConfig.enabled) {
      try { await bridge.reconnectServer(id); } catch { /* background */ }
    }
    return { success: true };
  });

  // GET /api/v1/mcp/catalog — local curated catalog (no network needed)
  app.get('/api/v1/mcp/catalog', { preHandler: [requireRole('admin')] }, async () => {
    const status = bridge.getStatus();
    const installedIds = new Set(Object.keys(status.servers));

    const catalog = Object.entries(MCP_CATALOG).map(([id, entry]) => {
      const secretKeys = bridge.secretsStore?.getSetKeys(id) || {};
      const envStatus: Record<string, boolean> = {};
      for (const spec of entry.envVars) {
        envStatus[spec.key] = !!secretKeys[spec.key] || !!process.env[spec.key];
      }
      return {
        id,
        ...entry,
        installed: installedIds.has(id),
        enabled: status.servers[id]?.config?.enabled ?? false,
        envStatus,
      };
    });

    return { catalog };
  });

  // GET /api/v1/mcp/marketplace — live registry search (with cache + retry)
  app.get('/api/v1/mcp/marketplace', { preHandler: [requireRole('admin')] }, async (request, _reply) => {
    const query = (request.query as any)?.search || '';
    const limit = Math.min(parseInt((request.query as any)?.limit || '20'), 50);
    const cursor = (request.query as any)?.cursor || undefined;

    try {
      return await searchMCPRegistry(query, limit, cursor);
    } catch (e) {
      return { servers: [], nextCursor: null, total: 0, error: (e as Error).message };
    }
  });
};
