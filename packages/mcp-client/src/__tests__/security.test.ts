import { describe, it, expect } from 'vitest';
import { validateServerEnv } from '../security.js';

/**
 * #146 MCP-001 — validateServerEnv is now wired into the spawn path so gateway
 * secrets handed to a third-party MCP process are flagged. These tests cover the
 * detection logic the wiring relies on.
 */
describe('validateServerEnv', () => {
  it('flags gateway API keys and provider secrets', () => {
    const r = validateServerEnv({
      SOME_TOKEN: 'agw_sk_live_abc123',
      ANTHROPIC_API_KEY: 'sk-ant-xxxx',
      OPENAI_API_KEY: 'sk-proj-yyyy',
      TELEGRAM_BOT_TOKEN: '123456:ABCDEF',
    });
    expect(r.safe).toBe(false);
    expect(r.warnings.length).toBe(4);
  });

  it('passes a clean env', () => {
    const r = validateServerEnv({ PATH: '/usr/bin', MY_SERVER_URL: 'https://example.com', DEBUG: '1' });
    expect(r.safe).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('flags by value, not just key name', () => {
    const r = validateServerEnv({ INNOCENT_NAME: 'agw_sk_leaked' });
    expect(r.safe).toBe(false);
  });

  it('does NOT warn on a generic credential name with a non-secret value', () => {
    // A server's own short/empty token shouldn't trigger warning fatigue.
    const r = validateServerEnv({ GITHUB_TOKEN: 'short', WEATHER_API_KEY: '' });
    expect(r.safe).toBe(true);
  });

  it('DOES warn on a generic credential name with a secret-shaped value', () => {
    const r = validateServerEnv({ GITHUB_TOKEN: 'ghp_' + 'a1B2c3D4'.repeat(5) });
    expect(r.safe).toBe(false);
  });
});
