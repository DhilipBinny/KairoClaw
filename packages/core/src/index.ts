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
import { authPlugin, requireRole } from './auth/middleware.js';
import { ProviderRegistry } from './providers/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/builtin/index.js';
import { setMemorySystem } from './tools/builtin/memory.js';
import { MemorySystem } from './memory/index.js';
import { MCPBridge } from './mcp/bridge.js';
import { registerAllPlugins, reloadPlugins } from './plugins/index.js';
import { loadPlugins } from './plugins/store.js';
import { MediaStore } from './media/store.js';
import { SecretsStore } from './secrets/store.js';
import { migrateToSecretsStore } from './secrets/migrate.js';
import { resolveMasterKey } from './secrets/crypto.js';
import { runAgent } from './agent/loop.js';
import { SessionRepository } from './db/repositories/session.js';
import { SenderLinkRepository } from './db/repositories/sender-link.js';
import { UserRepository } from './db/repositories/user.js';
import { deriveScopeKey, deriveGroupScopeKey, ensureScopeDir, migrateScopesToUserUUID, migrateToSharedDir } from './agent/scope.js';
import { CronScheduler } from './cron/scheduler.js';
import { broadcastToWeb, stopWebchatCleanup } from './channels/webchat.js';
import { createTelegramChannel } from './channels/telegram.js';
import type { TelegramChannelInstance } from './channels/telegram.js';
import { createWhatsAppChannel } from './channels/whatsapp.js';
import type { WhatsAppChannelInstance } from './channels/whatsapp.js';
import type { AgentRunner } from './channels/types.js';
import { checkOutboundAllowed } from './security/outbound.js';
import { migrateOutboundAllowlist } from './security/migrate-outbound.js';
import { createModuleLogger } from './observability/logger.js';

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
import { registerDatabaseRoutes } from './routes/database.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerWhatsAppRoutes } from './routes/whatsapp.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerUserRoutes } from './routes/users.js';
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

  // Database config: AGW_DATABASE_URL env var → config.database → default SQLite
  const dbUrl = process.env.AGW_DATABASE_URL || (config as unknown as Record<string, unknown>).databaseUrl as string | undefined;
  const dbDialect = dbUrl ? 'postgres' as const : 'sqlite' as const;
  const db = dbUrl
    ? createDatabase({ type: 'postgres', url: dbUrl })
    : createDatabase(path.join(stateDir, 'gateway.db'));

  if (dbDialect === 'postgres') {
    console.log('  Database: PostgreSQL');
    // Validate PG connection before proceeding
    try {
      await db.get('SELECT 1 as ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('\n' + '='.repeat(60));
      console.error('  POSTGRESQL CONNECTION FAILED');
      console.error(`  ${msg}`);
      console.error('');
      console.error('  Check AGW_DATABASE_URL:');
      console.error(`  ${dbUrl?.replace(/:[^:@]+@/, ':***@')}`);
      console.error('');
      console.error('  Ensure PostgreSQL is running and accessible.');
      console.error('='.repeat(60) + '\n');
      process.exit(1);
    }
  }

  // Store stateDir in config for route access
  config._stateDir = stateDir;

  // 3. Run migrations
  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  await runMigrations(db, migrationsDir, dbDialect);

  // 3b. Auto-migrate SQLite → PostgreSQL (if conditions met)
  // Must run BEFORE seed so migrated tenants/users prevent seed from creating new ones
  if (dbDialect === 'postgres') {
    const { autoMigrateSqliteToPg } = await import('./db/migrate-to-pg.js');
    const migResult = await autoMigrateSqliteToPg(db, stateDir);
    if (migResult.migrated) {
      console.log(`  Migrated SQLite → PostgreSQL (${migResult.totalRows} rows)`);
    }
  }

  // 3c. Clean up orphaned internal sessions (sub-agents that didn't clean up)
  try {
    const sessionRepo = new SessionRepository(db);
    const cleaned = await sessionRepo.cleanupOrphans();
    if (cleaned > 0) {
      console.log(`  Cleaned ${cleaned} orphaned internal sessions`);
    }
  } catch { /* non-critical */ }

  // 4. Seed database (first run — skipped if migration populated tenants)
  const { apiKey, isFirstRun } = await seedDatabase(db);
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
    let workspace = config.agent?.workspace || 'workspace';
    // Resolve relative workspace paths against stateDir (not CWD)
    if (!path.isAbsolute(workspace)) {
      workspace = path.join(stateDir, workspace);
    }
    config.agent.workspace = workspace;
    try {
      fs.mkdirSync(workspace, { recursive: true });
    } catch {
      workspace = path.join(stateDir, 'workspace');
      config.agent.workspace = workspace;
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

  // 5. Migrate v1 data if present (SQLite only — PG deployments are fresh)
  const defaultTenant = await db.get<{ id: string }>(
    'SELECT id FROM tenants WHERE slug = ?',
    ['default'],
  );
  const tenantId = defaultTenant?.id || 'default';
  if (defaultTenant && dbDialect === 'sqlite') {
    const migration = await migrateV1Data(db, stateDir, tenantId);
    if (migration.sessions > 0 || migration.messages > 0) {
      console.log(
        `v1 migration: ${migration.sessions} sessions, ${migration.messages} messages, ${migration.mcpServers} MCP servers`,
      );
    }
  }

  // 6. Migrate secrets + create unified secrets store
  migrateToSecretsStore(stateDir);
  const masterKey = resolveMasterKey(stateDir);
  const secretsStore = new SecretsStore(stateDir, masterKey);
  if (secretsStore.isEncrypted) {
    console.log('  Secrets: encrypted (AES-256-GCM envelope encryption)');
  }

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

  // 7a. Initialize media store + load plugins from plugins.json
  const mediaStore = new MediaStore(stateDir);
  mediaStore.startCleanup();

  // Load plugins.json into runtime config
  config.plugins = loadPlugins(stateDir);

  const pluginLogger = createModuleLogger('plugins');
  const pluginTools = await registerAllPlugins(config, toolRegistry, secretsStore, pluginLogger as any, mediaStore);
  if (pluginTools.length > 0) {
    console.log(`  Plugins: ${pluginTools.length} tools registered`);
  }

  // 7b. Migrate old channel-based scopes to user UUID scopes (one-time)
  try {
    const scopeResult = await migrateScopesToUserUUID(config.agent.workspace, db);
    if (scopeResult.migrated > 0) {
      console.log(`[scope] Migrated ${scopeResult.migrated} scope dirs from channel:sender to user UUID`);
    }
  } catch (e) {
    console.error('[scope] Scope migration failed:', e instanceof Error ? e.message : e);
  }

  // 7b2. Migrate old documents/ and media/ to shared/ (one-time)
  try {
    const sharedResult = migrateToSharedDir(config.agent.workspace);
    if (sharedResult.migrated) {
      console.log('[scope] Migrated documents/ and media/ to shared/');
    }
  } catch (e) {
    console.error('[scope] Shared dir migration failed:', e instanceof Error ? e.message : e);
  }

  // 7c. Initialize memory system
  const memorySystem = new MemorySystem(db, config.agent.workspace);
  await memorySystem.init();
  setMemorySystem(memorySystem);

  // 8. Create Fastify server (needed before MCP bridge for server.log)
  const server = await createServer({ db, config });

  // 9. One-time DB→config migration for MCP servers (SQLite only), then initialize bridge
  const mcpMigrated = dbDialect === 'sqlite' ? await migrateDbMcpToConfig(db, CONFIG_PATH) : 0;
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
  const senderLinkRepo = new SenderLinkRepository(db);
  const userRepo = new UserRepository(db);

  // Shared services — populated later, referenced by closures
  const sharedServices: {
    cronScheduler?: any;
    telegramSend?: (text: string, chatId?: string) => Promise<void>;
    whatsappSend?: (text: string, jid?: string) => Promise<void>;
    browserManager?: any;
  } = {};

  // Browser session manager — lazy-initialized on first browse tool call
  try {
    const { BrowserSessionManager } = await import('./browser/session-manager.js');
    sharedServices.browserManager = new BrowserSessionManager();
  } catch {
    // Chromium may not be installed — browse tool will return an error
  }

  const createRunner: AgentRunner = async (
    inbound: InboundMessage,
    callbacks?: AgentCallbacks,
  ): Promise<AgentResult> => {
    // Resolve or create a session for this chat
    const chatIdStr = String(inbound.chatId);

    // Resolve user: try direct lookup first (webchat/API), then sender_links (Telegram/WhatsApp)
    let validUserId: string | undefined;
    let resolvedUser: { id: string; role: string; elevated: number; active: number } | undefined;
    if (inbound.userId) {
      resolvedUser = await db.get<{ id: string; role: string; elevated: number; active: number }>(
        'SELECT id, role, elevated, active FROM users WHERE id = ? AND active = 1',
        [String(inbound.userId)],
      );
      reqLog.info({ userId: inbound.userId, resolved: !!resolvedUser, role: resolvedUser?.role, channel: inbound.channel }, 'User resolution');
    }
    if (!resolvedUser && inbound.userId && inbound.channel !== 'web' && inbound.channel !== 'api') {
      // Channel sender — look up sender_links
      const link = await senderLinkRepo.findByChannelSender(tenantId, inbound.channel, String(inbound.userId));
      if (link) {
        resolvedUser = await db.get<{ id: string; role: string; elevated: number; active: number }>(
          'SELECT id, role, elevated, active FROM users WHERE id = ? AND active = 1',
          [link.user_id],
        );
      }
    }
    // Group sessions must never be owned by a single user — multiple people share them.
    // resolvedUser is still used for per-request permission checking (AgentContext.user).
    const isGroupChat = chatIdStr.startsWith('telegram:-') || chatIdStr.includes('@g.us');
    validUserId = isGroupChat ? undefined : resolvedUser?.id;

    const existingSessions = await sessionRepo.listByTenant(tenantId, 500);
    let sessionRow = existingSessions.find(
      (s) => s.channel === inbound.channel && s.chat_id === chatIdStr,
    );

    if (!sessionRow) {
      const sessionId = crypto.randomUUID();
      sessionRow = await sessionRepo.create({
        id: sessionId,
        tenantId,
        userId: validUserId,
        channel: inbound.channel,
        chatId: chatIdStr,
      });
      // Audit: session.create
      try {
        await auditService.log({
          tenantId,
          userId: validUserId,
          action: 'session.create',
          resource: sessionId,
          details: { channel: inbound.channel, chatId: chatIdStr },
        });
      } catch { /* audit should not break session creation */ }
    }

    // Derive scope key for memory isolation:
    // - Group chats → group scope (shared group memory)
    // - Individual chats → user scope (personal memory by UUID)
    const scopeKey = isGroupChat
      ? deriveGroupScopeKey(inbound.channel, chatIdStr)
      : deriveScopeKey(inbound.channel, inbound.userId, resolvedUser?.id);
    if (scopeKey) ensureScopeDir(config.agent.workspace, scopeKey, {
      name: inbound.senderName,
      channel: inbound.channel,
      userId: inbound.userId,
    });

    return runAgent(inbound, callbacks || {}, {
      db,
      config,
      session: sessionRow,
      tenantId,
      userId: validUserId,
      // User context for tool permissions + scope isolation:
      // - Resolved user → their actual role from DB
      // - Cron/internal/system → admin (needs all tools)
      // - Unlinked real channel sender → restricted user (safe default)
      user: resolvedUser
        ? { id: resolvedUser.id, role: resolvedUser.role, elevated: !!resolvedUser.elevated }
        : (['cron', 'internal', 'heartbeat'].includes(inbound.channel)
          ? { id: 'system', role: 'admin', elevated: true }
          : { id: 'anonymous', role: 'user', elevated: false }),
      scopeKey,
      callLLM: (args) => providerRegistry.callWithFailover(args),
      tools: await toolRegistry.getDefinitions({
        userRole: resolvedUser?.role
          || (['cron', 'internal', 'heartbeat'].includes(inbound.channel) ? 'admin' : 'user'),
        db,
        tenantId,
        elevated: !!resolvedUser?.elevated,
      }),
      executeTool: async (name, args, ctx) => {
        // Inject shared services + sub-agent context into tool executor
        const enrichedCtx = {
          ...ctx,
          db,
          config,
          tenantId,
          callLLM: (llmArgs: any) => providerRegistry.callWithFailover(llmArgs),
          tools: await toolRegistry.getDefinitions({
            userRole: (ctx as Record<string, any>).user?.role || 'user',
            db,
            tenantId,
            elevated: !!(ctx as Record<string, any>).user?.elevated,
          }),
          executeTool: (toolName: string, toolArgs: Record<string, unknown>, toolCtx: any) => {
            return toolRegistry.execute(toolName, toolArgs, { ...toolCtx, ...enrichedCtx } as any);
          },
          subagentDepth: 0,
          scopeKey,
          secretsStore,
          cronScheduler: sharedServices.cronScheduler,
          browserManager: sharedServices.browserManager,
          telegramSend: sharedServices.telegramSend,
          whatsappSend: sharedServices.whatsappSend,
          broadcastToWeb,
          checkOutboundAllowed: (channel: 'whatsapp' | 'telegram', recipient: string) =>
            checkOutboundAllowed(channel, recipient, config, db),  // already returns Promise
          braveApiKey: secretsStore.get('tools.webSearch', 'apiKey') || config.tools?.webSearch?.apiKey || process.env.BRAVE_API_KEY || '',
          pluginReloader: () => reloadPlugins(config, toolRegistry, secretsStore, pluginLogger as any, mediaStore),
          mediaStore,
        };
        return toolRegistry.execute(name, args, enrichedCtx as any);
      },
    });
  };

  // 11. Register auth plugin (BEFORE routes)
  await server.register(authPlugin, { db, auditService });

  // 12. Register ALL routes
  await server.register(registerHealthRoutes, { secretsStore });
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
    // Plugin hot-reload
    if (dotPath.startsWith('plugins.') || dotPath === 'plugins') {
      try {
        const reloaded = await reloadPlugins(config, toolRegistry, secretsStore, pluginLogger as any, mediaStore);
        server.log.info({ count: reloaded.length }, 'Plugins reloaded via Settings');
      } catch (e) {
        server.log.error(e, 'Failed to reload plugins');
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

  // Admin endpoint: list all registered tool definitions (for permission management UI)
  server.get('/api/v1/admin/tool-definitions', { preHandler: [requireRole('admin')] }, async () => {
    const allTools = await toolRegistry.getDefinitions();
    return allTools.map(t => ({ name: t.name, description: t.description }));
  });

  await server.register(registerConfigRoutes, { auditService, onConfigChange });
  await server.register(registerUsageRoutes);
  await server.register(registerUserRoutes);
  await server.register(registerLogRoutes);
  await server.register(registerAuditRoutes);
  await server.register(registerMCPRoutes, { auditService, mcpBridge });
  await server.register(chatRoutes, { runner: createRunner });
  await server.register(registerWorkspaceRoutes);
  await server.register(registerSystemRoutes, { providerRegistry, secretsStore });
  await server.register(registerDatabaseRoutes);
  await server.register(registerMediaRoutes, { mediaStore });

  // 13. Start cron scheduler
  const scheduler = new CronScheduler({
    stateDir,
    db,
    tenantId,
    logger: (server.log as unknown as Logger).child({ category: 'cron' }),
    executor: async (job) => {
      // Use job owner's userId if set — cron runs with their permissions
      const cronUserId = job.userId || 'system';
      const inbound: InboundMessage = {
        text: job.prompt,
        channel: job.userId ? 'internal' : 'cron', // user-owned crons use 'internal' channel
        chatId: `cron:${job.id}`,
        chatType: 'private',
        userId: cronUserId,
        senderName: 'Cron',
      };
      const result = await createRunner(inbound);
      return { text: result.text ?? undefined, media: result.media };
    },
    deliverer: async (text, channel, to, media) => {
      // Outbound policy check for cron delivery
      if ((channel === 'whatsapp' || channel === 'telegram') && to) {
        const check = await checkOutboundAllowed(channel, to, config, db);
        if (!check.allowed) {
          const cronLog = createModuleLogger('cron');
          cronLog.warn({ channel, to, reason: check.reason }, 'Cron delivery blocked by outbound policy');
          return;
        }
      }
      if (channel === 'telegram') {
        if (!channelRegistry.telegram) {
          const cronLog = createModuleLogger('cron');
          cronLog.warn({ channel, to }, 'Cron delivery skipped: Telegram channel is disabled');
          return;
        }
        if (media && media.length > 0) {
          await channelRegistry.telegram.sendMediaToChat(media, text, to);
        } else {
          await channelRegistry.telegram.sendToChat(text, to);
        }
      } else if (channel === 'whatsapp') {
        if (!channelRegistry.whatsapp) {
          const cronLog = createModuleLogger('cron');
          cronLog.warn({ channel, to }, 'Cron delivery skipped: WhatsApp channel is disabled');
          return;
        }
        if (media && media.length > 0) {
          await channelRegistry.whatsapp.sendMediaToChat(media, text, to);
        } else {
          await channelRegistry.whatsapp.sendToChat(text, to);
        }
      } else if (channel === 'web') {
        broadcastToWeb({ type: 'cron.delivery', text, ts: Date.now() });
      } else {
        const cronLog = createModuleLogger('cron');
        cronLog.warn({ channel }, 'Cron delivery skipped: unknown channel');
      }
    },
  });
  await scheduler.start();
  sharedServices.cronScheduler = scheduler;

  // Migrate: seed outbound allowlists from existing active cron targets
  try {
    migrateOutboundAllowlist(scheduler, config);
  } catch { /* non-critical — existing crons may need manual allowlisting */ }

  // Register cron routes (needs scheduler)
  await server.register(registerCronRoutes, { scheduler });

  // 14. Register WebSocket (webchat) plugin
  await server.register(webchatPlugin, { db, config, runner: createRunner, secretsStore });

  // 15. Channel registry — mutable so channels can be hot-reloaded via Settings
  const channelRegistry: {
    telegram?: TelegramChannelInstance;
    whatsapp?: WhatsAppChannelInstance;
  } = {};

  // Shared services read from registry (lazy lookup) so they always see the current instance
  sharedServices.telegramSend = async (text: string, chatId?: string) => {
    if (!channelRegistry.telegram) throw new Error('Telegram channel not enabled');
    if (chatId) {
      const check = await checkOutboundAllowed('telegram', chatId, config, db);
      if (!check.allowed) throw new Error(`Outbound blocked: ${check.reason}`);
    }
    return channelRegistry.telegram.sendToChat(text, chatId);
  };
  sharedServices.whatsappSend = async (text: string, jid?: string) => {
    if (!channelRegistry.whatsapp) throw new Error('WhatsApp channel not enabled');
    if (jid) {
      const check = await checkOutboundAllowed('whatsapp', jid, config, db);
      if (!check.allowed) throw new Error(`Outbound blocked: ${check.reason}`);
    }
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

  // 19. Daily memory consolidation — runs every 24h, consolidates session notes → PROFILE.md
  const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const consolidationTimer = setInterval(async () => {
    try {
      const { consolidateMemory } = await import('./agent/auto-memory.js');
      const scopesDir = path.join(config.agent.workspace, 'scopes');
      if (!fs.existsSync(scopesDir)) return;

      const scopes = fs.readdirSync(scopesDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const scopeKey of scopes) {
        try {
          await consolidateMemory({
            config,
            callLLM: (args: any) => providerRegistry.callWithFailover(args),
            scopeKey,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Memory consolidation failed for ${scopeKey}: ${msg}`);
        }
      }

      // Also consolidate global memory (web/API users without scope)
      try {
        await consolidateMemory({
          config,
          callLLM: (args: any) => providerRegistry.callWithFailover(args),
          scopeKey: null,
        });
      } catch { /* non-critical */ }
    } catch (e) {
      console.error('Memory consolidation error:', e);
    }
  }, CONSOLIDATION_INTERVAL_MS);
  consolidationTimer.unref(); // Don't keep process alive just for this

  // 20. Graceful shutdown
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

    // Stop memory consolidation timer
    clearInterval(consolidationTimer);

    // Stop scheduler
    scheduler.stop();

    // Shutdown MCP bridge
    await mcpBridge.shutdown();

    // Shutdown browser sessions
    if (sharedServices.browserManager?.shutdown) {
      await sharedServices.browserManager.shutdown();
    }

    // Stop media cleanup
    mediaStore.stopCleanup();

    // Stop memory system
    memorySystem.close();

    // Close server
    await server.close();

    // Close database
    await db.close();

    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
