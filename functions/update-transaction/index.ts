import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  AmountOutOfRangeError,
  calculateReportingAmount,
  parseTransactionAmount,
} from '../_shared/transactionAmount.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-main-currency, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const

const FRANKFURTER_API_BASE = 'https://api.frankfurter.dev/v2/rate'
const PROVIDER_NAME = 'frankfurter'
const CURRENCY_CODE_RE = /^[A-Z]{3}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type UpdateTransactionRequest = {
  transaction_id?: unknown
  wallet_id?: unknown
  amount?: unknown
  date?: unknown
  category?: unknown
  category_id?: unknown
  title?: unknown
  note?: unknown
  receipt_id?: unknown
  receipt_item_index?: unknown
  goal_id?: unknown
  debt_id?: unknown
  budget_id?: unknown
  is_budget_rollover?: unknown
  is_opening_balance?: unknown
  is_manual_topup?: unknown
  excluded_from_balance?: unknown
  import_session_id?: unknown
  import_source_type?: unknown
  import_fingerprint?: unknown
  source?: unknown
  provider?: unknown
  provider_txn_id?: unknown
  sync_status?: unknown
  is_suggested?: unknown
  is_internal_transfer?: unknown
  internal_transfer_group_id?: unknown
  user_dismissed_transfer_pair?: unknown
}

type ExistingTransactionRow = {
  id: string
  wallet_id: string
  amount: number
  category: string | null
  category_id: string | null
  title: string | null
  note: string | null
  date: string
  receipt_id: string | null
  receipt_item_index: number | null
  goal_id: string | null
  debt_id: string | null
  budget_id: string | null
  is_budget_rollover: boolean | null
  is_opening_balance: boolean | null
  is_manual_topup: boolean | null
  excluded_from_balance: boolean | null
  import_session_id: string | null
  import_source_type: string | null
  import_fingerprint: string | null
  source: string | null
  provider: string | null
  provider_txn_id: string | null
  sync_status: string | null
  is_suggested: boolean | null
  is_internal_transfer: boolean | null
  internal_transfer_group_id: string | null
  user_dismissed_transfer_pair: boolean | null
}

type CategoryRow = {
  id: string
  name: string
  user_id: string | null
  is_system: boolean | null
}

type ResolvedCategory = {
  category: string
  categoryId: string | null
}

type FxResolutionResult =
  | {
    ok: true
    rate: number
    requestedDate: string
    rateDate: string
    provider: string
  }
  | {
    ok: false
    code: 'unsupported_currency' | 'provider_unavailable' | 'provider_response_invalid'
    message: string
  }

type JsonRecord = Record<string, unknown>

function log(event: string, meta: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }))
}

function logError(event: string, meta: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event, ...meta }))
}

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
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

function json(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  })
}

function hasOwn(payload: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(payload, key)
}

function asOptionalTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseRequiredUuid(field: unknown, fieldName: string): string {
  const value = asOptionalTrimmedString(field)
  if (!value || !UUID_RE.test(value)) {
    throw new Error(`Invalid ${fieldName}. Expected UUID.`)
  }
  return value
}

function parseDate(value: unknown): { dateIso: string; requestedDate: string } {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('Missing date.')
  const parsed = new Date(raw)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('Invalid date. Expected ISO date/time or YYYY-MM-DD.')
  }
  const dateIso = parsed.toISOString()
  return {
    dateIso,
    requestedDate: dateIso.slice(0, 10),
  }
}

function parseNullableUuidFromPatch(payload: Record<string, unknown>, key: string, existingValue: string | null) {
  if (!hasOwn(payload, key)) return existingValue
  const raw = payload[key]
  if (raw === null) return null
  const asString = asOptionalTrimmedString(raw)
  if (!asString || !UUID_RE.test(asString)) throw new Error(`Invalid ${key}. Expected UUID or null.`)
  return asString
}

