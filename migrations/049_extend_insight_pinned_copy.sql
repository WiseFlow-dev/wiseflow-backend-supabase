-- Phase 1: Extend insight_pinned_copy for ONE BRAIN Strategy B content blocks
-- Adds 3 new nullable columns for summaryLine, whyItMatters, quickWin
-- Maintains full backward compatibility with existing pinned content

-- Add new Strategy B content columns to existing table
ALTER TABLE insight_pinned_copy 
ADD COLUMN IF NOT EXISTS summary_line TEXT CHECK (char_length(summary_line) <= 70),
ADD COLUMN IF NOT EXISTS why_it_matters TEXT CHECK (char_length(why_it_matters) <= 140),
ADD COLUMN IF NOT EXISTS quick_win TEXT CHECK (char_length(quick_win) <= 70);

-- Update the table comment to reflect new functionality
COMMENT ON TABLE insight_pinned_copy IS 'Stores Gemini-generated insight copy that remains stable within each month to prevent UI "flip" and reduce token costs. Extended with Strategy B content blocks (summaryLine, whyItMatters, quickWin) for ONE BRAIN system.';

-- Add comments for new columns
COMMENT ON COLUMN insight_pinned_copy.summary_line IS 'ONE BRAIN Strategy B: 1-line summary (~70 chars max)';
COMMENT ON COLUMN insight_pinned_copy.why_it_matters IS 'ONE BRAIN Strategy B: Why this matters explanation (1-2 lines, ~140 chars max)';
COMMENT ON COLUMN insight_pinned_copy.quick_win IS 'ONE BRAIN Strategy B: Quick actionable win (1 line, ~70 chars max)';

-- Note: Existing indexes and constraints remain unchanged
-- Note: All new columns are nullable to support gradual rollout
-- Note: char_length() used instead of length() for proper Unicode/emoji handling
-- Note: Existing title/subtitle/soft_note columns and data remain untouched