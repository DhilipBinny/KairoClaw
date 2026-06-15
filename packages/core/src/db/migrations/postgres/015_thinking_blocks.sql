-- Add thinking_blocks column to messages table for extended thinking persistence
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thinking_blocks TEXT;
