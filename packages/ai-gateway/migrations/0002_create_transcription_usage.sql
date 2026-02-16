-- Migration: Create transcription usage tracking table for minute-based metering
-- Run with: wrangler d1 execute screenpipe-usage --file=./migrations/0002_create_transcription_usage.sql

CREATE TABLE IF NOT EXISTS transcription_usage (
  user_id TEXT PRIMARY KEY,           -- clerk_id or device_id for anonymous
  minutes_used REAL DEFAULT 0,        -- total minutes consumed (cumulative, never resets)
  minutes_granted REAL DEFAULT 500,   -- total minutes granted (500 for new signups)
  tier TEXT DEFAULT 'anonymous',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for tier-based analytics
CREATE INDEX IF NOT EXISTS idx_transcription_tier ON transcription_usage(tier);
