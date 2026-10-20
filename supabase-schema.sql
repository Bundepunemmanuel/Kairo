-- Kairo Supabase Schema — Chunk 2
-- Run this in your Supabase SQL editor

-- Enable RLS (Row Level Security)
-- This ensures users can only see their own data

-- Product profiles table
-- Stores the product URL and analysis result for each user
CREATE TABLE IF NOT EXISTS product_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  url TEXT NOT NULL,
  analysis JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One product profile per user (can be updated when they re-scan)
CREATE UNIQUE INDEX IF NOT EXISTS product_profiles_user_id_idx ON product_profiles(user_id);

-- Enable Row Level Security
ALTER TABLE product_profiles ENABLE ROW LEVEL SECURITY;

-- Users can only read their own product profile
CREATE POLICY "Users can view own profile" ON product_profiles
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own product profile
CREATE POLICY "Users can insert own profile" ON product_profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own product profile
CREATE POLICY "Users can update own profile" ON product_profiles
  FOR UPDATE USING (auth.uid() = user_id);



-- Kairo Supabase Schema — Chunk 3 only (leads table)
-- product_profiles already exists from Chunk 2, skip it

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT NOT NULL,
  subreddit TEXT NOT NULL,
  score FLOAT NOT NULL,
  signal_type TEXT NOT NULL,
  specific_problem TEXT,
  reason TEXT,
  created_at_post BIGINT,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leads_user_id_idx ON leads(user_id);
CREATE INDEX IF NOT EXISTS leads_scanned_at_idx ON leads(scanned_at DESC);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own leads" ON leads
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own leads" ON leads
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own leads" ON leads
  FOR DELETE USING (auth.uid() = user_id);



-- Kairo Chunk 4 — Cron job schema additions
-- Adds: plan field, deleted flag on leads, quota tracking

-- Add plan column to track each user's tier
CREATE TABLE IF NOT EXISTS user_plans (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free', -- free, starter, pro, unlimited
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own plan" ON user_plans
  FOR SELECT USING (auth.uid() = user_id);

-- Add a deleted flag to leads — deletion hides from view but doesn't affect quota
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;

-- Add replied flag — moves lead to "replied" section without deleting
ALTER TABLE leads ADD COLUMN IF NOT EXISTS replied BOOLEAN DEFAULT FALSE;

-- Function to get plan daily lead limit
CREATE OR REPLACE FUNCTION get_plan_limit(p_plan TEXT)
RETURNS INTEGER AS $$
BEGIN
  RETURN CASE p_plan
    WHEN 'free' THEN 3
    WHEN 'starter' THEN 10
    WHEN 'pro' THEN 50
    WHEN 'unlimited' THEN 999999
    ELSE 3
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Set the hardcoded unlimited account
-- Run this after the account has signed up at least once
-- INSERT INTO user_plans (user_id, plan)
-- SELECT id, 'unlimited' FROM auth.users WHERE email = 'bundepunemmanuel@gmail.com'
-- ON CONFLICT (user_id) DO UPDATE SET plan = 'unlimited';





-- Kairo Chunk 6 schema additions

-- Fix: leads table was missing UPDATE policy (this is why Replied/Delete buttons
-- appeared to do nothing — Supabase silently blocks RLS-denied updates)
-- Postgres has no "CREATE POLICY IF NOT EXISTS" syntax, so we drop first if it
-- exists, then create — this makes the script safely re-runnable.
DROP POLICY IF EXISTS "Users can update own leads" ON leads;
CREATE POLICY "Users can update own leads" ON leads
  FOR UPDATE USING (auth.uid() = user_id);

-- User settings table — Telegram notifications, notify frequency
CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  telegram_chat_id TEXT,
  notify_frequency TEXT NOT NULL DEFAULT 'all', -- 'all' or 'critical_only'
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_leads_at TIMESTAMPTZ DEFAULT NOW(), -- used to compute "New" lead badges
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own settings" ON user_settings;
CREATE POLICY "Users can view own settings" ON user_settings
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own settings" ON user_settings;
CREATE POLICY "Users can insert own settings" ON user_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own settings" ON user_settings;
CREATE POLICY "Users can update own settings" ON user_settings
  FOR UPDATE USING (auth.uid() = user_id);

-- Add last_scan_at to product_profiles — shown in Settings as "Last scanned: X ago"
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ DEFAULT NOW();

-- Set the hardcoded unlimited account (run after they've signed up at least once)
-- The Edge Function also enforces this automatically on every cron run as a safety net.
INSERT INTO user_plans (user_id, plan)
SELECT id, 'unlimited' FROM auth.users WHERE email = 'bundepunemmanuel@gmail.com'
ON CONFLICT (user_id) DO UPDATE SET plan = 'unlimited';


-- Run in Supabase SQL Editor before deploying the conversation-loop changes

-- conversation: ordered array of { role: 'sent' | 'them', text, at }
--   'sent'  = what the Kairo user actually posted (after their required edit/confirm)
--   'them'  = what the thread owner replied with (pasted in by the user)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation JSONB DEFAULT '[]'::jsonb;

-- 'open'   = AI thinks this is still worth following up on
-- 'closed' = AI judged the thread owner isn't a fit / conversation resolved —
--            stop suggesting follow-ups for this lead
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_status TEXT DEFAULT 'open'
  CHECK (conversation_status IN ('open', 'closed'));








-- Run this in Supabase SQL Editor before deploying billing.js

create table if not exists upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_plan text not null check (requested_plan in ('starter', 'pro', 'unlimited')),
  created_at timestamptz not null default now()
);

alter table upgrade_requests enable row level security;

-- Users can insert their own upgrade request
create policy "Users can create their own upgrade requests"
  on upgrade_requests for insert
  with check (auth.uid() = user_id);

-- Users can see their own upgrade requests (so billing.js can show
-- "you're on the list" after a page refresh, not just right after clicking)
create policy "Users can view their own upgrade requests"
  on upgrade_requests for select
  using (auth.uid() = user_id);

-- No update/delete policy — requests are immutable once created.
-- Admin reads happen via the service role key in /api/admin.js, which
-- bypasses RLS entirely, so no admin-specific policy is needed here.



-- Run in Supabase SQL Editor before deploying the new index.ts / score.js

-- Tracks every post URL ever sent to an AI for scoring, per user — whether
-- it qualified as a lead or not. Lets cron-scan skip re-scoring the same
-- post twice, which was the single biggest source of wasted tokens.
CREATE TABLE IF NOT EXISTS seen_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_url TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, post_url)
);