// Patch-semantics helper for internal_transfer_group_id:
// - Absent key  → preserve existing value (never clear via an old payload).
// - Explicit null → clear to null.
// - Non-empty string ≤128 chars → accepted as-is (no UUID validation,
//   because Android creates IDs shaped "itf_<16hex>").
export function parseNullableTransferGroupIdFromPatch(payload: Record<string, unknown>, key: string, existingValue: string | null) {
  if (!hasOwn(payload, key)) return existingValue
  const raw = payload[key]
  if (raw === null) return null
  if (typeof raw !== 'string') {
    throw new Error(`Invalid ${key}. Expected string or null.`)
  }
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`Invalid ${key}. Expected non-empty string or null.`)
  if (trimmed.length > 128) throw new Error(`Invalid ${key}. Value too long (max 128 chars).`)
  return trimmed
}

function parseNullableIntFromPatch(payload: Record<string, unknown>, key: string, existingValue: number | null) {
  if (!hasOwn(payload, key)) return existingValue
  const raw = payload[key]
  if (raw === null) return null
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw
  throw new Error(`Invalid ${key}. Expected integer or null.`)
}

function parseBooleanFromPatch(payload: Record<string, unknown>, key: string, existingValue: boolean) {
  if (!hasOwn(payload, key)) return existingValue
  const raw = payload[key]
  if (typeof raw === 'boolean') return raw
  throw new Error(`Invalid ${key}. Expected boolean.`)
}

function parseSource(value: unknown): 'manual' | 'bank' | null {
  const raw = asOptionalTrimmedString(value)?.toLowerCase()
  if (!raw) return null
  if (raw === 'manual' || raw === 'bank') return raw
  throw new Error('Invalid source. Expected "manual" or "bank".')
}

function parseProvider(value: unknown): 'plaid' | 'truelayer' | 'gocardless' | 'finverse' | null {
  const raw = asOptionalTrimmedString(value)?.toLowerCase()
  if (!raw) return null
  if (raw === 'plaid' || raw === 'truelayer' || raw === 'gocardless' || raw === 'finverse') return raw
  throw new Error('Invalid provider. Expected "plaid", "truelayer", "gocardless", or "finverse".')
}

function parseSyncStatus(value: unknown): 'pending' | 'posted' | null {
  const raw = asOptionalTrimmedString(value)?.toLowerCase()
  if (!raw) return null
  if (raw === 'pending' || raw === 'posted') return raw
  throw new Error('Invalid sync_status. Expected "pending" or "posted".')
}

function normalizeCategoryName(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase()
}

