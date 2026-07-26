-- Chat Sessions Management System for Wisey AI
-- This creates ChatGPT-like sidebar functionality with persistent memory

-- Chat Sessions Table (each conversation gets its own session)
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    title VARCHAR(100) NOT NULL,
    summary TEXT,
    personality_mode VARCHAR(20) DEFAULT 'friendly',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    message_count INTEGER DEFAULT 0,
    is_archived BOOLEAN DEFAULT FALSE
);

-- Chat Messages Table (updated to link to sessions)
DROP TABLE IF EXISTS chat_messages;
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    content TEXT NOT NULL,
    is_from_user BOOLEAN NOT NULL,
    personality_mode VARCHAR(20) DEFAULT 'friendly',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Global Memory Index (summaries of all chats for cross-chat context)
CREATE TABLE IF NOT EXISTS chat_memory_index (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    topic VARCHAR(100) NOT NULL,
    summary TEXT NOT NULL,
    keywords TEXT[], -- Array of searchable keywords
    relevance_score FLOAT DEFAULT 1.0, -- For ranking memories
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_created_at ON chat_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_memory_user_id ON chat_memory_index(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_memory_keywords ON chat_memory_index USING GIN(keywords);

-- RLS Policies
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_memory_index ENABLE ROW LEVEL SECURITY;

-- Users can manage their own chat sessions
CREATE POLICY "Users can manage their own chat sessions" ON chat_sessions 
    FOR ALL USING (auth.uid() = user_id);

-- Users can manage their own chat messages
CREATE POLICY "Users can manage their own chat messages" ON chat_messages 
    FOR ALL USING (auth.uid() = user_id);

-- Users can manage their own memory index
CREATE POLICY "Users can manage their own memory index" ON chat_memory_index 
    FOR ALL USING (auth.uid() = user_id);

-- Function to update chat session timestamp when messages are added
CREATE OR REPLACE FUNCTION update_chat_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_sessions 
    SET updated_at = NOW(), message_count = message_count + 1
    WHERE id = NEW.session_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update session timestamps
DROP TRIGGER IF EXISTS trigger_update_chat_session ON chat_messages;
CREATE TRIGGER trigger_update_chat_session
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_chat_session_timestamp();

-- Comments for documentation
COMMENT ON TABLE chat_sessions IS 'Individual chat sessions with auto-generated titles and summaries';
COMMENT ON TABLE chat_messages IS 'Messages within chat sessions, linked to sessions for proper organization';
COMMENT ON TABLE chat_memory_index IS 'Global memory summaries for cross-chat context and continuity';
