-- MCP servers are now stored in config.json, not in the database.
-- The mcp_servers table was used in early versions and migrated via
-- migrateDbMcpToConfig(). This migration removes the legacy table.
DROP TABLE IF EXISTS mcp_servers;