async function loadAllowedCategories(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<CategoryRow[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id,name,user_id,is_system')
    .or(`user_id.eq.${userId},is_system.eq.true`)

  if (error) {
    throw new Error(`Failed loading categories: ${error.message}`)
  }

  return ((data || []) as CategoryRow[]).filter((row) => typeof row.name === 'string' && row.name.trim().length > 0)
}

async function resolveCategoryForWrite(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  categoryInput: string | null,
  categoryIdInput: string | null,
): Promise<ResolvedCategory> {
  const allowedCategories = await loadAllowedCategories(supabase, userId)

  if (categoryIdInput) {
    const byId = allowedCategories.find((row) => row.id === categoryIdInput)
    if (!byId) {
      throw new Error('Invalid category_id. Category is not available for this user.')
    }
    return { category: byId.name, categoryId: byId.id }
  }

  const normalizedInput = normalizeCategoryName(categoryInput)
  if (normalizedInput) {
    const byName = allowedCategories.find((row) => normalizeCategoryName(row.name) === normalizedInput)
    if (byName) {
      return { category: byName.name, categoryId: byName.id }
    }
  }

  const fallback =
    allowedCategories.find((row) => normalizeCategoryName(row.name) === 'uncategorized')
    ?? allowedCategories.find((row) => normalizeCategoryName(row.name) === 'other')

  if (fallback) {
    return { category: fallback.name, categoryId: fallback.id }
  }

  return { category: 'Uncategorized', categoryId: null }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function normalizeCurrency(code: unknown): string | null {
  const candidate = String(code ?? '').trim().toUpperCase()
  return CURRENCY_CODE_RE.test(candidate) ? candidate : null
}

async function resolveMainCurrency(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  req: Request,
) {
  const fromHeader = normalizeCurrency(req.headers.get('x-main-currency'))
  if (fromHeader) return { currency: fromHeader, source: 'header' as const }

  const { data, error } = await supabase
    .from('user_preferences')
    .select('currency')
    .eq('user_id', userId)
    .maybeSingle<{ currency: string | null }>()

  if (error) throw new Error(`Failed to resolve main currency: ${error.message}`)
  const fromDb = normalizeCurrency(data?.currency)
  if (fromDb) return { currency: fromDb, source: 'db' as const }
  return { currency: 'USD', source: 'default' as const }
}

async function resolveWalletCurrency(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  walletId: string,
) {
  const { data, error } = await supabase
    .from('wallets')
    .select('id,user_id,currency_code')
    .eq('id', walletId)
    .maybeSingle<{ id: string; user_id: string; currency_code: string | null }>()
  if (error) throw new Error(`Failed to load wallet currency: ${error.message}`)
  if (!data || data.user_id !== userId) throw new Error('Wallet not found for user.')
  return normalizeCurrency(data.currency_code) ?? 'USD'
}

function parseRate(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

async function resolveFxRate(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  base: string,
  quote: string,
  requestedDate: string,
): Promise<FxResolutionResult> {
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
  if (cacheError) throw new Error(`Failed reading fx_rate_cache: ${cacheError.message}`)
  if (cached) {
    const rate = parseRate(cached.rate)
    if (rate !== null && DATE_RE.test(cached.rate_date)) {
      return {
        ok: true,
        rate,
        requestedDate,
        rateDate: cached.rate_date,
        provider: cached.provider || PROVIDER_NAME,
      }
    }
  }

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
        return { ok: false, code: 'unsupported_currency', message: 'FX provider does not support this pair.' }
      }
      return { ok: false, code: 'provider_unavailable', message: `FX provider unavailable (HTTP ${response.status}).` }
    }

    const payload = await response.json() as { date?: unknown; rate?: unknown }
    const rate = parseRate(payload.rate)
    const rateDate = String(payload.date ?? '')
    if (rate === null || !DATE_RE.test(rateDate)) {
      return { ok: false, code: 'provider_response_invalid', message: 'FX provider payload was invalid.' }
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
    if (upsertError) throw new Error(`Failed writing fx_rate_cache: ${upsertError.message}`)

    return {
      ok: true,
      rate,
      requestedDate,
      rateDate,
      provider: PROVIDER_NAME,
    }
  } catch (_error) {
    return { ok: false, code: 'provider_unavailable', message: 'FX provider request failed.' }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function enqueueFxRetry(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  transactionId: string,
  userId: string,
  reason: string,
) {
  const now = new Date().toISOString()
  const { error } = await supabase.from('fx_normalization_retry_queue').upsert(
    {
      transaction_id: transactionId,
      user_id: userId,
      reason,
      last_error: reason,
      next_attempt_at: now,
      updated_at: now,
    },
    { onConflict: 'transaction_id' },
  )
  if (error) {
    logError('update_transaction.fx_retry_enqueue_failed', {
      transactionId,
      userId,
      error: error.message,
    })
  }
}

async function getIdempotencyRecord(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  operation: 'create' | 'update',
  idempotencyKey: string,
) {
  const { data, error } = await supabase
    .from('transaction_write_idempotency')
    .select('request_hash,response_body')
    .eq('user_id', userId)
    .eq('operation', operation)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle<{ request_hash: string; response_body: JsonRecord }>()
  if (error) throw new Error(`Failed reading idempotency record: ${error.message}`)
  return data
}

async function storeIdempotencyRecord(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  operation: 'create' | 'update',
  idempotencyKey: string,
  requestHash: string,
  responseBody: JsonRecord,
) {
  const { error } = await supabase.from('transaction_write_idempotency').upsert(
    {
      user_id: userId,
      operation,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      response_body: responseBody,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString(),
    },
    { onConflict: 'user_id,operation,idempotency_key' },
  )
  if (error) throw new Error(`Failed writing idempotency record: ${error.message}`)
}

if (import.meta.main) {
  serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, 405)
  }

  const supabase = getServiceSupabaseClient()
  let transactionId: string | null = null

  try {
    const user = await getUserFromAuthHeader(supabase, req)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const patch = body as UpdateTransactionRequest & Record<string, unknown>

    transactionId = parseRequiredUuid(patch.transaction_id, 'transaction_id')
    const { data: existing, error: existingError } = await supabase
      .from('wallet_transactions')
      .select('id,wallet_id,amount,category,category_id,title,note,date,receipt_id,receipt_item_index,goal_id,debt_id,budget_id,is_budget_rollover,is_opening_balance,is_manual_topup,excluded_from_balance,import_session_id,import_source_type,import_fingerprint,source,provider,provider_txn_id,sync_status,is_suggested,is_internal_transfer,internal_transfer_group_id,user_dismissed_transfer_pair')
      .eq('id', transactionId)
      .eq('user_id', user.id)
      .maybeSingle<ExistingTransactionRow>()

    if (existingError) throw new Error(`Failed loading existing transaction: ${existingError.message}`)
    if (!existing) {
      return json({ ok: false, error: { code: 'not_found', message: 'Transaction not found.' } }, 404)
    }

    const walletId = hasOwn(patch, 'wallet_id')
      ? parseRequiredUuid(patch.wallet_id, 'wallet_id')
      : existing.wallet_id
    const amount = hasOwn(patch, 'amount')
      ? parseTransactionAmount(patch.amount)
      : Number(existing.amount)

    const dateResult = hasOwn(patch, 'date')
      ? parseDate(patch.date)
      : parseDate(existing.date)

    const categoryPatched = hasOwn(patch, 'category')
    const categoryIdPatched = hasOwn(patch, 'category_id')
    const requestedCategory = categoryPatched
      ? asOptionalTrimmedString(patch.category)
      : existing.category
    const requestedCategoryId = categoryIdPatched
      ? parseNullableUuidFromPatch(patch, 'category_id', existing.category_id)
      : (categoryPatched ? null : existing.category_id)
    const isBudgetRollover = parseBooleanFromPatch(patch, 'is_budget_rollover', existing.is_budget_rollover ?? false)
    const isOpeningBalance = parseBooleanFromPatch(patch, 'is_opening_balance', existing.is_opening_balance ?? false)
    const isManualTopup = parseBooleanFromPatch(patch, 'is_manual_topup', existing.is_manual_topup ?? false)
    const normalizedRequestedCategory = normalizeCategoryName(requestedCategory)
    const resolvedCategory = isOpeningBalance || normalizedRequestedCategory === 'opening balance'
      ? { category: 'Opening Balance', categoryId: null }
      : isManualTopup ||
          normalizedRequestedCategory === 'manual topup' ||
          normalizedRequestedCategory === 'manual top up'
        ? { category: 'Manual Topup', categoryId: null }
        : (categoryPatched || categoryIdPatched)
          ? await resolveCategoryForWrite(supabase, user.id, requestedCategory, requestedCategoryId)
          : { category: existing.category ?? 'Uncategorized', categoryId: existing.category_id }
    const category = resolvedCategory.category
    const categoryId = resolvedCategory.categoryId
    const title = hasOwn(patch, 'title')
      ? asOptionalTrimmedString(patch.title)
      : existing.title
    const note = hasOwn(patch, 'note')
      ? asOptionalTrimmedString(patch.note)
      : existing.note
    const receiptId = parseNullableUuidFromPatch(patch, 'receipt_id', existing.receipt_id)
    const receiptItemIndex = parseNullableIntFromPatch(patch, 'receipt_item_index', existing.receipt_item_index)
    const goalId = parseNullableUuidFromPatch(patch, 'goal_id', existing.goal_id)
    const debtId = parseNullableUuidFromPatch(patch, 'debt_id', existing.debt_id)
    const budgetId = parseNullableUuidFromPatch(patch, 'budget_id', existing.budget_id)
    const excludedFromBalance = parseBooleanFromPatch(patch, 'excluded_from_balance', existing.excluded_from_balance ?? false)
    const importSessionId = hasOwn(patch, 'import_session_id')
      ? asOptionalTrimmedString(patch.import_session_id)
      : existing.import_session_id
    const importSourceType = hasOwn(patch, 'import_source_type')
      ? asOptionalTrimmedString(patch.import_source_type)
      : existing.import_source_type
    const importFingerprint = hasOwn(patch, 'import_fingerprint')
      ? asOptionalTrimmedString(patch.import_fingerprint)
      : existing.import_fingerprint
    const providerTxnId = hasOwn(patch, 'provider_txn_id')
      ? asOptionalTrimmedString(patch.provider_txn_id)
      : existing.provider_txn_id
    const source = (hasOwn(patch, 'source')
      ? parseSource(patch.source)
      : parseSource(existing.source)) ?? (providerTxnId ? 'bank' : 'manual')
    const provider = hasOwn(patch, 'provider')
      ? parseProvider(patch.provider)
      : parseProvider(existing.provider)
    const syncStatus = source === 'bank'
      ? ((hasOwn(patch, 'sync_status')
        ? parseSyncStatus(patch.sync_status)
        : parseSyncStatus(existing.sync_status)) ?? 'posted')
      : null
    const isSuggested = parseBooleanFromPatch(patch, 'is_suggested', existing.is_suggested ?? false)
    const isInternalTransfer = parseBooleanFromPatch(patch, 'is_internal_transfer', existing.is_internal_transfer ?? false)
    const internalTransferGroupId = parseNullableTransferGroupIdFromPatch(patch, 'internal_transfer_group_id', existing.internal_transfer_group_id)
    const userDismissedTransferPair = parseBooleanFromPatch(patch, 'user_dismissed_transfer_pair', existing.user_dismissed_transfer_pair ?? false)

    const requestForHash = {
      operation: 'update',
      transaction_id: transactionId,
      wallet_id: walletId,
      amount,
      date: dateResult.dateIso,
      category,
      category_id: categoryId,
      title,
      note,
      receipt_id: receiptId,
      receipt_item_index: receiptItemIndex,
      goal_id: goalId,
      debt_id: debtId,
      budget_id: budgetId,
      is_budget_rollover: isBudgetRollover,
      is_opening_balance: isOpeningBalance,
      is_manual_topup: isManualTopup,
      excluded_from_balance: excludedFromBalance,
      import_session_id: importSessionId,
      import_source_type: importSourceType,
      import_fingerprint: importFingerprint,
      source,
      provider,
      provider_txn_id: providerTxnId,
      sync_status: syncStatus,
      is_suggested: isSuggested,
      is_internal_transfer: isInternalTransfer,
      internal_transfer_group_id: internalTransferGroupId,
      user_dismissed_transfer_pair: userDismissedTransferPair,
    }

    const idempotencyKey = asOptionalTrimmedString(req.headers.get('x-idempotency-key'))
      ?? `${transactionId}:update`
    const requestHash = await sha256Hex(JSON.stringify(requestForHash))

    const existingIdempotency = await getIdempotencyRecord(supabase, user.id, 'update', idempotencyKey)
    if (existingIdempotency) {
      if (existingIdempotency.request_hash !== requestHash) {
        return json({
          ok: false,
          error: {
            code: 'idempotency_conflict',
            message: 'Same idempotency key used with different payload.',
          },
        }, 409)
      }
      return json(existingIdempotency.response_body, 200)
    }

    const mainCurrency = await resolveMainCurrency(supabase, user.id, req)
    const walletCurrency = await resolveWalletCurrency(supabase, user.id, walletId)
    const fxResult = await resolveFxRate(supabase, walletCurrency, mainCurrency.currency, dateResult.requestedDate)

    const nowIso = new Date().toISOString()
    let normalizationStatus: 'normalized' | 'pending_fx' = 'normalized'
    let fxError: string | null = null

    const updateRow: Record<string, unknown> = {
      wallet_id: walletId,
      amount,
      category,
      category_id: categoryId,
      title,
      note,
      receipt_id: receiptId,
      receipt_item_index: receiptItemIndex,
      goal_id: goalId,
      debt_id: debtId,
      budget_id: budgetId,
      is_budget_rollover: isBudgetRollover,
      is_opening_balance: isOpeningBalance,
      is_manual_topup: isManualTopup,
      excluded_from_balance: excludedFromBalance,
      import_session_id: importSessionId,
      import_source_type: importSourceType,
      import_fingerprint: importFingerprint,
      source,
      provider,
      provider_txn_id: providerTxnId,
      sync_status: syncStatus,
      is_suggested: isSuggested,
      is_internal_transfer: isInternalTransfer,
      internal_transfer_group_id: internalTransferGroupId,
      user_dismissed_transfer_pair: userDismissedTransferPair,
      date: dateResult.dateIso,
      reporting_version: 1,
    }

    if (fxResult.ok) {
      updateRow.reporting_amount = calculateReportingAmount(amount, fxResult.rate)
      updateRow.reporting_currency = mainCurrency.currency
      updateRow.fx_rate_used = fxResult.rate
      updateRow.fx_requested_date = fxResult.requestedDate
      updateRow.fx_rate_date = fxResult.rateDate
      updateRow.fx_provider = fxResult.provider
      updateRow.normalized_at = nowIso
    } else {
      normalizationStatus = 'pending_fx'
      fxError = fxResult.message
      updateRow.reporting_amount = null
      updateRow.reporting_currency = null
      updateRow.fx_rate_used = null
      updateRow.fx_requested_date = null
      updateRow.fx_rate_date = null
      updateRow.fx_provider = null
      updateRow.normalized_at = null
    }

    const { error: updateError } = await supabase
      .from('wallet_transactions')
      .update(updateRow)
      .eq('id', transactionId)
      .eq('user_id', user.id)
    if (updateError) throw new Error(`Failed updating transaction: ${updateError.message}`)

    if (normalizationStatus === 'pending_fx') {
      await enqueueFxRetry(
        supabase,
        transactionId,
        user.id,
        fxError ?? 'FX normalization unavailable at update-time.',
      )
    }

    const responseBody: JsonRecord = {
      ok: true,
      operation: 'update',
      transaction_id: transactionId,
      idempotency_key: idempotencyKey,
      normalization_status: normalizationStatus,
      reporting_version: 1,
      main_currency: mainCurrency.currency,
      main_currency_source: mainCurrency.source,
      wallet_currency: walletCurrency,
      reporting_currency: normalizationStatus === 'normalized' ? mainCurrency.currency : null,
      fx_error: fxError,
    }

    await storeIdempotencyRecord(supabase, user.id, 'update', idempotencyKey, requestHash, responseBody)

    log('update_transaction.success', {
      userId: user.id,
      transactionId,
      normalizationStatus,
      mainCurrency: mainCurrency.currency,
      walletCurrency,
    })

    return json(responseBody)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof AmountOutOfRangeError) {
      logError('update_transaction.amount_rejected', {
        transactionId,
        failureCategory: error.failureCategory,
      })
      return json({
        ok: false,
        error: {
          code: 'amount_out_of_range',
          message: 'Transaction amount is outside the supported range.',
        },
      }, 422)
    }
    if (message.includes('Authorization') || message.includes('token')) {
      return json({ ok: false, error: { code: 'unauthorized', message: 'Unauthorized request.' } }, 401)
    }
    if (message.startsWith('Invalid') || message.startsWith('Missing') || message.includes('Wallet not found')) {
      return json({ ok: false, error: { code: 'bad_request', message } }, 400)
    }
    logError('update_transaction.error', { error: message })
    return json({ ok: false, error: { code: 'internal_error', message: 'Unexpected internal error.' } }, 500)
  }
})
}
