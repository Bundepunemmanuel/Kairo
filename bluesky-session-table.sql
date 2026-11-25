-- Kairo — Bluesky session cache.
-- Mirrors the existing reddit_rate_limit table's shape: a tiny table
-- written by the server after every real network call, read before the
-- next one, so nothing has to re-authenticate on every request. Bluesky's
-- access token expires in minutes and a serverless function has no
-- memory between invocations, so without this every single request would
-- re-authenticate from scratch.
--
-- Single row (id is always 'default') — one shared Bluesky account for
-- the whole app, not per-user.

CREATE TABLE IF NOT EXISTS bluesky_session (
  id TEXT PRIMARY KEY,
  access_jwt TEXT NOT NULL,
  refresh_jwt TEXT NOT NULL,
  -- When access_jwt actually expires, as reported by Bluesky at session
  -- creation/refresh time — never guessed or hardcoded on our side.
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
