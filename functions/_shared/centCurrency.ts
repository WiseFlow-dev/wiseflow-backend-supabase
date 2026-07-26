import {
  normalizeCurrencyCode,
  normalizeTransactionsToMainCurrency,
  type NormalizeTxnMetrics,
} from './currencyReporting.ts'

export type CentCurrencyMissingConversionMode = 'keep' | 'zero'

export type CentCurrencyFieldSpec = {
  amountField: string
  dateField?: string
  fallbackDate?: string
  missingConversion?: CentCurrencyMissingConversionMode
}

export type CentCurrencyNormalizationSummary = {
  field: string
  inputRows: number
  usableRows: number
  normalizedRows: number
  keptRawRows: number
  zeroedRows: number
  metrics: NormalizeTxnMetrics
}

export type CentCurrencyNormalizationResult<T> = {
  rows: T[]
  summaries: CentCurrencyNormalizationSummary[]
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function emptyMetrics(): NormalizeTxnMetrics {
  return {
    normalized_rows_used: 0,
    temporary_converted_rows_used: 0,
    raw_same_currency_rows_used: 0,
    rows_with_missing_reporting_fields: 0,
    fx_lookup_failures: 0,
  }
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function hasCurrencyScope(row: Record<string, unknown>): boolean {
  const walletId = typeof row?.wallet_id === 'string' ? row.wallet_id.trim() : ''
  const sourceCurrency = normalizeCurrencyCode(row?.currency_code) ??
    normalizeCurrencyCode(row?.currency) ??
    normalizeCurrencyCode(row?.source_currency)
  return walletId.length > 0 || sourceCurrency !== null
}

function normalizeDateKey(value: unknown, fallbackDate: string, maxDate: string): string {
  const clampToMax = (dateKey: string): string => (dateKey > maxDate ? maxDate : dateKey)
  const text = typeof value === 'string' ? value.trim() : ''
  if (DATE_KEY_RE.test(text)) return clampToMax(text)
  const parsed = new Date(text)
  if (Number.isFinite(parsed.getTime())) return clampToMax(parsed.toISOString().slice(0, 10))
  return clampToMax(fallbackDate)
}

async function normalizeCentFieldToMainCurrency<T extends Record<string, unknown>>(
  supabase: any,
  userId: string,
  mainCurrency: string,
  rows: T[],
  spec: CentCurrencyFieldSpec,
): Promise<{ rows: T[]; summary: CentCurrencyNormalizationSummary }> {
  const todayDateKey = new Date().toISOString().slice(0, 10)
  const fallbackDate = normalizeDateKey(spec.fallbackDate, todayDateKey, todayDateKey)
  const missingConversion = spec.missingConversion ?? 'keep'

  const prepared: Array<{
    row_index: number
    wallet_id: string | null
    amount: number
    reporting_amount: null
    reporting_currency: null
    source_currency: string | null
    date: string
  }> = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as Record<string, unknown>
    const amountCents = toFiniteNumber(row?.[spec.amountField])
    if (amountCents === null || !(amountCents > 0)) continue

    const sourceCurrency = normalizeCurrencyCode(row?.currency_code) ??
      normalizeCurrencyCode(row?.currency) ??
      normalizeCurrencyCode(row?.source_currency)

    prepared.push({
      row_index: index,
      wallet_id: !sourceCurrency && typeof row?.wallet_id === 'string' && row.wallet_id.trim().length > 0
        ? row.wallet_id.trim()
        : null,
      amount: amountCents / 100,
      reporting_amount: null,
      reporting_currency: null,
      source_currency: sourceCurrency,
      date: normalizeDateKey(spec.dateField ? row?.[spec.dateField] : null, fallbackDate, todayDateKey),
    })
  }

  if (prepared.length === 0) {
    return {
      rows,
      summary: {
        field: spec.amountField,
        inputRows: rows.length,
        usableRows: 0,
        normalizedRows: 0,
        keptRawRows: rows.length,
        zeroedRows: 0,
        metrics: emptyMetrics(),
      },
    }
  }

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrency,
    prepared,
  )

  const normalizedByIndex = new Map<number, number>()
  for (const row of normalized.rows || []) {
    const index = toFiniteNumber((row as Record<string, unknown>)?.row_index)
    const amount = toFiniteNumber((row as Record<string, unknown>)?.amount)
    if (index === null || amount === null || !(amount >= 0)) continue
    normalizedByIndex.set(Math.round(index), Math.max(0, Math.round(amount * 100)))
  }

  let normalizedRows = 0
  let zeroedRows = 0
  let keptRawRows = 0

  const nextRows = rows.map((row, index) => {
    const normalizedCents = normalizedByIndex.get(index)
    if (typeof normalizedCents === 'number') {
      normalizedRows += 1
      return { ...row, [spec.amountField]: normalizedCents } as T
    }

    const amountCents = toFiniteNumber((row as Record<string, unknown>)?.[spec.amountField])
    if (amountCents !== null && amountCents > 0 && missingConversion === 'zero' && hasCurrencyScope(row)) {
      zeroedRows += 1
      return { ...row, [spec.amountField]: 0 } as T
    }

    keptRawRows += 1
    return row
  })

  return {
    rows: nextRows,
    summary: {
      field: spec.amountField,
      inputRows: rows.length,
      usableRows: prepared.length,
      normalizedRows,
      keptRawRows,
      zeroedRows,
      metrics: normalized.metrics,
    },
  }
}

export async function normalizeCentFieldsToMainCurrency<T extends Record<string, unknown>>(
  supabase: any,
  userId: string,
  mainCurrency: string,
  rows: T[],
  fields: CentCurrencyFieldSpec[],
): Promise<CentCurrencyNormalizationResult<T>> {
  let nextRows = rows || []
  const summaries: CentCurrencyNormalizationSummary[] = []

  for (const field of fields) {
    const result = await normalizeCentFieldToMainCurrency(
      supabase,
      userId,
      mainCurrency,
      nextRows,
      field,
    )
    nextRows = result.rows
    summaries.push(result.summary)
  }

  return { rows: nextRows, summaries }
}

export function buildCentNormalizationWarning(
  label: string,
  result: CentCurrencyNormalizationResult<Record<string, unknown>>,
  mainCurrency: string,
): string | null {
  const zeroedRows = result.summaries.reduce((sum, summary) => sum + summary.zeroedRows, 0)
  const fxFailures = result.summaries.reduce((sum, summary) => sum + summary.metrics.fx_lookup_failures, 0)
  if (zeroedRows <= 0 && fxFailures <= 0) return null

  const parts = [
    zeroedRows > 0
      ? `${label}: ${zeroedRows} wallet-scoped money field(s) were excluded because conversion to ${mainCurrency} was unavailable.`
      : null,
    fxFailures > 0
      ? `${label}: ${fxFailures} FX lookup(s) to ${mainCurrency} failed.`
      : null,
  ].filter(Boolean)

  return parts.join(' ')
}
