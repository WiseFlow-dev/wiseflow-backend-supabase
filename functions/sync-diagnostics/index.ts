import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

type SyncEventLog = {
  user_id: string
  provider: 'plaid' | 'truelayer' | 'system'
  event_name: string
  latency_ms: number | null
  provider_ref: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
}

type ProviderSummary = {
  last_event_at: string | null
  last_sync_success_at: string | null
  last_sync_failed_at: string | null
  sync_success_count_24h: number
  sync_failed_count_24h: number
  median_sync_latency_ms_24h: number | null
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function toIso24hAgo(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

function summarizeProvider(events: SyncEventLog[], fromIso: string): ProviderSummary {
  const recent = events.filter((e) => e.created_at >= fromIso)
  const syncSuccess24h = recent.filter((e) => e.event_name === 'sync_success')
  const syncFailed24h = recent.filter((e) => e.event_name === 'sync_failed')
  const latencies = syncSuccess24h
    .map((e) => e.latency_ms)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)

  return {
    last_event_at: events[0]?.created_at ?? null,
    last_sync_success_at: events.find((e) => e.event_name === 'sync_success')?.created_at ?? null,
    last_sync_failed_at: events.find((e) => e.event_name === 'sync_failed')?.created_at ?? null,
    sync_success_count_24h: syncSuccess24h.length,
    sync_failed_count_24h: syncFailed24h.length,
    median_sync_latency_ms_24h: median(latencies),
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json(500, { ok: false, error: 'Server configuration error' })
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json(401, { ok: false, error: 'Missing Authorization header' })

  const token = authHeader.replace('Bearer ', '').trim()
  const url = new URL(req.url)
  const requestedUserId = url.searchParams.get('user_id')
  const rawLimit = Number(url.searchParams.get('limit') ?? 60)
  const parsedLimit = Number.isFinite(rawLimit) ? rawLimit : 60
  const limit = Math.min(Math.max(parsedLimit, 10), 300)
  const isServiceRoleCall = token === serviceRoleKey

  let targetUserId: string
  let mode: 'self' | 'support'
  let client: any

  if (isServiceRoleCall) {
    if (!requestedUserId) {
      return json(400, { ok: false, error: 'user_id is required for support mode' })
    }
    targetUserId = requestedUserId
    mode = 'support'
    client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  } else {
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userData, error: authError } = await userClient.auth.getUser()
    const user = userData?.user
    if (authError || !user) return json(401, { ok: false, error: 'Invalid or expired token' })

    if (requestedUserId && requestedUserId !== user.id) {
      return json(403, { ok: false, error: 'Forbidden: can only view your own diagnostics' })
    }

    targetUserId = user.id
    mode = 'self'
    client = userClient
  }

  const { data, error } = await client
    .from('sync_event_logs')
    .select('user_id,provider,event_name,latency_ms,provider_ref,error_code,error_message,created_at')
    .eq('user_id', targetUserId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return json(500, { ok: false, error: error.message })
  }

  const rows = (data ?? []) as SyncEventLog[]
  const fromIso = toIso24hAgo()
  const plaidRows = rows.filter((r) => r.provider === 'plaid')
  const trueLayerRows = rows.filter((r) => r.provider === 'truelayer')
  const syncEvents24h = rows.filter((r) => r.created_at >= fromIso && (r.event_name === 'sync_success' || r.event_name === 'sync_failed'))
  const syncSuccess24h = syncEvents24h.filter((r) => r.event_name === 'sync_success').length
  const syncFailed24h = syncEvents24h.filter((r) => r.event_name === 'sync_failed').length

  const lastSyncSuccessAt = rows.find((r) => r.event_name === 'sync_success')?.created_at ?? null
  const staleSyncHours = lastSyncSuccessAt
    ? Math.floor((Date.now() - new Date(lastSyncSuccessAt).getTime()) / (60 * 60 * 1000))
    : null

  return json(200, {
    ok: true,
    mode,
    user_id: targetUserId,
    generated_at: new Date().toISOString(),
    summary: {
      total_events_returned: rows.length,
      last_event_at: rows[0]?.created_at ?? null,
      last_sync_success_at: lastSyncSuccessAt,
      last_sync_failed_at: rows.find((r) => r.event_name === 'sync_failed')?.created_at ?? null,
      stale_sync_hours: staleSyncHours,
      sync_success_count_24h: syncSuccess24h,
      sync_failed_count_24h: syncFailed24h,
      sync_success_rate_24h: syncEvents24h.length > 0 ? Number((syncSuccess24h / syncEvents24h.length).toFixed(3)) : null,
    },
    providers: {
      plaid: summarizeProvider(plaidRows, fromIso),
      truelayer: summarizeProvider(trueLayerRows, fromIso),
    },
    timeline: rows,
  })
})
