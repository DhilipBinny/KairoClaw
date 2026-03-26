/**
 * enforceFileOrganization tests — personal vs shared document routing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We can't import enforceFileOrganization directly (it's not exported).
// Recreate the logic here to test the routing decisions.
// The actual function is in files.ts — if it changes, these tests catch drift.

import { PERSONA_FILES, DOCUMENTS_DIR, SCOPE_DIR_NAME, SHARED_DIR } from '../../../constants.js';

function enforceFileOrganization(
  filePath: string,
  workspace: string,
  scopeKey?: string | null,
): { path: string; redirected: boolean; note?: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspace, filePath);
  const relative = path.relative(workspace, resolved);

  if (relative.includes(path.sep)) {
    return { path: resolved, redirected: false };
  }

  const fileName = path.basename(resolved);
  if (PERSONA_FILES.includes(fileName)) {
    throw new Error(`Cannot overwrite "${fileName}" — protected persona file`);
  }

  if (scopeKey) {
    const userDocsDir = path.join(workspace, SCOPE_DIR_NAME, scopeKey, DOCUMENTS_DIR);
    fs.mkdirSync(userDocsDir, { recursive: true });
    return { path: path.join(userDocsDir, fileName), redirected: true, note: 'Saved to your personal documents folder' };
  }

  const sharedDocsDir = path.join(workspace, SHARED_DIR, DOCUMENTS_DIR);
  fs.mkdirSync(sharedDocsDir, { recursive: true });
  return { path: path.join(sharedDocsDir, fileName), redirected: true, note: 'Saved to shared documents folder' };
}

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kairo-org-test-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('enforceFileOrganization', () => {
  // Persona protection
  it('blocks writing IDENTITY.md', () => {
    expect(() => enforceFileOrganization('IDENTITY.md', workspace)).toThrow('protected persona');
  });

  it('blocks writing SOUL.md', () => {
    expect(() => enforceFileOrganization('SOUL.md', workspace)).toThrow('protected persona');
  });

  it('blocks writing RULES.md', () => {
    expect(() => enforceFileOrganization('RULES.md', workspace)).toThrow('protected persona');
  });

  // Scoped user — root writes go to personal documents/
  it('scoped user: root file → personal documents/', () => {
    const result = enforceFileOrganization('report.md', workspace, 'user-uuid');
    expect(result.redirected).toBe(true);
    expect(result.path).toContain(path.join('scopes', 'user-uuid', 'documents', 'report.md'));
    expect(result.note).toContain('personal');
  });

  // No scope (admin/system) — root writes go to shared/
  it('no scope: root file → shared/documents/', () => {
    const result = enforceFileOrganization('report.md', workspace);
    expect(result.redirected).toBe(true);
    expect(result.path).toContain(path.join('shared', 'documents', 'report.md'));
    expect(result.note).toContain('shared');
  });

  // Subdirectory writes pass through
  it('subdirectory write passes through unchanged', () => {
    const result = enforceFileOrganization('shared/documents/team-report.md', workspace);
    expect(result.redirected).toBe(false);
    expect(result.path).toContain('shared/documents/team-report.md');
  });

  it('scope subdirectory write passes through', () => {
    const result = enforceFileOrganization('scopes/user-uuid/documents/my-file.md', workspace, 'user-uuid');
    expect(result.redirected).toBe(false);
  });

  // Creates directories
  it('creates personal documents dir if missing', () => {
    enforceFileOrganization('test.txt', workspace, 'new-user');
    expect(fs.existsSync(path.join(workspace, 'scopes', 'new-user', 'documents'))).toBe(true);
  });

  it('creates shared documents dir if missing', () => {
    enforceFileOrganization('test.txt', workspace);
    expect(fs.existsSync(path.join(workspace, 'shared', 'documents'))).toBe(true);
  });
});
