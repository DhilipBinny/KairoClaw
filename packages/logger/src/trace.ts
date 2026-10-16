import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

interface TraceContext {
  traceId: string;
}

const traceStore = new AsyncLocalStorage<TraceContext>();

export function getTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

export function withTraceId<T>(fn: () => T, traceId?: string): T {
  const id = traceId ?? `tr-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return traceStore.run({ traceId: id }, fn);
}

export function withTraceIdAsync<T>(fn: () => Promise<T>, traceId?: string): Promise<T> {
  const id = traceId ?? `tr-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  return traceStore.run({ traceId: id }, fn);
}
