-- Kairo Phase 2 — Admin X-lead watchlist + self-hosted analytics
-- Run this in the Supabase SQL editor. Additive only — nothing here
-- touches or drops existing tables.

-- ── Admin X-lead watchlist (#4) ──────────────────────────────────────────
-- One row per pasted (productUrl, xPostUrl) pair. The batch processor
-- (index.ts, ?task=watchlist-scan) claims 'pending' rows, flips them to
-- 'scanning' while working, and lands on 'done' (with a share_token) or
-- 'error' (with error_message). x_post_url is never used by the scan
-- pipeline itself — it's pure reference data so the admin knows which X
-- post to go reply to with the resulting share link.
CREATE TABLE IF NOT EXISTS watchlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_url TEXT NOT NULL,
  x_post_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | scanning | done | error
  share_token TEXT,
  lead_count INTEGER,
  top_score NUMERIC,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watchlist_items_status_idx ON watchlist_items (status, created_at ASC);

-- Singleton control row the admin's Run/Stop buttons flip and the batch
-- processor reads between items. is_running is purely a UI/admin-visible
-- flag (so Run can be disabled while a chain of self-scheduled slices is
-- still working through the queue); cancel_requested is the actual signal
-- the Edge Function checks before starting its first item in a slice AND
-- again before starting each subsequent item in that same slice, per the
-- requirement that a cancel never leaves an item half-processed.
CREATE TABLE IF NOT EXISTS watchlist_control (
  id TEXT PRIMARY KEY DEFAULT 'global',
  is_running BOOLEAN NOT NULL DEFAULT false,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO watchlist_control (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- No schema change needed for the third reddit_rate_limit row —
-- reddit_rate_limit.id is already TEXT and reddit.js's upsert(onConflict:
-- 'id') will create the 'watchlist-worker' row itself on first write, the
-- same way 'direct' and 'worker' were never manually seeded either.

-- ── Self-hosted analytics (#5, #6) ───────────────────────────────────────
-- Replaces PostHog. One row per tracked event. device_type and is_owner
-- are written at event time (not derived later) since they're per-browser
-- facts the client already knows when the event fires. properties is
-- freeform per event — for share_page_viewed it carries {status, token},
-- which is what #6's per-share view counts are matched against.
CREATE TABLE IF NOT EXISTS visitor_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  device_type TEXT,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  path TEXT,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visitor_events_type_created_idx ON visitor_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS visitor_events_visitor_created_idx ON visitor_events (visitor_id, created_at DESC);
-- Used by #6 (per-share-link view counts) to look up share_page_viewed
-- rows by the token in properties without a full table scan.
CREATE INDEX IF NOT EXISTS visitor_events_share_token_idx
  ON visitor_events ((properties->>'token'))
  WHERE event_type = 'share_page_viewed';
