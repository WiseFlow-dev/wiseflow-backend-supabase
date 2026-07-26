-- Phase 1: Insight pinned copy storage for stable monthly insights
-- This table stores Gemini-generated copy that stays stable within a month

CREATE TABLE IF NOT EXISTS insight_pinned_copy (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month_key TEXT NOT NULL, -- YYYY-MM format
  insight_id TEXT NOT NULL, -- Stable insight identifier
  persona TEXT NOT NULL CHECK (persona IN ('coach', 'companion')),
  variant_slot INTEGER NOT NULL CHECK (variant_slot >= 0 AND variant_slot <= 9),
  title TEXT NOT NULL CHECK (LENGTH(title) <= 42),
  subtitle TEXT NOT NULL CHECK (LENGTH(subtitle) <= 90), 
  soft_note TEXT CHECK (LENGTH(soft_note) <= 110),
  model_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Ensure one pinned copy per user/month/insight/persona combination
  UNIQUE(user_id, month_key, insight_id, persona)
);

-- Index for fast lookups by user/month/persona
CREATE INDEX IF NOT EXISTS idx_insight_pinned_copy_lookup 
ON insight_pinned_copy(user_id, month_key, persona);

-- Index for cleanup by month
CREATE INDEX IF NOT EXISTS idx_insight_pinned_copy_month 
ON insight_pinned_copy(month_key);

-- RLS policies
ALTER TABLE insight_pinned_copy ENABLE ROW LEVEL SECURITY;

-- Users can only access their own pinned copy
CREATE POLICY insight_pinned_copy_user_access ON insight_pinned_copy
  FOR ALL USING (auth.uid() = user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_insight_pinned_copy_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at
CREATE TRIGGER insight_pinned_copy_updated_at
  BEFORE UPDATE ON insight_pinned_copy
  FOR EACH ROW
  EXECUTE FUNCTION update_insight_pinned_copy_updated_at();

-- Optional: Function to clean up old pinned copy (older than 12 months)
CREATE OR REPLACE FUNCTION cleanup_old_insight_pinned_copy()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete pinned copy older than 12 months to ensure UI consistency
  -- 12 months allows users to scroll back through older months with stable copy
  DELETE FROM insight_pinned_copy 
  WHERE created_at < NOW() - INTERVAL '12 months';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Comment for documentation
COMMENT ON TABLE insight_pinned_copy IS 'Stores Gemini-generated insight copy that remains stable within each month to prevent UI "flip" and reduce token costs';
COMMENT ON COLUMN insight_pinned_copy.variant_slot IS 'Deterministic variant (0-9) for controlled variety across months while maintaining stability within month';
COMMENT ON COLUMN insight_pinned_copy.model_version IS 'Tracks which model/prompt version generated this copy for regeneration control';