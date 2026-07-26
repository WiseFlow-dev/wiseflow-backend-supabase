import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const

const FRANKFURTER_API_BASE = 'https://api.frankfurter.dev/v2/rate'
const PROVIDER_NAME = 'frankfurter'
const BATCH_SIZE = 150
const MAX_JOBS_PER_RUN = 2
const MAX_RETRY_ROWS_PER_RUN = 50
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/

type FxResult =
  | { ok: true; rate: number; requestedDate: string; rateDate: string; provider: string }
  | { ok: false; error: string }

type RebaseJob = {
  id: number
  user_id: string
  from_currency: string
  to_currency: string
  status: string
  processed_rows: number
  total_rows: number
}

type TxnRow = {
  id: string
  user_id: string
  wallet_id: string | null
  amount: number | string
  date: string
}

function log(event: string, meta: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }))
}

function logError(event: string, meta: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, ...meta }))
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  })
}

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { persistSession: false } })
}

function parseRate(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function parseAmount(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

function normalizeDate(dateRaw: unknown): string | null {
  const parsed = new Date(String(dateRaw ?? '').trim())
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function normalizeCurrency(raw: unknown): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return CURRENCY_RE.test(code) ? code : null
}

async function resolveFxRate(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  base: string,
  quote: string,
  requestedDate: string,
): Promise<FxResult> {
  if (base === quote) {
    return {
      ok: true,
      rate: 1,
      requestedDate,
      rateDate: requestedDate,
      provider: 'identity',
    }
  }

  const { data: cached, error: cacheError } = await supabase
    .from('fx_rate_cache')
    .select('rate,rate_date,provider')
    .eq('base', base)
    .eq('quote', quote)
    .eq('requested_date', requestedDate)
    .maybeSingle<{ rate: number | string; rate_date: string; provider: string }>()

  if (cacheError) {
    return { ok: false, error: `fx_cache_read_error:${cacheError.message}` }
  }

  if (cached) {
    const rate = parseRate(cached.rate)
    if (rate !== null && DATE_RE.test(String(cached.rate_date ?? ''))) {
      return {
        ok: true,
        rate,
        requestedDate,
        rateDate: String(cached.rate_date),
        provider: String(cached.provider || PROVIDER_NAME),
      }
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 9000)
  const url = `${FRANKFURTER_API_BASE}/${encodeURIComponent(base)}/${encodeURIComponent(quote)}?date=${encodeURIComponent(requestedDate)}`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, error: `fx_provider_http_${res.status}` }
    }

    const payload = await res.json() as { date?: unknown; rate?: unknown }
    const rate = parseRate(payload.rate)
    const rateDate = String(payload.date ?? '')
    if (rate === null || !DATE_RE.test(rateDate)) {
      return { ok: false, error: 'fx_provider_payload_invalid' }
    }

    const { error: upsertError } = await supabase.from('fx_rate_cache').upsert(
      {
        base,
        quote,
        requested_date: requestedDate,
        rate_date: rateDate,
        rate,
        provider: PROVIDER_NAME,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'base,quote,requested_date' },
    )
    if (upsertError) {
      return { ok: false, error: `fx_cache_write_error:${upsertError.message}` }
    }

    return {
      ok: true,
      rate,
      requestedDate,
      rateDate,
      provider: PROVIDER_NAME,
    }
  } catch {
    return { ok: false, error: 'fx_provider_unreachable' }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function loadWalletCurrencyMap(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  walletIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (walletIds.length === 0) return result

  const { data, error } = await supabase
    .from('wallets')
    .select('id,currency_code')
    .eq('user_id', userId)
    .in('id', walletIds)

  if (error) {
    throw new Error(`wallet_currency_lookup_failed:${error.message}`)
  }

  for (const row of (data ?? []) as Array<{ id: string; currency_code: string | null }>) {
    result.set(row.id, normalizeCurrency(row.currency_code) ?? 'USD')
  }
  return result
}

async function enqueueRetry(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  tx: TxnRow,
  reason: string,
) {
  const now = new Date().toISOString()
  await supabase.from('fx_normalization_retry_queue').upsert(
    {
      transaction_id: tx.id,
      user_id: tx.user_id,
      reason,
      last_error: reason,
      updated_at: now,
    },
    { onConflict: 'transaction_id' },
  )
}

function backoffMinutes(nextAttemptCount: number): number {
  if (nextAttemptCount <= 1) return 1
  if (nextAttemptCount === 2) return 5
  if (nextAttemptCount === 3) return 15
  if (nextAttemptCount === 4) return 60
  if (nextAttemptCount === 5) return 360
  return 1440
}

async function resolveUserMainCurrency(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('currency')
    .eq('user_id', userId)
    .maybeSingle<{ currency: string | null }>()

  if (error) throw new Error(`user_currency_lookup_failed:${error.message}`)
  return normalizeCurrency(data?.currency) ?? 'USD'
}

async function processRetryQueue(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('fx_normalization_retry_queue')
    .select('transaction_id,user_id,attempt_count')
    .lte('next_attempt_at', nowIso)
    .order('next_attempt_at', { ascending: true })
    .limit(MAX_RETRY_ROWS_PER_RUN)

  if (error) throw new Error(`retry_queue_read_failed:${error.message}`)

  let succeeded = 0
  let failed = 0

  for (const row of (data ?? []) as Array<{ transaction_id: string; user_id: string; attempt_count: number }>) {
    const { data: tx, error: txError } = await supabase
      .from('wallet_transactions')
      .select('id,user_id,wallet_id,amount,date')
      .eq('id', row.transaction_id)
      .eq('user_id', row.user_id)
      .maybeSingle<TxnRow>()

    if (txError || !tx) {
      await supabase
        .from('fx_normalization_retry_queue')
        .delete()
        .eq('transaction_id', row.transaction_id)
      continue
    }

    try {
      const targetCurrency = await resolveUserMainCurrency(supabase, row.user_id)
      const walletCurrencyMap = await loadWalletCurrencyMap(
        supabase,
        row.user_id,
        tx.wallet_id ? [tx.wallet_id] : [],
      )
      const walletCurrency = tx.wallet_id ? (walletCurrencyMap.get(tx.wallet_id) ?? 'USD') : 'USD'
      const requestedDate = normalizeDate(tx.date)
      const amount = parseAmount(tx.amount)
      if (!requestedDate || amount === null) {
        throw new Error('invalid_transaction_row')
      }

      const fx = await resolveFxRate(supabase, walletCurrency, targetCurrency, requestedDate)
      if (!fx.ok) {
        throw new Error(fx.error)
      }

      const { error: updateError } = await supabase
        .from('wallet_transactions')
        .update({
          reporting_amount: Number((amount * fx.rate).toFixed(6)),
          reporting_currency: targetCurrency,
          fx_rate_used: fx.rate,
          fx_requested_date: fx.requestedDate,
          fx_rate_date: fx.rateDate,
          fx_provider: fx.provider,
          reporting_version: 1,
          normalized_at: new Date().toISOString(),
        })
        .eq('id', tx.id)
        .eq('user_id', tx.user_id)

      if (updateError) throw new Error(`tx_update_failed:${updateError.message}`)

      await supabase
        .from('fx_normalization_retry_queue')
        .delete()
        .eq('transaction_id', tx.id)
      succeeded += 1
    } catch (e) {
      const nextCount = (row.attempt_count ?? 0) + 1
      const retryMinutes = backoffMinutes(nextCount)
      const nextAttempt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString()

      await supabase
        .from('fx_normalization_retry_queue')
        .update({
          attempt_count: nextCount,
          last_error: String(e),
          next_attempt_at: nextAttempt,
          updated_at: new Date().toISOString(),
        })
        .eq('transaction_id', row.transaction_id)

      failed += 1
    }
  }

  return { processed: (data ?? []).length, succeeded, failed }
}

async function processSingleRebaseJob(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  job: RebaseJob,
): Promise<{ processedRows: number; completed: boolean }> {
  const newerJobCheck = await supabase
    .from('currency_rebase_jobs')
    .select('id')
    .eq('user_id', job.user_id)
    .in('status', ['queued', 'running'])
    .gt('id', job.id)
    .limit(1)

  if ((newerJobCheck.data ?? []).length > 0) {
    await supabase
      .from('currency_rebase_jobs')
      .update({ status: 'superseded', updated_at: new Date().toISOString() })
      .eq('id', job.id)
    return { processedRows: 0, completed: true }
  }

  const targetCurrency = normalizeCurrency(job.to_currency) ?? 'USD'
  const fromOffset = Math.max(0, Number(job.processed_rows ?? 0))
  const toOffset = fromOffset + BATCH_SIZE - 1

  const { data: txRows, error: txError } = await supabase
    .from('wallet_transactions')
    .select('id,user_id,wallet_id,amount,date,created_at')
    .eq('user_id', job.user_id)
    .order('created_at', { ascending: true })
    .range(fromOffset, toOffset)

  if (txError) {
    throw new Error(`rebase_tx_read_failed:${txError.message}`)
  }

  const rows = (txRows ?? []) as TxnRow[]
  if (rows.length === 0) {
    return { processedRows: 0, completed: true }
  }

  const walletIds = [...new Set(rows.map((r) => String(r.wallet_id ?? '')).filter((v) => v.length > 0))]
  const walletCurrencyMap = await loadWalletCurrencyMap(supabase, job.user_id, walletIds)

  for (const tx of rows) {
    const amount = parseAmount(tx.amount)
    const requestedDate = normalizeDate(tx.date)
    if (amount === null || !requestedDate) {
      await enqueueRetry(supabase, tx, 'invalid_transaction_data')
      continue
    }

    const walletCurrency = tx.wallet_id
      ? (walletCurrencyMap.get(tx.wallet_id) ?? 'USD')
      : 'USD'
    const fx = await resolveFxRate(supabase, walletCurrency, targetCurrency, requestedDate)
    if (!fx.ok) {
      await enqueueRetry(supabase, tx, `rebase_fx_failed:${fx.error}`)
      continue
    }

    const { error: updateError } = await supabase
      .from('wallet_transactions')
      .update({
        reporting_amount: Number((amount * fx.rate).toFixed(6)),
        reporting_currency: targetCurrency,
        fx_rate_used: fx.rate,
        fx_requested_date: fx.requestedDate,
        fx_rate_date: fx.rateDate,
        fx_provider: fx.provider,
        reporting_version: 1,
        normalized_at: new Date().toISOString(),
      })
      .eq('id', tx.id)
      .eq('user_id', tx.user_id)

    if (updateError) {
      await enqueueRetry(supabase, tx, `rebase_tx_update_failed:${updateError.message}`)
    }
  }

  return { processedRows: rows.length, completed: rows.length < BATCH_SIZE }
}

async function processRebaseJobs(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
): Promise<{ processed: number; completed: number; failed: number }> {
  const { data, error } = await supabase
    .from('currency_rebase_jobs')
    .select('id,user_id,from_currency,to_currency,status,processed_rows,total_rows')
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: true })
    .limit(MAX_JOBS_PER_RUN)

  if (error) throw new Error(`rebase_job_read_failed:${error.message}`)

  let completed = 0
  let failed = 0

  for (const rawJob of (data ?? []) as RebaseJob[]) {
    try {
      const nowIso = new Date().toISOString()
      const { data: claimed, error: claimError } = await supabase
        .from('currency_rebase_jobs')
        .update({ status: 'running', updated_at: nowIso })
        .eq('id', rawJob.id)
        .in('status', ['queued', 'running'])
        .select('id,user_id,from_currency,to_currency,status,processed_rows,total_rows')
        .maybeSingle<RebaseJob>()

      if (claimError) throw new Error(`rebase_job_claim_failed:${claimError.message}`)
      if (!claimed) continue

      const result = await processSingleRebaseJob(supabase, claimed)
      const nextProcessed = Math.max(0, Number(claimed.processed_rows ?? 0) + result.processedRows)
      const totalRows = Math.max(Number(claimed.total_rows ?? 0), nextProcessed)
      const status = result.completed || nextProcessed >= totalRows ? 'completed' : 'running'

      const { error: jobUpdateError } = await supabase
        .from('currency_rebase_jobs')
        .update({
          status,
          processed_rows: nextProcessed,
          total_rows: totalRows,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', claimed.id)

      if (jobUpdateError) throw new Error(`rebase_job_update_failed:${jobUpdateError.message}`)
      if (status === 'completed') completed += 1
    } catch (e) {
      failed += 1
      const message = String(e)
      await supabase
        .from('currency_rebase_jobs')
        .update({
          status: 'failed',
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', rawJob.id)
      logError('currency_rebase_worker.job_failed', { jobId: rawJob.id, error: message })
    }
  }

  return { processed: (data ?? []).length, completed, failed }
}

function assertAuthorized(req: Request) {
  // Same fallback order as policy-eval-cron: the scheduler posts the vault
  // 'wisey_cron_secret', which is provisioned as WISEY_CRON_SECRET.
  const expectedCronKey = Deno.env.get('WISEY_CRON_SECRET') ?? Deno.env.get('CRON_SECRET')
  if (!expectedCronKey) {
    throw new Error('missing_cron_secret')
  }
  const actualCronKey = req.headers.get('x-cron-key') ?? ''
  if (actualCronKey !== expectedCronKey) {
    throw new Error('unauthorized_cron_key')
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Use POST' }, 405)
  }

  try {
    assertAuthorized(req)
    const supabase = getServiceSupabaseClient()

    const [jobResult, retryResult] = await Promise.all([
      processRebaseJobs(supabase),
      processRetryQueue(supabase),
    ])

    log('currency_rebase_worker.completed', { jobResult, retryResult })
    return json({
      ok: true,
      job_result: jobResult,
      retry_result: retryResult,
    })
  } catch (e) {
    const message = String(e)
    if (message.includes('missing_cron_secret')) {
      return json({ ok: false, error: 'CRON_SECRET is not configured' }, 500)
    }
    if (message.includes('unauthorized_cron_key')) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }
    logError('currency_rebase_worker.error', { error: message })
    return json({ ok: false, error: message }, 500)
  }
})
