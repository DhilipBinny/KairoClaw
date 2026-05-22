-- Migration 013 — add missing indexes identified in deep audit
--
-- These composite and single-column indexes cover query patterns
-- that currently rely on full table scans or single-column indexes
-- when a composite would be more selective.

-- Audit log: hash-chain verification lookups
CREATE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash);

-- Audit log: tenant-scoped action filtering (replaces two separate scans)
CREATE INDEX IF NOT EXISTS idx_audit_tenant_action ON audit_log(tenant_id, action);

-- Tool permissions: tenant+role lookups for RBAC checks
CREATE INDEX IF NOT EXISTS idx_tool_perms_tenant_role ON tool_permissions(tenant_id, role);

-- Sessions: chat_id lookups (Telegram/Slack resume-by-chat)
CREATE INDEX IF NOT EXISTS idx_sessions_chat_id ON sessions(chat_id);

-- Messages: session history ordered by time (context window loading)
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

-- Messages: session+role filtering (e.g. fetch only user turns)
CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, role);
