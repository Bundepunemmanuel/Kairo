-- Kairo — Nurture system + watchlist reply tracking
-- Additive only. Safe to re-run.

-- ── Watchlist reply tracking ─────────────────────────────────────────────
ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

-- ── Nurture system ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nurture_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_url TEXT NOT NULL,
  x_contact TEXT NOT NULL, -- X comment/post URL or founder username
  status TEXT NOT NULL DEFAULT 'cold', -- cold | warm | interested | stopped
  times_sent INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nurture_items_status_idx ON nurture_items (status, created_at DESC);
