-- Add confidence column to chat_messages so Wisey can persist per-message confidence labels
ALTER TABLE chat_messages
ADD COLUMN IF NOT EXISTS confidence TEXT CHECK (confidence IN ('low', 'medium', 'high'));
