-- Kairo — follow-up addition to phase2-schema.sql
-- Only this block is new since you last ran the schema file. Everything
-- else in phase2-schema.sql (watchlist_items, watchlist_control,
-- visitor_events + indexes) you've already applied — don't re-run those.

CREATE OR REPLACE FUNCTION schedule_watchlist_followup(
  target_url TEXT,
  auth_header TEXT,
  run_at TIMESTAMPTZ
)
RETURNS void AS $$
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

-- To check/unschedule if something looks stuck:
--   SELECT * FROM cron.job WHERE jobname = 'kairo-watchlist-followup';
--   SELECT cron.unschedule('kairo-watchlist-followup');
