import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseAdapter } from '../db/index.js';
import { UserRepository } from '../db/repositories/user.js';
import { SenderLinkRepository } from '../db/repositories/sender-link.js';
import { UsageRepository } from '../db/repositories/usage.js';
import { SessionRepository } from '../db/repositories/session.js';
import { requireRole } from '../auth/middleware.js';
import { generateApiKey, hashApiKey } from '../auth/keys.js';

function getDb(request: unknown): DatabaseAdapter {
  return (request as { ctx: { db: DatabaseAdapter } }).ctx.db;
}

export const registerUserRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/admin/users — list all users with stats
  app.get('/api/v1/admin/users', { preHandler: [requireRole('admin')] }, async (request) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';

    const userRepo = new UserRepository(db);
    const senderLinkRepo = new SenderLinkRepository(db);
    const usageRepo = new UsageRepository(db);
    const sessionRepo = new SessionRepository(db);

    const users = await userRepo.listByTenant(tenantId);
    const allLinks = await senderLinkRepo.listByTenant(tenantId);
    const allUsage = await usageRepo.summarizeAllUsers(tenantId, 30);

    // Get session counts per user
    const sessionCounts = await db.query<{ user_id: string; count: number }>(
      'SELECT user_id, COUNT(*) as count FROM sessions WHERE tenant_id = ? AND user_id IS NOT NULL GROUP BY user_id',
      [tenantId],
    );
    const sessionMap = new Map(sessionCounts.map(r => [r.user_id, r.count]));
    const usageMap = new Map(allUsage.map(r => [r.user_id, r]));

    return users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      elevated: !!u.elevated,
      active: !!u.active,
      deactivated_at: u.deactivated_at,
      created_at: u.created_at,
      updated_at: u.updated_at,
      session_count: sessionMap.get(u.id) || 0,
      sender_links: allLinks.filter(l => l.user_id === u.id).map(l => ({
        id: l.id,
        channel_type: l.channel_type,
        sender_id: l.sender_id,
      })),
      usage: usageMap.get(u.id) || { total_input: 0, total_output: 0, total_cost: 0, request_count: 0 },
    }));
  });

  // POST /api/v1/admin/users — create user (returns API key ONCE)
  app.post('/api/v1/admin/users', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { name, email, role, elevated } = (request.body as {
      name: string; email?: string; role?: string; elevated?: boolean;
    }) || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' });
    }

    const validRoles = ['admin', 'user'];
    const userRole = role && validRoles.includes(role) ? role : 'user';

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const userRepo = new UserRepository(db);
    const user = await userRepo.create({
      tenantId,
      name: name.trim(),
      email: email?.trim() || undefined,
      role: userRole,
      apiKeyHash,
    });

    // Set elevated if requested
    if (elevated) {
      await userRepo.update(user.id, { elevated: 1 });
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        elevated: !!elevated,
        active: true,
      },
      api_key: apiKey, // Returned ONCE — not stored in plaintext
    };
  });

  // GET /api/v1/admin/users/:id — user detail
  app.get('/api/v1/admin/users/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const senderLinkRepo = new SenderLinkRepository(db);
    const usageRepo = new UsageRepository(db);

    const links = await senderLinkRepo.listByUser(tenantId, id);
    const usage = await usageRepo.summarizeByUser(tenantId, id, 30);

    const sessionCount = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM sessions WHERE tenant_id = ? AND user_id = ?',
      [tenantId, id],
    );

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      elevated: !!user.elevated,
      active: !!user.active,
      deactivated_at: user.deactivated_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
      session_count: sessionCount?.count || 0,
      sender_links: links.map(l => ({
        id: l.id,
        channel_type: l.channel_type,
        sender_id: l.sender_id,
        linked_at: l.linked_at,
      })),
      usage,
    };
  });

  // PATCH /api/v1/admin/users/:id — update user
  app.patch('/api/v1/admin/users/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; email?: string; role?: string; elevated?: boolean };

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    // Prevent self-demotion (admin can't remove their own admin role)
    if (id === request.user?.id && body.role && body.role !== 'admin') {
      return reply.code(400).send({ error: 'Cannot change your own role' });
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.email !== undefined) updates.email = body.email.trim() || null;
    if (body.role !== undefined && ['admin', 'user'].includes(body.role)) updates.role = body.role;
    if (body.elevated !== undefined) updates.elevated = body.elevated ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      await userRepo.update(id, updates as any);
    }

    return { success: true };
  });

  // DELETE /api/v1/admin/users/:id — deactivate (soft delete)
  app.delete('/api/v1/admin/users/:id', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    // Prevent self-deactivation
    if (id === request.user?.id) {
      return reply.code(400).send({ error: 'Cannot deactivate yourself' });
    }

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    await userRepo.deactivate(id, tenantId);

    // Remove sender links so deactivated user can't message via channels
    const senderLinkRepo = new SenderLinkRepository(db);
    const links = await senderLinkRepo.listByUser(tenantId, id);
    for (const link of links) {
      await senderLinkRepo.unlink(link.id, tenantId);
    }

    return { success: true };
  });

  // DELETE /api/v1/admin/users/:id/permanent — hard delete
  app.delete('/api/v1/admin/users/:id/permanent', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    if (id === request.user?.id) {
      return reply.code(400).send({ error: 'Cannot delete yourself' });
    }

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    await userRepo.hardDelete(id, tenantId);
    return { success: true };
  });

  // POST /api/v1/admin/users/:id/reactivate — reactivate user
  app.post('/api/v1/admin/users/:id/reactivate', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    await userRepo.reactivate(id, tenantId);
    return { success: true };
  });

  // POST /api/v1/admin/users/:id/api-key — regenerate API key
  app.post('/api/v1/admin/users/:id/api-key', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    await userRepo.update(id, { apiKeyHash });

    return { api_key: apiKey }; // Returned ONCE
  });

  // GET /api/v1/admin/users/:id/sender-links — list linked senders
  app.get('/api/v1/admin/users/:id/sender-links', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };

    const senderLinkRepo = new SenderLinkRepository(db);
    return await senderLinkRepo.listByUser(tenantId, id);
  });

  // POST /api/v1/admin/users/:id/sender-links — link a sender
  app.post('/api/v1/admin/users/:id/sender-links', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { id } = request.params as { id: string };
    const { channelType, senderId } = (request.body as { channelType: string; senderId: string }) || {};

    if (!channelType || !senderId) {
      return reply.code(400).send({ error: 'channelType and senderId are required' });
    }

    const userRepo = new UserRepository(db);
    const user = await userRepo.getById(id, tenantId);
    if (!user) return reply.code(404).send({ error: 'User not found' });

    const senderLinkRepo = new SenderLinkRepository(db);
    const link = await senderLinkRepo.link({
      tenantId,
      channelType,
      senderId,
      userId: id,
      linkedBy: request.user?.id,
    });

    return link;
  });

  // DELETE /api/v1/admin/users/:id/sender-links/:linkId — unlink
  app.delete('/api/v1/admin/users/:id/sender-links/:linkId', { preHandler: [requireRole('admin')] }, async (request, reply) => {
    const db = getDb(request);
    const tenantId = request.tenantId || 'default';
    const { linkId } = request.params as { id: string; linkId: string };

    const senderLinkRepo = new SenderLinkRepository(db);
    const link = await senderLinkRepo.getById(Number(linkId), tenantId);
    if (!link) return reply.code(404).send({ error: 'Link not found' });

    await senderLinkRepo.unlink(Number(linkId), tenantId);
    return { success: true };
  });
};
