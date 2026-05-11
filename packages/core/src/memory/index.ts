/**
 * Re-export shim — delegates to @agw/memory-engine.
 * Wraps MemorySystem to inject the core logger.
 */
export type { MemoryChunk, MemoryStats } from '@agw/memory-engine';

import { MemorySystem as _MemorySystem } from '@agw/memory-engine';
import type { DatabaseAdapter, GatewayConfig } from '@agw/types';
import { createModuleLogger } from '../observability/logger.js';

const log = createModuleLogger('memory');

export class MemorySystem extends _MemorySystem {
  constructor(db: DatabaseAdapter, workspace: string, config?: GatewayConfig) {
    super(db, workspace, config, log as any);
  }
}
