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
