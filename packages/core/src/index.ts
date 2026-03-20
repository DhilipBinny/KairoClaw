import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InboundMessage, AgentCallbacks, AgentResult } from '@agw/types';
import type { Logger } from 'pino';
import { loadConfig, CONFIG_PATH } from './config/loader.js';
import { createDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { migrateV1Data, migrateDbMcpToConfig } from './db/migrate-v1.js';
import { createServer } from './server.js';
import { authPlugin } from './auth/middleware.js';
import { ProviderRegistry } from './providers/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/builtin/index.js';
import { setMemorySystem } from './tools/builtin/memory.js';
import { MemorySystem } from './memory/index.js';
import { MCPBridge } from './mcp/bridge.js';
import { SecretsStore } from './secrets/store.js';
import { migrateToSecretsStore } from './secrets/migrate.js';
import { runAgent } from './agent/loop.js';
import { SessionRepository } from './db/repositories/session.js';
import { CronScheduler } from './cron/scheduler.js';
import { broadcastToWeb, stopWebchatCleanup } from './channels/webchat.js';
import { createTelegramChannel } from './channels/telegram.js';
import type { TelegramChannelInstance } from './channels/telegram.js';
import { createWhatsAppChannel } from './channels/whatsapp.js';
import type { WhatsAppChannelInstance } from './channels/whatsapp.js';
import type { AgentRunner } from './channels/types.js';

// Routes
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerMCPRoutes } from './routes/mcp.js';
import { chatRoutes } from './routes/chat.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerCronRoutes } from './routes/cron.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWhatsAppRoutes } from './routes/whatsapp.js';
import { registerChannelRoutes } from './routes/channels.js';
import { webchatPlugin } from './channels/webchat.js';
import { AuditService } from './security/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');

// ─── Process-level crash protection ─────────────────────────
// Log but do NOT crash the process for unhandled errors.
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  setTimeout(() => process.exit(1), 1000);
});

