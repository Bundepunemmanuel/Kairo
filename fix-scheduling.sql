-- Kairo — scheduling fixes
-- 1) kairo-lead-scan: every 30 minutes → hourly
-- 2) schedule_watchlist_followup + a matching unschedule function, so the
--    watchlist's follow-up job never sits "active" for a year after a miss
-- 3) schedule_followup_batch + unschedule_batch_followup, same fix for the
--    main loop's own follow-up (kairo-batch-followup), which turned out to
--    have the identical flaw — it's been dead since Oct 21.
--
-- Safe to run all of this even though you already have earlier versions —
-- CREATE OR REPLACE and cron.schedule() both overwrite cleanly by name.

-- ── 1) Hourly main scan ──────────────────────────────────────────────────
SELECT cron.schedule(
  'kairo-lead-scan',
  '0 * * * *',  -- was '*/30 * * * *'
  $$
  SELECT net.http_post(
    url := 'https://qohemjizplefdvkgizmu.supabase.co/functions/v1/cron-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_SUPABASE_SERVICE_ROLE_KEY_HERE'
    ),
    body := '{}'::jsonb
  );
  $$
);
-- cron.schedule() upserts by job name, so this replaces the existing
-- kairo-lead-scan registration in place — no separate unschedule step.
-- NOTE: swap in the real service role key before running if this line's
-- placeholder doesn't already match what's live — check with:
--   SELECT command FROM cron.job WHERE jobname = 'kairo-lead-scan';
-- and copy the real Authorization value from there if different.

-- ── 2) Watchlist follow-up — rebuilt without the fragile one-shot trick ──
-- The old version computed a cron expression matching one exact future
-- minute with only a few seconds of buffer. Any delay between computing
-- that timestamp and cron.schedule() actually registering could push past
-- the target minute — and pg_cron never retries a missed minute, it just
-- waits for that exact minute/hour/day/month to recur (up to a year
-- later), while the job still reports active: true the whole time. This
-- is exactly what happened to kairo-watchlist-followup.
--
-- The fix doesn't make the buffer safer — it makes staleness impossible
-- to hide: runWatchlistScan now unschedules this job the moment it starts
-- (via unschedule_watchlist_followup, below), every single invocation,
-- before deciding whether to register the next one. So at any moment
-- there's either exactly one live future job, or none — never a dead one
-- silently sitting there. The admin kickoff (Run button) no longer uses
-- this function at all — it fires the first slice immediately via a
-- direct fetch from pages/api/admin.js, since there's no reason to delay
-- that one. This function is now only called from the 2-minute
-- self-reschedule gap between slices, where the buffer is naturally much
-- safer than the old 5-second kickoff ever was.
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

GRANT EXECUTE ON FUNCTION schedule_watchlist_followup(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- Called at the START of every runWatchlistScan invocation, before
-- anything else. If no job exists under this name (the normal case right
-- after a slice that found nothing left pending, or the very first ever
-- call), cron.unschedule() raises — caught and ignored, since "nothing to
-- clean up" isn't a real error here.
CREATE OR REPLACE FUNCTION unschedule_watchlist_followup()
RETURNS void
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  PERFORM cron.unschedule('kairo-watchlist-followup');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION unschedule_watchlist_followup() TO service_role;

-- ── 3) Main loop's own follow-up — same fix, same reasoning ─────────────
-- kairo-batch-followup had the identical flaw (confirmed: its schedule
-- was 'Oct 21, 3:03 AM' — already a week-plus stale by the time this was
-- found). This is a fresh rewrite under the same job name and the same
-- target_url/auth_header/run_at signature index.ts already calls, so the
-- main loop's own call site barely changes — it just also calls
-- unschedule_batch_followup() at the start of its run, same pattern as
-- the watchlist side.
CREATE OR REPLACE FUNCTION schedule_followup_batch(
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
    'kairo-batch-followup',
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

GRANT EXECUTE ON FUNCTION schedule_followup_batch(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION unschedule_batch_followup()
RETURNS void
SECURITY DEFINER
SET search_path = public, cron
AS $$
BEGIN
  PERFORM cron.unschedule('kairo-batch-followup');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION unschedule_batch_followup() TO service_role;

-- To verify after deploying + a couple of scan cycles:
--   SELECT jobid, jobname, schedule, active FROM cron.job;
-- Both follow-up jobs should only exist when real work is actually
-- pending — if either is "active" with no plausible near-future
-- schedule, something regressed.
