-- Multi-user hardening: sender_links table + user columns

-- sender_links: maps channel sender IDs (Telegram user ID, WhatsApp phone) to user accounts
CREATE TABLE IF NOT EXISTS sender_links (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  linked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(tenant_id, channel_type, sender_id)
);
CREATE INDEX IF NOT EXISTS idx_sender_links_lookup ON sender_links(channel_type, sender_id);
CREATE INDEX IF NOT EXISTS idx_sender_links_user ON sender_links(user_id);

-- Users: elevated access toggle (grants dangerous tools to non-admin users)
ALTER TABLE users ADD COLUMN IF NOT EXISTS elevated INTEGER NOT NULL DEFAULT 0;

-- Users: soft delete support
ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TEXT;
