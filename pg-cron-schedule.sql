-- Kairo Chunk 4 — pg_cron schedule
-- Run this in Supabase SQL editor AFTER deploying the cron-scan Edge Function
-- Requires pg_cron and pg_net extensions (enabled by default on most Supabase projects)

-- Enable extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule the cron-scan Edge Function to run every 30 minutes
SELECT cron.schedule(
  'kairo-lead-scan',           -- job name
  '*/30 * * * *',              -- every 30 minutes
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

-- To check scheduled jobs:
-- SELECT * FROM cron.job;

-- To unschedule (if needed):
-- SELECT cron.unschedule('kairo-lead-scan');

-- To set the unlimited account (run once after the user signs up):
-- INSERT INTO user_plans (user_id, plan)
-- SELECT id, 'unlimited' FROM auth.users WHERE email = 'bundepunemmanuel@gmail.com'
-- ON CONFLICT (user_id) DO UPDATE SET plan = 'unlimited';
