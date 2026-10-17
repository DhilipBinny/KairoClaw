import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetContainerManager = vi.fn();

const mockContainerManager = {
  isDesktopEnabled: vi.fn(),
  getDesktopContainer: vi.fn(),
  getOrCreateDesktop: vi.fn(),
  destroyContainer: vi.fn(),
  listActive: vi.fn().mockReturnValue([]),
};

function resetMocks() {
  vi.clearAllMocks();
  mockGetContainerManager.mockReturnValue(mockContainerManager);
  mockContainerManager.isDesktopEnabled.mockReturnValue(false);
  mockContainerManager.getDesktopContainer.mockReturnValue(null);
  mockContainerManager.listActive.mockReturnValue([]);
}

async function createApp() {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();

  app.decorateRequest('ctx', null);
  app.addHook('preHandler', async (request) => {
    (request as any).ctx = { config: { _stateDir: '/data' } };
  });

  app.addHook('preHandler', async (request) => {
    (request as any).user = { id: 'admin-1', role: 'admin' };
  });

  vi.doMock('../../auth/middleware.js', () => ({
    requireRole: () => async () => {},
  }));

  const { registerDesktopRoutes } = await import('../desktop.js');
  await app.register(registerDesktopRoutes, {
    getContainerManager: mockGetContainerManager,
  });

  return app;
}

beforeEach(resetMocks);

describe('desktop routes', () => {
  describe('GET /status', () => {
    it('returns 503 when container manager is null', async () => {
      mockGetContainerManager.mockReturnValue(null);
      const app = await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/desktop/user-1/status',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain('not initialized');
    });

    it('returns stopped status when no container running', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/desktop/user-1/status',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('stopped');
    });

    it('returns running status with hostPorts when container exists', async () => {
      mockContainerManager.getDesktopContainer.mockReturnValue({
        containerId: 'abc123def456',
        containerIp: '172.17.0.5',
        hostPorts: { '6080/tcp': 32768 },
        desktopSecrets: { vncPassword: 'pw', sessionToken: 'tok' },
        createdAt: Date.now() - 60000,
      });
      const app = await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/desktop/user-1/status',
      });

      const body = res.json();
      expect(body.status).toBe('running');
      expect(body.hostPorts).toEqual({ '6080/tcp': 32768 });
      expect(body.desktopSecrets).toEqual({ vncPassword: 'pw', sessionToken: 'tok' });
    });
  });

  describe('POST /start', () => {
    it('returns 500 when container manager is null', async () => {
      mockGetContainerManager.mockReturnValue(null);
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/desktop/user-1/start',
      });

      expect(res.statusCode).toBe(500);
    });

    it('returns 403 when desktop not enabled for user', async () => {
      mockContainerManager.isDesktopEnabled.mockReturnValue(false);
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/desktop/user-1/start',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('not enabled');
    });

    it('starts desktop when user is enabled', async () => {
      mockContainerManager.isDesktopEnabled.mockReturnValue(true);
      mockContainerManager.getOrCreateDesktop.mockResolvedValue({
        containerId: 'abc123def456',
        containerIp: '172.17.0.5',
        hostPorts: { '6080/tcp': 32768 },
        desktopSecrets: { vncPassword: 'pw', sessionToken: 'tok' },
      });
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/desktop/user-1/start',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('running');
      expect(mockContainerManager.getOrCreateDesktop).toHaveBeenCalledOnce();
    });
  });

  describe('POST /stop', () => {
    it('returns 404 when no container running', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/desktop/user-1/stop',
      });

      expect(res.statusCode).toBe(404);
    });

    it('stops desktop container', async () => {
      mockContainerManager.getDesktopContainer.mockReturnValue({
        containerId: 'abc123',
      });
      const app = await createApp();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/desktop/user-1/stop',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('stopped');
      expect(mockContainerManager.destroyContainer).toHaveBeenCalledWith('desktop:user-1');
    });
  });

  describe('GET /list', () => {
    it('returns empty list when no containers', async () => {
      const app = await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/desktop/list',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().containers).toEqual([]);
    });

    it('returns only desktop containers', async () => {
      mockContainerManager.listActive.mockReturnValue([
        { userId: 'alice', containerId: 'abc123def456', desktop: true, createdAt: Date.now() },
        { userId: 'bob', containerId: 'def456abc123', desktop: false, createdAt: Date.now() },
      ]);
      const app = await createApp();

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/desktop/list',
      });

      const containers = res.json().containers;
      expect(containers).toHaveLength(1);
      expect(containers[0].userId).toBe('alice');
    });
  });
});
