import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { Agent, fetch } from 'undici';
import { readBodyCapped } from '../http.js';
import type { Response as UndiciResponse } from 'undici';

/**
 * #146 PLUG-002 — plugin response bodies (including binary downloads) must be
 * size-bounded so a malicious/oversized endpoint can't OOM the process.
 */

// Minimal Response stand-in: just the bits readBodyCapped uses.
function fakeRes(bytes: number, declaredLen?: number, chunk = 64 * 1024): UndiciResponse {
  async function* gen() {
    let remaining = bytes;
    while (remaining > 0) {
      const n = Math.min(chunk, remaining);
      remaining -= n;
      yield Buffer.alloc(n, 1);
    }
  }
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'content-length' && declaredLen != null ? String(declaredLen) : null) },
    body: gen(),
  } as unknown as UndiciResponse;
}

describe('readBodyCapped', () => {
  it('reads a small body fully', async () => {
    const buf = await readBodyCapped(fakeRes(1000, 1000), 1024 * 1024);
    expect(buf.length).toBe(1000);
  });

  it('rejects up-front when Content-Length exceeds the cap', async () => {
    await expect(readBodyCapped(fakeRes(10, 5_000_000), 1_000_000)).rejects.toThrow(/too large/i);
  });

  it('rejects while streaming when the body exceeds the cap despite a small/absent Content-Length', async () => {
    // Lies: declares 10 bytes but streams 3MB. Must still be aborted.
    await expect(readBodyCapped(fakeRes(3_000_000, 10), 1_000_000)).rejects.toThrow(/too large/i);
  });

  it('handles a missing body', async () => {
    const res = { headers: { get: () => null }, body: null } as unknown as UndiciResponse;
    const buf = await readBodyCapped(res);
    expect(buf.length).toBe(0);
  });
});

describe('readBodyCapped does not leak the connection on the Content-Length cap', () => {
  let server: http.Server;
  let agent: Agent;

  afterAll(async () => {
    agent?.close();
    await new Promise<void>(r => server?.close(() => r()));
  });

  it('frees the pooled socket so a later request still succeeds (connections:1)', async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('content-length', '999999999'); // claim ~1GB
      res.end('x'); // but send almost nothing
    });
    await new Promise<void>(r => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    agent = new Agent({ connections: 1, pipelining: 0 });

    // First request trips the up-front Content-Length cap.
    const r1 = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: agent });
    await expect(readBodyCapped(r1, 1_000_000)).rejects.toThrow(/too large/i);

    // With only one pooled connection, this hangs/times out unless the first
    // response's body was cancelled and the socket released.
    const r2 = await fetch(`http://127.0.0.1:${port}/`, {
      dispatcher: agent,
      signal: AbortSignal.timeout(3000),
    });
    await expect(readBodyCapped(r2, 1_000_000)).rejects.toThrow(/too large/i);
  });
});
