-- Kairo — Bulletproof Analytics, Phase 1 foundation
-- Additive only. Run once; safe to re-run (IF NOT EXISTS / ON CONFLICT
-- throughout).

-- ── visitor_events: new columns ──────────────────────────────────────────
-- session_id/referrer/utm_*/landing_page are inherently client-reported
-- (true everywhere, PostHog/GA included) — spoofing your own attribution
-- only corrupts your own analytics, not anyone else's, so no server
-- verification needed here.
--
-- auth_user_id and event_source are different: auth_user_id is set
-- SERVER-SIDE ONLY, by resolving the caller's access_token via
-- supabaseAdmin.auth.getUser() in log-scan.js — never trusted from a
-- client-claimed field, since a spoofed user_id could falsely attribute
-- activity to someone else's account or falsely claim owner status.
-- event_source records whether an event passed that server-side
-- verification ('server') or is an ordinary unverified client report
-- ('client') — this is what makes "server-confirmed" events actually
-- distinguishable from client-claimed ones in later queries, not just a
-- naming convention.
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS referrer TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS utm_source TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS utm_medium TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS landing_page TEXT;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS auth_user_id UUID;
ALTER TABLE visitor_events ADD COLUMN IF NOT EXISTS event_source TEXT NOT NULL DEFAULT 'client';

CREATE INDEX IF NOT EXISTS visitor_events_session_idx ON visitor_events (session_id);
CREATE INDEX IF NOT EXISTS visitor_events_auth_user_idx ON visitor_events (auth_user_id);

-- ── visitor_sessions ──────────────────────────────────────────────────────
-- A session boundary didn't exist before — only the persistent visitor_id.
-- 30 minutes of inactivity (enforced client-side in lib/analytics.js)
-- starts a new session. One row per session, denormalized attribution
-- fields (first-touch for that session) so "unique sessions per visitor"
-- and "sessions by source" queries in Phase 2 don't need to join against
-- visitor_events at all.
CREATE TABLE IF NOT EXISTS visitor_sessions (
  session_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_type TEXT,
  landing_page TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT
);
CREATE INDEX IF NOT EXISTS visitor_sessions_visitor_idx ON visitor_sessions (visitor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS visitor_sessions_started_idx ON visitor_sessions (started_at DESC);

-- ── owner_identities ──────────────────────────────────────────────────────
-- Authenticated-identity owner marking — the STRONGEST signal per the
-- brief, checked server-side against a verified user_id (never a
-- client-claimed one), and the reason owner exclusion now works across
-- devices: log in as the owner anywhere, and that device's activity is
-- excluded automatically, with no need to visit with ?kairo_owner=1 or
-- tap "mark this browser" first. The browser-flag mechanism (localStorage,
-- see lib/analytics.js) remains as a fallback specifically for owner
-- activity while NOT logged in (e.g. testing the signed-out homepage).
CREATE TABLE IF NOT EXISTS owner_identities (
  user_id UUID PRIMARY KEY,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

-- Seeds the real owner account by email, resolved against auth.users —
-- the only place Supabase Auth user records actually live. Safe to
-- re-run (ON CONFLICT DO NOTHING). If this returns 0 rows affected, the
-- account may not exist yet under this email, or auth.users isn't
-- queryable from this context — check manually with:
--   SELECT id, email FROM auth.users WHERE email = 'bundepunemmanuel@gmail.com';
INSERT INTO owner_identities (user_id, note)
SELECT id, 'Primary admin account (bundepunemmanuel@gmail.com)'
FROM auth.users
WHERE email = 'bundepunemmanuel@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- To add another owner-identified account later (e.g. a co-founder):
--   INSERT INTO owner_identities (user_id, note)
--   SELECT id, 'note here' FROM auth.users WHERE email = 'someone@example.com'
--   ON CONFLICT (user_id) DO NOTHING;
