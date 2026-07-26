-- 022_wisey_analytics_tables.sql
-- Phase 1: wisey Analytics MVP - Core Tables
-- Creates tables for XP system, badges, and Wisey Score tracking

BEGIN;

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

/* ================================
 * 1. user_xp_progress
 * Tracks current XP, level, and streaks (not monthly scores)
 * ================================ */

CREATE TABLE IF NOT EXISTS public.user_xp_progress (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  current_xp INT DEFAULT 0 CHECK (current_xp >= 0),
  current_level INT DEFAULT 1 CHECK (current_level >= 1),
  total_xp_earned BIGINT DEFAULT 0 CHECK (total_xp_earned >= 0),
  
  -- Current streak (not monthly)
  current_streak_days INT DEFAULT 0 CHECK (current_streak_days >= 0),
  best_streak_days INT DEFAULT 0 CHECK (best_streak_days >= 0),
  streak_last_updated DATE,
  
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xp_level ON public.user_xp_progress(current_level DESC);

-- RLS: Users can only SELECT their own data
ALTER TABLE public.user_xp_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own XP progress" ON public.user_xp_progress;
CREATE POLICY "Users can view own XP progress"
  ON public.user_xp_progress FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE policies for users - only via RPC (service role)

/* ================================
 * 2. user_monthly_scores
 * Stores Wisey Score breakdown per month
 * ================================ */

CREATE TABLE IF NOT EXISTS public.user_monthly_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- "2025-12"
  
  -- Wisey Score components for THIS month
  savings_rate_score DECIMAL(3,1) NOT NULL CHECK (savings_rate_score >= 0 AND savings_rate_score <= 10),
  consistency_score DECIMAL(3,1) NOT NULL CHECK (consistency_score >= 0 AND consistency_score <= 10),
  challenge_score DECIMAL(3,1) NOT NULL CHECK (challenge_score >= 0 AND challenge_score <= 10),
  streak_score DECIMAL(3,1) NOT NULL CHECK (streak_score >= 0 AND streak_score <= 10),
  total_wisey_score DECIMAL(3,1) NOT NULL CHECK (total_wisey_score >= 0 AND total_wisey_score <= 10),
  
  -- Metadata
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_scores ON public.user_monthly_scores(user_id, month DESC);

-- RLS: Users can only SELECT their own data
ALTER TABLE public.user_monthly_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own monthly scores" ON public.user_monthly_scores;
CREATE POLICY "Users can view own monthly scores"
  ON public.user_monthly_scores FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE policies for users - only via edge function (service role)

/* ================================
 * 3. xp_transactions
 * Transaction log for XP awards (prevents double-awarding)
 * ================================ */

CREATE TABLE IF NOT EXISTS public.xp_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  xp_amount INT NOT NULL,
  reason TEXT NOT NULL, -- 'challenge_completed', 'badge_earned', etc.
  reference_id TEXT, -- badge_id or challenge_id for deduplication
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent double-awards at DB level (idempotency)
  UNIQUE(user_id, reason, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_xp_txn ON public.xp_transactions(user_id, created_at DESC);

-- RLS: Users can only SELECT their own data
ALTER TABLE public.xp_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own XP transactions" ON public.xp_transactions;
CREATE POLICY "Users can view own XP transactions"
  ON public.xp_transactions FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT policy for users - only via edge function (service role)

/* ================================
 * 4. user_badges
 * Earned badges
 * ================================ */

CREATE TABLE IF NOT EXISTS public.user_badges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL,
  earned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  xp_awarded INT DEFAULT 0,
  
  -- Prevent duplicate badges
  UNIQUE(user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges ON public.user_badges(user_id, earned_at DESC);

-- RLS: Users can only SELECT their own data
ALTER TABLE public.user_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own badges" ON public.user_badges;
CREATE POLICY "Users can view own badges"
  ON public.user_badges FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT policy for users - only via edge function (service role)

/* ================================
 * 5. spending_personality_history
 * Track personality changes over months
 * ================================ */

CREATE TABLE IF NOT EXISTS public.spending_personality_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- "2025-12"
  personality_type TEXT NOT NULL, -- "steady_saver", "weekend_warrior", etc.
  personality_score DECIMAL(3,1),
  month_streak_days INT,
  
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_personality_month ON public.spending_personality_history(user_id, month DESC);

-- RLS: Users can only SELECT their own data
ALTER TABLE public.spending_personality_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own personality history" ON public.spending_personality_history;
CREATE POLICY "Users can view own personality history"
  ON public.spending_personality_history FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE policies for users - only via edge function (service role)

COMMIT;
