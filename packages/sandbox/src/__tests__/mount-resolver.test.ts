import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveMounts, toDockerBinds } from '../mount-resolver.js';
import {
  CONTAINER_WORKSPACE_PATH,
  CONTAINER_SHARED_PATH,
  CONTAINER_PERSONA_PATH,
} from '../constants.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-'));
  // Create workspace structure
  fs.mkdirSync(path.join(tmpDir, 'shared', 'documents'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'IDENTITY.md'), '# Test Agent');
  fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Personality');
  fs.writeFileSync(path.join(tmpDir, 'RULES.md'), '# Rules');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveMounts — admin', () => {
  it('mounts full workspace for admin with read-write', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: true,
      mountMode: 'read-write',
    });

    expect(result.binds).toHaveLength(1);
    expect(result.binds[0].hostPath).toBe(tmpDir);
    expect(result.binds[0].containerPath).toBe(CONTAINER_WORKSPACE_PATH);
    expect(result.binds[0].readOnly).toBe(false);
    expect(result.workdir).toBe(CONTAINER_WORKSPACE_PATH);
  });

  it('mounts full workspace read-only for admin with read-only mode', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: true,
      mountMode: 'read-only',
    });

    expect(result.binds).toHaveLength(1);
    expect(result.binds[0].readOnly).toBe(true);
  });

  it('returns no binds for admin with none mode', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: true,
      mountMode: 'none',
    });

    expect(result.binds).toHaveLength(0);
    expect(result.workdir).toBe(CONTAINER_WORKSPACE_PATH);
  });
});

describe('resolveMounts — non-admin', () => {
  it('mounts scope dir + shared + persona files for scoped user', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'user-abc-123',
      isAdmin: false,
      mountMode: 'read-write',
    });

    // scope dir + shared + 3 persona files = 5 binds
    expect(result.binds).toHaveLength(5);

    const scopeBind = result.binds.find(b => b.containerPath === CONTAINER_WORKSPACE_PATH);
    expect(scopeBind).toBeDefined();
    expect(scopeBind!.hostPath).toBe(path.join(tmpDir, 'scopes', 'user-abc-123'));
    expect(scopeBind!.readOnly).toBe(false);

    const sharedBind = result.binds.find(b => b.containerPath === CONTAINER_SHARED_PATH);
    expect(sharedBind).toBeDefined();
    expect(sharedBind!.readOnly).toBe(true);

    const personaBinds = result.binds.filter(b => b.containerPath.startsWith(CONTAINER_PERSONA_PATH));
    expect(personaBinds).toHaveLength(3);
    personaBinds.forEach(b => expect(b.readOnly).toBe(true));
  });

  it('blocks path traversal via scopeKey', () => {
    expect(() => resolveMounts({
      workspacePath: tmpDir,
      scopeKey: '../../etc',
      isAdmin: false,
      mountMode: 'read-write',
    })).toThrow('path traversal');
  });

  it('blocks path traversal with encoded dots', () => {
    expect(() => resolveMounts({
      workspacePath: tmpDir,
      scopeKey: '../../../root',
      isAdmin: false,
      mountMode: 'read-write',
    })).toThrow('path traversal');
  });

  it('creates scope dir if it does not exist', () => {
    const scopePath = path.join(tmpDir, 'scopes', 'new-user');
    expect(fs.existsSync(scopePath)).toBe(false);

    resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'new-user',
      isAdmin: false,
      mountMode: 'read-write',
    });

    expect(fs.existsSync(scopePath)).toBe(true);
  });

  it('applies read-only to scope mount in read-only mode', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'user-abc',
      isAdmin: false,
      mountMode: 'read-only',
    });

    const scopeBind = result.binds.find(b => b.containerPath === CONTAINER_WORKSPACE_PATH);
    expect(scopeBind!.readOnly).toBe(true);
  });

  it('returns no binds for non-admin with none mode', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'user-abc',
      isAdmin: false,
      mountMode: 'none',
    });

    expect(result.binds).toHaveLength(0);
  });

  it('skips persona files that do not exist', () => {
    fs.unlinkSync(path.join(tmpDir, 'RULES.md'));

    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'user-abc',
      isAdmin: false,
      mountMode: 'read-write',
    });

    const personaBinds = result.binds.filter(b => b.containerPath.startsWith(CONTAINER_PERSONA_PATH));
    expect(personaBinds).toHaveLength(2); // only IDENTITY.md + SOUL.md
  });

  it('skips shared if shared dir does not exist', () => {
    fs.rmSync(path.join(tmpDir, 'shared'), { recursive: true });

    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: 'user-abc',
      isAdmin: false,
      mountMode: 'read-write',
    });

    const sharedBind = result.binds.find(b => b.containerPath === CONTAINER_SHARED_PATH);
    expect(sharedBind).toBeUndefined();
  });

  it('handles null scopeKey (no scope mount, but shared + persona)', () => {
    const result = resolveMounts({
      workspacePath: tmpDir,
      scopeKey: null,
      isAdmin: false,
      mountMode: 'read-write',
    });

    const scopeBind = result.binds.find(b => b.containerPath === CONTAINER_WORKSPACE_PATH);
    expect(scopeBind).toBeUndefined();

    const sharedBind = result.binds.find(b => b.containerPath === CONTAINER_SHARED_PATH);
    expect(sharedBind).toBeDefined();
  });
});

describe('toDockerBinds', () => {
  it('converts read-write mounts', () => {
    const binds = toDockerBinds([
      { hostPath: '/host/path', containerPath: '/container/path', readOnly: false },
    ]);
    expect(binds).toEqual(['/host/path:/container/path']);
  });

  it('converts read-only mounts', () => {
    const binds = toDockerBinds([
      { hostPath: '/host/path', containerPath: '/container/path', readOnly: true },
    ]);
    expect(binds).toEqual(['/host/path:/container/path:ro']);
  });

  it('handles multiple binds', () => {
    const binds = toDockerBinds([
      { hostPath: '/a', containerPath: '/x', readOnly: false },
      { hostPath: '/b', containerPath: '/y', readOnly: true },
    ]);
    expect(binds).toEqual(['/a:/x', '/b:/y:ro']);
  });

  it('handles empty array', () => {
    expect(toDockerBinds([])).toEqual([]);
  });
});
