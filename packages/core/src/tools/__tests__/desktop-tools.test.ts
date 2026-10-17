import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutionContext, SandboxExecResult } from '@agw/types';

const mockDesktopExec = vi.fn<(userId: string, command: string, timeoutSec?: number) => Promise<SandboxExecResult>>().mockResolvedValue({
  exitCode: 0, stdout: '{}', stderr: '',
});
const mockGetDesktopContainer = vi.fn().mockReturnValue({
  containerId: 'desktop-1',
  userId: 'user-1',
  desktop: true,
});

vi.mock('@agw/sandbox', () => ({
  ContainerManager: vi.fn(),
}));

const { desktopTools, setDesktopManager } = await import('../builtin/desktop.js');

function makeContext(userId?: string): ToolExecutionContext {
  return {
    user: userId ? { id: userId, role: 'user' } : undefined,
    session: { id: 'sess-1' } as any,
  };
}

function findTool(name: string) {
  return desktopTools.find(t => t.definition.name === name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDesktopExec.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });
  mockGetDesktopContainer.mockReturnValue({ containerId: 'desktop-1', userId: 'user-1', desktop: true });

  setDesktopManager({
    desktopExec: mockDesktopExec,
    getDesktopContainer: mockGetDesktopContainer,
  } as any);
});