CREATE INDEX IF NOT EXISTS seen_posts_user_id_idx ON seen_posts (user_id);

-- No RLS needed — this table is only ever touched by cron-scan via the
-- service role key, never read/written from the client.

-- Tracks when a product's analysis (name/description/subreddits) was last
-- refreshed, separate from last_scan_at (which tracks Reddit scanning).
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS last_analyzed_at TIMESTAMPTZ;

-- Housekeeping note (not automated, run manually every so often):
-- old seen_posts rows are harmless but grow forever. Reddit's "new" feed
-- won't resurface anything this old, so periodically pruning is safe:
--   DELETE FROM seen_posts WHERE scored_at < now() - interval '60 days';

-- ── Homepage scan ticker ────────────────────────────────────────────────
-- One row per completed scan that found at least one qualified lead —
-- logged from every scan path (main onboarding flow, share page's
-- "notify me" flow), not just ones that end in a signup or a share link.
-- Deliberately minimal: product name + numbers only, never lead content
-- or subreddit-level detail, since this is public-facing. No RLS needed —
-- only ever written via the service-role key from /api/log-scan; read
-- publicly (unauthenticated) via /api/scan-feed, which selects only these
-- columns, never anything else from product_profiles.
CREATE TABLE IF NOT EXISTS scan_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  lead_count INTEGER NOT NULL,
  top_score NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scan_feed_created_at_idx ON scan_feed (created_at DESC);

-- The homepage ticker was inserting a new row on every completed scan,
-- including repeat scans of the SAME product (same visitor re-scanning,
-- or re-visiting onboarding) — the ticker would show duplicate-looking
-- entries for one product instead of a single, improving one. `url` is
-- the scanned product's own site URL (not a Reddit post URL — scan_feed
-- has never tracked individual posts), passed through from onboarding.js
-- / share/[token].js, and is what log-scan.js now looks up an existing
-- row by before deciding whether to update it or insert a new one.
ALTER TABLE scan_feed ADD COLUMN IF NOT EXISTS url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS scan_feed_url_idx ON scan_feed (url) WHERE url IS NOT NULL;

-- ── Reddit shared-quota persistence ────────────────────────────────────
-- Reddit enforces a real, numeric, per-IP rate limit — roughly one request
-- per ~30-60 second reset window, shared across the ENTIRE app (every
-- visitor's browser scan, every share-page notify, every cron-scan run —
-- all draw from the same budget, since they all land on the same outbound
-- IP). This single row holds the most recent X-Ratelimit-Reset Reddit
-- reported, converted to an absolute timestamp, so anything in the app can
-- check "is the shared window open right now?" without spending part of
-- that window just to find out.
--
-- Written only by /api/reddit.js (every response, success or 429) via the
-- service-role key. Read by /api/reddit.js itself (mode=status, also
-- service-role — used by onboarding.js and share/[token].js) and directly
-- by cron-scan (index.ts) via the service-role key. Never touched by an
-- anon client, so — same as seen_posts — no RLS policy is needed.
CREATE TABLE IF NOT EXISTS reddit_rate_limit (
  id TEXT PRIMARY KEY DEFAULT 'global',
  reset_at TIMESTAMPTZ,
  remaining NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Seven-day hold system ────────────────────────────────────────────────
-- Accounts inactive for 7+ days (by user_settings.last_active_at — the
-- same field admin.js's churn-risk view already uses, not a new signal)
-- get held: cron-scan's skip-check (index.ts) stops spending AI tokens
-- scanning/scoring for them, without touching their saved leads or
-- deleting anything. held_at is when the hold actually started, so the
-- dashboard banner and the daily cron job (below) both have a fixed point
-- to reason from instead of re-deriving it from last_active_at each time
-- (which would keep moving if, say, an admin manually releases and the
-- user goes quiet again).
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS is_held BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE product_profiles ADD COLUMN IF NOT EXISTS held_at TIMESTAMPTZ;

-- ── Push-engagement tracking (feeds #6's warn/delete cutoff) ────────────
-- Nothing previously tracked whether a sent push was ever actually opened
-- — send-push.js only knew a send succeeded, sw.js's notificationclick
-- handler just navigated and told the server nothing. These three columns
-- are what make "sent but not opened for N days" measurable at all.
-- last_sent_at: set by send-push.js every time a push actually goes out —
--   the #6 clock only runs for subscriptions that have been sent
--   something; a user with zero leads so far isn't "ignoring" anything.
-- last_opened_at: set when sw.js's notificationclick handler pings back
--   (new endpoint on send-push.js, not a new file) — null means never
--   opened, which the #6 cron job treats as "inactive since last_sent_at"
--   rather than erroring on a missing date.
-- warned_at: set the first time the Day 6 warning push goes out, so the
--   daily job doesn't resend the warning every day it stays unopened, and
--   so Day 7's delete step can tell "already warned, still ignored" apart
--   from "never warned yet."
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS warned_at TIMESTAMPTZ;
