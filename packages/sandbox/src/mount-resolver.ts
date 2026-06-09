import path from 'node:path';
import fs from 'node:fs';
import type { SandboxMountMode } from '@agw/types';
import {
  CONTAINER_WORKSPACE_PATH,
  CONTAINER_SHARED_PATH,
  CONTAINER_PERSONA_PATH,
  PERSONA_FILES,
} from './constants.js';

export interface MountBind {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface ResolvedMounts {
  binds: MountBind[];
  workdir: string;
}

/**
 * Resolve the Docker bind mounts for a sandbox container.
 *
 * Admin users get the full workspace mounted at /workspace.
 * Non-admin users get their scope directory + shared + persona files.
 */
export function resolveMounts(opts: {
  workspacePath: string;
  scopeKey: string | null;
  isAdmin: boolean;
  mountMode: SandboxMountMode;
}): ResolvedMounts {
  const { workspacePath, scopeKey, isAdmin, mountMode } = opts;
  const binds: MountBind[] = [];

  if (mountMode === 'none') {
    return { binds: [], workdir: CONTAINER_WORKSPACE_PATH };
  }

  const isReadOnly = mountMode === 'read-only';

  if (isAdmin) {
    binds.push({
      hostPath: workspacePath,
      containerPath: CONTAINER_WORKSPACE_PATH,
      readOnly: isReadOnly,
    });
  } else {
    if (scopeKey) {
      const scopeDir = path.join(workspacePath, 'scopes', scopeKey);
      ensureDirExists(scopeDir);
      binds.push({
        hostPath: scopeDir,
        containerPath: CONTAINER_WORKSPACE_PATH,
        readOnly: isReadOnly,
      });
    }

    const sharedDir = path.join(workspacePath, 'shared');
    if (fs.existsSync(sharedDir)) {
      binds.push({
        hostPath: sharedDir,
        containerPath: CONTAINER_SHARED_PATH,
        readOnly: true,
      });
    }

    for (const file of PERSONA_FILES) {
      const filePath = path.join(workspacePath, file);
      if (fs.existsSync(filePath)) {
        binds.push({
          hostPath: filePath,
          containerPath: path.join(CONTAINER_PERSONA_PATH, file),
          readOnly: true,
        });
      }
    }
  }

  return { binds, workdir: CONTAINER_WORKSPACE_PATH };
}

/**
 * Convert MountBind array to Docker bind-mount strings.
 */
export function toDockerBinds(mounts: MountBind[]): string[] {
  return mounts.map(m => {
    const ro = m.readOnly ? ':ro' : '';
    return `${m.hostPath}:${m.containerPath}${ro}`;
  });
}

function ensureDirExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
