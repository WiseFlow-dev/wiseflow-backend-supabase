-- Phase 1 foundation for Wisey chat context V2.
-- Adds schema needed for context state, durable memory metadata, and safe observability rollout.

-- ---------------------------------------------------------------------------
-- chat_sessions: working context state + summary timing + optimistic concurrency
-- ---------------------------------------------------------------------------
ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS context_state JSONB;

ALTER TABLE chat_sessions
ALTER COLUMN context_state SET DEFAULT jsonb_build_object(
  'version', 1,
  'activeIntent', NULL,
  'slots', '{}'::jsonb,
  'openQuestion', NULL,
  'recentTopics', '[]'::jsonb,
  'turnCounter', 0,
  'summary', jsonb_build_object(
    'text', '',
    'updatedAt', NULL,
    'lastTurnNumber', 0
  )
);

UPDATE chat_sessions
SET context_state = jsonb_build_object(
  'version', 1,
  'activeIntent', NULL,
  'slots', '{}'::jsonb,
  'openQuestion', NULL,
  'recentTopics', '[]'::jsonb,
  'turnCounter', 0,
  'summary', jsonb_build_object(
    'text', '',
    'updatedAt', NULL,
    'lastTurnNumber', 0
  )
)
WHERE context_state IS NULL;

ALTER TABLE chat_sessions
ALTER COLUMN context_state SET NOT NULL;

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMPTZ;

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS context_state_rev BIGINT;

ALTER TABLE chat_sessions
ALTER COLUMN context_state_rev SET DEFAULT 0;

UPDATE chat_sessions
SET context_state_rev = 0
WHERE context_state_rev IS NULL;

ALTER TABLE chat_sessions
ALTER COLUMN context_state_rev SET NOT NULL;

ALTER TABLE chat_sessions
ADD COLUMN IF NOT EXISTS context_state_updated_at TIMESTAMPTZ;

UPDATE chat_sessions
SET summary_updated_at = COALESCE(summary_updated_at, updated_at)
WHERE summary IS NOT NULL;

UPDATE chat_sessions
SET context_state_updated_at = COALESCE(context_state_updated_at, updated_at)
WHERE context_state_updated_at IS NULL;

COMMENT ON COLUMN chat_sessions.context_state IS 'Wisey chat V2 working context state, persisted as the versioned V1 JSON shape.';
COMMENT ON COLUMN chat_sessions.summary_updated_at IS 'Timestamp of the last deterministic session summary refresh.';
COMMENT ON COLUMN chat_sessions.context_state_rev IS 'Optimistic concurrency revision for chat context state writes.';
COMMENT ON COLUMN chat_sessions.context_state_updated_at IS 'Timestamp of the last successful context_state write.';

-- ---------------------------------------------------------------------------
-- chat_memory_index: structured facts + dedupe key + retention metadata
-- ---------------------------------------------------------------------------
ALTER TABLE chat_memory_index
ADD COLUMN IF NOT EXISTS facts JSONB;

ALTER TABLE chat_memory_index
ALTER COLUMN facts SET DEFAULT '[]'::jsonb;

UPDATE chat_memory_index
SET facts = '[]'::jsonb
WHERE facts IS NULL;

ALTER TABLE chat_memory_index
ALTER COLUMN facts SET NOT NULL;

ALTER TABLE chat_memory_index
ADD COLUMN IF NOT EXISTS memory_key TEXT;

UPDATE chat_memory_index
SET memory_key = 'legacy:' || id::text
WHERE memory_key IS NULL OR btrim(memory_key) = '';

ALTER TABLE chat_memory_index
ALTER COLUMN memory_key SET DEFAULT ('legacy:' || gen_random_uuid()::text);

ALTER TABLE chat_memory_index
ALTER COLUMN memory_key SET NOT NULL;

ALTER TABLE chat_memory_index
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE chat_memory_index
ALTER COLUMN expires_at SET DEFAULT (now() + interval '90 days');

UPDATE chat_memory_index
SET expires_at = COALESCE(updated_at, created_at, now()) + interval '90 days'
WHERE expires_at IS NULL;

ALTER TABLE chat_memory_index
ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE chat_memory_index
ADD COLUMN IF NOT EXISTS source_context_version SMALLINT;

ALTER TABLE chat_memory_index
ALTER COLUMN source_context_version SET DEFAULT 1;

UPDATE chat_memory_index
SET source_context_version = 1
WHERE source_context_version IS NULL;

ALTER TABLE chat_memory_index
ALTER COLUMN source_context_version SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_memory_index_user_memory_key
ON chat_memory_index(user_id, memory_key);

CREATE INDEX IF NOT EXISTS idx_chat_memory_index_user_expires_at
ON chat_memory_index(user_id, expires_at);

COMMENT ON COLUMN chat_memory_index.facts IS 'Structured financial facts extracted for reuse across chat sessions.';
COMMENT ON COLUMN chat_memory_index.memory_key IS 'Deduplication key for durable memory entries. Phase 1 uses safe legacy defaults until semantic keys are written.';
COMMENT ON COLUMN chat_memory_index.expires_at IS 'Rolling retention cutoff for cross-session memory retrieval.';
COMMENT ON COLUMN chat_memory_index.source_context_version IS 'Context schema version that produced this memory row.';
