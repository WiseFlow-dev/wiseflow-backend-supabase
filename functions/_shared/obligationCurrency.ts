import {
  normalizeCurrencyCode,
  normalizeTransactionsToMainCurrency,
  type NormalizeTxnMetrics,
} from './currencyReporting.ts'

export type SupportedObligationSource = 'bill' | 'planned_payment' | 'subscription' | 'goal_auto_save'

export type NormalizedCanonicalObligationLine = {
  source: SupportedObligationSource
  sourceId: string | null
  name: string | null
  category: string | null
  amountCents: number
  walletId: string | null
  isOverdue: boolean
  isRecurring: boolean
  frequency: string | null
  dateKey: string
}

export type NormalizedCanonicalObligationResult = {
  lines: NormalizedCanonicalObligationLine[]
  excludedLineCount: number
  metrics: NormalizeTxnMetrics
}

export type NormalizedObligationTotals = {
  billsCents: number
  plannedPaymentsCents: number
  subscriptionsCents: number
  goalAutoSaveCents: number
  totalCents: number
  overdueCents: number
  grandTotalCents: number
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

type ObligationSourceCurrencyLookup = Map<string, string>

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function isSupportedObligationSource(source: unknown): source is SupportedObligationSource {
  return source === 'bill' ||
    source === 'planned_payment' ||
    source === 'subscription' ||
    source === 'goal_auto_save'
}

function normalizeDateKey(value: unknown, fallbackDate: string, maxDate: string): string {
  const clampToMax = (dateKey: string): string => (dateKey > maxDate ? maxDate : dateKey)
  const text = typeof value === 'string' ? value.trim() : ''
  if (DATE_KEY_RE.test(text)) return clampToMax(text)
  const parsed = new Date(text)
  if (Number.isFinite(parsed.getTime())) return clampToMax(parsed.toISOString().slice(0, 10))
  return clampToMax(fallbackDate)
}

function emptyMetrics(): NormalizeTxnMetrics {
  return {
    normalized_rows_used: 0,
    temporary_converted_rows_used: 0,
    raw_same_currency_rows_used: 0,
    rows_with_missing_reporting_fields: 0,
    fx_lookup_failures: 0,
  }
}

function currencyLookupKey(source: SupportedObligationSource, sourceId: string | null): string | null {
  if (!sourceId) return null
  return `${source}:${sourceId}`
}

async function loadObligationSourceCurrencies(
  supabase: any,
  userId: string,
  lines: Array<{ source: SupportedObligationSource; sourceId: string | null }>,
): Promise<ObligationSourceCurrencyLookup> {
  const sourceTables: Record<SupportedObligationSource, string> = {
    bill: 'bills',
    planned_payment: 'planned_payments',
    subscription: 'subscriptions',
    goal_auto_save: 'goals',
  }
  const idsBySource = new Map<SupportedObligationSource, Set<string>>()

  for (const line of lines) {
    if (!line.sourceId) continue
    const bucket = idsBySource.get(line.source) ?? new Set<string>()
    bucket.add(line.sourceId)
    idsBySource.set(line.source, bucket)
  }

  const result: ObligationSourceCurrencyLookup = new Map()
  for (const [source, idsSet] of idsBySource.entries()) {
    const ids = Array.from(idsSet)
    if (ids.length === 0) continue

    const { data, error } = await supabase
      .from(sourceTables[source])
      .select('id,currency_code')
      .eq('user_id', userId)
      .in('id', ids)

    if (error) {
      throw new Error(`Failed to load ${source} currencies: ${error.message}`)
    }

    for (const row of data ?? []) {
      const sourceId = typeof row?.id === 'string' ? row.id : null
      const currency = normalizeCurrencyCode(row?.currency_code)
      const key = currencyLookupKey(source, sourceId)
      if (key && currency) {
        result.set(key, currency)
      }
    }
  }

  return result
}

export async function normalizeCanonicalObligationLinesToMainCurrency(
  supabase: any,
  userId: string,
  mainCurrency: string,
  lines: any[],
  fallbackDate: string,
): Promise<NormalizedCanonicalObligationResult> {
  const todayDateKey = new Date().toISOString().slice(0, 10)
  const prepared: Array<{
    lineIndex: number
    source: SupportedObligationSource
    sourceId: string | null
    name: string | null
    category: string | null
    amountCents: number
    walletId: string | null
    sourceCurrency: string | null
    isOverdue: boolean
    isRecurring: boolean
    frequency: string | null
    dateKey: string
  }> = []

  for (const line of lines || []) {
    const source = String(line?.source || '')
    if (!isSupportedObligationSource(source)) continue

    const amountRaw = toFiniteNumber(line?.amountCents)
    const amountCents = amountRaw === null ? 0 : Math.max(0, Math.round(amountRaw))
    if (!(amountCents > 0)) continue

    const walletId = typeof line?.walletId === 'string' ? line.walletId : null
    const occurrenceDate = typeof line?.occurrenceDate === 'string' ? line.occurrenceDate : null
    const sourceCurrency = normalizeCurrencyCode(line?.currencyCode ?? line?.currency_code)

    prepared.push({
      lineIndex: prepared.length,
      source,
      sourceId: typeof line?.sourceId === 'string' ? line.sourceId : null,
      name: typeof line?.name === 'string' ? line.name : null,
      category: typeof line?.category === 'string' ? line.category : null,
      amountCents,
      walletId,
      sourceCurrency,
      isOverdue: line?.isOverdue === true,
      isRecurring: line?.isRecurring === true,
      frequency: typeof line?.frequency === 'string' ? line.frequency : null,
      dateKey: normalizeDateKey(occurrenceDate, fallbackDate, todayDateKey),
    })
  }

  if (prepared.length === 0) {
    return {
      lines: [],
      excludedLineCount: 0,
      metrics: emptyMetrics(),
    }
  }

  const sourceCurrencyByLineKey = await loadObligationSourceCurrencies(supabase, userId, prepared)

  const syntheticRows = prepared.map((line) => {
    const effectiveSourceCurrency =
      line.sourceCurrency ??
      sourceCurrencyByLineKey.get(currencyLookupKey(line.source, line.sourceId) ?? '') ??
      null

    return {
      lineIndex: line.lineIndex,
      wallet_id: effectiveSourceCurrency ? null : line.walletId,
      amount: line.amountCents / 100,
      reporting_amount: null,
      reporting_currency: null,
      source_currency: effectiveSourceCurrency,
      date: line.dateKey,
    }
  })

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrency,
    syntheticRows,
  )

  const normalizedAmountByIndex = new Map<number, number>()
  for (const row of normalized.rows || []) {
    const lineIndexRaw = toFiniteNumber((row as any)?.lineIndex)
    if (lineIndexRaw === null) continue
    const lineIndex = Math.round(lineIndexRaw)
    if (!(lineIndex >= 0)) continue

    const amount = toFiniteNumber((row as any)?.amount)
    if (amount === null || !(amount >= 0)) continue
    normalizedAmountByIndex.set(lineIndex, Math.max(0, Math.round(amount * 100)))
  }

  const normalizedLines: NormalizedCanonicalObligationLine[] = []
  let excludedLineCount = 0

  for (const line of prepared) {
    const normalizedAmount = normalizedAmountByIndex.get(line.lineIndex)
    if (typeof normalizedAmount === 'number') {
      normalizedLines.push({
        source: line.source,
        sourceId: line.sourceId,
        name: line.name,
        category: line.category,
        amountCents: normalizedAmount,
        walletId: line.walletId,
        isOverdue: line.isOverdue,
        isRecurring: line.isRecurring,
        frequency: line.frequency,
        dateKey: line.dateKey,
      })
      continue
    }

    if (!line.walletId) {
      normalizedLines.push({
        source: line.source,
        sourceId: line.sourceId,
        name: line.name,
        category: line.category,
        amountCents: line.amountCents,
        walletId: null,
        isOverdue: line.isOverdue,
        isRecurring: line.isRecurring,
        frequency: line.frequency,
        dateKey: line.dateKey,
      })
      continue
    }

    excludedLineCount += 1
  }

  return {
    lines: normalizedLines,
    excludedLineCount,
    metrics: normalized.metrics,
  }
}