async function main(): Promise<void> {
  // 1. Load config
  const config = loadConfig();

  // 2. Initialize database
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!process.env.AGW_STATE_DIR && !home) {
    console.error('ERROR: Set AGW_STATE_DIR or HOME environment variable');
    process.exit(1);
  }
  const stateDir = process.env.AGW_STATE_DIR || path.join(home!, '.agw');
  const dbPath = path.join(stateDir, 'gateway.db');
  const db = createDatabase(dbPath);

  // Store stateDir in config for route access
  config._stateDir = stateDir;

  // 3. Run migrations
  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  runMigrations(db, migrationsDir);

  // 4. Seed database (first run)
  const { apiKey, isFirstRun } = seedDatabase(db);
  if (isFirstRun && apiKey) {
    console.log('\n' + '='.repeat(60));
    console.log('  FIRST RUN — Your admin API key:');
    console.log(`  ${apiKey}`);
    console.log('');
    console.log('  Save this key! It will not be shown again.');
    console.log('  Tip: Set AGW_ADMIN_KEY env var to choose your own key.');
    console.log('='.repeat(60) + '\n');
  }

  // 4b. Seed default workspace persona files from workspace-defaults/
  {
    const fs = await import('node:fs');
    let workspace = config.agent?.workspace || path.join(stateDir, 'workspace');
    try {
      fs.mkdirSync(workspace, { recursive: true });
    } catch {
      workspace = path.join(stateDir, 'workspace');
    }
    fs.mkdirSync(workspace, { recursive: true });

    // Copy from workspace-defaults/ (single source of truth)
    const defaultsDir = path.join(projectRoot, 'workspace-defaults');
    if (fs.existsSync(defaultsDir)) {
      for (const file of fs.readdirSync(defaultsDir)) {
        const dest = path.join(workspace, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(path.join(defaultsDir, file), dest);
        }
      }
    }
  }

  // 5. Migrate v1 data if present
  const defaultTenant = db.get<{ id: string }>(
    'SELECT id FROM tenants WHERE slug = ?',
    ['default'],
  );
  const tenantId = defaultTenant?.id || 'default';
  if (defaultTenant) {
    const migration = migrateV1Data(db, stateDir, tenantId);
    if (migration.sessions > 0 || migration.messages > 0) {
      console.log(
        `v1 migration: ${migration.sessions} sessions, ${migration.messages} messages, ${migration.mcpServers} MCP servers`,
      );
    }
  }

  // 6. Migrate secrets + create unified secrets store
  migrateToSecretsStore(stateDir);
  const secretsStore = new SecretsStore(stateDir);

  // 6b. Initialize provider registry with secrets store
  const providerRegistry = new ProviderRegistry(config);
  providerRegistry.setSecretsStore(secretsStore);

  // 6b. Initialize audit service
  const auditService = new AuditService(db);

  // 7. Initialize tool registry with built-in tools (config-aware filtering)
  const toolRegistry = new ToolRegistry();
  toolRegistry.setAuditService(auditService);
  const toolEnabledMap: Record<string, boolean> = {
    exec: config.tools?.exec?.enabled !== false,
    web_search: config.tools?.webSearch?.enabled !== false,
    web_fetch: config.tools?.webFetch?.enabled !== false,
    send_email: !!config.tools?.email?.enabled,
  };
  for (const tool of builtinTools) {
    const name = tool.definition.name;
    if (name in toolEnabledMap && !toolEnabledMap[name]) continue;
    toolRegistry.register(tool);
  }

  // 7b. Initialize memory system
  const memorySystem = new MemorySystem(db, config.agent.workspace);
  memorySystem.init();
  setMemorySystem(memorySystem);

  // 8. Create Fastify server (needed before MCP bridge for server.log)
  const server = await createServer({ db, config });

  // 9. One-time DB→config migration for MCP servers, then initialize bridge
  const mcpMigrated = migrateDbMcpToConfig(db, CONFIG_PATH);
  if (mcpMigrated > 0) {
    console.log(`DB→config migration: ${mcpMigrated} MCP servers moved to config.json`);
    // Reload config to pick up migrated MCP servers
    const refreshed = loadConfig();
    config.mcp = refreshed.mcp;
  }

  const mcpBridge = new MCPBridge(config, CONFIG_PATH, (server.log as unknown as Logger).child({ category: 'mcp' }));
  mcpBridge.setToolRegistry(toolRegistry);
  mcpBridge.setSecretsStore(secretsStore);
  await mcpBridge.init();

  // 10. Create the agent runner factory — resolves sessions and builds AgentContext
  const sessionRepo = new SessionRepository(db);

  // Shared services — populated later, referenced by closures
  const sharedServices: {
    cronScheduler?: any;
    telegramSend?: (text: string, chatId?: string) => Promise<void>;
    whatsappSend?: (text: string, jid?: string) => Promise<void>;
  } = {};

  const createRunner: AgentRunner = async (
    inbound: InboundMessage,
    callbacks?: AgentCallbacks,
  ): Promise<AgentResult> => {
    // Resolve or create a session for this chat
    const chatIdStr = String(inbound.chatId);
    // Only use userId if it's a real user ID from the users table, not a channel-generated ID
    const userRow = inbound.userId
      ? db.get<{ id: string }>('SELECT id FROM users WHERE id = ?', [String(inbound.userId)])
      : undefined;
    const validUserId = userRow?.id ?? undefined;

    const existingSessions = sessionRepo.listByTenant(tenantId, 500);
    let sessionRow = existingSessions.find(
      (s) => s.channel === inbound.channel && s.chat_id === chatIdStr,
    );

    if (!sessionRow) {
      const sessionId = crypto.randomUUID();
      sessionRow = sessionRepo.create({
        id: sessionId,
        tenantId,
        userId: validUserId,
        channel: inbound.channel,
        chatId: chatIdStr,
      });
      // Audit: session.create
      try {
        auditService.log({
          tenantId,
          userId: validUserId,
          action: 'session.create',
          resource: sessionId,
          details: { channel: inbound.channel, chatId: chatIdStr },
        });
      } catch { /* audit should not break session creation */ }
    }

    return runAgent(inbound, callbacks || {}, {
      db,
      config,
      session: sessionRow,
      tenantId,
      userId: validUserId,
      callLLM: (args) => providerRegistry.callWithFailover(args),
      tools: toolRegistry.getDefinitions(),
      executeTool: (name, args, ctx) => {
        // Inject shared services into tool context
        const enrichedCtx = {
          ...ctx,
          config,
          secretsStore,
          cronScheduler: sharedServices.cronScheduler,
          telegramSend: sharedServices.telegramSend,
          whatsappSend: sharedServices.whatsappSend,
          broadcastToWeb,
          braveApiKey: secretsStore.get('tools.webSearch', 'apiKey') || config.tools?.webSearch?.apiKey || process.env.BRAVE_API_KEY || '',
        };
        return toolRegistry.execute(name, args, enrichedCtx as any);
      },
    });
  };

  // 11. Register auth plugin (BEFORE routes)
  await server.register(authPlugin, { db, auditService });

  // 12. Register ALL routes
  await server.register(registerHealthRoutes);
  await server.register(registerAuthRoutes);
  await server.register(registerSessionRoutes);
  // Config change handler — hot-reload channels when toggled via Settings UI
  const onConfigChange = async (dotPath: string, value: unknown) => {
    if (dotPath === 'channels.whatsapp.enabled') {
      if (value && !channelRegistry.whatsapp) {
        const waChannel = createWhatsAppChannel(config, db, tenantId);
        await waChannel.start(createRunner);
        channelRegistry.whatsapp = waChannel;
        server.log.info('WhatsApp channel started via Settings');
      } else if (!value && channelRegistry.whatsapp) {
        await channelRegistry.whatsapp.stop();
        channelRegistry.whatsapp = undefined;
        server.log.info('WhatsApp channel stopped via Settings');
      }
    }
    // Tool toggle hot-reload
    if (dotPath.startsWith('tools.') && dotPath.endsWith('.enabled')) {
      const toolKeyMap: Record<string, string> = {
        'tools.exec.enabled': 'exec',
        'tools.webSearch.enabled': 'web_search',
        'tools.webFetch.enabled': 'web_fetch',
        'tools.email.enabled': 'send_email',
      };
      const toolName = toolKeyMap[dotPath];
      if (toolName) {
        if (value) {
          const tool = builtinTools.find(t => t.definition.name === toolName);
          if (tool && !toolRegistry.has(toolName)) {
            toolRegistry.register(tool);
            server.log.info(`Tool ${toolName} enabled via Settings`);
          }
        } else {
          if (toolRegistry.has(toolName)) {
            toolRegistry.unregister(toolName);
            server.log.info(`Tool ${toolName} disabled via Settings`);
          }
        }
      }
    }
    if (dotPath === 'channels.telegram.enabled') {
      const tgToken = secretsStore.get('channels.telegram', 'botToken') || config.channels.telegram.botToken;
      if (value && !channelRegistry.telegram && tgToken) {
        const tgChannel = createTelegramChannel(config, db, tenantId, secretsStore);
        await tgChannel.start(createRunner);
        channelRegistry.telegram = tgChannel;
        server.log.info('Telegram channel started via Settings');
      } else if (!value && channelRegistry.telegram) {
        await channelRegistry.telegram.stop();
        channelRegistry.telegram = undefined;
        server.log.info('Telegram channel stopped via Settings');
      }
    }
  };

  await server.register(registerConfigRoutes, { auditService, onConfigChange });
  await server.register(registerUsageRoutes);
  await server.register(registerLogRoutes);
  await server.register(registerAuditRoutes);
  await server.register(registerMCPRoutes, { auditService, mcpBridge });
  await server.register(chatRoutes, { runner: createRunner });
  await server.register(registerWorkspaceRoutes);
  await server.register(registerSystemRoutes, { providerRegistry, secretsStore });

  // 13. Start cron scheduler
  const scheduler = new CronScheduler({
    stateDir,
    logger: (server.log as unknown as Logger).child({ category: 'cron' }),
    executor: async (job) => {
      const inbound: InboundMessage = {
        text: job.prompt,
        channel: 'cron',
        chatId: `cron:${job.id}`,
        chatType: 'private',
        userId: 'system',
        senderName: 'Cron',
      };
      const result = await createRunner(inbound);
      return { text: result.text ?? undefined };
    },
    deliverer: async (text, channel, to) => {
      if (channel === 'telegram' && channelRegistry.telegram) {
        await channelRegistry.telegram.sendToChat(text, to);
      } else if (channel === 'whatsapp' && channelRegistry.whatsapp) {
        await channelRegistry.whatsapp.sendToChat(text, to);
      } else if (channel === 'web') {
        broadcastToWeb({ type: 'cron.delivery', text, ts: Date.now() });
      } else {
        throw new Error(`Channel "${channel}" not available for delivery`);
      }
    },
  });
  scheduler.start();
  sharedServices.cronScheduler = scheduler;

  // Register cron routes (needs scheduler)
  await server.register(registerCronRoutes, { scheduler });

  // 14. Register WebSocket (webchat) plugin
  await server.register(webchatPlugin, { db, config, runner: createRunner });

  // 15. Channel registry — mutable so channels can be hot-reloaded via Settings
  const channelRegistry: {
    telegram?: TelegramChannelInstance;
    whatsapp?: WhatsAppChannelInstance;
  } = {};

  // Shared services read from registry (lazy lookup) so they always see the current instance
  sharedServices.telegramSend = async (text: string, chatId?: string) => {
    if (!channelRegistry.telegram) throw new Error('Telegram channel not enabled');
    return channelRegistry.telegram.sendToChat(text, chatId);
  };
  sharedServices.whatsappSend = async (text: string, jid?: string) => {
    if (!channelRegistry.whatsapp) throw new Error('WhatsApp channel not enabled');
    return channelRegistry.whatsapp.sendToChat(text, jid);
  };

  // Start Telegram (if enabled — check secrets store first, then config)
  const startupTgToken = secretsStore.get('channels.telegram', 'botToken') || config.channels?.telegram?.botToken;
  if (config.channels?.telegram?.enabled && startupTgToken) {
    const tgChannel = createTelegramChannel(config, db, tenantId, secretsStore);
    await tgChannel.start(createRunner);
    channelRegistry.telegram = tgChannel;
  }

  // Start WhatsApp (if enabled)
  if (config.channels?.whatsapp?.enabled) {
    const waChannel = createWhatsAppChannel(config, db, tenantId);
    await waChannel.start(createRunner);
    channelRegistry.whatsapp = waChannel;
  }

  // Register WhatsApp routes
  await server.register(registerWhatsAppRoutes, { channelRegistry });

  // Register unified channels status route
  await server.register(registerChannelRoutes, { channelRegistry, config, secretsStore });

  // 16. Serve static UI files
  // Try SvelteKit build first, fall back to legacy public/index.html
  const svelteKitBuild = path.join(projectRoot, 'packages', 'ui', 'build');
  const legacyPublic = path.join(projectRoot, 'public');
  const fs = await import('node:fs');

  if (fs.existsSync(svelteKitBuild)) {
    await server.register(import('@fastify/static'), {
      root: svelteKitBuild,
      prefix: '/',
      decorateReply: false,
    });

    // SPA fallback: serve index.html for all non-API, non-WS routes
    // This enables direct URL access to client-side routes like /admin/cron
    server.setNotFoundHandler((request, reply) => {
      const url = request.url || '';
      // Don't intercept API routes or WebSocket
      if (url.startsWith('/api/') || url === '/ws') {
        reply.code(404).send({ error: 'Not found', statusCode: 404 });
        return;
      }
      // Serve index.html for SPA client-side routing
      const indexPath = path.join(svelteKitBuild, 'index.html');
      if (fs.existsSync(indexPath)) {
        reply.type('text/html').send(fs.readFileSync(indexPath));
      } else {
        reply.code(404).send({ error: 'Not found', statusCode: 404 });
      }
    });
  } else if (fs.existsSync(legacyPublic)) {
    await server.register(import('@fastify/static'), {
      root: legacyPublic,
      prefix: '/',
      decorateReply: false,
    });
  }

  // 18. Listen
  const port = config.gateway?.port || 18181;
  const host = config.gateway?.host || '0.0.0.0';

  await server.listen({ port, host });

  console.log(
    `Kairo listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
  );
  if (channelRegistry.telegram) {
    console.log('  Telegram bot: active');
  }
  if (channelRegistry.whatsapp) {
    console.log('  WhatsApp: active');
  }
  console.log(`  Tools: ${toolRegistry.size} registered`);
  console.log(`  MCP servers: connecting in background`);

  // 18. Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');

    // Stop channels
    if (channelRegistry.telegram) {
      try {
        await channelRegistry.telegram.stop();
      } catch {
        /* ignore */
      }
    }
    if (channelRegistry.whatsapp) {
      try {
        await channelRegistry.whatsapp.stop();
      } catch {
        /* ignore */
      }
    }

    // Stop webchat cleanup interval
    stopWebchatCleanup();

    // Stop scheduler
    scheduler.stop();

    // Shutdown MCP bridge
    await mcpBridge.shutdown();

    // Stop memory system
    memorySystem.close();

    // Close server
    await server.close();

    // Close database
    db.close();

    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
