-- Add variety flag to cron_jobs — enables theme tracking for creative crons
ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS variety INTEGER NOT NULL DEFAULT 0;
