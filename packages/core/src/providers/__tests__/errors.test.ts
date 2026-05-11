import { describe, it, expect } from 'vitest';
import { classifyError } from '@agw/provider-bridge';

describe('classifyError — timeout classification', () => {
  it('classifies AbortError by name', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = classifyError(err);
    expect(result.type).toBe('timeout');
    expect(result.retriable).toBe(true);
    expect(result.action).toBe('failover');
  });

  it('classifies "Request was aborted." message', () => {
    const result = classifyError(new Error('Request was aborted.'));
    expect(result.type).toBe('timeout');
    expect(result.retriable).toBe(true);
    expect(result.action).toBe('failover');
  });

  it('classifies "timed out" message', () => {
    const result = classifyError(new Error('Connection timed out'));
    expect(result.type).toBe('timeout');
    expect(result.retriable).toBe(true);
  });

  it('classifies ETIMEDOUT', () => {
    const err = new Error('connect ETIMEDOUT 1.2.3.4:443');
    const result = classifyError(err);
    expect(result.type).toBe('timeout');
    expect(result.retriable).toBe(true);
  });
});
