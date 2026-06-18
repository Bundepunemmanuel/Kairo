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
