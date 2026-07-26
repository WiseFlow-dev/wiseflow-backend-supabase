import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type VacationPayload = {
  vacationName?: string
  costCents?: number
  targetMonth?: string
  languageCode?: string
  localeTag?: string
  mainCurrencyCode?: string
  numberFormatMode?: string
}

type SavingsPayload = {
  targetSavingsCents?: number
  targetMonth?: string
  languageCode?: string
  localeTag?: string
  mainCurrencyCode?: string
  numberFormatMode?: string
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function toVacationPayload(body: any): VacationPayload | null {
  if (!body || typeof body !== 'object') return null

  const action = typeof body.action === 'string' ? body.action.trim() : ''
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : body
  const isVacationAction =
    action === 'vacation_plan' ||
    (typeof body.intentType === 'string' && body.intentType.toLowerCase() === 'vacation_plan')

  // IMPORTANT:
  // `targetMonth` is shared by both vacation and savings. Do NOT treat it as a vacation hint
  // unless the action explicitly says vacation or we have a vacation-specific field.
  if (!isVacationAction && !('vacationName' in payload || 'costCents' in payload)) {
    return null
  }

  const vacationName = typeof payload.vacationName === 'string' ? payload.vacationName : undefined
  const targetMonth = typeof payload.targetMonth === 'string' ? payload.targetMonth : undefined
  const rawCost = asNumber(payload.costCents)
  const costCents = rawCost > 0 ? Math.round(rawCost) : undefined
  const languageCode = typeof payload.languageCode === 'string' ? payload.languageCode : undefined
  const localeTag = typeof payload.localeTag === 'string' ? payload.localeTag : undefined
  const mainCurrencyCode = typeof payload.mainCurrencyCode === 'string' ? payload.mainCurrencyCode : undefined
  const numberFormatMode = typeof payload.numberFormatMode === 'string' ? payload.numberFormatMode : undefined

  return { vacationName, costCents, targetMonth, languageCode, localeTag, mainCurrencyCode, numberFormatMode }
}

function toSavingsPayload(body: any): SavingsPayload | null {
  if (!body || typeof body !== 'object') return null

  const action = typeof body.action === 'string' ? body.action.trim() : ''
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : body
  const isSavingsAction =
    action === 'savings_plan' ||
    (typeof body.intentType === 'string' && body.intentType.toLowerCase() === 'savings_plan')

  if (!isSavingsAction && !('targetSavingsCents' in payload || 'targetMonth' in payload)) {
    return null
  }

  const rawTarget = asNumber(payload.targetSavingsCents)
  const targetSavingsCents = rawTarget > 0 ? Math.round(rawTarget) : undefined
  const targetMonth = typeof payload.targetMonth === 'string' ? payload.targetMonth : undefined
  const languageCode = typeof payload.languageCode === 'string' ? payload.languageCode : undefined
  const localeTag = typeof payload.localeTag === 'string' ? payload.localeTag : undefined
  const mainCurrencyCode = typeof payload.mainCurrencyCode === 'string' ? payload.mainCurrencyCode : undefined
  const numberFormatMode = typeof payload.numberFormatMode === 'string' ? payload.numberFormatMode : undefined
  return { targetSavingsCents, targetMonth, languageCode, localeTag, mainCurrencyCode, numberFormatMode }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ type: 'error', error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json().catch(() => ({}))
    const action = typeof body?.action === 'string' ? body.action.trim() : ''
    const vacationPayload = toVacationPayload(body)
    const savingsPayload = toSavingsPayload(body)

    if (!vacationPayload && !savingsPayload) {
      return new Response(JSON.stringify({
        type: 'error',
        error: 'Unsupported planner action. Expected action="vacation_plan" or action="savings_plan".',
      }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !serviceRole) {
      return new Response(JSON.stringify({
        type: 'error',
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
      }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } })
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
    if (authError || !user) {
      return new Response(JSON.stringify({ type: 'error', error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    // Prefer the explicit action when provided. This avoids false positives when both payloads
    // share fields (e.g., `targetMonth`).
    const plannerFunctionSlug =
      action === 'vacation_plan'
        ? 'ai-planner-vacation'
        : action === 'savings_plan'
          ? 'ai-planner-savings'
          : (vacationPayload ? 'ai-planner-vacation' : 'ai-planner-savings')
    const plannerUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${plannerFunctionSlug}`
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

    const plannerRes = await fetch(plannerUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'apikey': anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(vacationPayload || savingsPayload),
    })

    const plannerJson = await plannerRes.json().catch(() => ({
      type: 'error',
      error: `Invalid response from ${plannerFunctionSlug}`,
    }))

    return new Response(JSON.stringify(plannerJson), {
      status: plannerRes.ok ? 200 : plannerRes.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({
      type: 'error',
      error: String((error as any)?.message || 'Internal server error'),
    }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
