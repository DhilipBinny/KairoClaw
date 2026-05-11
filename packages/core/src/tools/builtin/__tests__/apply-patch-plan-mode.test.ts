import { describe, it, expect, vi } from 'vitest';
import { extractPatchPaths } from '@agw/tools-common';
import { planModeTools } from '@agw/tools-common';

const enterPlanMode = planModeTools.find(t => t.definition.name === 'enter_plan_mode')!;
const exitPlanMode = planModeTools.find(t => t.definition.name === 'exit_plan_mode')!;

// ─── extractPatchPaths ──────────────────────────────────────────────

describe('extractPatchPaths', () => {
  it('extracts both a/ and b/ paths from a normal patch', () => {
    const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
 line3
`;
    const paths = extractPatchPaths(patch);
    expect(paths).toContain('src/foo.ts');
  });

  it('excludes /dev/null for additions (--- /dev/null)', () => {
    const patch = `diff --git a/new-file.ts b/new-file.ts
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,2 @@
+hello
+world
`;
    const paths = extractPatchPaths(patch);
    expect(paths).toContain('new-file.ts');
    expect(paths).not.toContain('/dev/null');
  });

  it('excludes /dev/null for deletions (+++ /dev/null)', () => {
    const patch = `diff --git a/old-file.ts b/old-file.ts
--- a/old-file.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;
    const paths = extractPatchPaths(patch);
    expect(paths).toContain('old-file.ts');
    expect(paths).not.toContain('/dev/null');
  });

  it('handles multiple files in one patch', () => {
    const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/c.ts b/src/c.ts
--- /dev/null
+++ b/src/c.ts
@@ -0,0 +1 @@
+brand new
`;
    const paths = extractPatchPaths(patch);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/c.ts');
    expect(paths).not.toContain('/dev/null');
  });
});

// ─── plan mode tools ────────────────────────────────────────────────

describe('plan mode — enter_plan_mode', () => {
  it('calls registry.setPlanMode(sessionId, true)', async () => {
    const setPlanMode = vi.fn();
    const isInPlanMode = vi.fn().mockReturnValue(false);
    const context = {
      toolRegistry: { setPlanMode, isInPlanMode },
      session: { id: 'session-abc-123' },
    } as any;

    const result = await enterPlanMode.executor({}, context);
    expect(setPlanMode).toHaveBeenCalledWith('session-abc-123', true);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/Plan mode: ON/);
  });
});

describe('plan mode — exit_plan_mode', () => {
  it('calls registry.setPlanMode(sessionId, false)', async () => {
    const setPlanMode = vi.fn();
    const isInPlanMode = vi.fn().mockReturnValue(true);
    const context = {
      toolRegistry: { setPlanMode, isInPlanMode },
      session: { id: 'session-abc-123' },
    } as any;

    const result = await exitPlanMode.executor({}, context);
    expect(setPlanMode).toHaveBeenCalledWith('session-abc-123', false);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/Plan mode: OFF/);
  });

  it('returns "already off" text when plan mode was not active', async () => {
    const setPlanMode = vi.fn();
    const isInPlanMode = vi.fn().mockReturnValue(false);
    const context = {
      toolRegistry: { setPlanMode, isInPlanMode },
      session: { id: 'session-xyz-456' },
    } as any;

    const result = await exitPlanMode.executor({}, context);
    const text = (result as any).content[0].text;
    expect(text).toMatch(/already off/);
  });
});