describe('desktop tools', () => {
  describe('checkDesktop guard', () => {
    it('returns error when no manager is set', async () => {
      setDesktopManager(null);
      const tool = findTool('desktop_screenshot');
      const result = await tool.executor({}, makeContext('user-1'));
      expect(result).toEqual({ error: expect.stringContaining('not available') });
    });

    it('returns error when no user in context', async () => {
      const tool = findTool('desktop_screenshot');
      const result = await tool.executor({}, makeContext());
      expect(result).toEqual({ error: expect.stringContaining('authenticated user') });
    });

    it('returns error when no desktop container running', async () => {
      mockGetDesktopContainer.mockReturnValue(null);
      const tool = findTool('desktop_screenshot');
      const result = await tool.executor({}, makeContext('user-1'));
      expect(result).toEqual({ error: expect.stringContaining('No desktop container') });
    });
  });

  describe('desktop_navigate', () => {
    it('rejects non-http protocols', async () => {
      const tool = findTool('desktop_navigate');
      const result = await tool.executor({ url: 'file:///etc/passwd' }, makeContext('user-1'));
      expect(JSON.parse(result as string)).toEqual({ error: 'Only http/https URLs allowed' });
    });

    it('rejects invalid URLs', async () => {
      const tool = findTool('desktop_navigate');
      const result = await tool.executor({ url: 'not a url' }, makeContext('user-1'));
      expect(JSON.parse(result as string)).toEqual({ error: 'Invalid URL' });
    });

    it('rejects URLs with control characters', async () => {
      const tool = findTool('desktop_navigate');
      const result = await tool.executor({ url: 'http://example.com/\x00' }, makeContext('user-1'));
      expect(JSON.parse(result as string)).toEqual({ error: 'URL contains control characters' });
    });

    it('navigates to valid http URL', async () => {
      mockDesktopExec.mockResolvedValue({ exitCode: 0, stdout: '{"title":"Google","url":"https://google.com"}', stderr: '' });
      const tool = findTool('desktop_navigate');
      await tool.executor({ url: 'https://google.com' }, makeContext('user-1'));
      expect(mockDesktopExec).toHaveBeenCalled();
    });
  });

  describe('desktop_key', () => {
    it('allows alphanumeric keys', async () => {
      const tool = findTool('desktop_key');
      await tool.executor({ key: 'Return' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('xdotool key Return');
    });

    it('allows plus for key combinations', async () => {
      const tool = findTool('desktop_key');
      await tool.executor({ key: 'ctrl+a' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('xdotool key ctrl+a');
    });

    it('allows hyphens for key names', async () => {
      const tool = findTool('desktop_key');
      await tool.executor({ key: 'ctrl-a' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('xdotool key ctrl-a');
    });

    it('allows underscores and periods for X key names', async () => {
      const tool = findTool('desktop_key');
      await tool.executor({ key: 'KP_Decimal' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('xdotool key KP_Decimal');
    });

    it('strips dangerous characters like semicolons, spaces, slashes', async () => {
      const tool = findTool('desktop_key');
      await tool.executor({ key: 'Return; rm -rf /' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).not.toContain(';');
      expect(cmd).not.toContain('/');
      expect(cmd).not.toContain(' rm');
      expect(cmd).toContain('xdotool key Returnrm-rf');
    });
  });

  describe('desktop_scroll', () => {
    it('defaults to 3 clicks', async () => {
      const tool = findTool('desktop_scroll');
      const result = await tool.executor({ direction: 'down' }, makeContext('user-1'));
      expect(JSON.parse(result as string).clicks).toBe(3);
    });

    it('caps amount at 20', async () => {
      const tool = findTool('desktop_scroll');
      const result = await tool.executor({ direction: 'up', amount: 100 }, makeContext('user-1'));
      expect(JSON.parse(result as string).clicks).toBe(20);
    });

    it('enforces minimum of 1', async () => {
      const tool = findTool('desktop_scroll');
      const result = await tool.executor({ direction: 'down', amount: -5 }, makeContext('user-1'));
      expect(JSON.parse(result as string).clicks).toBe(1);
    });

    it('uses xdotool --repeat flag', async () => {
      const tool = findTool('desktop_scroll');
      await tool.executor({ direction: 'down', amount: 5 }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('--repeat 5');
    });

    it('uses button 4 for up and 5 for down', async () => {
      const tool = findTool('desktop_scroll');
      await tool.executor({ direction: 'up' }, makeContext('user-1'));
      expect((mockDesktopExec.mock.calls[0][1] as string)).toContain('click --repeat 3 --delay 50 4');

      mockDesktopExec.mockClear();
      await tool.executor({ direction: 'down' }, makeContext('user-1'));
      expect((mockDesktopExec.mock.calls[0][1] as string)).toContain('click --repeat 3 --delay 50 5');
    });
  });

  describe('desktop_type_raw', () => {
    it('rejects control characters (except newline/tab)', async () => {
      const tool = findTool('desktop_type_raw');
      const result = await tool.executor({ text: 'hello\x01world' }, makeContext('user-1'));
      expect(JSON.parse(result as string)).toEqual({ error: 'Text contains control characters' });
    });

    it('allows newlines and tabs', async () => {
      const tool = findTool('desktop_type_raw');
      await tool.executor({ text: 'hello\nworld\ttab' }, makeContext('user-1'));
      expect(mockDesktopExec).toHaveBeenCalled();
    });
  });

  describe('desktop_click_xy', () => {
    it('rounds coordinates to integers', async () => {
      const tool = findTool('desktop_click_xy');
      const result = await tool.executor({ x: 100.7, y: 200.3 }, makeContext('user-1'));
      const parsed = JSON.parse(result as string);
      expect(parsed.x).toBe(101);
      expect(parsed.y).toBe(200);
    });

    it('defaults to left mouse button', async () => {
      const tool = findTool('desktop_click_xy');
      await tool.executor({ x: 100, y: 200 }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('click 1');
    });

    it('supports right click', async () => {
      const tool = findTool('desktop_click_xy');
      await tool.executor({ x: 100, y: 200, button: 'right' }, makeContext('user-1'));
      const cmd = mockDesktopExec.mock.calls[0][1] as string;
      expect(cmd).toContain('click 3');
    });
  });

  describe('execDesktop error handling', () => {
    it('throws on non-zero exit code even with empty stderr', async () => {
      mockDesktopExec.mockResolvedValueOnce({ exitCode: 1, stdout: 'error output', stderr: '' });
      const tool = findTool('desktop_screenshot');
      await expect(tool.executor({}, makeContext('user-1'))).rejects.toThrow('error output');
    });

    it('prefers stderr over stdout for error message', async () => {
      mockDesktopExec.mockResolvedValueOnce({ exitCode: 1, stdout: 'out', stderr: 'err msg' });
      const tool = findTool('desktop_screenshot');
      await expect(tool.executor({}, makeContext('user-1'))).rejects.toThrow('err msg');
    });
  });
});
