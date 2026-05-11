/**
 * Re-export shim — delegates to @agw/memory-engine.
 */
export {
  deriveScopeKey,
  deriveGroupScopeKey,
  resolveScopedFile,
  getScopedMemoryDir,
  ensureScopeDir,
  migrateScopesToUserUUID,
  migrateToSharedDir,
} from '@agw/memory-engine';
