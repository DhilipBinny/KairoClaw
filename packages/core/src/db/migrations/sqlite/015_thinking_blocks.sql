-- Add thinking_blocks column to messages table for extended thinking persistence
ALTER TABLE messages ADD COLUMN thinking_blocks TEXT;
