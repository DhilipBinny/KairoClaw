/**
 * Desktop tools — browser automation + computer-use for the desktop sandbox.
 *
 * Two modes:
 * - CDP tools (desktop_navigate, desktop_click, desktop_type, desktop_read_page,
 *   desktop_screenshot): precise browser control via Chrome DevTools Protocol.
 * - Computer-use tools (desktop_screen, desktop_click_xy, desktop_type_raw,
 *   desktop_key): general desktop automation via xdotool + screenshots.
 *
 * These tools are NOT in builtinTools — they're registered dynamically when
 * a desktop container is active for the user.
 */

import type { ToolRegistration } from '@agw/tool-platform';
import type { ContainerManager } from '@agw/sandbox';

const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Create desktop tool registrations for a user with an active desktop container.
 * The tools use ContainerManager.exec to run commands inside the container
 * (xdotool, scrot) for computer-use automation.
 */
export function createDesktopTools(
  containerManager: ContainerManager,
  userId: string,
): ToolRegistration[] {
  async function execDesktop(command: string, timeoutSec = 10): Promise<string> {
    const result = await containerManager.desktopExec(userId, command, timeoutSec);
    if (result.exitCode !== 0 && result.stderr) {
      throw new Error(result.stderr.trim());
    }
    return result.stdout;
  }

  // ── CDP tools (browser-specific) ───────────────────────

  const desktopNavigate: ToolRegistration = {
    definition: {
      name: 'desktop_navigate',
      description: 'Navigate the desktop browser to a URL. Returns the page title after loading.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
    executor: async (args) => {
      const { url } = args as { url: string };
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return JSON.stringify({ error: 'Only http/https URLs allowed' });
        }
      } catch { return JSON.stringify({ error: 'Invalid URL' }); }
      if (/[\x00-\x1f]/.test(url)) return JSON.stringify({ error: 'URL contains control characters' });
      const escaped = url.replace(/'/g, "'\\''");
      await execDesktop(`export DISPLAY=:99 && xdotool key ctrl+l && sleep 0.2 && xdotool type --delay 10 -- '${escaped}' && xdotool key Return`, 30);
      await execDesktop('sleep 2', 5);
      const titleJson = await execDesktop(`curl -sf http://127.0.0.1:9222/json | python3 -c "import sys,json; tabs=json.load(sys.stdin); print(json.dumps({'title':tabs[0].get('title',''),'url':tabs[0].get('url','')}))"`, 5);
      return titleJson;
    },
    source: 'builtin',
    category: 'write',
  };

  const desktopScreenshot: ToolRegistration = {
    definition: {
      name: 'desktop_screenshot',
      description: 'Take a screenshot of the desktop browser. Returns base64-encoded PNG image.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    executor: async () => {
      await execDesktop('export DISPLAY=:99 && scrot -o /tmp/desktop-screenshot.png', 5);
      const b64 = await execDesktop('base64 -w 0 /tmp/desktop-screenshot.png', 10);
      if (b64.length > SCREENSHOT_MAX_BYTES) {
        return JSON.stringify({ error: 'Screenshot too large', sizeBytes: b64.length });
      }
      return JSON.stringify({ image: b64, width: 1280, height: 720, format: 'png' });
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  };

  const desktopReadPage: ToolRegistration = {
    definition: {
      name: 'desktop_read_page',
      description: 'Read the current page content and URL from the desktop browser.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    executor: async () => {
      const result = await execDesktop(`curl -sf http://127.0.0.1:9222/json | python3 -c "
import sys, json
tabs = json.load(sys.stdin)
page = next((t for t in tabs if t.get('type') == 'page'), None)
if page:
    print(json.dumps({'title': page.get('title',''), 'url': page.get('url','')}))
else:
    print(json.dumps({'error': 'No page tab found'}))
"`, 5);
      return result;
    },
    source: 'builtin',
    category: 'read',
    concurrencySafe: true,
  };

  // ── Computer-use tools (general desktop) ───────────────

  const desktopClickXy: ToolRegistration = {
    definition: {
      name: 'desktop_click_xy',
      description: 'Click at specific coordinates on the desktop display. Use after taking a screenshot to identify positions.',
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
    executor: async (args) => {
      const { x, y, button } = args as { x: number; y: number; button?: string };
      const btn = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
      await execDesktop(`export DISPLAY=:99 && xdotool mousemove --sync ${Math.round(x)} ${Math.round(y)} && xdotool click ${btn}`);
      return JSON.stringify({ clicked: true, x: Math.round(x), y: Math.round(y) });
    },
    source: 'builtin',
    category: 'write',
  };

  const desktopTypeRaw: ToolRegistration = {
    definition: {
      name: 'desktop_type_raw',
      description: 'Type text at the current cursor position on the desktop. Does not click first — use desktop_click_xy to focus an input first.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
    executor: async (args) => {
      const { text } = args as { text: string };
      if (/[\x00-\x1f]/.test(text.replace(/[\n\t\r]/g, ''))) return JSON.stringify({ error: 'Text contains control characters' });
      const escaped = text.replace(/'/g, "'\\''");
      await execDesktop(`export DISPLAY=:99 && xdotool type --delay 20 -- '${escaped}'`);
      return JSON.stringify({ typed: true, length: text.length });
    },
    source: 'builtin',
    category: 'write',
  };

  const desktopKey: ToolRegistration = {
    definition: {
      name: 'desktop_key',
      description: 'Press a key or key combination on the desktop. Examples: "Return", "ctrl+a", "ctrl+c", "Tab", "Escape", "F5".',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key or key combination (e.g. "Return", "ctrl+a", "alt+F4")' },
        },
        required: ['key'],
      },
    },
    executor: async (args) => {
      const { key } = args as { key: string };
      const safeKey = key.replace(/[^a-zA-Z0-9+_]/g, '');
      await execDesktop(`export DISPLAY=:99 && xdotool key ${safeKey}`);
      return JSON.stringify({ pressed: true, key: safeKey });
    },
    source: 'builtin',
    category: 'write',
  };

  const desktopScroll: ToolRegistration = {
    definition: {
      name: 'desktop_scroll',
      description: 'Scroll the desktop display up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', description: '"up" or "down"' },
          amount: { type: 'number', description: 'Scroll clicks. Defaults to 3' },
        },
        required: ['direction'],
      },
    },
    executor: async (args) => {
      const { direction, amount } = args as { direction: string; amount?: number };
      const clicks = amount ?? 3;
      const button = direction === 'up' ? '4' : '5';
      const cmds = Array(clicks).fill(`xdotool click ${button}`).join(' && ');
      await execDesktop(`export DISPLAY=:99 && ${cmds}`);
      return JSON.stringify({ scrolled: true, direction, clicks });
    },
    source: 'builtin',
    category: 'write',
  };

  return [
    desktopNavigate,
    desktopScreenshot,
    desktopReadPage,
    desktopClickXy,
    desktopTypeRaw,
    desktopKey,
    desktopScroll,
  ];
}