export function sumNormalizedObligationTotals(
  lines: NormalizedCanonicalObligationLine[],
): NormalizedObligationTotals {
  const totals: NormalizedObligationTotals = {
    billsCents: 0,
    plannedPaymentsCents: 0,
    subscriptionsCents: 0,
    goalAutoSaveCents: 0,
    totalCents: 0,
    overdueCents: 0,
    grandTotalCents: 0,
  }

  for (const line of lines || []) {
    if (line.isOverdue) {
      totals.overdueCents += line.amountCents
      continue
    }

    if (line.source === 'bill') {
      totals.billsCents += line.amountCents
    } else if (line.source === 'planned_payment') {
      totals.plannedPaymentsCents += line.amountCents
    } else if (line.source === 'subscription') {
      totals.subscriptionsCents += line.amountCents
    } else if (line.source === 'goal_auto_save') {
      totals.goalAutoSaveCents += line.amountCents
    }
  }

  totals.totalCents =
    totals.billsCents +
    totals.plannedPaymentsCents +
    totals.subscriptionsCents +
    totals.goalAutoSaveCents
  totals.grandTotalCents = totals.totalCents + totals.overdueCents
  return totals
}

export function buildObligationNormalizationWarning(
  result: NormalizedCanonicalObligationResult,
  mainCurrency: string,
): string | null {
  const parts = [
    result.excludedLineCount > 0
      ? `${result.excludedLineCount} obligation line(s) were excluded because FX conversion to ${mainCurrency} was unavailable.`
      : null,
    result.metrics.fx_lookup_failures > 0
      ? `Some obligation FX lookups to ${mainCurrency} failed; fixed obligations may be conservative.`
      : null,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' ') : null
}

export function formatCurrencyTextFromCents(cents: number, currencyCode: string): string {
  const amount = Math.max(0, Math.round(Number(cents) || 0)) / 100
  return `${amount.toFixed(2)} ${currencyCode}`
}
