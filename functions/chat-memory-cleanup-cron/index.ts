import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, X-Cron-Secret',
    },
  })
}

function safeErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) return error
  return fallback
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: json({}).headers })

  try {
    const secret = Deno.env.get('WISEY_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
    const incoming = req.headers.get('X-Cron-Secret') ?? req.headers.get('x-cron-secret') ?? ''
    if (!secret || !incoming || secret !== incoming) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }

    const supabase = getServiceSupabaseClient()
    const nowIso = new Date().toISOString()

    let totalDeleted = 0
    const deletedIds: string[] = []
    const deletedMemoryKeys: string[] = []

    while (true) {
      const { data: expiredRows, error: selectError } = await supabase
        .from('chat_memory_index')
        .select('id, user_id, memory_key, expires_at')
        .lte('expires_at', nowIso)
        .limit(500)

      if (selectError) {
        throw new Error(`Failed to list expired memories: ${selectError.message}`)
      }

      if (!expiredRows || expiredRows.length === 0) {
        break
      }

      const expiredIds = expiredRows
        .map((row: { id?: string | null }) => String(row.id || '').trim())
        .filter((id: string) => id.length > 0)

      const { error: deleteError } = await supabase
        .from('chat_memory_index')
        .delete()
        .in('id', expiredIds)

      if (deleteError) {
        throw new Error(`Failed to delete expired memories: ${deleteError.message}`)
      }

      totalDeleted += expiredIds.length
      deletedIds.push(...expiredIds)
      deletedMemoryKeys.push(
        ...expiredRows.map((row: { memory_key?: string | null }) => String(row.memory_key || '')).filter((key: string) => key.length > 0)
      )

      if (expiredRows.length < 500) {
        break
      }
    }

    if (totalDeleted === 0) {
      console.log(JSON.stringify({ event: 'chat_memory_cleanup.noop', ts: nowIso, deleted: 0 }))
      return json({ ok: true, deleted: 0, message: 'No expired memories found' })
    }

    console.log(JSON.stringify({
      event: 'chat_memory_cleanup.completed',
      ts: nowIso,
      deleted: totalDeleted,
      memoryKeys: deletedMemoryKeys,
    }))

    return json({
      ok: true,
      deleted: totalDeleted,
      deletedIds,
    })
  } catch (error) {
    console.error('chat-memory-cleanup-cron error:', error)
    return json({ ok: false, error: safeErrorMessage(error, 'Cleanup failed') }, 500)
  }
})
