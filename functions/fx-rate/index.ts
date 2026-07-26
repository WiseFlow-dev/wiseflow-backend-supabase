import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const
const FRANKFURTER_API_BASE = 'https://api.frankfurter.dev/v2/rate'
const PROVIDER_NAME = 'frankfurter'
const CURRENCY_CODE_RE = /^[A-Z]{3}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type FxRateRequest = {
  base?: unknown
  quote?: unknown
  date?: unknown
}

type FxRateSuccess = {
  ok: true
  base: string
  quote: string
  requestedDate: string
  rateDate: string
  rate: number
  provider: string
  cached: boolean
}

type FxRateError = {
  ok: false
  error: {
    code:
      | 'bad_request'
      | 'unauthorized'
      | 'unsupported_currency'
      | 'provider_unavailable'
      | 'provider_response_invalid'
      | 'internal_error'
    message: string
    retryable: boolean
  }
}

type FxRateCacheRow = {
  base: string
  quote: string
  requested_date: string
  rate_date: string
  rate: number | string
  provider: string
}

type FrankfurterRateResponse = {
  date?: unknown
  base?: unknown
  quote?: unknown
  rate?: unknown
}

function log(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), event, ...meta }
  console.log(JSON.stringify(payload))
}

function logError(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), level: 'error', event, ...meta }
  console.error(JSON.stringify(payload))
}

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getUserFromAuthHeader(supabaseClient: ReturnType<typeof getServiceSupabaseClient>, req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Error('Missing Authorization header')
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabaseClient.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired token')
  return user
}

function json(body: FxRateSuccess | FxRateError, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  })
}

function errorResponse(
  code: FxRateError['error']['code'],
  message: string,
  status: number,
  retryable: boolean,
) {
  return json(
    {
      ok: false,
      error: {
        code,
        message,
        retryable,
      },
    },
    status,
  )
}

function parsePayload(raw: FxRateRequest) {
  const base = String(raw.base ?? '').trim().toUpperCase()
  const quote = String(raw.quote ?? '').trim().toUpperCase()
  const requestedDate = String(raw.date ?? '').trim()

  if (!CURRENCY_CODE_RE.test(base)) {
    throw new Error('Invalid base currency code. Expected ISO-4217 format (e.g. EUR).')
  }
  if (!CURRENCY_CODE_RE.test(quote)) {
    throw new Error('Invalid quote currency code. Expected ISO-4217 format (e.g. USD).')
  }
  if (!DATE_RE.test(requestedDate)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD.')
  }

  return { base, quote, requestedDate }
}

