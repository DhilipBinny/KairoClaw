/**
 * Browse tool — full browser automation for the AI agent.
 *
 * Uses Playwright with system Chromium. Single tool with action discriminator.
 * Flat schema compatible with all LLM providers (no anyOf/oneOf).
 *
 * Numbered-ref interaction: the snapshot assigns [ref=N] to each interactive
 * element. The LLM uses ref numbers to click/type/select — no ambiguity.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Page, Locator } from 'playwright-core';
import type { ToolRegistration } from '../types.js';
import type { BrowserSessionManager } from '../../browser/session-manager.js';
import { validateFetchUrl, validateResolvedIP } from './web.js';
import { hasRemoteBrowser, sendBrowserCommand } from '../../browser/bridge.js';

const MAX_SNAPSHOT_CHARS = 60_000;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_INTERACTIVE_ELEMENTS = 100;

// ── Blocked resource domains (ads, trackers) ────────────────
const BLOCKED_DOMAINS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'google-analytics.com',
  'googletagmanager.com', 'facebook.net', 'fbcdn.net',
  'amazon-adsystem.com', 'adsystem.com', 'adnxs.com',
  'criteo.com', 'outbrain.com', 'taboola.com',
  'hotjar.com', 'fullstory.com', 'mixpanel.com',
  'segment.io', 'sentry.io',
]);
const BLOCKED_RESOURCE_TYPES = new Set(['font', 'media']);

/** Check if a URL should be blocked for performance. */
export function shouldBlockResource(url: string, resourceType: string): boolean {
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true;
  try {
    const hostname = new URL(url).hostname;
    for (const domain of BLOCKED_DOMAINS) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return true;
    }
  } catch { /* invalid URL */ }
  return false;
}

// ── Snapshot with numbered refs ─────────────────────────────

interface SnapshotResult {
  text: string;
  refMap: Map<number, string>; // ref → unique CSS selector
}

/**
 * Build page snapshot with numbered refs for interactive elements.
 * Injects data-kc-ref attributes, builds ref→selector map.
 */
async function buildSnapshot(page: Page, maxChars = MAX_SNAPSHOT_CHARS): Promise<SnapshotResult> {
  const refMap = new Map<number, string>();

  try {
    const data = await page.evaluate((maxElements: number) => {
      const interactive: Array<{ ref: number; desc: string; selector: string }> = [];
      const content: string[] = [];
      const seen = new Set<Element>();
      let nextRef = 1;

      // ── Pass 1: All interactive elements with numbered refs ──
      // Clear any pre-existing refs (prevent malicious page from spoofing refs)
      document.querySelectorAll('[data-kc-ref]').forEach(el => el.removeAttribute('data-kc-ref'));

      const elements = document.querySelectorAll(
        'input, textarea, select, button, a[href], [role="button"], [role="tab"], ' +
        '[role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], ' +
        '[role="combobox"], [role="searchbox"], [role="option"]'
      );

      for (const el of elements) {
        if (seen.has(el) || interactive.length >= maxElements) break;
        seen.add(el);

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;

        const tag = el.tagName;
        const name = el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('placeholder')
          || el.getAttribute('alt')
          || el.textContent?.trim().slice(0, 60)
          || '';
        if (!name && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') continue;

        const ref = nextRef++;

        // Set data attribute for later locating
        el.setAttribute('data-kc-ref', String(ref));

        // Build unique selector
        const selector = `[data-kc-ref="${ref}"]`;

        // Build description
        let desc: string;
        if (tag === 'INPUT') {
          const input = el as HTMLInputElement;
          if (input.type === 'hidden') { nextRef--; continue; }
          desc = `[ref=${ref}] [input type=${input.type || 'text'}] "${name}"`;
          // Never leak password values
          if (input.type === 'password') { desc += ' value="[REDACTED]"'; }
          else if (input.value) desc += ` value="${input.value.slice(0, 40)}"`;
          if (input.disabled) desc += ' [disabled]';
          if (input.required) desc += ' [required]';
        } else if (tag === 'TEXTAREA') {
          desc = `[ref=${ref}] [textarea] "${name}"`;
          const val = (el as HTMLTextAreaElement).value;
          if (val) desc += ` value="${val.slice(0, 40)}"`;
        } else if (tag === 'SELECT') {
          const select = el as HTMLSelectElement;
          desc = `[ref=${ref}] [select] "${name}"`;
          if (select.value) desc += ` value="${select.value}"`;
          const opts = Array.from(select.options).map(o => o.text.trim()).slice(0, 5);
          if (opts.length) desc += ` options=[${opts.join(', ')}]`;
        } else if (tag === 'A') {
          desc = `[ref=${ref}] [link] "${name}"`;
        } else if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
          desc = `[ref=${ref}] [button] "${name}"`;
        } else {
          const role = el.getAttribute('role') || tag.toLowerCase();
          desc = `[ref=${ref}] [${role}] "${name}"`;
          if (el.getAttribute('aria-checked') === 'true') desc += ' [checked]';
          if (el.getAttribute('aria-selected') === 'true') desc += ' [selected]';
        }

        interactive.push({ ref, desc, selector });
      }

      // ── Pass 2: Page text content ──
      const headings = document.querySelectorAll('h1, h2, h3, h4');
      for (const h of headings) {
        const text = h.textContent?.trim().slice(0, 150);
        if (text) content.push(`[${h.tagName.toLowerCase()}] ${text}`);
        if (content.length >= 20) break;
      }

      const textNodes = document.querySelectorAll(
        'p, li, td, th, span[class*="price"], span[class*="Price"], ' +
        '[data-price], .a-price, .a-offscreen, .a-color-price'
      );
      const maxContent = 80;
      for (const el of textNodes) {
        if (content.length >= maxContent) break;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = el.textContent?.trim().slice(0, 200);
        if (text && text.length > 3) content.push(text);
      }

      return { interactive, content };
    }, MAX_INTERACTIVE_ELEMENTS);

    // Build ref map (server-side)
    for (const item of data.interactive) {
      refMap.set(item.ref, item.selector);
    }

    // Build text output
    const sections: string[] = [];
    if (data.interactive.length > 0) {
      sections.push('INTERACTIVE ELEMENTS:\n' + data.interactive.map(i => i.desc).join('\n'));
    }
    if (data.content.length > 0) {
      sections.push('PAGE CONTENT:\n' + data.content.join('\n'));
    }

    let text = sections.join('\n\n');
    if (!text.trim()) text = '[Empty page — no visible content]';
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n[...TRUNCATED]';
    }

    return { text, refMap };
  } catch {
    return { text: '[Failed to read page content]', refMap };
  }
}

