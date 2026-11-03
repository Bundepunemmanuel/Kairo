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

-- ── Dedicated one-time-schedule RPC for the watchlist batch ─────────────
-- index.ts's main cron-scan loop reuses an existing schedule_followup_batch
-- RPC to self-reschedule its own follow-up slices. That RPC's own comment
-- in index.ts says it "upserts" its job, which strongly suggests pg_cron's
-- job name it schedules under is a single fixed string — not derived from
-- target_url. If that's accurate, a watchlist-scan follow-up scheduled
-- around the same moment as a cron-scan follow-up would silently
-- overwrite whichever one lost, since cron.schedule() itself upserts by
-- job name.
--
-- Rather than edit a function I haven't actually seen the body of (and
-- risk breaking the thing the main scan loop depends on every 30
-- minutes), this is a SEPARATE function, modeled on the same
-- cron.schedule()/net.http_post() pattern already used in
-- pg-cron-schedule.sql for the main hourly trigger — but scheduled under
-- its OWN job name ('kairo-watchlist-followup'), so it can never collide
-- with whatever job name schedule_followup_batch uses. index.ts's
-- runWatchlistScan calls THIS function, not schedule_followup_batch.
--
-- cron.schedule()'s own upsert-by-job-name behavior is still exactly
-- what we want here: each watchlist slice replaces the previous
-- watchlist slice's pending job, so slices never pile up — the same
-- "naturally replaces itself" property the main loop relies on, just
-- scoped to a name only this feature ever touches.
-- SECURITY DEFINER is the fix for "permission denied for schema cron":
-- without it, this function runs with the CALLER's privileges (the
-- service_role the admin panel/Edge Function connects as), which has no
-- direct USAGE grant on the cron schema. With it, the function runs as
-- its OWNER instead (whoever ran this CREATE — normally postgres, which
-- does have cron access), the same reason the original
-- schedule_followup_batch already works today without this needing to be
-- called out explicitly there. search_path is pinned for the usual
-- SECURITY DEFINER hygiene reason: without it, a search_path hijack
-- (e.g. a malicious function named cron.schedule earlier in a caller's
-- path) could run instead of the real one.
CREATE OR REPLACE FUNCTION schedule_watchlist_followup(
  target_url TEXT,
  auth_header TEXT,
  run_at TIMESTAMPTZ
)
RETURNS void
SECURITY DEFINER
SET search_path = public, cron, net
AS $$
BEGIN
  PERFORM cron.schedule(
    'kairo-watchlist-followup',
    -- One-time run: pg_cron's five-field syntax has no native "once at
    -- this timestamp", so this builds a minute/hour/day/month cron
    -- expression (day-of-week left as *) that only ever matches run_at's
    -- exact minute, in UTC since that's what pg_cron evaluates against.
    -- The job fires once at that minute; the next watchlist-scan
    -- invocation (if any) calls this function again and cron.schedule()
    -- upserts a fresh one-time expression over it — never a recurring
    -- job left behind.
    format('%s %s %s %s *',
      extract(minute from run_at AT TIME ZONE 'UTC')::int,
      extract(hour from run_at AT TIME ZONE 'UTC')::int,
      extract(day from run_at AT TIME ZONE 'UTC')::int,
      extract(month from run_at AT TIME ZONE 'UTC')::int
    ),
    format(
      $sql$ SELECT net.http_post(
        url := %L,
        headers := %L::jsonb,
        body := '{}'::jsonb
      ); $sql$,
      target_url,
      jsonb_build_object('Content-Type', 'application/json', 'Authorization', auth_header)
    )
  );
END;
$$ LANGUAGE plpgsql;

-- Explicit, rather than relying on the default PUBLIC execute grant a
-- newly created function gets — the admin panel and index.ts both call
-- this as service_role.
GRANT EXECUTE ON FUNCTION schedule_watchlist_followup(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- To check/unschedule if something looks stuck:
--   SELECT * FROM cron.job WHERE jobname = 'kairo-watchlist-followup';
--   SELECT cron.unschedule('kairo-watchlist-followup');

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
