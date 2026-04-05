/**
 * Browser Session Manager — manages per-user Playwright browser contexts.
 *
 * Each user gets one isolated BrowserContext with its own cookies, storage.
 * Contexts auto-close after idle timeout. Browser instance is shared (single Chromium process).
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createModuleLogger } from '../observability/logger.js';
import { validateFetchUrl, validateResolvedIP } from '../tools/builtin/web.js';

const log = createModuleLogger('browser');

// Chromium launch flags for Docker / headless server
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--no-first-run',
  '--headless=new',
  '--js-flags=--max-old-space-size=256', // limit JS heap per renderer
];

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const IDLE_TIMEOUT_MS = 5 * 60_000;      // 5 minutes idle
const ABSOLUTE_TIMEOUT_MS = 30 * 60_000;  // 30 minutes absolute
const NAV_TIMEOUT_MS = 30_000;            // 30 seconds per navigation
const MAX_SESSIONS = 5;                   // max concurrent browser contexts
const MAX_PAGES_PER_CONTEXT = 5;          // max tabs per user session

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  userId: string;
  createdAt: number;
  lastActivity: number;
  /** Map of ref number → CSS selector for element targeting */
  refMap: Map<number, string>;
}

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, BrowserSession>();
  private pendingSessions = new Map<string, Promise<{ page: Page; context: BrowserContext }>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private executablePath: string;

  constructor(executablePath?: string) {
    this.executablePath = executablePath
      || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      || '/usr/bin/chromium';

    // Periodic cleanup every 60s (unref so it doesn't prevent shutdown)
    this.cleanupTimer = setInterval(() => this._cleanup(), 60_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Get or create a browser session for a user. Serialized per-user to prevent races. */
  async getSession(userId: string): Promise<{ page: Page; context: BrowserContext }> {
    // Return existing session if valid
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastActivity = Date.now();
      if (!existing.page.isClosed()) {
        return { page: existing.page, context: existing.context };
      }
      // Page was closed — create a new one in the same context
      const page = await existing.context.newPage();
      existing.page = page;
      return { page, context: existing.context };
    }

    // Serialize concurrent creation for the same user (prevent race condition)
    const pending = this.pendingSessions.get(userId);
    if (pending) return pending;

    const promise = this._createSession(userId);
    this.pendingSessions.set(userId, promise);
    try {
      return await promise;
    } finally {
      this.pendingSessions.delete(userId);
    }
  }

  /** Internal: create a new session (called only once per user via serialization). */
  private async _createSession(userId: string): Promise<{ page: Page; context: BrowserContext }> {
    // Enforce max sessions — evict oldest
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, session] of this.sessions) {
        if (session.lastActivity < oldestTime) {
          oldestTime = session.lastActivity;
          oldestKey = key;
        }
      }
      if (oldestKey) await this.closeSession(oldestKey);
    }

    // Launch browser if not running
    if (!this.browser || !this.browser.isConnected()) {
      log.info('Launching Chromium browser');
      this.browser = await chromium.launch({
        executablePath: this.executablePath,
        args: CHROMIUM_ARGS,
      });
    }

    // Create isolated context + page — wrapped in try/catch to prevent context leaks
    let context: BrowserContext | null = null;
    try {
      context = await this.browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        userAgent: 'KairoClaw/1.0 (Browser Tool)',
        acceptDownloads: false, // prevent disk-filling downloads
      });
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      context.setDefaultTimeout(NAV_TIMEOUT_MS);

      // Limit popup/tab accumulation
      context.on('page', (newPage) => {
        const pages = context!.pages();
        if (pages.length > MAX_PAGES_PER_CONTEXT) {
          newPage.close().catch(() => {});
        }
      });

      // Auto-dismiss dialogs (alert/confirm/prompt) so agent doesn't get stuck
      context.on('page', (p) => {
        p.on('dialog', (dialog) => {
          log.debug({ type: dialog.type(), message: dialog.message().slice(0, 100) }, 'Auto-dismissing dialog');
          dialog.dismiss().catch(() => {});
        });
      });

      // SSRF + performance: intercept requests, block private IPs + ads/trackers
      const { shouldBlockResource } = await import('../tools/builtin/browse.js');
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();

        // Allow data/blob URLs
        if (url.startsWith('data:') || url.startsWith('blob:')) {
          await route.continue();
          return;
        }

        // Block ads, trackers, fonts, media for performance
        if (shouldBlockResource(url, resourceType)) {
          await route.abort('blockedbyclient');
          return;
        }

        // SSRF protection
        try {
          const parsed = validateFetchUrl(url);
          await validateResolvedIP(parsed.hostname);
          await route.continue();
        } catch {
          log.debug({ url: url.slice(0, 200) }, 'Blocked request (SSRF protection)');
          await route.abort('blockedbyclient');
        }
      });

      const page = await context.newPage();

      // Dialog handler for initial page
      page.on('dialog', (dialog) => {
        log.debug({ type: dialog.type(), message: dialog.message().slice(0, 100) }, 'Auto-dismissing dialog');
        dialog.dismiss().catch(() => {});
      });

      const session: BrowserSession = {
        context,
        page,
        userId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        refMap: new Map(),
      };
      this.sessions.set(userId, session);
      log.info({ userId, activeSessions: this.sessions.size }, 'Browser session created');

      return { page, context };
    } catch (e) {
      // Clean up context if it was created but page/route setup failed
      if (context) {
        try { await context.close(); } catch { /* ignore */ }
      }
      throw e;
    }
  }

  /** Check if a user has an active session. */
  hasSession(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /** Get the ref map for a user's session. */
  getRefMap(userId: string): Map<number, string> {
    return this.sessions.get(userId)?.refMap ?? new Map();
  }

  /** Update the ref map for a user's session. */
  setRefMap(userId: string, refMap: Map<number, string>): void {
    const session = this.sessions.get(userId);
    if (session) session.refMap = refMap;
  }

  // ── Session persistence (cookies/localStorage) ─────────────

  /** Get the directory for storing browser session profiles. */
  private _sessionDir(workspace: string, userId: string): string {
    return path.join(workspace, 'scopes', userId, 'browser-sessions');
  }

  /** Save current browser session (cookies + localStorage) to a named profile. */
  async saveSession(userId: string, name: string, workspace: string): Promise<{ success: boolean; name: string }> {
    const session = this.sessions.get(userId);
    if (!session) throw new Error('No active browser session. Navigate to a page first.');

    const dir = this._sessionDir(workspace, userId);
    fs.mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filePath = path.join(dir, `${safeName}.json`);

    const state = await session.context.storageState();
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    } catch (e: unknown) {
      throw new Error(`Failed to save session: ${e instanceof Error ? e.message : 'disk error'}`);
    }
    log.info({ userId, name: safeName }, 'Browser session saved');
    return { success: true, name: safeName };
  }

  /** Create a new browser context with a saved session profile (cookies/localStorage restored). */
  async loadSession(userId: string, name: string, workspace: string): Promise<{ page: Page; context: BrowserContext }> {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filePath = path.join(this._sessionDir(workspace, userId), `${safeName}.json`);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Saved session "${name}" not found. Use saveSession first.`);
    }

    // Close existing session if any
    await this.closeSession(userId);

    // Read and validate saved state
    let storageState: unknown;
    try {
      const stateJson = fs.readFileSync(filePath, 'utf8');
      storageState = JSON.parse(stateJson);
    } catch {
      throw new Error(`Failed to read session file "${name}" — may be corrupted.`);
    }
    // Basic schema validation — Playwright expects { cookies: [], origins: [] }
    if (!storageState || typeof storageState !== 'object') {
      throw new Error(`Corrupted session file "${name}".`);
    }
    const state = storageState as Record<string, unknown>;
    if (state.cookies && !Array.isArray(state.cookies)) {
      throw new Error(`Invalid session file "${name}" — cookies must be an array.`);
    }
    if (state.origins && !Array.isArray(state.origins)) {
      throw new Error(`Invalid session file "${name}" — origins must be an array.`);
    }

    // Launch browser if needed
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        executablePath: this.executablePath,
        args: CHROMIUM_ARGS,
      });
    }

    // Create context with saved state
    let context: BrowserContext | null = null;
    try {
      context = await this.browser.newContext({
        viewport: DEFAULT_VIEWPORT,
        userAgent: 'KairoClaw/1.0 (Browser Tool)',
        acceptDownloads: false,
        storageState: storageState as any,
      });
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      context.setDefaultTimeout(NAV_TIMEOUT_MS);

      // Apply same protections as _createSession
      context.on('page', (newPage) => {
        if (context!.pages().length > MAX_PAGES_PER_CONTEXT) newPage.close().catch(() => {});
      });
      context.on('page', (p) => {
        p.on('dialog', (d) => d.dismiss().catch(() => {}));
      });
      const { shouldBlockResource } = await import('../tools/builtin/browse.js');
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('blob:')) { await route.continue(); return; }
        if (shouldBlockResource(url, route.request().resourceType())) { await route.abort('blockedbyclient'); return; }
        try {
          const parsed = validateFetchUrl(url);
          await validateResolvedIP(parsed.hostname);
          await route.continue();
        } catch { await route.abort('blockedbyclient'); }
      });

      const page = await context.newPage();
      page.on('dialog', (d) => d.dismiss().catch(() => {}));

      this.sessions.set(userId, {
        context, page, userId,
        createdAt: Date.now(), lastActivity: Date.now(),
        refMap: new Map(),
      });
      log.info({ userId, name: safeName }, 'Browser session loaded from saved state');
      return { page, context };
    } catch (e) {
      if (context) try { await context.close(); } catch { /* ignore */ }
      throw e;
    }
  }

  /** List saved session profile names for a user. */
  listSavedSessions(userId: string, workspace: string): string[] {
    const dir = this._sessionDir(workspace, userId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }

  /** Delete a saved session profile. */
  deleteSavedSession(userId: string, name: string, workspace: string): boolean {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const filePath = path.join(this._sessionDir(workspace, userId), `${safeName}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /** Close a specific user's session. */
  async closeSession(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;
    this.sessions.delete(userId);
    try {
      await session.context.close();
    } catch {
      // Context may already be closed
    }
    log.info({ userId, activeSessions: this.sessions.size }, 'Browser session closed');
  }

  /** Shut down everything — call on server shutdown. */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Collect keys first to avoid mutating map during iteration
    const userIds = [...this.sessions.keys()];
    for (const userId of userIds) {
      await this.closeSession(userId);
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    log.info('Browser session manager shut down');
  }

  /** Clean up idle / expired sessions. */
  private async _cleanup(): Promise<void> {
    const now = Date.now();
    // Collect keys to close first (don't mutate map during iteration)
    const toClose: string[] = [];
    for (const [userId, session] of this.sessions) {
      const idle = now - session.lastActivity > IDLE_TIMEOUT_MS;
      const expired = now - session.createdAt > ABSOLUTE_TIMEOUT_MS;
      if (idle || expired) {
        log.debug({ userId, idle, expired }, 'Cleaning up browser session');
        toClose.push(userId);
      }
    }
    for (const userId of toClose) {
      await this.closeSession(userId);
    }

    // Close browser if no sessions
    if (this.sessions.size === 0 && this.browser?.isConnected()) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
      log.debug('Browser closed (no active sessions)');
    }
  }
}