/** Resolve a ref number or text description to a Playwright Locator. */
async function resolveElement(
  page: Page,
  refMap: Map<number, string>,
  ref?: number | string,
  element?: string,
): Promise<Locator> {
  // Try ref number first
  const refNum = typeof ref === 'number' ? ref : (typeof ref === 'string' ? parseInt(ref) : NaN);
  if (!isNaN(refNum)) {
    const selector = refMap.get(refNum);
    if (selector) {
      const loc = page.locator(selector);
      if (await loc.count() > 0) return loc.first();
    }
    throw new Error(`Element ref=${refNum} not found. Take a fresh snapshot to get updated refs.`);
  }

  // Fallback: text-based search
  if (element) {
    // Try role-based matching
    for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem'] as const) {
      const loc = page.getByRole(role, { name: element, exact: false });
      if (await loc.count() > 0) return loc.first();
    }
    // Try text matching
    const textLoc = page.getByText(element, { exact: false });
    if (await textLoc.count() > 0) return textLoc.first();
    // Try placeholder
    const placeholderLoc = page.getByPlaceholder(element, { exact: false });
    if (await placeholderLoc.count() > 0) return placeholderLoc.first();
    // Try label
    const labelLoc = page.getByLabel(element, { exact: false });
    if (await labelLoc.count() > 0) return labelLoc.first();

    throw new Error(`Element "${element}" not found. Take a fresh snapshot to see current elements.`);
  }

  throw new Error('Either ref (number) or element (text) is required.');
}

/** Resolve element with auto-retry: wait 2s for lazy content, re-try once. */
async function resolveWithRetry(
  page: Page,
  refMap: Map<number, string>,
  ref?: number | string,
  element?: string,
): Promise<Locator> {
  try {
    return await resolveElement(page, refMap, ref, element);
  } catch {
    // Auto-retry: wait for content to load, try again
    await page.waitForTimeout(2000);
    return await resolveElement(page, refMap, ref, element);
  }
}

// ── Tool definition ─────────────────────────────────────────

