-- Migration: Add index to optimize rate-limiting query performance
-- The rate-limiting query filters by user_id, is_from_user, and created_at
-- This composite index supports the exact query pattern used in ai-chat function

-- Index for rate-limiting check: recent messages by user
CREATE INDEX IF NOT EXISTS idx_chat_messages_rate_limit 
ON chat_messages (user_id, is_from_user, created_at DESC)
WHERE is_from_user = true;

-- Note: This is a partial index that only includes user messages (is_from_user = true)
-- which is exactly what the rate-limiting query needs, making it very efficient.
