export type ObligationMode = 'current_cycle' | 'rolling_30_days' | 'custom'

export type CanonicalObligationLine = {
  source: 'bill' | 'planned_payment' | 'subscription' | 'goal_auto_save' | string
  sourceId: string
  name: string
  category: string | null
  amountCents: number
  occurrenceDate: string
  walletId: string | null
  isOverdue: boolean
  isRecurring: boolean
  frequency: string | null
}

export type CanonicalObligations = {
  version: string
  window: {
    mode: string
    startDate: string
    endDate: string
  }
  totals: {
    billsCents: number
    plannedPaymentsCents: number
    subscriptionsCents: number
    goalAutoSaveCents: number
    windowTotalCents: number
    overdueTotalCents: number
    grandTotalCents: number
  }
  counts: {
    bills: number
    plannedPayments: number
    subscriptions: number
    goalAutoSave: number
    overdueLines: number
  }
  lines: CanonicalObligationLine[]
  warnings: string[]
}

export type GetCanonicalObligationsInput = {
  mode: ObligationMode
  anchorDate?: string | null
  cycleStartDay?: number | null
  windowStart?: string | null
  windowEnd?: string | null
  walletIds?: Set<string> | string[] | null
  includeOverdue?: boolean
  includeLines?: boolean
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((x) => String(x)).filter((x) => x.length > 0)
}

function normalizeWalletIds(walletIds: Set<string> | string[] | null | undefined): string[] | null {
  if (!walletIds) return null
  const arr = Array.isArray(walletIds) ? walletIds : Array.from(walletIds)
  const ids = arr
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id.length > 0)
  return ids.length > 0 ? ids : null
}

function normalizeCanonicalPayload(raw: any): CanonicalObligations {
  const totalsRaw = raw?.totals || {}
  const countsRaw = raw?.counts || {}
  const linesRaw = Array.isArray(raw?.lines) ? raw.lines : []

  const lines: CanonicalObligationLine[] = linesRaw.map((line: any) => ({
    source: asText(line?.source) || 'unknown',
    sourceId: asText(line?.sourceId),
    name: asText(line?.name),
    category: typeof line?.category === 'string' ? line.category : null,
    amountCents: Math.max(0, Math.round(asNumber(line?.amountCents))),
    occurrenceDate: asText(line?.occurrenceDate),
    walletId: typeof line?.walletId === 'string' ? line.walletId : null,
    isOverdue: line?.isOverdue === true,
    isRecurring: line?.isRecurring === true,
    frequency: typeof line?.frequency === 'string' ? line.frequency : null,
  }))

  return {
    version: asText(raw?.version) || 'v1',
    window: {
      mode: asText(raw?.window?.mode),
      startDate: asText(raw?.window?.startDate),
      endDate: asText(raw?.window?.endDate),
    },
    totals: {
      billsCents: Math.max(0, Math.round(asNumber(totalsRaw?.billsCents))),
      plannedPaymentsCents: Math.max(0, Math.round(asNumber(totalsRaw?.plannedPaymentsCents))),
      subscriptionsCents: Math.max(0, Math.round(asNumber(totalsRaw?.subscriptionsCents))),
      goalAutoSaveCents: Math.max(0, Math.round(asNumber(totalsRaw?.goalAutoSaveCents))),
      windowTotalCents: Math.max(0, Math.round(asNumber(totalsRaw?.windowTotalCents))),
      overdueTotalCents: Math.max(0, Math.round(asNumber(totalsRaw?.overdueTotalCents))),
      grandTotalCents: Math.max(0, Math.round(asNumber(totalsRaw?.grandTotalCents))),
    },
    counts: {
      bills: Math.max(0, Math.round(asNumber(countsRaw?.bills))),
      plannedPayments: Math.max(0, Math.round(asNumber(countsRaw?.plannedPayments))),
      subscriptions: Math.max(0, Math.round(asNumber(countsRaw?.subscriptions))),
      goalAutoSave: Math.max(0, Math.round(asNumber(countsRaw?.goalAutoSave))),
      overdueLines: Math.max(0, Math.round(asNumber(countsRaw?.overdueLines))),
    },
    lines,
    warnings: toStringArray(raw?.warnings),
  }
}

export async function getCanonicalObligations(
  supabase: any,
  input: GetCanonicalObligationsInput
): Promise<CanonicalObligations> {
  const walletIds = normalizeWalletIds(input.walletIds)
  const params = {
    p_mode: input.mode,
    p_anchor_date: input.anchorDate || null,
    p_cycle_start_day: input.cycleStartDay ?? 1,
    p_window_start: input.windowStart || null,
    p_window_end: input.windowEnd || null,
    p_wallet_ids: walletIds,
    p_include_overdue: input.includeOverdue ?? true,
    p_include_lines: input.includeLines ?? true,
  }

  const { data, error } = await supabase.rpc('get_obligations_v1', params)
  if (error) {
    throw new Error(`[obligations] RPC get_obligations_v1 failed: ${error.message}`)
  }
  return normalizeCanonicalPayload(data || {})
}

