// Re-export from @agw/database — backward compatible
export type { DatabaseAdapter, DatabaseConfig } from '@agw/database';
export { SQLiteAdapter, PostgresAdapter, createDatabase, runMigrations } from '@agw/database';

// Core-specific exports that stay here
export { seedDatabase } from './seed.js';
export { migrateV1Data } from './migrate-v1.js';
