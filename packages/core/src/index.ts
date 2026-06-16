import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
async function hasBinary(cmd: string): Promise<boolean> {
  try { await execFileAsync('which', [cmd], { timeout: 3000 }); return true; } catch { return false; }
}
import type { InboundMessage, AgentCallbacks, AgentResult } from '@agw/types';
import type { Logger } from 'pino';
import { loadConfig, CONFIG_PATH } from './config/loader.js';
import { createDatabase, runMigrations } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { migrateV1Data, migrateDbMcpToConfig } from './db/migrate-v1.js';
import { createServer } from './server.js';
import { authPlugin, requireRole } from './auth/middleware.js';
import { resolvePrincipal } from './auth/principal.js';
import { ProviderRegistry } from './providers/registry.js';
import { ToolRegistry } from './tools/registry.js';
import { builtinTools } from './tools/builtin/index.js';
import { setMemorySystem, setSandboxManager } from '@agw/tools-common';
import { ContainerManager, isDockerAvailable, imageExists } from '@agw/sandbox';
import { MemorySystem } from './memory/index.js';
import { MCPBridge } from './mcp/bridge.js';
import { registerAllPlugins, reloadPlugins, loadPlugins } from './plugins/index.js';
import { MediaStore } from './media/store.js';
import { createMediaUrlSigner, deriveMediaSigningKey } from './media/signing.js';
import { setApiKeyPepper, deriveApiKeyPepper } from './auth/keys.js';
import { SecretsStore } from './secrets/store.js';
import { migrateToSecretsStore } from './secrets/migrate.js';
import { resolveMasterKey } from './secrets/crypto.js';
import { runAgent } from './agent/loop.js';
import { FileStateTracker } from './agent/file-state.js';
import { ProgressBus, ResultBudget, LoopDetector, ResultStorage } from '@agw/tool-platform';
import { backgroundTaskRegistry } from './agent/background-task-registry.js';
import { SessionRepository } from './db/repositories/session.js';
import { SenderLinkRepository } from './db/repositories/sender-link.js';
import { UserRepository } from './db/repositories/user.js';
import { deriveScopeKey, deriveGroupScopeKey, ensureScopeDir, migrateScopesToUserUUID, migrateToSharedDir, setTokenEstimatorLogger } from '@agw/memory-engine';
import { setMessagesLogger, setPromptLogger } from '@agw/agent-core';
import { CronScheduler } from './cron/scheduler.js';
import { AlertManager } from './alerts/index.js';
import { WebSocketAlertChannel } from './alerts/channels/websocket.js';
import { TelegramAlertChannel } from './alerts/channels/telegram.js';
import { WebhookAlertChannel } from './alerts/channels/webhook.js';
import { ChannelHealthProbe } from './alerts/health/channel-probe.js';
import { broadcastToWeb, broadcastToUser, broadcastToAdmins, stopWebchatCleanup } from './channels/webchat.js';
import { createTelegramChannel } from './channels/telegram.js';
import type { TelegramChannelInstance } from './channels/telegram.js';
import { createWhatsAppChannel } from './channels/whatsapp.js';
import type { WhatsAppChannelInstance } from './channels/whatsapp.js';
import type { AgentRunner } from './channels/types.js';
import { checkOutboundAllowed } from './security/outbound.js';
import { migrateOutboundAllowlist } from './security/migrate-outbound.js';
import { createModuleLogger, toAgwLogger } from './observability/logger.js';

// Wire loggers for extracted packages that added setters in PR #120
const _agentLog = createModuleLogger('agent');
setMessagesLogger(toAgwLogger(_agentLog));
setPromptLogger(toAgwLogger(_agentLog));
setTokenEstimatorLogger(toAgwLogger(_agentLog));

