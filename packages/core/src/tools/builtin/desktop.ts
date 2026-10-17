/**
 * Desktop tools — browser automation + computer-use for the desktop sandbox.
 *
 * Uses module-level containerManager (set via setDesktopManager) and gets
 * the userId from ToolExecutionContext, matching the sandbox-exec pattern.
 */

import type { ToolRegistration } from '@agw/tool-platform';
import type { ToolExecutionContext } from '@agw/types';
import type { ContainerManager } from '@agw/sandbox';

const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

let containerManager: ContainerManager | null = null;

export function setDesktopManager(manager: ContainerManager | null): void {
  containerManager = manager;
}

function getUserId(context: ToolExecutionContext): string | null {
  return context.user?.id ?? null;
}

async function execDesktop(userId: string, command: string, timeoutSec = 10): Promise<string> {
  if (!containerManager) throw new Error('Desktop is not available');
  const result = await containerManager.desktopExec(userId, command, timeoutSec);
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(result.stderr.trim());
  }
  return result.stdout;
}

function checkDesktop(context: ToolExecutionContext): { userId: string } | { error: string } {
  if (!containerManager) return { error: 'Desktop is not available. Sandbox may not be running.' };
  const userId = getUserId(context);
  if (!userId) return { error: 'desktop tools require an authenticated user' };
  const container = containerManager.getDesktopContainer(userId);
  if (!container) return { error: 'No desktop container running for this user. Ask an admin to start one.' };
  return { userId };
}

export const desktopTools: ToolRegistration[] = [
  {
    definition: {
      name: 'desktop_navigate',
      description: 'Navigate the desktop browser to a URL. Returns the page title after loading.',
      alwaysLoad: false,
      searchHint: 'desktop browser navigate url open page',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
    executor: async (args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      const { url } = args as { url: string };
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return JSON.stringify({ error: 'Only http/https URLs allowed' });
        }
      } catch { return JSON.stringify({ error: 'Invalid URL' }); }
      if (/[\x00-\x1f]/.test(url)) return JSON.stringify({ error: 'URL contains control characters' });
      const escaped = url.replace(/'/g, "'\\''");
      await execDesktop(check.userId, `export DISPLAY=:99 && xdotool key ctrl+l && sleep 0.2 && xdotool type --delay 10 -- '${escaped}' && xdotool key Return`, 30);
      await execDesktop(check.userId, 'sleep 2', 5);
      const titleJson = await execDesktop(check.userId, `curl -sf http://127.0.0.1:9222/json | python3 -c "import sys,json; tabs=json.load(sys.stdin); print(json.dumps({'title':tabs[0].get('title',''),'url':tabs[0].get('url','')}))"`, 5);
      return titleJson;
    },
    source: 'builtin',
    category: 'write',
  },

  {
    definition: {
      name: 'desktop_screenshot',
      description: 'Take a screenshot of the desktop browser. Returns base64-encoded PNG image.',
      alwaysLoad: false,
      searchHint: 'desktop screenshot capture screen',
      parameters: { type: 'object', properties: {} },
    },
    executor: async (_args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      await execDesktop(check.userId, 'export DISPLAY=:99 && scrot -o /tmp/desktop-screenshot.png', 5);
      const b64 = await execDesktop(check.userId, 'base64 -w 0 /tmp/desktop-screenshot.png', 10);
      if (b64.length > SCREENSHOT_MAX_BYTES) {
        return JSON.stringify({ error: 'Screenshot too large', sizeBytes: b64.length });
      }
      return JSON.stringify({ image: b64, width: 1280, height: 720, format: 'png' });
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  },

  {
    definition: {
      name: 'desktop_read_page',
      description: 'Read the current page content and URL from the desktop browser.',
      alwaysLoad: false,
      searchHint: 'desktop read page content url title',
      parameters: { type: 'object', properties: {} },
    },
    executor: async (_args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      return execDesktop(check.userId, `curl -sf http://127.0.0.1:9222/json | python3 -c "
import sys, json
tabs = json.load(sys.stdin)
page = next((t for t in tabs if t.get('type') == 'page'), None)
if page:
    print(json.dumps({'title': page.get('title',''), 'url': page.get('url','')}))
else:
    print(json.dumps({'error': 'No page tab found'}))
"`, 5);
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  },

  {
    definition: {
      name: 'desktop_click_xy',
      description: 'Click at specific coordinates on the desktop display. Use after taking a screenshot to identify positions.',
      alwaysLoad: false,
      searchHint: 'desktop click mouse coordinate',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (0-1280)' },
          y: { type: 'number', description: 'Y coordinate (0-720)' },
          button: { type: 'string', description: 'Mouse button: left, right, or middle. Defaults to left' },
        },
        required: ['x', 'y'],
      },
    },
    executor: async (args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      const { x, y, button } = args as { x: number; y: number; button?: string };
      const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      await execDesktop(check.userId, `export DISPLAY=:99 && xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} && xdotool click ${btn}`);
      return JSON.stringify({ clicked: true, x: Math.round(x), y: Math.round(y) });
    },
    source: 'builtin',
    category: 'write',
  },

  {
    definition: {
      name: 'desktop_type_raw',
      description: 'Type text at the current cursor position on the desktop. Use desktop_click_xy to focus an input first.',
      alwaysLoad: false,
      searchHint: 'desktop type text keyboard input',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
    executor: async (args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      const { text } = args as { text: string };
      if (/[\x00-\x1f]/.test(text.replace(/[\n\t\r]/g, ''))) return JSON.stringify({ error: 'Text contains control characters' });
      const escaped = text.replace(/'/g, "'\\''");
      await execDesktop(check.userId, `export DISPLAY=:99 && xdotool type --delay 20 -- '${escaped}'`);
      return JSON.stringify({ typed: true, length: text.length });
    },
    source: 'builtin',
    category: 'write',
  },

  {
    definition: {
      name: 'desktop_key',
      description: 'Press a key or key combination on the desktop. Examples: "Return", "ctrl+a", "ctrl+c", "Tab", "Escape".',
      alwaysLoad: false,
      searchHint: 'desktop key press keyboard shortcut',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or combination (e.g. "Return", "ctrl+a", "alt+F4")' },
        },
        required: ['key'],
      },
    },
    executor: async (args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      const { key } = args as { key: string };
      const safeKey = key.replace(/[^a-zA-Z0-9+_]/g, '');
      await execDesktop(check.userId, `export DISPLAY=:99 && xdotool key ${safeKey}`);
      return JSON.stringify({ pressed: true, key: safeKey });
    },
    source: 'builtin',
    category: 'write',
  },

  {
    definition: {
      name: 'desktop_scroll',
      description: 'Scroll the desktop display up or down.',
      alwaysLoad: false,
      searchHint: 'desktop scroll up down page',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '"up" or "down"' },
          amount: { type: 'number', description: 'Scroll clicks. Defaults to 3' },
        },
        required: ['direction'],
      },
    },
    executor: async (args, context) => {
      const check = checkDesktop(context);
      if ('error' in check) return { error: check.error };
      const { direction, amount } = args as { direction: string; amount?: number };
      const clicks = amount ?? 3;
      const button = direction === 'up' ? '4' : '5';
      const cmds = Array(clicks).fill(`xdotool click ${button}`).join(' && ');
      await execDesktop(check.userId, `export DISPLAY=:99 && ${cmds}`);
      return JSON.stringify({ scrolled: true, direction, clicks });
    },
    source: 'builtin',
    category: 'write',
  },
];
