const FRANKFURTER_API_BASE = 'https://api.frankfurter.dev/v2/rate'
const CURRENCY_CODE_RE = /^[A-Z]{3}$/

export type MainCurrencySource = 'header' | 'body' | 'db'

export type ResolveMainCurrencyOptions = {
  headerCurrency?: string | null
  bodyCurrency?: unknown
}

type FxTuple = {
  base: string
  quote: string
  requestedDate: string
}

type NormalizeTxnInput = {
  wallet_id?: unknown
  amount?: unknown
  reporting_amount?: unknown
  reporting_currency?: unknown
  source_currency?: unknown
  date?: unknown
}

export type NormalizeWalletBalanceInput = {
  id?: unknown
  balance?: unknown
  currency_code?: unknown
}

type WalletCurrencyRow = {
  id: string
  currency_code: string | null
}

type FxRateCacheRow = {
  rate: number | string
  rate_date: string
}

export type NormalizeTxnMetrics = {
  normalized_rows_used: number
  temporary_converted_rows_used: number
  raw_same_currency_rows_used: number
  rows_with_missing_reporting_fields: number
  fx_lookup_failures: number
}

export type NormalizeWalletBalanceMetrics = NormalizeTxnMetrics & {
  input_wallet_rows: number
  usable_wallet_rows: number
  normalized_wallet_rows: number
  excluded_wallet_rows: number
}

export function normalizeCurrencyCode(raw: unknown): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return CURRENCY_CODE_RE.test(code) ? code : null
}

