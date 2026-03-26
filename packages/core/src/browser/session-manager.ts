/**
 * Browser Session Manager — manages per-user Playwright browser contexts.
 *
 * Each user gets one isolated BrowserContext with its own cookies, storage.
 * Contexts auto-close after idle timeout. Browser instance is shared (single Chromium process).
 *
 * Usage:
 *   const mgr = new BrowserSessionManager();
 *   const { page, context } = await mgr.getSession(userId);
 *   // ... use page ...
 *   mgr.closeSession(userId);
 */

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
];

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const IDLE_TIMEOUT_MS = 5 * 60_000;      // 5 minutes idle
const ABSOLUTE_TIMEOUT_MS = 30 * 60_000;  // 30 minutes absolute
const NAV_TIMEOUT_MS = 30_000;            // 30 seconds per navigation
const MAX_SESSIONS = 5;                   // max concurrent browser contexts

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  userId: string;
  createdAt: number;
  lastActivity: number;
}

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, BrowserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private executablePath: string;

  constructor(executablePath?: string) {
    // Auto-detect Chromium path
    this.executablePath = executablePath
      || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      || '/usr/bin/chromium';

    // Periodic cleanup every 60s
    this.cleanupTimer = setInterval(() => this._cleanup(), 60_000);
  }

  /** Get or create a browser session for a user. */
  async getSession(userId: string): Promise<{ page: Page; context: BrowserContext }> {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.lastActivity = Date.now();
      // Ensure page is still open
      if (!existing.page.isClosed()) {
        return { page: existing.page, context: existing.context };
      }
      // Page was closed — create a new one in the same context
      const page = await existing.context.newPage();
      existing.page = page;
      return { page, context: existing.context };
    }

    // Enforce max sessions
    if (this.sessions.size >= MAX_SESSIONS) {
      // Close oldest idle session
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, session] of this.sessions) {
        if (session.lastActivity < oldestTime) {
          oldestTime = session.lastActivity;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        await this.closeSession(oldestKey);
      }
    }

    // Launch browser if not running
    if (!this.browser || !this.browser.isConnected()) {
      log.info('Launching Chromium browser');
      this.browser = await chromium.launch({
        executablePath: this.executablePath,
        args: CHROMIUM_ARGS,
      });
    }

    // Create isolated context + page
    const context = await this.browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      userAgent: 'KairoClaw/1.0 (Browser Tool)',
    });
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    context.setDefaultTimeout(NAV_TIMEOUT_MS);

    // SSRF protection: intercept all requests and block private IPs
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      try {
        const parsed = validateFetchUrl(url);
        await validateResolvedIP(parsed.hostname);
        await route.continue();
      } catch {
        // Allow data: URLs for inline resources (images, fonts)
        if (url.startsWith('data:')) {
          await route.continue();
          return;
        }
        log.debug({ url }, 'Blocked request (SSRF protection)');
        await route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();

    const session: BrowserSession = {
      context,
      page,
      userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(userId, session);
    log.info({ userId, activeSessions: this.sessions.size }, 'Browser session created');

    return { page, context };
  }

  /** Check if a user has an active session. */
  hasSession(userId: string): boolean {
    return this.sessions.has(userId);
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
    for (const [userId] of this.sessions) {
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
    for (const [userId, session] of this.sessions) {
      const idle = now - session.lastActivity > IDLE_TIMEOUT_MS;
      const expired = now - session.createdAt > ABSOLUTE_TIMEOUT_MS;
      if (idle || expired) {
        log.debug({ userId, idle, expired }, 'Cleaning up browser session');
        await this.closeSession(userId);
      }
    }

    // Close browser if no sessions
    if (this.sessions.size === 0 && this.browser?.isConnected()) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
      log.debug('Browser closed (no active sessions)');
    }
  }
}
