-- P3: Auto-discovery of allowed senders
CREATE TABLE IF NOT EXISTS pending_senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  message_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  UNIQUE(channel, sender_id)
);