export const browseTools: ToolRegistration[] = [
  {
    definition: {
      name: 'browse',
      description: `Browse and interact with web pages using a real browser with JavaScript rendering.

WORKFLOW:
1. navigate to a URL → returns page snapshot with numbered [ref=N] elements
2. Use ref numbers to interact: click(ref=3), type(ref=5, text="hello")
3. Every action that changes the page auto-returns a fresh snapshot with new refs

RULES:
- ALWAYS use ref numbers from the LATEST snapshot. Refs become invalid after page changes.
- For forms, prefer fill action with multiple {ref, value} pairs at once.
- Use screenshot only for visual verification, not for finding elements.

ACTIONS:
- navigate: Go to URL. Params: url (required). Optional: session (load saved session first). Returns snapshot.
- click: Click element. Params: ref (required). Returns snapshot.
- type: Type into input. Params: ref (required), text (required), submit (optional — press Enter after).
- press: Press key. Params: key (required, e.g. "Enter", "Tab", "Escape").
- select: Select option. Params: ref (required), value (required).
- fill: Fill multiple fields. Params: fields (required — [{ref, value}]).
- snapshot: Get current page with refs.
- screenshot: Capture page image.
- wait: Wait for condition. Params: text, url, or timeMs.
- scroll: Params: direction ("up"/"down").
- back: Navigate back.
- tabs: List open tabs.
- hover: Params: ref (required).
- forms: Detect all forms on page — returns structured field list with refs for easy fill.
- saveSession: Save cookies/login state. Params: session (required — name for the profile).
- loadSession: Restore saved session. Params: session (required).
- listSessions: List saved session profiles.
- deleteSession: Delete saved profile. Params: session (required).
- close: End browser session.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'click', 'type', 'press', 'select', 'fill', 'snapshot', 'screenshot', 'wait', 'scroll', 'back', 'tabs', 'hover', 'forms', 'saveSession', 'loadSession', 'listSessions', 'deleteSession', 'close'],
            description: 'The browser action to perform',
          },
          session: { type: 'string', description: 'Session profile name (for saveSession/loadSession/deleteSession, or with navigate to auto-restore)' },
          url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
          ref: { type: 'number', description: 'Element ref number from snapshot (for click/type/select/hover)' },
          element: { type: 'string', description: 'Element text/name fallback if ref not available (for click/type/select/hover)' },
          text: { type: 'string', description: 'Text to type (for type action) or text to wait for (for wait action)' },
          key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")' },
          value: { type: 'string', description: 'Value to select (for select action)' },
          fields: {
            type: 'array',
            description: 'Array of {ref, value} for batch form fill',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'number', description: 'Element ref number' },
                value: { type: 'string', description: 'Value to fill' },
              },
            },
          },
          submit: { type: 'boolean', description: 'Press Enter after typing (for type action)' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          fullPage: { type: 'boolean', description: 'Full page screenshot' },
          timeMs: { type: 'number', description: 'Wait duration in ms' },
        },
        required: ['action'],
      },
    },
    executor: async (args, context) => {
      const action = args.action as string;
      if (!action) return { error: 'action is required' };

      const ctx = context as Record<string, unknown>;
      const userId = (ctx.user as { id?: string } | undefined)?.id || 'anonymous';
      const workspace = (ctx.workspace as string) || process.cwd();

      // ── Remote browser mode: route through Chrome extension bridge ──
      // Session management actions always use local (they're about local files)
      const localOnlyActions = new Set(['saveSession', 'loadSession', 'listSessions', 'deleteSession']);
      if (!localOnlyActions.has(action) && hasRemoteBrowser(userId)) {
        try {
          const params: Record<string, unknown> = { ...args };
          delete params.action;
          const result = await sendBrowserCommand(userId, action, params);
          return result as Record<string, unknown>;
        } catch (e: unknown) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }

      // ── Local browser mode (Playwright) ──
      const browserManager = ctx.browserManager as BrowserSessionManager | undefined;
      if (!browserManager) {
        return { error: 'Browser not available. Install the Chrome extension for remote browsing, or ensure Chromium is installed for local browsing.' };
      }

      // Actions that don't need an active page
      if (action === 'close') {
        await browserManager.closeSession(userId);
        return { success: true, message: 'Browser session closed' };
      }
      if (action === 'listSessions') {
        const sessions = browserManager.listSavedSessions(userId, workspace);
        return { sessions, count: sessions.length };
      }
      if (action === 'deleteSession') {
        const name = args.session as string;
        if (!name) return { error: 'session name is required for deleteSession' };
        const deleted = browserManager.deleteSavedSession(userId, name, workspace);
        return deleted ? { success: true, deleted: name } : { error: `Session "${name}" not found` };
      }
      if (action === 'saveSession') {
        const name = args.session as string;
        if (!name) return { error: 'session name is required for saveSession' };
        try {
          return await browserManager.saveSession(userId, name, workspace);
        } catch (e: unknown) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (action === 'loadSession') {
        const name = args.session as string;
        if (!name) return { error: 'session name is required for loadSession' };
        try {
          await browserManager.loadSession(userId, name, workspace);
          return { success: true, loaded: name, message: `Session "${name}" loaded. Cookies and login state restored.` };
        } catch (e: unknown) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      }

      // Load saved session on navigate if requested
      let sessionWarning: string | undefined;
      if (action === 'navigate' && args.session) {
        try {
          await browserManager.loadSession(userId, args.session as string, workspace);
        } catch (e: unknown) {
          sessionWarning = `Failed to load session "${args.session}": ${e instanceof Error ? e.message : String(e)}. Continuing without saved cookies.`;
        }
      }

      let page: Page;
      try {
        const session = await browserManager.getSession(userId);
        page = session.page;
      } catch (e: unknown) {
        return { error: `Failed to start browser: ${e instanceof Error ? e.message : String(e)}` };
      }

      // Helper: take snapshot + update ref map
      async function snap(): Promise<{ url: string; title: string; snapshot: string }> {
        const result = await buildSnapshot(page);
        browserManager!.setRefMap(userId, result.refMap);
        return { url: page.url(), title: await page.title(), snapshot: result.text };
      }

      const refMap = browserManager.getRefMap(userId);

      try {
        switch (action) {
          case 'navigate': {
            const url = args.url as string;
            if (!url) return { error: 'url is required for navigate action' };
            try {
              const parsed = validateFetchUrl(url);
              await validateResolvedIP(parsed.hostname);
            } catch (e: unknown) {
              return { error: `Blocked: ${e instanceof Error ? e.message : String(e)}` };
            }
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
            return { success: true, ...(await snap()), ...(sessionWarning ? { warning: sessionWarning } : {}) };
          }

          case 'click': {
            const loc = await resolveWithRetry(page, refMap, args.ref as number, args.element as string);
            await loc.click({ timeout: 10_000 });
            await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
            return { success: true, ...(await snap()) };
          }

          case 'type': {
            const text = args.text as string;
            if (!text) return { error: 'text is required for type action' };
            const loc = await resolveWithRetry(page, refMap, args.ref as number, args.element as string);
            await loc.fill(text, { timeout: 10_000 });
            if (args.submit) {
              await page.keyboard.press('Enter');
              await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
              return { success: true, ...(await snap()) };
            }
            return { success: true, typed: text.length + ' characters' };
          }

          case 'press': {
            const key = args.key as string;
            if (!key) return { error: 'key is required' };
            await page.keyboard.press(key);
            if (['Enter', 'Tab', 'Escape'].includes(key)) {
              await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
              return { success: true, key, ...(await snap()) };
            }
            return { success: true, key };
          }

          case 'select': {
            const value = args.value as string;
            if (!value) return { error: 'value is required for select action' };
            const loc = await resolveWithRetry(page, refMap, args.ref as number, args.element as string);
            await loc.selectOption(value, { timeout: 10_000 });
            return { success: true, selected: value };
          }

          case 'fill': {
            const fields = args.fields as Array<{ ref: number; value: string }> | undefined;
            if (!fields || !Array.isArray(fields) || fields.length === 0) {
              return { error: 'fields array required. E.g. [{ref: 2, value: "me@example.com"}]' };
            }
            const results: string[] = [];
            for (const field of fields) {
              try {
                const loc = await resolveElement(page, refMap, field.ref);
                await loc.fill(field.value, { timeout: 5_000 });
                results.push(`ref=${field.ref}: filled`);
              } catch {
                results.push(`ref=${field.ref}: failed`);
              }
            }
            return { success: true, results, ...(await snap()) };
          }

          case 'snapshot': {
            return await snap();
          }

          case 'screenshot': {
            const buffer = await page.screenshot({
              fullPage: !!args.fullPage,
              type: 'jpeg',
              quality: 75,
            });
            if (buffer.length > MAX_SCREENSHOT_SIZE) {
              return { error: 'Screenshot too large (max 5MB). Try fullPage: false.' };
            }
            const user = (ctx.user as { id?: string } | undefined);
            const mediaDir = user?.id
              ? path.join(workspace, 'scopes', user.id, 'media')
              : path.join(workspace, 'shared', 'media');
            const filename = `screenshot-${Date.now()}.jpg`;
            const filePath = path.join(mediaDir, filename);
            try {
              fs.mkdirSync(mediaDir, { recursive: true });
              fs.writeFileSync(filePath, buffer, { mode: 0o600 });
            } catch (e: unknown) {
              return { error: `Failed to save screenshot: ${e instanceof Error ? e.message : 'disk error'}` };
            }
            return {
              success: true,
              url: page.url(),
              title: await page.title(),
              screenshot: `/api/v1/media/${encodeURIComponent(filename)}`,
              _media: [{ type: 'image' as const, filePath, fileName: filename, mimeType: 'image/jpeg' }],
            };
          }

          case 'wait': {
            const waitText = args.text as string | undefined;
            const waitUrl = args.url as string | undefined;
            const maxWait = Math.min((args.timeMs as number) || 5000, 30_000);
            if (waitText) {
              const safeText = waitText.replace(/"/g, '\\"');
              await page.waitForSelector(`text="${safeText}"`, { timeout: maxWait }).catch(() => {});
            }
            else if (waitUrl) await page.waitForURL(waitUrl, { timeout: maxWait }).catch(() => {});
            else await page.waitForTimeout(Math.min(maxWait, 10_000));
            return { success: true, ...(await snap()) };
          }

          case 'scroll': {
            const delta = (args.direction as string) === 'up' ? -500 : 500;
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(500);
            return { success: true, direction: args.direction || 'down', ...(await snap()) };
          }

          case 'back': {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
            return { success: true, ...(await snap()) };
          }

          case 'tabs': {
            return { tabs: page.context().pages().map((p, i) => ({ index: i, url: p.url(), active: p === page })) };
          }

          case 'hover': {
            const loc = await resolveWithRetry(page, refMap, args.ref as number, args.element as string);
            await loc.hover({ timeout: 10_000 });
            return { success: true };
          }

          case 'forms': {
            // Take a fresh snapshot first to ensure refs are current
            const snapResult = await snap();

            const formData = await page.evaluate(() => {
              const forms: Array<{
                name: string;
                action: string;
                method: string;
                fields: Array<{ ref: number; tag: string; type: string; label: string; name: string; required: boolean; value: string }>;
                submitButton: { ref: number; text: string } | null;
              }> = [];

              for (const form of document.querySelectorAll('form')) {
                const fields: typeof forms[0]['fields'] = [];
                let submitBtn: typeof forms[0]['submitButton'] = null;

                // Find all fields in this form
                for (const el of form.querySelectorAll('input, textarea, select')) {
                  const refAttr = el.getAttribute('data-kc-ref');
                  if (!refAttr) continue;
                  const ref = parseInt(refAttr);
                  const tag = el.tagName.toLowerCase();
                  const type = (el as HTMLInputElement).type || tag;
                  if (type === 'hidden' || type === 'submit') {
                    if (type === 'submit' && !submitBtn) {
                      submitBtn = { ref, text: (el as HTMLInputElement).value || 'Submit' };
                    }
                    continue;
                  }

                  // Find label
                  const id = el.getAttribute('id');
                  // Escape id for CSS selector to prevent injection
                  const safeId = id ? id.replace(/["\\]/g, '') : null;
                  const labelEl = safeId ? document.querySelector(`label[for="${safeId}"]`) : null;
                  const label = labelEl?.textContent?.trim().slice(0, 60)
                    || el.getAttribute('aria-label')
                    || el.getAttribute('placeholder')
                    || el.getAttribute('name')
                    || '';

                  fields.push({
                    ref,
                    tag,
                    type,
                    label,
                    name: el.getAttribute('name') || '',
                    required: (el as HTMLInputElement).required || false,
                    // Never leak password values
                    value: type === 'password' ? '[REDACTED]' : ((el as HTMLInputElement).value || ''),
                  });
                }

                // Find submit button (if not found as input[type=submit])
                if (!submitBtn) {
                  const btn = form.querySelector('button[type="submit"], button:not([type])');
                  if (btn) {
                    const refAttr = btn.getAttribute('data-kc-ref');
                    if (refAttr) {
                      submitBtn = { ref: parseInt(refAttr), text: btn.textContent?.trim().slice(0, 40) || 'Submit' };
                    }
                  }
                }

                if (fields.length > 0) {
                  forms.push({
                    name: form.getAttribute('aria-label') || form.getAttribute('name') || form.getAttribute('id') || `Form ${forms.length + 1}`,
                    action: form.getAttribute('action') || '',
                    method: (form.getAttribute('method') || 'GET').toUpperCase(),
                    fields,
                    submitButton: submitBtn,
                  });
                }
              }
              return forms;
            });

            return {
              url: snapResult.url,
              title: snapResult.title,
              forms: formData,
              formCount: formData.length,
              hint: formData.length > 0
                ? 'Use the fill action with [{ref, value}] to fill form fields, then click the submit button ref.'
                : 'No forms detected on this page.',
            };
          }

          default:
            return { error: `Unknown action: "${action}"` };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: msg };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