export async function resolveMainCurrencyCode(
  supabase: any,
  userId: string,
  options: ResolveMainCurrencyOptions = {},
): Promise<{ currency: string; source: MainCurrencySource }> {
  const fromHeader = normalizeCurrencyCode(options.headerCurrency)
  if (fromHeader) {
    return { currency: fromHeader, source: 'header' }
  }

  const fromBody = normalizeCurrencyCode(options.bodyCurrency)
  if (fromBody) {
    return { currency: fromBody, source: 'body' }
  }

  const { data, error } = await supabase
    .from('user_preferences')
    .select('currency')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to resolve main currency: ${error.message}`)
  }

  const fromDb = normalizeCurrencyCode((data as { currency?: unknown } | null)?.currency)
  if (fromDb) {
    return { currency: fromDb, source: 'db' }
  }

  throw new Error('user_preferences.currency is missing or invalid for this user')
}

function parseAmount(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeRequestedDate(raw: unknown): string | null {
  const parsed = new Date(String(raw ?? '').trim())
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function chunk<T>(input: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < input.length; i += size) {
    out.push(input.slice(i, i + size))
  }
  return out
}

async function loadWalletCurrencies(
  supabase: any,
  userId: string,
  walletIds: string[],
): Promise<Map<string, string>> {
  if (walletIds.length === 0) return new Map<string, string>()

  const result = new Map<string, string>()
  for (const ids of chunk(walletIds, 200)) {
    const { data, error } = await supabase
      .from('wallets')
      .select('id,currency_code')
      .eq('user_id', userId)
      .in('id', ids)

    if (error) {
      throw new Error(`Failed to load wallet currencies: ${error.message}`)
    }

    for (const row of (data ?? []) as WalletCurrencyRow[]) {
      const code = normalizeCurrencyCode(row.currency_code)
      if (code) {
        result.set(row.id, code)
      }
    }
  }

  return result
}

async function resolveFxRate(
  supabase: any,
  tuple: FxTuple,
): Promise<number | null> {
  if (tuple.base === tuple.quote) return 1

  const { data: cached, error: cacheError } = await supabase
    .from('fx_rate_cache')
    .select('rate,rate_date')
    .eq('base', tuple.base)
    .eq('quote', tuple.quote)
    .eq('requested_date', tuple.requestedDate)
    .maybeSingle()

  if (cacheError) {
    throw new Error(`Failed to read FX cache: ${cacheError.message}`)
  }

  const cachedRate = parseAmount((cached as FxRateCacheRow | null)?.rate)
  if (cachedRate && cachedRate > 0) {
    return cachedRate
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 9000)
  const url =
    `${FRANKFURTER_API_BASE}/${encodeURIComponent(tuple.base)}/${encodeURIComponent(tuple.quote)}?date=${encodeURIComponent(tuple.requestedDate)}`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return null

    const payload = await res.json() as { rate?: unknown; date?: unknown }
    const rate = parseAmount(payload.rate)
    const rateDate = normalizeRequestedDate(payload.date)
    if (!rate || rate <= 0 || !rateDate) return null

    await supabase.from('fx_rate_cache').upsert(
      {
        base: tuple.base,
        quote: tuple.quote,
        requested_date: tuple.requestedDate,
        rate_date: rateDate,
        rate,
        provider: 'frankfurter',
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'base,quote,requested_date' },
    )

    return rate
  } catch (_error) {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function normalizeTransactionsToMainCurrency<T extends NormalizeTxnInput>(
  supabase: any,
  userId: string,
  mainCurrency: string,
  rows: T[],
): Promise<{ rows: T[]; metrics: NormalizeTxnMetrics }> {
  const metrics: NormalizeTxnMetrics = {
    normalized_rows_used: 0,
    temporary_converted_rows_used: 0,
    raw_same_currency_rows_used: 0,
    rows_with_missing_reporting_fields: 0,
    fx_lookup_failures: 0,
  }

  if (rows.length === 0) {
    return { rows, metrics }
  }

  const walletIds = [...new Set(
    rows
      .map((r) => String(r.wallet_id ?? '').trim())
      .filter((id) => id.length > 0),
  )]
  const walletCurrencyById = await loadWalletCurrencies(supabase, userId, walletIds)

  const fxNeedMap = new Map<string, FxTuple>()
  for (const row of rows) {
    const walletId = String(row.wallet_id ?? '').trim()
    const walletCurrency = walletCurrencyById.get(walletId) ?? normalizeCurrencyCode(row.source_currency)

    const reportingAmount = parseAmount(row.reporting_amount)
    const reportingCurrency = normalizeCurrencyCode(row.reporting_currency)
    if (reportingAmount !== null && reportingCurrency === mainCurrency) {
      continue
    }
    if (!walletCurrency) {
      continue
    }
    if (walletCurrency === mainCurrency) {
      continue
    }

    const requestedDate = normalizeRequestedDate(row.date)
    if (!requestedDate) continue
    const key = `${walletCurrency}|${mainCurrency}|${requestedDate}`
    fxNeedMap.set(key, {
      base: walletCurrency,
      quote: mainCurrency,
      requestedDate,
    })
  }

  const fxRatesByKey = new Map<string, number>()
  for (const [key, tuple] of fxNeedMap.entries()) {
    const rate = await resolveFxRate(supabase, tuple)
    if (rate && rate > 0) {
      fxRatesByKey.set(key, rate)
    } else {
      metrics.fx_lookup_failures += 1
    }
  }

  const normalizedRows: T[] = []
  for (const row of rows) {
    const rowAmount = parseAmount(row.amount)
    if (rowAmount === null) continue

    const walletId = String(row.wallet_id ?? '').trim()
    const walletCurrency = walletCurrencyById.get(walletId) ?? normalizeCurrencyCode(row.source_currency)
    const reportingAmount = parseAmount(row.reporting_amount)
    const reportingCurrency = normalizeCurrencyCode(row.reporting_currency)

    if (reportingAmount !== null && reportingCurrency === mainCurrency) {
      normalizedRows.push({ ...row, amount: reportingAmount })
      metrics.normalized_rows_used += 1
      continue
    }

    if (!walletCurrency) {
      metrics.rows_with_missing_reporting_fields += 1
      continue
    }

    if (walletCurrency === mainCurrency) {
      normalizedRows.push({ ...row, amount: rowAmount })
      metrics.raw_same_currency_rows_used += 1
      continue
    }

    const requestedDate = normalizeRequestedDate(row.date)
    if (!requestedDate) {
      metrics.rows_with_missing_reporting_fields += 1
      continue
    }

    const fxKey = `${walletCurrency}|${mainCurrency}|${requestedDate}`
    const rate = fxRatesByKey.get(fxKey)
    if (!rate || !(rate > 0)) {
      metrics.rows_with_missing_reporting_fields += 1
      continue
    }

    const converted = Number((rowAmount * rate).toFixed(6))
    normalizedRows.push({ ...row, amount: converted })
    metrics.temporary_converted_rows_used += 1
  }

  return { rows: normalizedRows, metrics }
}

export async function normalizeWalletBalancesToMainCurrency<T extends NormalizeWalletBalanceInput>(
  supabase: any,
  userId: string,
  mainCurrency: string,
  wallets: T[],
  asOfDate: unknown = new Date().toISOString().slice(0, 10),
): Promise<{
  balancesByWalletId: Map<string, number>
  total: number
  metrics: NormalizeWalletBalanceMetrics
}> {
  const requestedDate = normalizeRequestedDate(asOfDate) ?? new Date().toISOString().slice(0, 10)
  const syntheticRows = wallets
    .map((wallet) => {
      const walletId = String(wallet?.id ?? '').trim()
      const amount = parseAmount(wallet?.balance)
      if (!walletId || amount === null) return null
      return {
        wallet_id: walletId,
        amount,
        reporting_amount: null,
        reporting_currency: null,
        source_currency: normalizeCurrencyCode(wallet?.currency_code),
        date: requestedDate,
      }
    })
    .filter((row): row is {
      wallet_id: string
      amount: number
      reporting_amount: null
      reporting_currency: null
      source_currency: string | null
      date: string
    } => row !== null)

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrency,
    syntheticRows,
  )

  const balancesByWalletId = new Map<string, number>()
  let total = 0
  for (const row of normalized.rows) {
    const walletId = String(row.wallet_id ?? '').trim()
    const amount = parseAmount(row.amount)
    if (!walletId || amount === null) continue
    balancesByWalletId.set(walletId, amount)
    total += amount
  }

  const metrics: NormalizeWalletBalanceMetrics = {
    ...normalized.metrics,
    input_wallet_rows: wallets.length,
    usable_wallet_rows: syntheticRows.length,
    normalized_wallet_rows: balancesByWalletId.size,
    excluded_wallet_rows: Math.max(0, syntheticRows.length - balancesByWalletId.size),
  }

  return {
    balancesByWalletId,
    total: Number(total.toFixed(6)),
    metrics,
  }
}
