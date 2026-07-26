ALTER TABLE public.chat_memory_index
ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE public.chat_memory_index
DROP CONSTRAINT IF EXISTS chat_memory_index_session_id_fkey;

ALTER TABLE public.chat_memory_index
ADD CONSTRAINT chat_memory_index_session_id_fkey
FOREIGN KEY (session_id)
REFERENCES public.chat_sessions(id)
ON DELETE SET NULL;

COMMENT ON COLUMN public.chat_memory_index.session_id IS
'Origin session for the memory row. Nullable so durable cross-session memory survives session deletion.';
