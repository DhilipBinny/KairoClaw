/**
 * Browse tool — full browser automation for the AI agent.
 *
 * Uses Playwright with system Chromium. Single tool with action discriminator.
 * Flat schema compatible with all LLM providers (no anyOf/oneOf).
 *
 * Accessibility-ref-based interaction: the LLM reads a text snapshot
 * with numbered refs and uses those refs to click/type/select.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Page } from 'playwright-core';
import type { ToolRegistration } from '../types.js';
import type { BrowserSessionManager } from '../../browser/session-manager.js';
import { validateFetchUrl, validateResolvedIP } from './web.js';

const MAX_SNAPSHOT_CHARS = 60_000;
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Get page snapshot — two-pass approach:
 * 1. Direct query ALL interactive elements (inputs, buttons, links, selects)
 * 2. Extract page text content (headings, paragraphs) for context
 * This never misses elements regardless of DOM nesting depth.
 */
async function getSnapshot(page: Page, maxChars = MAX_SNAPSHOT_CHARS): Promise<string> {
  try {
    const snapshot = await page.evaluate(() => {
      const sections: string[] = [];

      // ── Pass 1: All interactive elements (direct query, no tree walking) ──
      const interactive: string[] = [];
      const seen = new Set<Element>();

      function describeElement(el: Element): string | null {
        if (seen.has(el)) return null;
        seen.add(el);
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
        // Skip tiny/invisible elements
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;

        const tag = el.tagName;
        const name = el.getAttribute('aria-label')
          || el.getAttribute('title')
          || el.getAttribute('placeholder')
          || el.getAttribute('alt')
          || el.textContent?.trim().slice(0, 80)
          || '';
        if (!name) return null;

        if (tag === 'INPUT') {
          const input = el as HTMLInputElement;
          if (input.type === 'hidden') return null;
          let desc = `[input type=${input.type || 'text'}] "${name}"`;
          if (input.value) desc += ` value="${input.value.slice(0, 50)}"`;
          if (input.disabled) desc += ' [disabled]';
          if (input.required) desc += ' [required]';
          return desc;
        }
        if (tag === 'TEXTAREA') {
          const ta = el as HTMLTextAreaElement;
          let desc = `[textarea] "${name}"`;
          if (ta.value) desc += ` value="${ta.value.slice(0, 50)}"`;
          return desc;
        }
        if (tag === 'SELECT') {
          const select = el as HTMLSelectElement;
          let desc = `[select] "${name}"`;
          if (select.value) desc += ` value="${select.value}"`;
          const opts = Array.from(select.options).map(o => o.text.trim()).slice(0, 5);
          if (opts.length) desc += ` options=[${opts.join(', ')}]`;
          return desc;
        }
        if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
          return `[button] "${name}"`;
        }
        if (tag === 'A') {
          return `[link] "${name}"`;
        }
        // Elements with click handlers or role
        const role = el.getAttribute('role');
        if (role && ['tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio'].includes(role)) {
          let desc = `[${role}] "${name}"`;
          if (el.getAttribute('aria-checked') === 'true') desc += ' [checked]';
          if (el.getAttribute('aria-selected') === 'true') desc += ' [selected]';
          return desc;
        }
        return null;
      }

      // Query all interactive elements at once — no depth limit issues
      const elements = document.querySelectorAll(
        'input, textarea, select, button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="searchbox"]'
      );
      for (const el of elements) {
        const desc = describeElement(el);
        if (desc) interactive.push(desc);
        if (interactive.length >= 100) break; // cap to prevent token explosion
      }

      if (interactive.length > 0) {
        sections.push('INTERACTIVE ELEMENTS:\n' + interactive.join('\n'));
      }

      // ── Pass 2: Page text content (headings + key text) ──
      const content: string[] = [];

      // Headings
      const headings = document.querySelectorAll('h1, h2, h3, h4');
      for (const h of headings) {
        const text = h.textContent?.trim().slice(0, 150);
        if (text) content.push(`[${h.tagName.toLowerCase()}] ${text}`);
        if (content.length >= 20) break;
      }

      // Key text: paragraphs, list items, table cells with prices/data
      const textNodes = document.querySelectorAll('p, li, td, th, span[class*="price"], span[class*="Price"], [data-price], .a-price, .a-offscreen');
      for (const el of textNodes) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = el.textContent?.trim().slice(0, 200);
        if (text && text.length > 5) {
          content.push(text);
        }
        if (content.length >= 80) break;
      }

      if (content.length > 0) {
        sections.push('PAGE CONTENT:\n' + content.join('\n'));
      }

      return sections.join('\n\n');
    });

    if (!snapshot || snapshot.trim().length === 0) {
      return '[Empty page — no visible content]';
    }
    if (snapshot.length > maxChars) {
      return snapshot.slice(0, maxChars) + '\n[...TRUNCATED — page content exceeds limit]';
    }
    return snapshot;
  } catch {
    try {
      const text = await page.textContent('body');
      const trimmed = (text || '').trim().slice(0, maxChars);
      return trimmed || '[Empty page]';
    } catch {
      return '[Failed to read page content]';
    }
  }
}