function parseRate(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

function parseFrankfurterPayload(payload: FrankfurterRateResponse) {
  const rateDate = String(payload.date ?? '')
  const rate = parseRate(payload.rate)
  if (!DATE_RE.test(rateDate) || rate === null) {
    return null
  }
  return { rateDate, rate }
}

async function loadCachedRate(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  base: string,
  quote: string,
  requestedDate: string,
) {
  const { data, error } = await supabase
    .from('fx_rate_cache')
    .select('base,quote,requested_date,rate_date,rate,provider')
    .eq('base', base)
    .eq('quote', quote)
    .eq('requested_date', requestedDate)
    .maybeSingle<FxRateCacheRow>()

  if (error) {
    throw new Error(`Failed to load FX cache: ${error.message}`)
  }

  if (!data) return null

  const parsedRate = parseRate(data.rate)
  if (parsedRate === null || !DATE_RE.test(data.rate_date)) {
    return null
  }

  return {
    base: data.base,
    quote: data.quote,
    requestedDate: data.requested_date,
    rateDate: data.rate_date,
    rate: parsedRate,
    provider: data.provider || PROVIDER_NAME,
  }
}

async function saveCachedRate(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  base: string,
  quote: string,
  requestedDate: string,
  rateDate: string,
  rate: number,
  provider: string,
) {
  const { error } = await supabase.from('fx_rate_cache').upsert(
    {
      base,
      quote,
      requested_date: requestedDate,
      rate_date: rateDate,
      rate,
      provider,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'base,quote,requested_date' },
  )

  if (error) {
    throw new Error(`Failed to save FX cache: ${error.message}`)
  }
}

async function fetchFrankfurterRate(base: string, quote: string, requestedDate: string) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 9000)
  const url = `${FRANKFURTER_API_BASE}/${encodeURIComponent(base)}/${encodeURIComponent(quote)}?date=${encodeURIComponent(requestedDate)}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })

    if (!response.ok) {
      if (response.status === 422) {
        return {
          ok: false as const,
          code: 'unsupported_currency' as const,
          message: 'Currency pair is unsupported by FX provider.',
          retryable: false,
          status: 422,
        }
      }
      if (response.status >= 500 || response.status === 429) {
        return {
          ok: false as const,
          code: 'provider_unavailable' as const,
          message: `FX provider temporarily unavailable (HTTP ${response.status}).`,
          retryable: true,
          status: 503,
        }
      }
      return {
        ok: false as const,
        code: 'provider_unavailable' as const,
        message: `Unexpected FX provider response (HTTP ${response.status}).`,
        retryable: false,
        status: 502,
      }
    }

    const payload = await response.json() as FrankfurterRateResponse
    const parsed = parseFrankfurterPayload(payload)
    if (!parsed) {
      return {
        ok: false as const,
        code: 'provider_response_invalid' as const,
        message: 'FX provider returned malformed rate payload.',
        retryable: true,
        status: 502,
      }
    }

    return {
      ok: true as const,
      rateDate: parsed.rateDate,
      rate: parsed.rate,
      provider: PROVIDER_NAME,
    }
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false as const,
      code: 'provider_unavailable' as const,
      message: timeout ? 'FX provider request timed out.' : 'FX provider network request failed.',
      retryable: true,
      status: 503,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  if (req.method !== 'POST') {
    return errorResponse('bad_request', 'Method not allowed. Use POST.', 405, false)
  }

  const supabase = getServiceSupabaseClient()

  try {
    const user = await getUserFromAuthHeader(supabase, req)
    const body = await req.json().catch(() => ({}))
    const { base, quote, requestedDate } = parsePayload(body as FxRateRequest)

    if (base === quote) {
      return json({
        ok: true,
        base,
        quote,
        requestedDate,
        rateDate: requestedDate,
        rate: 1,
        provider: 'identity',
        cached: true,
      })
    }

    const cachedRate = await loadCachedRate(supabase, base, quote, requestedDate)
    if (cachedRate) {
      log('fx_rate.cache_hit', {
        userId: user.id,
        base,
        quote,
        requestedDate,
      })
      return json({
        ok: true,
        base: cachedRate.base,
        quote: cachedRate.quote,
        requestedDate: cachedRate.requestedDate,
        rateDate: cachedRate.rateDate,
        rate: cachedRate.rate,
        provider: cachedRate.provider,
        cached: true,
      })
    }

    const providerResult = await fetchFrankfurterRate(base, quote, requestedDate)
    if (!providerResult.ok) {
      logError('fx_rate.provider_error', {
        userId: user.id,
        base,
        quote,
        requestedDate,
        code: providerResult.code,
      })
      return errorResponse(
        providerResult.code,
        providerResult.message,
        providerResult.status,
        providerResult.retryable,
      )
    }

    await saveCachedRate(
      supabase,
      base,
      quote,
      requestedDate,
      providerResult.rateDate,
      providerResult.rate,
      providerResult.provider,
    )

    log('fx_rate.cache_miss_saved', {
      userId: user.id,
      base,
      quote,
      requestedDate,
      rateDate: providerResult.rateDate,
    })

    return json({
      ok: true,
      base,
      quote,
      requestedDate,
      rateDate: providerResult.rateDate,
      rate: providerResult.rate,
      provider: providerResult.provider,
      cached: false,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('Missing Authorization') || message.includes('Invalid or expired token')) {
      return errorResponse('unauthorized', 'Unauthorized request.', 401, false)
    }
    if (message.startsWith('Invalid ')) {
      return errorResponse('bad_request', message, 400, false)
    }

    logError('fx_rate.unhandled_error', { error: message })
    return errorResponse('internal_error', 'Unexpected internal error.', 500, true)
  }
})
