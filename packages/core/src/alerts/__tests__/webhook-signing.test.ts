import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebhookAlertChannel } from '../channels/webhook.js';
import type { AlertEvent, AlertInstance } from '@agw/types';

const SECRET = 'test-webhook-secret';

function makeEvent(overrides?: Partial<AlertEvent>): AlertEvent {
  return {
    type: 'test_alert',
    severity: 'warning',
    title: 'Test alert',
    message: 'Something happened',
    fingerprint: 'fp-1',
    labels: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeInstance(overrides?: Partial<AlertInstance>): AlertInstance {
  return {
    message: 'Instance detail',
    firedAt: Date.now(),
    resolvedAt: null,
    count: 1,
    ...overrides,
  } as AlertInstance;
}

describe('webhook signing with replay protection', () => {
  let channel: WebhookAlertChannel;
  let capturedHeaders: Record<string, string>;
  let capturedBody: string;

  beforeEach(() => {
    channel = new WebhookAlertChannel();
    capturedHeaders = {};
    capturedBody = '';

    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      capturedHeaders = opts.headers as Record<string, string>;
      capturedBody = opts.body as string;
      return { ok: true } as Response;
    }));
  });

  it('includes X-Webhook-Timestamp header when secret is configured', async () => {
    channel.setConfig(['https://example.com/hook'], SECRET);
    await channel.send(makeEvent(), makeInstance(), 'firing');

    expect(capturedHeaders['X-Webhook-Timestamp']).toBeDefined();
    const ts = Number(capturedHeaders['X-Webhook-Timestamp']);
    expect(ts).toBeGreaterThan(0);
    expect(Math.abs(ts - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('signature covers timestamp.payload for replay protection', async () => {
    channel.setConfig(['https://example.com/hook'], SECRET);
    await channel.send(makeEvent(), makeInstance(), 'firing');

    const ts = capturedHeaders['X-Webhook-Timestamp'];
    const sigHeader = capturedHeaders['X-Webhook-Signature'];
    const reportedSig = sigHeader.replace('sha256=', '');

    const expected = createHmac('sha256', SECRET)
      .update(`${ts}.${capturedBody}`)
      .digest('hex');
    expect(reportedSig).toBe(expected);
  });

  it('omits signature and timestamp headers when no secret is configured', async () => {
    channel.setConfig(['https://example.com/hook'], '');
    await channel.send(makeEvent(), makeInstance(), 'firing');

    expect(capturedHeaders['X-Webhook-Signature']).toBeUndefined();
    expect(capturedHeaders['X-Webhook-Timestamp']).toBeUndefined();
  });
});