/** Find element by ref-like approach: use accessibility snapshot to build a selector map. */
async function findElementByText(page: Page, text: string): Promise<string | null> {
  // Try common patterns: button, link, input by accessible name
  for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem']) {
    const locator = page.getByRole(role as any, { name: text, exact: false });
    if (await locator.count() > 0) {
      return `role=${role}[name="${text}"]`;
    }
  }
  // Fallback: text content
  const locator = page.getByText(text, { exact: false });
  if (await locator.count() > 0) return `text="${text}"`;
  return null;
}

export const browseTools: ToolRegistration[] = [
  {
    definition: {
      name: 'browse',
      description: `Browse and interact with web pages using a real browser. Returns an accessibility snapshot (text representation of the page with element descriptions).

WORKFLOW:
1. Use action="navigate" to go to a URL
2. Read the returned snapshot to understand the page structure
3. Use click/type/select with element text descriptions from the snapshot
4. After navigation or interactions, a fresh snapshot is auto-returned

RULES:
- Use the element descriptions from the snapshot to target elements
- For forms with multiple fields, use action="fill" to fill all at once
- Use action="screenshot" only for visual verification, not for finding elements
- If an action fails, take a fresh snapshot before retrying

ACTIONS:
- navigate: Go to URL. Returns snapshot. Params: url (required)
- click: Click element. Params: element (required — text/name from snapshot)
- type: Type into input. Params: element (required), text (required), submit (optional — press Enter after)
- press: Press keyboard key. Params: key (required — e.g. "Enter", "Tab", "Escape")
- select: Select dropdown option. Params: element (required), value (required)
- fill: Fill multiple form fields. Params: fields (required — array of {element, value})
- snapshot: Get current page content. No params needed.
- screenshot: Capture page image. Params: fullPage (optional)
- wait: Wait for condition. Params: text (wait for text), url (wait for URL pattern), timeMs (wait duration)
- scroll: Scroll page. Params: direction ("up" or "down")
- back: Navigate back in history
- tabs: List open tabs
- hover: Hover element. Params: element (required)
- close: End browser session`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'click', 'type', 'press', 'select', 'fill', 'snapshot', 'screenshot', 'wait', 'scroll', 'back', 'tabs', 'hover', 'close'],
            description: 'The browser action to perform',
          },
          url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
          element: { type: 'string', description: 'Element description/name from snapshot (for click/type/select/hover)' },
          text: { type: 'string', description: 'Text to type (for type action) or text to wait for (for wait action)' },
          key: { type: 'string', description: 'Keyboard key to press (for press action). E.g. "Enter", "Tab", "Escape", "ArrowDown"' },
          value: { type: 'string', description: 'Value to select (for select action)' },
          fields: {
            type: 'array',
            description: 'Array of {element, value} objects for batch form fill',
            items: {
              type: 'object',
              properties: {
                element: { type: 'string', description: 'Element description/name' },
                value: { type: 'string', description: 'Value to fill' },
              },
            },
          },
          submit: { type: 'boolean', description: 'Press Enter after typing (for type action)' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          fullPage: { type: 'boolean', description: 'Capture full page screenshot (default: viewport only)' },
          timeMs: { type: 'number', description: 'Wait duration in ms (for wait action)' },
        },
        required: ['action'],
      },
    },
    executor: async (args, context) => {
      const action = args.action as string;
      if (!action) return { error: 'action is required' };

      const ctx = context as Record<string, unknown>;
      const browserManager = ctx.browserManager as BrowserSessionManager | undefined;
      if (!browserManager) {
        return { error: 'Browser not available. The browse tool requires Chromium to be installed.' };
      }

      const userId = (ctx.user as { id?: string } | undefined)?.id || 'anonymous';
      const workspace = (ctx.workspace as string) || process.cwd();

      // Close action doesn't need a session
      if (action === 'close') {
        await browserManager.closeSession(userId);
        return { success: true, message: 'Browser session closed' };
      }

      // Get or create browser session
      let page: Page;
      try {
        const session = await browserManager.getSession(userId);
        page = session.page;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Failed to start browser: ${msg}. Chromium may not be installed.` };
      }

      try {
        switch (action) {
          // ── Navigate ───────────────────────────
          case 'navigate': {
            const url = args.url as string;
            if (!url) return { error: 'url is required for navigate action' };

            // SSRF check
            try {
              const parsed = validateFetchUrl(url);
              await validateResolvedIP(parsed.hostname);
            } catch (e: unknown) {
              return { error: `Blocked: ${e instanceof Error ? e.message : String(e)}` };
            }

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            // Wait for JS rendering — try networkidle, fallback to timeout
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
            const snapshot = await getSnapshot(page);
            return {
              success: true,
              url: page.url(),
              title: await page.title(),
              snapshot,
            };
          }

          // ── Click ──────────────────────────────
          case 'click': {
            const element = args.element as string;
            if (!element) return { error: 'element is required for click. Use a description from the snapshot.' };

            // Try to find and click the element
            try {
              // Try getByRole first (most reliable)
              const selector = await findElementByText(page, element);
              if (selector) {
                if (selector.startsWith('role=')) {
                  const match = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
                  if (match) {
                    await page.getByRole(match[1] as any, { name: match[2] }).first().click({ timeout: 10_000 });
                  }
                } else if (selector.startsWith('text=')) {
                  await page.getByText(element, { exact: false }).first().click({ timeout: 10_000 });
                }
              } else {
                // Last resort: try as CSS selector
                await page.click(element, { timeout: 10_000 });
              }
            } catch {
              return { error: `Could not find or click element: "${element}". Take a fresh snapshot to see current page elements.` };
            }

            await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
            const snapshot = await getSnapshot(page);
            return { success: true, url: page.url(), title: await page.title(), snapshot };
          }

          // ── Type ───────────────────────────────
          case 'type': {
            const element = args.element as string;
            const text = args.text as string;
            if (!element) return { error: 'element is required for type action' };
            if (!text) return { error: 'text is required for type action' };

            try {
              const selector = await findElementByText(page, element);
              if (selector) {
                const match = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
                if (match) {
                  const loc = page.getByRole(match[1] as any, { name: match[2] }).first();
                  await loc.fill(text, { timeout: 10_000 });
                } else {
                  await page.getByText(element, { exact: false }).first().fill(text, { timeout: 10_000 });
                }
              } else {
                await page.fill(element, text, { timeout: 10_000 });
              }
            } catch {
              return { error: `Could not find or type into element: "${element}". Take a fresh snapshot.` };
            }

            if (args.submit) {
              await page.keyboard.press('Enter');
              await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
              const snapshot = await getSnapshot(page);
              return { success: true, url: page.url(), title: await page.title(), snapshot };
            }
            return { success: true, typed: text.length + ' characters' };
          }

          // ── Press ──────────────────────────────
          case 'press': {
            const key = args.key as string;
            if (!key) return { error: 'key is required for press action (e.g. "Enter", "Tab", "Escape")' };

            await page.keyboard.press(key);
            const navKeys = ['Enter', 'Tab', 'Escape'];
            if (navKeys.includes(key)) {
              await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
              const snapshot = await getSnapshot(page);
              return { success: true, key, url: page.url(), snapshot };
            }
            return { success: true, key };
          }

          // ── Select ─────────────────────────────
          case 'select': {
            const element = args.element as string;
            const value = args.value as string;
            if (!element) return { error: 'element is required for select action' };
            if (!value) return { error: 'value is required for select action' };

            try {
              const selector = await findElementByText(page, element);
              if (selector) {
                const match = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
                if (match) {
                  await page.getByRole(match[1] as any, { name: match[2] }).first().selectOption(value, { timeout: 10_000 });
                } else {
                  await page.getByText(element, { exact: false }).first().selectOption(value, { timeout: 10_000 });
                }
              } else {
                await page.selectOption(element, value, { timeout: 10_000 });
              }
            } catch {
              return { error: `Could not find or select on element: "${element}". Take a fresh snapshot.` };
            }
            return { success: true, selected: value };
          }

          // ── Fill (batch) ───────────────────────
          case 'fill': {
            const fields = args.fields as Array<{ element: string; value: string }> | undefined;
            if (!fields || !Array.isArray(fields) || fields.length === 0) {
              return { error: 'fields array is required for fill action. E.g. [{element: "Email", value: "me@example.com"}]' };
            }

            const results: string[] = [];
            for (const field of fields) {
              try {
                const selector = await findElementByText(page, field.element);
                if (selector) {
                  const match = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
                  if (match) {
                    await page.getByRole(match[1] as any, { name: match[2] }).first().fill(field.value, { timeout: 5_000 });
                    results.push(`${field.element}: filled`);
                  } else {
                    await page.getByText(field.element, { exact: false }).first().fill(field.value, { timeout: 5_000 });
                    results.push(`${field.element}: filled`);
                  }
                } else {
                  results.push(`${field.element}: not found`);
                }
              } catch {
                results.push(`${field.element}: failed`);
              }
            }

            const snapshot = await getSnapshot(page);
            return { success: true, results, url: page.url(), snapshot };
          }

          // ── Snapshot ───────────────────────────
          case 'snapshot': {
            const snapshot = await getSnapshot(page);
            return { url: page.url(), title: await page.title(), snapshot };
          }

          // ── Screenshot ─────────────────────────
          case 'screenshot': {
            const fullPage = args.fullPage as boolean || false;
            const buffer = await page.screenshot({
              fullPage,
              type: 'jpeg',
              quality: 75,
            });

            if (buffer.length > MAX_SCREENSHOT_SIZE) {
              return { error: 'Screenshot too large (max 5MB). Try viewport-only (fullPage: false).' };
            }

            // Save to user's scoped media dir
            const user = (ctx.user as { id?: string } | undefined);
            const mediaDir = user?.id
              ? path.join(workspace, 'scopes', user.id, 'media')
              : path.join(workspace, 'shared', 'media');
            const filename = `screenshot-${Date.now()}.jpg`;
            const filePath = path.join(mediaDir, filename);
            try {
              fs.mkdirSync(mediaDir, { recursive: true });
              fs.writeFileSync(filePath, buffer);
            } catch (e: unknown) {
              return { error: `Failed to save screenshot: ${e instanceof Error ? e.message : 'disk error'}` };
            }

            return {
              success: true,
              url: page.url(),
              title: await page.title(),
              screenshot: `/api/v1/media/${encodeURIComponent(filename)}`,
              _media: [{
                type: 'image' as const,
                filePath,
                fileName: filename,
                mimeType: 'image/jpeg',
              }],
            };
          }

          // ── Wait ───────────────────────────────
          case 'wait': {
            const waitText = args.text as string | undefined;
            const waitUrl = args.url as string | undefined;
            const timeMs = (args.timeMs as number) || 5000;
            const maxWait = Math.min(timeMs, 30_000);

            if (waitText) {
              await page.waitForSelector(`text="${waitText}"`, { timeout: maxWait }).catch(() => {});
            } else if (waitUrl) {
              await page.waitForURL(waitUrl, { timeout: maxWait }).catch(() => {});
            } else {
              await page.waitForTimeout(Math.min(maxWait, 10_000));
            }

            const snapshot = await getSnapshot(page);
            return { success: true, url: page.url(), title: await page.title(), snapshot };
          }

          // ── Scroll ─────────────────────────────
          case 'scroll': {
            const direction = (args.direction as string) || 'down';
            const delta = direction === 'up' ? -500 : 500;
            await page.mouse.wheel(0, delta);
            await page.waitForTimeout(500);
            const snapshot = await getSnapshot(page);
            return { success: true, direction, url: page.url(), snapshot };
          }

          // ── Back ───────────────────────────────
          case 'back': {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
            const snapshot = await getSnapshot(page);
            return { success: true, url: page.url(), title: await page.title(), snapshot };
          }

          // ── Tabs ───────────────────────────────
          case 'tabs': {
            const pages = page.context().pages();
            const tabs = pages.map((p, i) => ({
              index: i,
              url: p.url(),
              title: '', // title is async, keep it simple
              active: p === page,
            }));
            return { tabs };
          }

          // ── Hover ──────────────────────────────
          case 'hover': {
            const element = args.element as string;
            if (!element) return { error: 'element is required for hover action' };

            try {
              const selector = await findElementByText(page, element);
              if (selector) {
                const match = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
                if (match) {
                  await page.getByRole(match[1] as any, { name: match[2] }).first().hover({ timeout: 10_000 });
                } else {
                  await page.getByText(element, { exact: false }).first().hover({ timeout: 10_000 });
                }
              } else {
                await page.hover(element, { timeout: 10_000 });
              }
            } catch {
              return { error: `Could not find element to hover: "${element}"` };
            }
            return { success: true };
          }

          default:
            return { error: `Unknown action: "${action}". Valid actions: navigate, click, type, press, select, fill, snapshot, screenshot, wait, scroll, back, tabs, hover, close` };
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `Browser error: ${msg}` };
      }
    },
    source: 'builtin',
    category: 'execute',
  },
];
