-- Add session archival support for 24-hour active session logic
-- This enables "Current Chat" vs "Recent Chats" functionality

-- Add is_archived column to chat_sessions
ALTER TABLE chat_sessions 
ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE;

-- Add index for efficient active session queries
CREATE INDEX IF NOT EXISTS idx_chat_sessions_active 
ON chat_sessions(user_id, is_archived, updated_at DESC);

-- Archive old sessions (> 24 hours since last update)
UPDATE chat_sessions 
SET is_archived = TRUE 
WHERE updated_at < NOW() - INTERVAL '24 hours'
AND is_archived = FALSE;

-- Add comment for documentation
COMMENT ON COLUMN chat_sessions.is_archived IS 'TRUE if session is archived (> 24 hours old), FALSE if active (current chat)';