// Routes
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerLogRoutes } from './routes/logs.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerBackgroundTaskRoutes } from './routes/background-tasks.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerMCPRoutes } from './routes/mcp.js';
import { chatRoutes } from './routes/chat.js';
import { registerSandboxRoutes } from './routes/sandbox.js';
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
import { DAILY_INTERVAL_MS, SQLITE_BACKUP_RETENTION, SQLITE_BACKUP_STARTUP_DELAY_MS } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '..', '..', '..');
const flatRoot = path.resolve(__dirname, '..');
const projectRoot = fs.existsSync(path.join(monorepoRoot, 'packages', 'ui')) ? monorepoRoot : flatRoot;

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
  // Pepper API-key hashing with a master-key-derived secret (HMAC-SHA256).
  // Existing SHA-256 hashes keep working and upgrade lazily on next auth.
  setApiKeyPepper(masterKey ? deriveApiKeyPepper(masterKey) : null);
  const secretsStore = new SecretsStore(stateDir, masterKey);
  // Signer for time-limited media URLs (key derived from the master key, so it
  // survives restarts). Without a master key, media falls back to auth-only.
  const mediaSigner = masterKey
    ? createMediaUrlSigner(deriveMediaSigningKey(masterKey))
    : undefined;
  if (secretsStore.isEncrypted) {
    console.log('  Secrets: encrypted (AES-256-GCM envelope encryption)');
  }

  // 6a. Clear sensitive env vars — secrets are now in encrypted store, not process.env
  // This prevents leaking tokens to child processes (e.g., Agent SDK subprocess)
  const sensitiveEnvVars = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'TELEGRAM_BOT_TOKEN', 'BRAVE_API_KEY',
  ];
  for (const key of sensitiveEnvVars) {
    if (process.env[key]) delete process.env[key];
  }

  // 6c. Migrate OAuth token from old namespace to kairo premium namespace
  const oldAuthToken = secretsStore.get('providers.anthropic', 'authToken');
  if (oldAuthToken && !secretsStore.get('kairo.providers.anthropic', 'authToken')) {
    secretsStore.set('kairo.providers.anthropic', 'authToken', oldAuthToken);
    secretsStore.set('providers.anthropic', 'authToken', '');
    console.log('  [migration] Moved OAuth token to kairo.providers.anthropic namespace');
  }

  // 6d. Initialize provider registry with secrets store
  const providerRegistry = new ProviderRegistry(config);
  providerRegistry.setSecretsStore(secretsStore);

  // 6e. Auto-fetch model capabilities from provider APIs (background, non-blocking)
  import('./models/refresh.js').then(({ refreshModelCapabilities }) =>
    refreshModelCapabilities(config, secretsStore).catch(() => { /* non-critical */ })
  );

  // 6f. Initialize audit service
  const auditService = new AuditService(db);

  // 7. Initialize tool registry with built-in tools (config-aware filtering)
  const toolRegistry = new ToolRegistry();
  toolRegistry.setPermissionCheckerFromDb(db);
  toolRegistry.setAuditService(auditService);
  // Phase 12: load PreToolUse / PostToolUse / SessionStart / PostCompact
  // hooks from config. setHooks() can be called again on config reload
  // for hot-reload support; for now it's a startup-only application.
  toolRegistry.setHooks((config as { hooks?: unknown }).hooks as Parameters<typeof toolRegistry.setHooks>[0]);
  const hasPdftotext = await hasBinary('pdftotext');
  const hasChromium = await hasBinary('chromium') || await hasBinary('chromium-browser');
  if (!hasPdftotext) console.log('  WARN: pdftotext not found — read_pdf tool disabled');
  if (!hasChromium) console.log('  WARN: chromium not found — browse tool disabled');

  const toolEnabledMap: Record<string, boolean> = {
    exec: config.tools?.exec?.enabled !== false,
    web_search: config.tools?.webSearch?.enabled !== false,
    web_fetch: config.tools?.webFetch?.enabled !== false,
    send_email: !!config.tools?.email?.enabled,
    browse: (config.tools?.browse?.enabled !== false) && hasChromium,
    read_pdf: hasPdftotext,
    sandbox_exec: !!config.tools?.sandbox?.enabled,
    sandbox_read_file: !!config.tools?.sandbox?.enabled,
    sandbox_write_file: !!config.tools?.sandbox?.enabled,
    sandbox_list_files: !!config.tools?.sandbox?.enabled,
  };
  for (const tool of builtinTools) {
    const name = tool.definition.name;
    if (name in toolEnabledMap && !toolEnabledMap[name]) continue;
    toolRegistry.register(tool, { builtin: true });
  }

  // 7a. Initialize media store + load plugins from plugins.json
  const mediaStore = new MediaStore(stateDir, mediaSigner);
  mediaStore.startCleanup();

  // Load plugins.json into runtime config
  config.plugins = loadPlugins(stateDir);

  const pluginLogger = createModuleLogger('plugins');
  const pluginTools = await registerAllPlugins(config, toolRegistry, secretsStore, pluginLogger, mediaStore);
  if (pluginTools.length > 0) {
    console.log(`  Plugins: ${pluginTools.length} tools registered`);
  }

  // Phase 6.5: process-wide progress bus for live SSE streaming.
  // Tools publish tool.start / tool.progress / tool.complete / tool.error
  // events here; the SSE endpoint at GET /api/v1/sessions/:id/progress
  // subscribes per-session and streams to the admin UI.
  const progressBus = new ProgressBus();

  // Phase 10 — wire the in-memory background task registry to its
  // durable SQLite table. Surviving `running` rows from the previous
  // process are marked `orphaned` so they stay visible in the admin
  // UI without trying to resume their (now-dead) promises. Tasks
  // older than 7 days are auto-purged on startup.
  await backgroundTaskRegistry.attachDb(db);
  await backgroundTaskRegistry.purgeOlderThan(7);

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
  const memorySystem = new MemorySystem(db, config.agent.workspace, config);
  await memorySystem.init();
  setMemorySystem(memorySystem);

  // 7d. Initialize sandbox container manager (if enabled + Docker available)
  let sandboxManager: ContainerManager | null = null;
  const sandboxConfig = config.tools?.sandbox;
  if (sandboxConfig?.enabled) {
    const dockerOk = await isDockerAvailable(sandboxConfig.dockerSocket);
    if (dockerOk) {
      const imgOk = await imageExists(sandboxConfig.dockerSocket, sandboxConfig.image);
      if (imgOk) {
        const sandboxLog = toAgwLogger(createModuleLogger('sandbox'));
        sandboxManager = new ContainerManager(sandboxConfig, sandboxLog);
        setSandboxManager(sandboxManager);
        console.log(`  Sandbox: enabled (image: ${sandboxConfig.image})`);
      } else {
        console.warn(`  Sandbox: image '${sandboxConfig.image}' not found — sandbox_exec disabled`);
      }
    } else {
      console.warn(`  Sandbox: Docker not reachable at ${sandboxConfig.dockerSocket} — sandbox_exec disabled`);
    }
  }

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
  const _userRepo = new UserRepository(db);

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
    let resolvedUser: { id: string; role: string; elevated: number; active: number } | undefined;
    if (inbound.userId) {
      resolvedUser = await db.get<{ id: string; role: string; elevated: number; active: number }>(
        'SELECT id, role, elevated, active FROM users WHERE id = ? AND active = 1',
        [String(inbound.userId)],
      );
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
    const validUserId = isGroupChat ? undefined : resolvedUser?.id;

    // Keyed lookup (indexed) — resolves the chat's session regardless of how
    // many sessions exist. The previous linear scan was capped at 500 and
    // silently forked a new session (losing history) past the cap (#186).
    let sessionRow = await sessionRepo.findByChat(tenantId, inbound.channel, chatIdStr);

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

    // ── Phase 6 per-turn services ──────────────────────────
    // One instance per createRunner invocation (= one inbound message =
    // one user turn). Lifetime: until this function's returned Promise
    // settles. Threaded into tool context via enrichedCtx below.
    const fileState = new FileStateTracker();
    const resultBudget = new ResultBudget();
    const loopDetector = new LoopDetector();
    const resultStorage = new ResultStorage({
      workspaceDir: config.agent.workspace,
      scopeKey,
      sessionId: sessionRow.id,
    });

    // ── Phase 8: deferred tool loading ─────────────────────
    // When enabled (default), the initial prompt only shows tools
    // marked `alwaysLoad: true`. Everything else is discoverable via
    // `tool_search`, which loads tools into this session's loaded
    // set. The agent loop's `refreshTools` callback picks up
    // newly-loaded tools between rounds. Set `agent.deferToolLoading
    // = false` in config or `AGW_DEFER_TOOLS=false` in env to
    // disable and send every tool on every turn (pre-Phase-8 shape).
    const deferEnvDisabled = process.env.AGW_DEFER_TOOLS === 'false';
    const deferToolLoading =
      !deferEnvDisabled &&
      ((config.agent as unknown as { deferToolLoading?: boolean })?.deferToolLoading !== false);

    // Resolve the security principal for this turn (role + elevation). This is
    // the single source of truth for both tool-loading and tool-execution.
    //
    // SECURITY (#179): a user-owned cron is dispatched on the 'internal'
    // channel carrying its owner's id. If that owner is no longer an active
    // account, resolvePrincipal returns null and we REFUSE the turn — never
    // falling through to a system-admin principal, which would let a
    // deactivated user's stored prompt run with full elevated privileges.
    const claimedUserId = inbound.userId ? String(inbound.userId) : undefined;
    const principal = resolvePrincipal(inbound.channel, claimedUserId, resolvedUser);
    if (!principal) {
      // Record the denied privileged turn in the tamper-evident audit trail —
      // this refusal is exactly the event a security audit needs to see.
      try {
        await auditService.log({
          tenantId,
          userId: claimedUserId,
          action: 'turn.refused',
          resource: chatIdStr,
          details: { channel: inbound.channel, reason: 'claimed user is not an active account' },
        });
      } catch { /* audit failure must not mask the refusal */ }
      throw new Error(
        `Refusing turn on channel "${inbound.channel}": claimed user "${claimedUserId}" is not an active account`,
      );
    }

    const toolOpts = {
      userRole: principal.role,
      db,
      tenantId,
      elevated: principal.elevated,
    };

    const initialTools = deferToolLoading
      ? await toolRegistry.getAlwaysLoadDefinitions(toolOpts)
      : await toolRegistry.getDefinitions(toolOpts);

    const refreshTools = deferToolLoading
      ? () => toolRegistry.getDefinitionsForSession(sessionRow.id, toolOpts)
      : undefined;

    return runAgent(inbound, callbacks || {}, {
      db,
      config,
      session: sessionRow,
      tenantId,
      userId: validUserId,
      // User context for tool permissions + scope isolation. Resolved above by
      // resolvePrincipal (#179):
      // - Resolved user → their actual role from DB
      // - System channel with no specific user → system admin
      // - Unlinked real channel sender → restricted anonymous user
      // - System channel with an unresolved specific owner → refused above
      user: principal,
      scopeKey,
      // Cancellation: a channel (e.g. webchat chat.stop) passes an AbortSignal
      // via callbacks; thread it so kill/stop actually halts the loop (#181).
      signal: callbacks?.signal,
      callLLM: (args) => providerRegistry.callWithFailover(args),
      isProviderAvailable: (prefix) => providerRegistry.hasProviderSync(prefix),
      tools: initialTools,
      refreshTools,
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
          // Phase 8: tool_search needs direct registry access to query
          // the full tool surface (including deferred tools) and mutate
          // the session's loaded set via loadForSession().
          toolRegistry,
          subagentDepth: 0,
          scopeKey,
          secretsStore,
          // Phase 6 per-turn services (see FileStateTracker / ResultBudget /
          // LoopDetector / ResultStorage). Passed through so the registry's
          // execute() can read them for loop detection + byte accounting;
          // individual tools opt in via context.fileState / context.resultBudget.
          fileState,
          resultBudget,
          loopDetector,
          resultStorage,
          // Phase 6.5: live progress bus (process-wide singleton). The
          // registry wraps context.progress per-call so tool authors can
          // emit custom in-flight events without knowing their own callId,
          // and publishes tool.start / tool.complete automatically.
          progressBus,
          // Phase 10: process-lifetime background task registry. Tools
          // read via ctx.backgroundTasks; the spawn_agent / task_*
          // builtins fall back to the exported singleton when it's
          // missing, but threading it through keeps tests swappable.
          backgroundTasks: backgroundTaskRegistry,
          cronScheduler: sharedServices.cronScheduler,
          browserManager: sharedServices.browserManager,
          telegramSend: sharedServices.telegramSend,
          whatsappSend: sharedServices.whatsappSend,
          broadcastToWeb,
          broadcastToUser,
          broadcastToAdmins,
          checkOutboundAllowed: (channel: 'whatsapp' | 'telegram', recipient: string) =>
            checkOutboundAllowed(channel, recipient, config, db),  // already returns Promise
          braveApiKey: secretsStore.get('tools.webSearch', 'apiKey') || config.tools?.webSearch?.apiKey || process.env.BRAVE_API_KEY || '',
          pluginReloader: () => reloadPlugins(config, toolRegistry, secretsStore, pluginLogger, mediaStore),
          mediaStore,
        };
        return toolRegistry.execute(name, args, enrichedCtx as any);
      },
      isToolConcurrencySafe: (name) => toolRegistry.isConcurrencySafe(name),
    });
  };

  // 11. Register auth plugin (BEFORE routes)
  await server.register(authPlugin, { db, auditService, mediaSigner });

  // 12. Register ALL routes
  await server.register(registerHealthRoutes, { secretsStore });
  await server.register(registerAuthRoutes);
  await server.register(registerSessionRoutes, { progressBus });
  // Config change handler — hot-reload channels when toggled via Settings UI
  const onConfigChange = async (dotPath: string, value: unknown) => {
    if (dotPath === 'channels.whatsapp.enabled') {
      if (value && !channelRegistry.whatsapp) {
        const waChannel = createWhatsAppChannel(config, db, tenantId);
        await waChannel.start(createRunner);
        waChannel.setAlertEmitter(emitFailure);
        channelRegistry.whatsapp = waChannel;
        server.log.info('WhatsApp channel started via Settings');
      } else if (!value && channelRegistry.whatsapp) {
        await channelRegistry.whatsapp.stop();
        channelRegistry.whatsapp = undefined;
        alertManager.emitSuccess('channel.disconnected', { source: 'whatsapp', channel: 'whatsapp' });
        server.log.info('WhatsApp channel stopped via Settings');
      }
    }
    // Kairo Premium config hot-reload (enabled, mode, defaultModel)
    if (dotPath.startsWith('providers.kairoPremium.')) {
      await providerRegistry.reinitProviders();
      // Refresh model capabilities (new provider config may access different models)
      import('./models/refresh.js').then(({ refreshModelCapabilities }) =>
        refreshModelCapabilities(config, secretsStore).catch(() => { /* non-critical */ })
      );
      server.log.info({ dotPath, value }, 'Kairo Premium config changed via Settings');
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
            toolRegistry.register(tool, { builtin: true });
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
    // Sandbox hot-reload
    if (dotPath === 'tools.sandbox.enabled') {
      if (value && !sandboxManager) {
        const sbConfig = config.tools?.sandbox;
        if (sbConfig) {
          const dockerOk = await isDockerAvailable(sbConfig.dockerSocket);
          if (dockerOk) {
            const imgOk = await imageExists(sbConfig.dockerSocket, sbConfig.image);
            if (imgOk) {
              const sbLog = toAgwLogger(createModuleLogger('sandbox'));
              sandboxManager = new ContainerManager(sbConfig, sbLog);
              setSandboxManager(sandboxManager);
              // Register sandbox tools
              const sandboxToolNames = ['sandbox_exec', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files'];
              for (const tool of builtinTools) {
                if (sandboxToolNames.includes(tool.definition.name) && !toolRegistry.has(tool.definition.name)) {
                  toolRegistry.register(tool, { builtin: true });
                }
              }
              server.log.info('Sandbox enabled via Settings');
            } else {
              server.log.warn(`Sandbox image '${sbConfig.image}' not found`);
            }
          } else {
            server.log.warn('Docker not reachable — sandbox not started');
          }
        }
      } else if (!value && sandboxManager) {
        await sandboxManager.destroyAll();
        setSandboxManager(null);
        sandboxManager = null;
        // Unregister sandbox tools
        for (const name of ['sandbox_exec', 'sandbox_read_file', 'sandbox_write_file', 'sandbox_list_files']) {
          if (toolRegistry.has(name)) toolRegistry.unregister(name);
        }
        server.log.info('Sandbox disabled via Settings');
      }
    } else if (dotPath.startsWith('tools.sandbox.') && sandboxManager) {
      const sbConfig = config.tools?.sandbox;
      if (sbConfig) sandboxManager.updateConfig(sbConfig);
    }
    // Plugin hot-reload
    if (dotPath.startsWith('plugins.') || dotPath === 'plugins') {
      try {
        const reloaded = await reloadPlugins(config, toolRegistry, secretsStore, pluginLogger, mediaStore);
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
        tgAlertChannel.setSender((chatId, text) => channelRegistry.telegram!.sendToChat(text, chatId));
        server.log.info('Telegram channel started via Settings');
      } else if (!value && channelRegistry.telegram) {
        await channelRegistry.telegram.stop();
        channelRegistry.telegram = undefined;
        tgAlertChannel.setSender(null as unknown as (chatId: string, text: string) => Promise<void>);
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
  await server.register(registerSandboxRoutes, { getContainerManager: () => sandboxManager });
  await server.register(registerUsageRoutes);
  await server.register(registerUserRoutes);
  await server.register(registerLogRoutes);
  await server.register(registerProgressRoutes, { progressBus });
  await server.register(registerBackgroundTaskRoutes);
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
      // SECURITY (#179): a user-owned cron must run as its owner. If a job
      // carries an owner id that does not resolve to an active account —
      // deactivated/deleted, or a forged 'system'/other id — DISABLE the job
      // and skip. Otherwise createRunner would refuse it turn-after-turn (it
      // never escalates a user-owned 'internal' turn to system admin).
      // Genuine system crons carry no owner (job.userId is null) and are
      // exempt; the `!owner` branch never fires for them.
      if (job.userId) {
        const owner = await db.get<{ id: string }>(
          'SELECT id FROM users WHERE id = ? AND active = 1',
          [job.userId],
        );
        if (!owner) {
          scheduler.update(job.id, { enabled: false });
          server.log.warn(
            { jobId: job.id, userId: job.userId },
            'Cron job owner is not an active user — job disabled',
          );
          return { text: undefined };
        }
      }
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
    deliverer: async (text, channel, to, media, ownerId) => {
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
        // Route to the cron's owner only — never fan a user's scheduled output
        // out to every connected web client (#191). System-owned jobs (no
        // owner) go to admin connections rather than everyone.
        const msg = { type: 'cron.delivery', text, ts: Date.now() };
        if (ownerId && ownerId !== 'system' && ownerId !== 'anonymous') {
          broadcastToUser(ownerId, msg);
        } else {
          broadcastToAdmins(msg);
        }
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

  // 14. Register @fastify/websocket at server level (shared by webchat + browser bridge)
  await server.register(import('@fastify/websocket'), {
    options: { maxPayload: 1 * 1024 * 1024 },
  });

  // 14a. Register WebSocket (webchat) plugin
  await server.register(webchatPlugin, { db, config, runner: createRunner, secretsStore });

  // 14b. Register browser bridge WebSocket (for Chrome extension remote browsing)
  try {
    const { browserBridgePlugin } = await import('./browser/bridge.js');
    await server.register(browserBridgePlugin, { db, config });
  } catch { /* browser bridge not available — non-critical */ }

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

  // 15b. Alert system
  const alertsConfig = config.alerts;
  const alertManager = new AlertManager({ config: alertsConfig, db });

  const wsAlertChannel = new WebSocketAlertChannel();
  alertManager.registerChannel(wsAlertChannel);

  const tgAlertChannel = new TelegramAlertChannel();
  if (channelRegistry.telegram) {
    tgAlertChannel.setSender((chatId, text) => channelRegistry.telegram!.sendToChat(text, chatId));
  }
  const tgAdminIds = alertsConfig.delivery?.telegram?.chatIds?.length
    ? alertsConfig.delivery.telegram.chatIds
    : (config.channels?.telegram as any)?.allowFrom ?? [];
  tgAlertChannel.setChatIds(tgAdminIds);
  alertManager.registerChannel(tgAlertChannel);

  const webhookAlertChannel = new WebhookAlertChannel();
  if (alertsConfig.delivery?.webhook?.urls?.length) {
    webhookAlertChannel.setConfig(alertsConfig.delivery.webhook.urls, alertsConfig.delivery.webhook.secret || '');
  }
  alertManager.registerChannel(webhookAlertChannel);

  // Wire alert emitters
  const { filterOutput } = await import('@agw/security');
  const emitFailure: typeof alertManager.emitFailure = (event) => {
    alertManager.emitFailure({ ...event, message: filterOutput(event.message), title: filterOutput(event.title) });
  };
  if (channelRegistry.whatsapp) channelRegistry.whatsapp.setAlertEmitter(emitFailure);
  providerRegistry.setAlertEmitter(emitFailure);
  scheduler.setAlertEmitter(emitFailure);

  // Start channel health probes
  const channelProbe = new ChannelHealthProbe(alertManager, channelRegistry as any);
  if (alertsConfig.enabled) channelProbe.start();

  // Register WhatsApp routes
  await server.register(registerWhatsAppRoutes, { channelRegistry });

  // Register unified channels status route
  await server.register(registerChannelRoutes, { channelRegistry, config, secretsStore });

  // Alert test + status endpoint (admin only)
  server.post('/api/v1/admin/alerts/test', { preHandler: [requireRole('admin')] }, async () => {
    alertManager.emitFailure({
      type: 'system.test',
      severity: 'warning',
      source: 'admin',
      labels: { source: 'admin', trigger: 'manual-test' },
      title: 'Test alert',
      message: 'This is a test alert triggered from the admin panel',
    });
    alertManager.emitFailure({
      type: 'system.test',
      severity: 'warning',
      source: 'admin',
      labels: { source: 'admin', trigger: 'manual-test' },
      title: 'Test alert',
      message: 'This is a test alert triggered from the admin panel',
    });
    return { ok: true, message: 'Test alert fired (2 failures to exceed threshold)' };
  });
  server.get('/api/v1/admin/alerts', { preHandler: [requireRole('admin')] }, async () => {
    return { firing: alertManager.getFiringAlerts(), all: alertManager.getStore().getAll() };
  });

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
  const CONSOLIDATION_INTERVAL_MS = DAILY_INTERVAL_MS;
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
  consolidationTimer.unref();

  // 19b. Daily database backup — SQLite uses native backup(), PG uses pg_dump
  const backupPrefix = dbDialect === 'sqlite' ? 'gateway.db.backup-' : 'gateway.pg.backup-';
  let backupTimer: ReturnType<typeof setInterval> | null = null;
  {
    const runBackup = async () => {
      try {
        const date = new Date().toISOString().slice(0, 10);
        const ext = dbDialect === 'sqlite' ? '' : '.dump';
        const backupPath = path.join(stateDir, `${backupPrefix}${date}${ext}`);
        if (fs.existsSync(backupPath)) return;
        await db.backup(backupPath);
        console.log(`  DB backup: ${backupPath}`);
        const files = fs.readdirSync(stateDir).filter(f => f.startsWith(backupPrefix)).sort();
        while (files.length > SQLITE_BACKUP_RETENTION) {
          const old = files.shift()!;
          try { fs.unlinkSync(path.join(stateDir, old)); } catch { /* ignore */ }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('not found')) {
          console.error('DB backup failed:', msg);
          emitFailure({
            type: 'system.backup_failed',
            severity: 'warning',
            source: 'core',
            labels: { source: 'core', dialect: dbDialect },
            title: 'Database backup failed',
            message: `Backup failed: ${msg}`,
          });
        }
      }
    };
    backupTimer = setInterval(async () => {
      await runBackup();
      await alertManager.cleanupHistory();
    }, DAILY_INTERVAL_MS);
    backupTimer.unref();
    setTimeout(runBackup, SQLITE_BACKUP_STARTUP_DELAY_MS);
  }

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
    if (backupTimer) clearInterval(backupTimer);

    // Stop alerts
    channelProbe.stop();
    alertManager.stop();

    // Stop scheduler
    scheduler.stop();

    // Shutdown MCP bridge
    await mcpBridge.shutdown();

    // Shutdown browser sessions
    if (sharedServices.browserManager?.shutdown) {
      await sharedServices.browserManager.shutdown();
    }

    // Stop sandbox containers
    if (sandboxManager) {
      await sandboxManager.destroyAll();
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
