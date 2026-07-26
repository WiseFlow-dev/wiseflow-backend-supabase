import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import { getCanonicalObligations } from '../ai-planner/obligations.ts'
import {
  buildBudgetLockContext,
  categoryLookupKeys,
  summarizeBudgetForLog
} from '../_shared/budgetLocks.ts'
import {
  normalizeTransactionsToMainCurrency,
  normalizeWalletBalancesToMainCurrency,
} from '../_shared/currencyReporting.ts'

// ============================================================================
// Types
// ============================================================================

type BudgetIntent = 'readiness' | 'build_budget_plan' | 'ask_cycle'

interface BudgetIntelligenceRequest {
  intent: BudgetIntent
  sessionId?: string
  timezone?: string
  timeframe?: string
  cycleType?: 'current' | 'next'
  message?: string          // forwarded from ai-chat for cycleType extraction
}

interface ReadinessResponse {
  ok: boolean
  readiness: {
    hasEnoughBudgetData: boolean
    expenseTxnCount: number
    spanDays: number
    suggestedPrompts: string[]
  }
}

interface MessageResponse {
  ok: boolean
  message: string
}

interface RecommendedCategory {
  categoryId: string
  categoryKey: string
  title: string
  suggestedCapCents: number
  reasonTag: string
  reasonText: string
  lastMonthSpendCents: number
  currentMonthToDateSpendCents: number
  alreadySpentThisCycleCents: number
}

interface BudgetAction {
  id: string
  title: string
  categoryId?: string
  categoryKey?: string
}

interface BudgetMetadata {
  cycleType: 'current' | 'next'
  daysRemaining: number
  availableDiscretionaryCents: number
  safetyBufferCents: number
  spendableBalanceCents: number
  fixedObligationsCents: number
  budgetReservedCents: number
  suggestNextCycle?: boolean
  currencyCode: string
  currencyWarning?: string
}

interface BudgetRecommendationsResponse {
  ok: boolean
  recommendations: {
    type: 'budget_category_recommendations'
    recommendationId: string
    timeframeLabel: string
    recommendedCategories: RecommendedCategory[]
    actions: BudgetAction[]
    metadata: BudgetMetadata
  }
}

// CycleQuestionResponse removed â€” V1 uses plain MessageResponse to avoid raw JSON in Android

interface BudgetWarningResponse {
  ok: boolean
  warning: {
    type: 'budget_warning'
    warningCode: string
    message: string
    metadata?: Partial<BudgetMetadata>
  }
}

// ============================================================================
// Constants
// ============================================================================

const SUGGESTED_PROMPTS = [
  "Build a budget for this month.",
  "Make me a more aggressive budget."
]

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeCategoryKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const INCOME_KEYWORDS = ['salary', 'freelance', 'income', 'wages', 'bonus', 'paycheck', 'pay check', 'payroll']

function isIncomeCategoryText(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.trim().toLowerCase()
  if (!text) return false
  return INCOME_KEYWORDS.some((k) => text.includes(k))
}

function toDateKey(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().split('T')[0]
}

function dollarsToCents(amount: unknown): number {
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

type SupportedObligationSource = 'bill' | 'planned_payment' | 'subscription' | 'goal_auto_save'

type NormalizedCanonicalObligationLine = {
  source: SupportedObligationSource
  amountCents: number
  walletId: string | null
  isOverdue: boolean
  dateKey: string
}

type NormalizedCanonicalObligationResult = {
  lines: NormalizedCanonicalObligationLine[]
  excludedLineCount: number
  metrics: {
    normalized_rows_used: number
    temporary_converted_rows_used: number
    raw_same_currency_rows_used: number
    rows_with_missing_reporting_fields: number
    fx_lookup_failures: number
  }
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function isSupportedObligationSource(source: unknown): source is SupportedObligationSource {
  return source === 'bill' || source === 'planned_payment' || source === 'subscription' || source === 'goal_auto_save'
}

function normalizeDateKey(value: unknown, fallbackDate: string, maxDate: string): string {
  const clampToMax = (dateKey: string): string => (dateKey > maxDate ? maxDate : dateKey)
  const text = typeof value === 'string' ? value.trim() : ''
  if (DATE_KEY_RE.test(text)) return clampToMax(text)
  const parsed = new Date(text)
  if (Number.isFinite(parsed.getTime())) return clampToMax(parsed.toISOString().slice(0, 10))
  return clampToMax(fallbackDate)
}

async function normalizeCanonicalObligationLinesToMainCurrency(
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
    amountCents: number
    walletId: string | null
    isOverdue: boolean
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

    prepared.push({
      lineIndex: prepared.length,
      source,
      amountCents,
      walletId,
      isOverdue: line?.isOverdue === true,
      dateKey: normalizeDateKey(occurrenceDate, fallbackDate, todayDateKey),
    })
  }

  if (prepared.length === 0) {
    return {
      lines: [],
      excludedLineCount: 0,
      metrics: {
        normalized_rows_used: 0,
        temporary_converted_rows_used: 0,
        raw_same_currency_rows_used: 0,
        rows_with_missing_reporting_fields: 0,
        fx_lookup_failures: 0,
      },
    }
  }

  const syntheticRows = prepared.map((line) => ({
    lineIndex: line.lineIndex,
    wallet_id: line.walletId,
    amount: line.amountCents / 100,
    reporting_amount: null,
    reporting_currency: null,
    source_currency: null,
    date: line.dateKey,
  }))

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
        amountCents: normalizedAmount,
        walletId: line.walletId,
        isOverdue: line.isOverdue,
        dateKey: line.dateKey,
      })
      continue
    }

    if (!line.walletId) {
      normalizedLines.push({
        source: line.source,
        amountCents: line.amountCents,
        walletId: null,
        isOverdue: line.isOverdue,
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

/**
 * Get year, month, day in a specific IANA timezone.
 * Returns { y: number, m: number (1-12), d: number }
 */
function getZonedYmd(now: Date, timeZone: string): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const parts = fmt.formatToParts(now)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

/**
 * Convert year, month (1-12), day to YYYY-MM-DD string.
 */
function ymdToDateKey(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

function clampCycleStartDay(cycleStartDay: number): number {
  if (!Number.isFinite(cycleStartDay)) return 1
  return Math.max(1, Math.min(31, Math.floor(cycleStartDay)))
}

function normalizeYearMonth(year: number, month: number): { year: number; month: number } {
  const normalized = new Date(Date.UTC(year, month - 1, 1))
  return {
    year: normalized.getUTCFullYear(),
    month: normalized.getUTCMonth() + 1,
  }
}

function getDaysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function buildCycleAnchorUtc(year: number, month: number, cycleStartDay: number): number {
  const normalized = normalizeYearMonth(year, month)
  const safeDay = Math.min(
    clampCycleStartDay(cycleStartDay),
    getDaysInMonthUtc(normalized.year, normalized.month),
  )
  return Date.UTC(normalized.year, normalized.month - 1, safeDay)
}

/**
 * Compute cycle boundaries based on user's cycle_start_day using timezone-aware date math.
 * Uses UTC timestamps for stable day calculations to avoid time-of-day issues.
 *
 * cycleStartDay = 1  â†’ standard calendar months
 * cycleStartDay = 25 â†’ cycle runs 25th to 24th of next month
 */
function getCycleBoundariesFromYmd(
  y: number,
  m: number, // 1-12
  d: number,
  cycleStartDay: number,
  cycleType: 'current' | 'next'
): { cycleStart: string; cycleEnd: string; daysRemaining: number; totalDays: number } {
  // Treat "today" as a date-only value; use Date.UTC for stable day math
  const todayMidUtc = Date.UTC(y, m - 1, d)
  
  // Determine cycleStart (date-only)
  const thisMonthStartUtc = buildCycleAnchorUtc(y, m, cycleStartDay)
  const startUtc = todayMidUtc >= thisMonthStartUtc
    ? thisMonthStartUtc
    : buildCycleAnchorUtc(y, m - 1, cycleStartDay)
  
  const startDate = new Date(startUtc)
  const nextCycleStartUtc = buildCycleAnchorUtc(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 2,
    cycleStartDay
  )
  const endUtc = nextCycleStartUtc - 86400000
  
  const endDate = new Date(endUtc)
  const nextStartDate = new Date(nextCycleStartUtc)
  
  if (cycleType === 'next') {
    const nextEndUtc = buildCycleAnchorUtc(
      nextStartDate.getUTCFullYear(),
      nextStartDate.getUTCMonth() + 2,
      cycleStartDay
    ) - 86400000
    const totalDays = Math.floor((nextEndUtc - nextCycleStartUtc) / 86400000) + 1
    const nextEndDate = new Date(nextEndUtc)
    return {
      cycleStart: ymdToDateKey(
        nextStartDate.getUTCFullYear(),
        nextStartDate.getUTCMonth() + 1,
        nextStartDate.getUTCDate()
      ),
      cycleEnd: ymdToDateKey(
        nextEndDate.getUTCFullYear(),
        nextEndDate.getUTCMonth() + 1,
        nextEndDate.getUTCDate()
      ),
      daysRemaining: totalDays,
      totalDays
    }
  }
  
  const totalDays = Math.floor((endUtc - startUtc) / 86400000) + 1
  const daysElapsed = Math.floor((todayMidUtc - startUtc) / 86400000)
  // INCLUDE TODAY: if today==start, daysElapsed=0 => remaining=totalDays
  const daysRemaining = Math.max(0, totalDays - daysElapsed)
  
  return {
    cycleStart: ymdToDateKey(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + 1,
      startDate.getUTCDate()
    ),
    cycleEnd: ymdToDateKey(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth() + 1,
      endDate.getUTCDate()
    ),
    daysRemaining,
    totalDays
  }
}

/**
 * Try to extract cycleType from user's natural language message.
 * Returns null if ambiguous.
 */
function extractCycleTypeFromMessage(message: string | undefined): 'current' | 'next' | null {
  if (!message) return null
  const lower = message.toLowerCase()
  if (/\bnext\s+month\b/.test(lower) || /\bupcoming\s+month\b/.test(lower)) return 'next'
  if (/\bthis\s+month\b/.test(lower) || /\bcurrent\s+month\b/.test(lower) || /\brest\s+of\b/.test(lower)) return 'current'
  return null
}

/**
 * Safe sum of amount_cents from query results.
 */
function sumAmountCents(rows: any[] | null): number {
  if (!rows || rows.length === 0) return 0
  return rows.reduce((sum: number, r: any) => {
    const v = Number(r.amount_cents)
    return sum + (Number.isFinite(v) ? v : 0)
  }, 0)
}

/**
 * Returns the last `count` completed budget cycle windows (not including the current partial cycle).
 * Each entry is { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }.
 * Algorithm: walk backwards one month at a time from the start of the current cycle.
 */
function getPreviousCycleWindows(
  y: number,
  m: number, // 1-12
  d: number,
  cycleStartDay: number,
  count: number
): Array<{ start: string; end: string }> {
  // Start of the current (partial) cycle â€” not included in results
  // Use UTC for stable date math
  const thisMonthStartUtc = buildCycleAnchorUtc(y, m, cycleStartDay)
  const todayMidUtc = Date.UTC(y, m - 1, d)
  const cycleStartUtc = todayMidUtc >= thisMonthStartUtc
    ? thisMonthStartUtc
    : buildCycleAnchorUtc(y, m - 1, cycleStartDay)
  
  let currentCycleStartUtc = cycleStartUtc

  const windows: Array<{ start: string; end: string }> = []

  for (let i = 0; i < count; i++) {
    // End of previous cycle = day before current cycleStart
    const endUtc = currentCycleStartUtc - 86400000
    const endDate = new Date(endUtc)
    
    // Start of previous cycle = same safeDay, one month earlier
    const currentStartDate = new Date(currentCycleStartUtc)
    const startUtc = buildCycleAnchorUtc(
      currentStartDate.getUTCFullYear(),
      currentStartDate.getUTCMonth(),
      cycleStartDay
    )
    const startDate = new Date(startUtc)

    windows.push({
      start: ymdToDateKey(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth() + 1,
        startDate.getUTCDate()
      ),
      end: ymdToDateKey(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth() + 1,
        endDate.getUTCDate()
      )
    })

    // Shift back: previous cycle's start becomes the new reference
    currentCycleStartUtc = startUtc
  }

  return windows
}

/**
 * Determine primary currency.
 * Prefer user_preferences.currency, otherwise most common wallet currency_code.
 */
function determinePrimaryCurrency(
  userPrefCurrency: string | null | undefined,
  wallets: any[] | null
): { primaryCurrency: string; warning: string | null } {
  const normalizedPref = typeof userPrefCurrency === 'string'
    ? userPrefCurrency.trim().toUpperCase()
    : ''
  if (normalizedPref.length >= 2) {
    return { primaryCurrency: normalizedPref, warning: null }
  }

  // Fallback: most common wallet currency_code
  if (!wallets || wallets.length === 0) {
    return { primaryCurrency: 'USD', warning: null }
  }

  const counts = new Map<string, number>()
  for (const w of wallets) {
    const cc = String(w.currency_code || 'USD').trim().toUpperCase() || 'USD'
    counts.set(cc, (counts.get(cc) || 0) + 1)
  }

  let best = 'USD'
  let bestCount = 0
  for (const [cc, count] of counts) {
    if (count > bestCount) {
      best = cc
      bestCount = count
    }
  }

  const distinctCurrencies = counts.size
  const warning = distinctCurrencies > 1
    ? `Multiple currencies detected (${[...counts.keys()].join(', ')}). Budget analysis is normalized to ${best}.`
    : null

  return { primaryCurrency: best, warning }
}

// ============================================================================
// Main handler
// ============================================================================

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      }
    })
  }

  try {
    // Extract user from JWT token
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    // Use anon-key client + forward Authorization for safer user-scoped queries (RLS-friendly)
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        auth: { persistSession: false },
        global: { headers: { Authorization: authHeader } }
      }
    )

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) throw new Error('Invalid or expired token')

    const userId = user.id

    // Parse request body
    const body = await req.json() as BudgetIntelligenceRequest
    const { intent, cycleType: rawCycleType, message } = body

    if (intent !== 'readiness' && intent !== 'build_budget_plan' && intent !== 'ask_cycle') {
      return new Response(JSON.stringify({ error: 'Invalid intent' }), {
        status: 400,
        headers: CORS_HEADERS
      })
    }

    // ========================================================================
    // READINESS CHECK (unchanged from existing logic)
    // ========================================================================

    // Performance: use count/head + min/max date queries.
    const { count: expenseTxnCount, error: expenseCountError } = await supabaseClient
      .from('wallet_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .lt('amount', 0)

    if (expenseCountError) {
      console.error('Error counting expense transactions:', expenseCountError)
      throw new Error('Failed to count expense transactions')
    }

    const { data: minDateRows } = await supabaseClient
      .from('wallet_transactions')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: true })
      .limit(1)

    const { data: maxDateRows } = await supabaseClient
      .from('wallet_transactions')
      .select('date')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1)

    let spanDays = 0
    const minDate = minDateRows?.[0]?.date
    const maxDate = maxDateRows?.[0]?.date
    if (minDate && maxDate) {
      const minMs = new Date(minDate).getTime()
      const maxMs = new Date(maxDate).getTime()
      if (!Number.isNaN(minMs) && !Number.isNaN(maxMs) && maxMs >= minMs) {
        spanDays = Math.floor((maxMs - minMs) / (1000 * 60 * 60 * 24))
      }
    }

    // Rule: >= 40 expense transactions OR >= 30 day span
    const safeExpenseTxnCount = expenseTxnCount ?? 0
    const hasEnoughBudgetData = safeExpenseTxnCount >= 40 || spanDays >= 30

    const suggestedPrompts = hasEnoughBudgetData ? SUGGESTED_PROMPTS : []

    if (intent === 'readiness') {
      const response: ReadinessResponse = {
        ok: true,
        readiness: {
          hasEnoughBudgetData,
          expenseTxnCount: safeExpenseTxnCount,
          spanDays,
          suggestedPrompts
        }
      }

      console.log(`Budget readiness check: hasEnoughData=${hasEnoughBudgetData}, expenseTxns=${expenseTxnCount}, spanDays=${spanDays}`)

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    // ========================================================================
    // USER PREFERENCES (needed for both ask_cycle and build_budget_plan)
    // ========================================================================

    const { data: userPrefsData } = await supabaseClient
      .from('user_preferences')
      .select('cycle_start_day, currency')
      .eq('user_id', userId)
      .limit(1)
      .single()

    const cycleStartDay = userPrefsData?.cycle_start_day ?? 1
    const userPrefCurrency = userPrefsData?.currency ?? null

    const today = new Date()
    const tz = body.timezone || 'UTC'
    const { y, m, d } = getZonedYmd(today, tz)
    const todayStr = ymdToDateKey(y, m, d)

    // ========================================================================
    // ASK_CYCLE INTENT
    // ========================================================================

    if (intent === 'ask_cycle') {
      const currentBounds = getCycleBoundariesFromYmd(y, m, d, cycleStartDay, 'current')

      const question = currentBounds.daysRemaining <= 7
        ? `Only ${currentBounds.daysRemaining} days left in your current cycle. Would you like to plan for next month instead, or set caps for the remaining days?`
        : `Would you like me to set budget caps for the rest of this cycle (${currentBounds.daysRemaining} days left), or plan ahead for next month?`

      const response: MessageResponse = {
        ok: true,
        message: question
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    // ========================================================================
    // BUILD_BUDGET_PLAN
    // ========================================================================

    // --- Determine cycleType ---
    // Priority: explicit param > message NLP extraction > return cycle_question
    let cycleType: 'current' | 'next' | null = rawCycleType || null
    if (!cycleType) {
      cycleType = extractCycleTypeFromMessage(message)
    }

    if (!cycleType) {
      // No cycleType provided â†’ return plain message so user picks (Android-safe)
      const currentBounds = getCycleBoundariesFromYmd(y, m, d, cycleStartDay, 'current')

      const question = currentBounds.daysRemaining <= 7
        ? `Only ${currentBounds.daysRemaining} days left in your current cycle. Would you like to plan for next month instead, or set caps for the remaining days?`
        : `Would you like me to set budget caps for the rest of this cycle (${currentBounds.daysRemaining} days left), or plan ahead for next month?`

      const response: MessageResponse = {
        ok: true,
        message: question
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    // Guardrail: if not enough data, do NOT guess caps.
    if (!hasEnoughBudgetData) {
      const response: MessageResponse = {
        ok: true,
        message:
          "I can help you set a budget, but I don't have enough spending history yet to recommend category caps confidently. Once you have at least 40 expense transactions OR 30 days of history, I can build a full budget plan. For now, tell me your goal (e.g., save 200 next month) and I can suggest a simple spending guardrail."
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    // --- Compute cycle boundaries ---
    const cycle = getCycleBoundariesFromYmd(y, m, d, cycleStartDay, cycleType)

    console.log(`Budget plan: cycleType=${cycleType}, cycle=${cycle.cycleStart} to ${cycle.cycleEnd}, daysRemaining=${cycle.daysRemaining}`)

    // ========================================================================
    // PARALLEL DATA QUERIES
    // ========================================================================

    // We need these for time window calculations regardless of cycleType
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const lastMonthStart = toDateKey(lastMonth)
    const lastMonthEnd = toDateKey(new Date(today.getFullYear(), today.getMonth(), 0))
    const currentMonthStart = toDateKey(new Date(today.getFullYear(), today.getMonth(), 1))

    // Obligation date range: today â†’ cycleEnd for current, cycleStart â†’ cycleEnd for next
    const obligationRangeStart = cycleType === 'current' ? todayStr : cycle.cycleStart
    const obligationRangeEnd = cycle.cycleEnd

    const [
      walletsResult,
      budgetsResult,
      incomesResult,
      categoriesResult,
      transactionsResult
    ] = await Promise.allSettled([
      // 1. All wallets (we filter by currency in code)
      supabaseClient
        .from('wallets')
        .select('id, balance, type, archived, currency_code, account_class')
        .eq('user_id', userId),

      // 2. All active budgets (we filter out recommended categories in code after scoring)
      supabaseClient
        .from('budgets')
        .select('category_id, amount_cents, start_date, end_date, is_active, name, wallet_id, categories(name)')
        .eq('user_id', userId)
        .eq('is_active', true),

      // 3. Incomes (recurring, and optionally scoped to next cycle)
      supabaseClient
        .from('incomes')
        .select('amount_cents, expected_date, is_recurring, recurring_frequency')
        .eq('user_id', userId),

      // 4. Categories (with is_fixed_obligation + expense_tier)
      supabaseClient
        .from('categories')
        .select('id, name, section, is_fixed_obligation, expense_tier, is_income')
        .eq('is_income', false),

      // 5. Expense transactions for category analysis (last month + current cycle)
      supabaseClient
        .from('wallet_transactions')
        .select(`
          id,
          wallet_id,
          amount,
          reporting_amount,
          reporting_currency,
          category,
          date,
          category_id,
          categories (
            id,
            name,
            section,
            is_fixed_obligation,
            expense_tier
          )
        `)
        .eq('user_id', userId)
        .lt('amount', 0)
        .gte('date', lastMonthStart)
        .lte('date', cycle.cycleEnd)
    ])

    // ========================================================================
    // PROCESS RESULTS â€” wallet balance is critical
    // ========================================================================

    // --- Wallets (CRITICAL: if this fails, return warning) ---
    if (walletsResult.status === 'rejected' || (walletsResult.status === 'fulfilled' && walletsResult.value.error)) {
      const errMsg = walletsResult.status === 'rejected'
        ? walletsResult.reason?.message
        : walletsResult.value.error?.message
      console.error('Wallet query failed:', errMsg)

      const response: BudgetWarningResponse = {
        ok: true,
        warning: {
          type: 'budget_warning',
          warningCode: 'wallet_query_failed',
          message: 'I couldn\'t access your wallet balances, so I can\'t safely recommend budget caps right now. Please try again in a moment.'
        }
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    const allWallets = walletsResult.value.data || []

    // --- Determine primary currency ---
    const { primaryCurrency, warning: baseCurrencyWarning } = determinePrimaryCurrency(userPrefCurrency, allWallets)

    // --- Spendable balance: normalize all spendable asset wallets into primary currency ---
    const spendableWallets = allWallets.filter((w: any) => {
      const walletType = String(w?.type || '').toLowerCase()
      const accountClass = String(w?.account_class || 'ASSET').trim().toUpperCase()
      return ['spending', 'cash', 'bank'].includes(walletType) &&
        w?.archived !== true &&
        accountClass !== 'LIABILITY'
    })

    const normalizedSpendableBalances = await normalizeWalletBalancesToMainCurrency(
      supabaseClient,
      userId,
      primaryCurrency,
      spendableWallets,
    )
    const spendableBalanceCents = Math.round(normalizedSpendableBalances.total * 100)
    const balanceExclusionWarning = normalizedSpendableBalances.metrics.excluded_wallet_rows > 0
      ? `${normalizedSpendableBalances.metrics.excluded_wallet_rows} wallet balance(s) were excluded because FX conversion to ${primaryCurrency} was unavailable.`
      : null
    let currencyWarning = [baseCurrencyWarning, balanceExclusionWarning].filter(Boolean).join(' ').trim() || null

    console.log(
      `[ai-budget-intelligence] spendable balance normalization: totalCents=${spendableBalanceCents}, wallets=${spendableWallets.length}, normalized=${normalizedSpendableBalances.metrics.normalized_wallet_rows}, excluded=${normalizedSpendableBalances.metrics.excluded_wallet_rows}, currency=${primaryCurrency}`
    )

    // --- Obligations (canonical RPC only; single source of truth) ---
    const activeAssetWalletIds = new Set<string>(
      allWallets
        .filter((w: any) =>
          w?.archived !== true &&
          String(w?.account_class || 'ASSET').trim().toUpperCase() !== 'LIABILITY'
        )
        .map((w: any) => String(w?.id || '').trim())
        .filter((id: string) => id.length > 0)
    )

    let subsRemaining = 0
    let billsRemaining = 0
    let plannedPaymentsRemaining = 0
    let fixedRemainingThisCycle = 0
    let overdueRemaining = 0
    let grandRemaining = 0
    let goalAutoSaveRemaining = 0
    const obligationScopeCount = activeAssetWalletIds.size

    console.log(
      `[ai-budget-intelligence] obligations request: mode=custom, window=${obligationRangeStart}..${obligationRangeEnd}, walletScopeCount=${obligationScopeCount}, includeOverdue=true, includeLines=true`
    )

    try {
      const canonical = await getCanonicalObligations(supabaseClient, {
        mode: 'custom',
        windowStart: obligationRangeStart,
        windowEnd: obligationRangeEnd,
        walletIds: activeAssetWalletIds,
        includeOverdue: true,
        includeLines: true
      })

      const normalized = await normalizeCanonicalObligationLinesToMainCurrency(
        supabaseClient,
        userId,
        primaryCurrency,
        canonical.lines || [],
        obligationRangeEnd,
      )

      for (const line of normalized.lines) {
        if (line.isOverdue) {
          overdueRemaining += line.amountCents
          continue
        }

        if (line.source === 'subscription') {
          subsRemaining += line.amountCents
        } else if (line.source === 'bill') {
          billsRemaining += line.amountCents
        } else if (line.source === 'planned_payment') {
          plannedPaymentsRemaining += line.amountCents
        } else if (line.source === 'goal_auto_save') {
          goalAutoSaveRemaining += line.amountCents
        }
      }
      fixedRemainingThisCycle = subsRemaining + billsRemaining + plannedPaymentsRemaining + goalAutoSaveRemaining
      grandRemaining = fixedRemainingThisCycle + overdueRemaining

      if (Array.isArray(canonical?.warnings) && canonical.warnings.length > 0) {
        console.log(`Obligations canonical warnings: ${canonical.warnings.join(' | ')}`)
      }
      if (normalized.excludedLineCount > 0) {
        console.log(
          `[ai-budget-intelligence] obligations normalization excluded ${normalized.excludedLineCount} wallet-scoped line(s) due to unavailable FX conversion to ${primaryCurrency}`
        )
      }
      if (normalized.metrics.fx_lookup_failures > 0) {
        console.log(
          `[ai-budget-intelligence] obligations normalization FX lookups failed: ${normalized.metrics.fx_lookup_failures}`
        )
      }
      const obligationsNormalizationWarning = [
        normalized.excludedLineCount > 0
          ? `${normalized.excludedLineCount} obligation line(s) were excluded because FX conversion to ${primaryCurrency} was unavailable.`
          : null,
        normalized.metrics.fx_lookup_failures > 0
          ? `Some obligation FX lookups to ${primaryCurrency} failed; obligations may be conservative.`
          : null,
      ].filter(Boolean).join(' ').trim() || null
      if (obligationsNormalizationWarning) {
        currencyWarning = [currencyWarning, obligationsNormalizationWarning].filter(Boolean).join(' ').trim() || null
      }
      console.log(
        `[ai-budget-intelligence] obligations response: version=${canonical?.version || 'v1'}, window=${canonical?.window?.startDate || obligationRangeStart}..${canonical?.window?.endDate || obligationRangeEnd}, subs=${subsRemaining}, bills=${billsRemaining}, planned=${plannedPaymentsRemaining}, goalAutoSave=${goalAutoSaveRemaining}, overdue=${overdueRemaining}, grand=${grandRemaining}, total=${fixedRemainingThisCycle}`
      )
    } catch (error) {
      const errMsg = String((error as any)?.message || error)
      console.error(`[ai-budget-intelligence] obligations failure: mode=custom, window=${obligationRangeStart}..${obligationRangeEnd}, walletScopeCount=${obligationScopeCount}, error=${errMsg}`)
      throw new Error(`Failed to fetch obligations via get_obligations_v1: ${errMsg}`)
    }

    console.log(`Obligations remaining: subs=${subsRemaining}, bills=${billsRemaining}, planned=${plannedPaymentsRemaining}, total=${fixedRemainingThisCycle}`)

    // --- Categories (with is_fixed_obligation + expense_tier fallback) ---
    let expenseCategories: any[] = []
    if (categoriesResult.status === 'fulfilled') {
      if (categoriesResult.value.error) {
        const msg = String(categoriesResult.value.error?.message || '')
        if (msg.toLowerCase().includes('is_fixed_obligation') && msg.toLowerCase().includes('does not exist')) {
          // Fallback: query without is_fixed_obligation
          const { data: fallbackData } = await supabaseClient
            .from('categories')
            .select('id, name, section, expense_tier, is_income')
            .eq('is_income', false)
          expenseCategories = (fallbackData || []) as any[]
        } else {
          console.error('Error fetching categories:', categoriesResult.value.error)
          throw new Error('Failed to fetch categories')
        }
      } else {
        expenseCategories = (categoriesResult.value.data || []) as any[]
      }
    }

    const categoryByNormalizedName = new Map<string, any>()
    const categoryNameById = new Map<string, string>()
    for (const c of expenseCategories) {
      const key = String(c.name || '').trim().toLowerCase()
      if (key && !categoryByNormalizedName.has(key)) {
        categoryByNormalizedName.set(key, c)
      }
      const id = typeof c?.id === 'string' ? c.id.trim() : ''
      const name = typeof c?.name === 'string' ? c.name.trim() : ''
      if (id && name && !categoryNameById.has(id)) {
        categoryNameById.set(id, name)
      }
    }
    const otherCategory = categoryByNormalizedName.get('other')

    // --- Transactions (with is_fixed_obligation fallback) ---
    let transactions: any[] = []
    if (transactionsResult.status === 'fulfilled') {
      if (transactionsResult.value.error) {
        const msg = String(transactionsResult.value.error?.message || '')
        if (msg.toLowerCase().includes('is_fixed_obligation') && msg.toLowerCase().includes('does not exist')) {
          const { data: fallbackData } = await supabaseClient
            .from('wallet_transactions')
            .select(`id, wallet_id, amount, reporting_amount, reporting_currency, category, date, category_id, categories (id, name, section, expense_tier)`)
            .eq('user_id', userId)
            .lt('amount', 0)
            .gte('date', lastMonthStart)
            .lte('date', cycle.cycleEnd)
          transactions = (fallbackData || []) as any[]
        } else {
          console.error('Error fetching transactions:', transactionsResult.value.error)
          throw new Error('Failed to fetch transaction data')
        }
      } else {
        transactions = (transactionsResult.value.data || []) as any[]
      }
    }
    if (transactions.length > 0) {
      const normalizedTx = await normalizeTransactionsToMainCurrency(
        supabaseClient,
        userId,
        primaryCurrency,
        transactions as Array<Record<string, unknown>>,
      )
      transactions = normalizedTx.rows as any[]
      console.log(
        `[ai-budget-intelligence] tx currency normalization: normalized=${normalizedTx.metrics.normalized_rows_used}, fx=${normalizedTx.metrics.temporary_converted_rows_used}, same=${normalizedTx.metrics.raw_same_currency_rows_used}, missing=${normalizedTx.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalizedTx.metrics.fx_lookup_failures}`
      )
    }

    // ========================================================================
    // CATEGORY SCORING (existing logic preserved)
    // ========================================================================

    const OUTLIER_THRESHOLD_CENTS = 50000 // $500

    interface CategoryMetrics {
      categoryId: string
      name: string
      section: string
      isFixedObligation: boolean
      lastMonthSpendCents: number
      currentMonthToDateSpendCents: number
      currentCycleSpendCents: number
      txnCountCurrentMonth: number
      txnAmounts: number[]
    }

    const categoryMap = new Map<string, CategoryMetrics>()

    for (const txn of transactions) {
      let cat = txn.categories
      if (!cat || !cat.id) {
        const legacyName = String(txn.category || '').trim()
        const normalizedLegacyName = legacyName.toLowerCase()
        cat = (legacyName && categoryByNormalizedName.get(normalizedLegacyName)) || otherCategory
      }

      if (!cat || !cat.id) continue

      const categoryId = cat.id
      const amountCents = Math.abs(dollarsToCents(txn.amount))
      const dateKey = toDateKey(txn.date)
      if (!dateKey) continue

      // Filter out outlier transactions (> $500)
      if (amountCents > OUTLIER_THRESHOLD_CENTS) {
        console.log(`Excluding outlier transaction: $${(amountCents/100).toFixed(2)} in ${cat.name}`)
        continue
      }

      if (!categoryMap.has(categoryId)) {
        categoryMap.set(categoryId, {
          categoryId,
          name: cat.name,
          section: cat.section,
          isFixedObligation: cat.is_fixed_obligation === true || String(cat.expense_tier || '').toLowerCase() === 'essential',
          lastMonthSpendCents: 0,
          currentMonthToDateSpendCents: 0,
          currentCycleSpendCents: 0,
          txnCountCurrentMonth: 0,
          txnAmounts: []
        })
      }

      const metrics = categoryMap.get(categoryId)!

      if (dateKey >= lastMonthStart && dateKey <= lastMonthEnd) {
        metrics.lastMonthSpendCents += amountCents
      }
      if (dateKey >= currentMonthStart && dateKey <= todayStr) {
        metrics.currentMonthToDateSpendCents += amountCents
        metrics.txnCountCurrentMonth++
        metrics.txnAmounts.push(amountCents)
      }
      // Track spending within the current cycle window
      if (dateKey >= cycle.cycleStart && dateKey <= todayStr) {
        metrics.currentCycleSpendCents += amountCents
      }
    }

    // --- Canonical budget lock context (single overlap logic used across prompts) ---
    const budgetRows = budgetsResult.status === 'fulfilled' && !budgetsResult.value.error
      ? (budgetsResult.value.data || [])
      : []
    const budgetLocks = buildBudgetLockContext({
      budgets: budgetRows,
      windowStartISO: cycle.cycleStart,
      windowEndISO: cycle.cycleEnd,
      categoryNameById
    })
    const budgetedCategoryIds = budgetLocks.lockedCategoryIds
    const budgetedCategoryKeys = budgetLocks.lockedCategoryKeys

    console.log(
      `[ai-budget-intelligence] budget lock context: cycle=${cycle.cycleStart}..${cycle.cycleEnd}, totalBudgets=${budgetLocks.totalBudgets}, activeBudgets=${budgetLocks.activeBudgets.length}, overlappingBudgets=${budgetLocks.overlappingBudgets.length}, lockedIds=${budgetedCategoryIds.size}, lockedKeys=${budgetedCategoryKeys.size}`
    )
    console.log(
      `[ai-budget-intelligence] overlapping budgets sample: ${budgetLocks.overlappingBudgets.slice(0, 10).map((b: any) => summarizeBudgetForLog(b)).join(' || ')}`
    )

    // Filter out categories that should not be recommended
    const candidates: CategoryMetrics[] = []
    let excludedByBudgetId = 0
    let excludedByBudgetKey = 0
    for (const metrics of categoryMap.values()) {
      if (metrics.isFixedObligation) continue
      if (budgetedCategoryIds.has(metrics.categoryId)) {
        excludedByBudgetId++
        continue
      }
      const metricKeys = categoryLookupKeys(metrics.name)
      if (metricKeys.some((k) => budgetedCategoryKeys.has(k))) {
        excludedByBudgetKey++
        continue
      }
      if (metrics.lastMonthSpendCents === 0 && metrics.currentMonthToDateSpendCents === 0) continue
      candidates.push(metrics)
    }
    console.log(
      `[ai-budget-intelligence] candidate filtering: candidates=${candidates.length}, excludedByBudgetId=${excludedByBudgetId}, excludedByBudgetKey=${excludedByBudgetKey}`
    )

    // --- Scoring (Rule B: 60% last month + 40% projected) ---
    interface ScoredCategory extends CategoryMetrics {
      projectedCurrentMonthSpendCents: number
      score: number
      reasonTag: string
      reasonText: string
      suggestedCapCents: number
      // Signal scores for diversification
      trendingSignal: number
      leakageSignal: number
      impactSignal: number
    }

    const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const daysElapsed = today.getDate()

    // Calculate total discretionary spend for impact calculation
    const totalDiscretionarySpend = candidates.reduce((sum, c) => 
      sum + c.currentMonthToDateSpendCents, 0)

    const scored: ScoredCategory[] = candidates.map(metrics => {
      const projectedCurrentMonthSpendCents = daysElapsed > 0
        ? Math.round((metrics.currentMonthToDateSpendCents / daysElapsed) * daysInCurrentMonth)
        : metrics.currentMonthToDateSpendCents

      // ========================================================================
      // SIGNAL COMPUTATION for reason diversification
      // ========================================================================
      
      // 1) Trending signal: compare current vs last month equivalent window
      const lastMonthEquivalent = daysElapsed > 0 && metrics.lastMonthSpendCents > 0
        ? (metrics.lastMonthSpendCents / daysInCurrentMonth) * daysElapsed
        : metrics.lastMonthSpendCents
      
      const trendPct = lastMonthEquivalent > 0
        ? (metrics.currentMonthToDateSpendCents - lastMonthEquivalent) / Math.max(lastMonthEquivalent, 1)
        : 0
      const trendingSignal = trendPct
      
      // 2) Leakage signal: many small transactions
      const avgTxn = metrics.txnCountCurrentMonth > 0
        ? metrics.currentMonthToDateSpendCents / metrics.txnCountCurrentMonth
        : 0
      const leakageSignal = metrics.txnCountCurrentMonth >= 8 && avgTxn < 5000 && avgTxn > 0
        ? metrics.txnCountCurrentMonth / Math.max(avgTxn / 1000, 1) // Higher count + lower avg = higher leakage
        : metrics.txnCountCurrentMonth >= 10 ? metrics.txnCountCurrentMonth : 0
      
      // 3) High impact signal: share of discretionary spend
      const impactShare = totalDiscretionarySpend > 0
        ? metrics.currentMonthToDateSpendCents / Math.max(totalDiscretionarySpend, 1)
        : 0
      const impactSignal = impactShare

      // ========================================================================
      // ASSIGN PRIMARY REASON based on signal thresholds
      // ========================================================================
      
      let reasonTag = 'high_driver'
      let reasonText = 'Significant spending category'
      
      // Priority order: Trending > Leakage > High impact > default
      if (trendPct >= 0.20 && metrics.currentMonthToDateSpendCents > 5000) {
        reasonTag = 'trending_up'
        reasonText = 'Spending increasing vs last month'
      } else if (leakageSignal > 0 && (metrics.txnCountCurrentMonth >= 10 || (metrics.txnCountCurrentMonth >= 8 && avgTxn < 5000))) {
        reasonTag = 'leak'
        reasonText = 'Many small purchases adding up'
      } else if (impactShare >= 0.15) {
        reasonTag = 'high_impact'
        reasonText = 'Big part of your discretionary spend'
      } else {
        // Default to strongest signal
        const maxSignal = Math.max(trendingSignal, leakageSignal, impactSignal)
        if (maxSignal === trendingSignal && trendPct > 0.05) {
          reasonTag = 'trending_up'
          reasonText = 'Spending increasing vs last month'
        } else if (maxSignal === leakageSignal && leakageSignal > 0) {
          reasonTag = 'leak'
          reasonText = 'Many small purchases adding up'
        } else if (maxSignal === impactSignal && impactShare > 0.10) {
          reasonTag = 'high_impact'
          reasonText = 'Big part of your discretionary spend'
        }
      }

      const base = (metrics.lastMonthSpendCents * 0.6) + (projectedCurrentMonthSpendCents * 0.4)
      let score = base
      // Boost score based on signals
      if (reasonTag === 'leak') score += 10000
      if (reasonTag === 'trending_up') score += 5000
      if (reasonTag === 'high_impact') score += 3000

      // Raw cap: 85% of reference spend (unclamped â€” we clamp after computing discretionary)
      const projected = projectedCurrentMonthSpendCents
      const lastMonthSpend = metrics.lastMonthSpendCents
      const referenceSpend = (projected > 0 && lastMonthSpend > 0)
        ? Math.min(projected, lastMonthSpend)
        : Math.max(projected, lastMonthSpend)

      const suggestedCapCents = Math.max(0, Math.round(referenceSpend * 0.85))

      return {
        ...metrics,
        projectedCurrentMonthSpendCents,
        score,
        reasonTag,
        reasonText,
        suggestedCapCents,
        trendingSignal,
        leakageSignal,
        impactSignal
      }
    })

    // ========================================================================
    // DIVERSITY RULE: Select up to 3 categories with diverse reasons
    // ========================================================================
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score)
    
    const topCategories: ScoredCategory[] = []
    const usedReasons = new Set<string>()
    
    // First pass: pick best of each reason type (max 1 per type)
    for (const reason of ['trending_up', 'leak', 'high_impact']) {
      const candidate = scored.find(c => 
        c.reasonTag === reason && 
        !topCategories.includes(c)
      )
      if (candidate && topCategories.length < 3) {
        topCategories.push(candidate)
        usedReasons.add(reason)
      }
    }
    
    // Second pass: fill remaining slots with highest scored categories
    // Allow repeating reasons but prefer diversity
    for (const cat of scored) {
      if (topCategories.length >= 3) break
      if (topCategories.includes(cat)) continue
      
      // Prefer categories with unused reasons, but allow repeats if needed
      if (!usedReasons.has(cat.reasonTag) || topCategories.length < 3) {
        topCategories.push(cat)
        usedReasons.add(cat.reasonTag)
      }
    }
    
    // If still need more, add any remaining high-scored categories
    for (const cat of scored) {
      if (topCategories.length >= 3) break
      if (!topCategories.includes(cat)) {
        topCategories.push(cat)
      }
    }
    
    console.log(`Selected categories with reasons: ${topCategories.map(c => `${c.name}(${c.reasonTag})`).join(', ')}`)

    // ========================================================================
    // PRO-RATING FOR CURRENT CYCLE (BEFORE CLAMPING)
    // ========================================================================
    
    // Compute total days in cycle
    const cycleStart = new Date(cycle.cycleStart)
    const cycleEnd = new Date(cycle.cycleEnd)
    const totalDaysInCycle = Math.round((cycleEnd.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24)) + 1
    
    // For current cycle only, pro-rate raw caps based on remaining days BEFORE clamping
    if (cycleType === 'current' && cycle.daysRemaining > 0) {
      const prorateRatio = cycle.daysRemaining / totalDaysInCycle
      topCategories.forEach(cat => {
        cat.suggestedCapCents = Math.round(cat.suggestedCapCents * prorateRatio)
      })
      console.log(`Pro-rated raw caps (current cycle): ${cycle.daysRemaining}/${totalDaysInCycle} days, ratio=${prorateRatio.toFixed(2)}`)
    }

    // ========================================================================
    // BUDGET RESERVES (exclude recommended categories)
    // ========================================================================

    const recommendedCategoryIds = new Set(topCategories.map(c => c.categoryId))

    // Budgets that overlap the cycle window AND are NOT in the recommended set
    const budgetReservedCents = budgetLocks.overlappingBudgets
      .filter((b: any) => {
        if (recommendedCategoryIds.has(b.category_id)) return false
        return true
      })
      .reduce((sum: number, b: any) => {
        const v = Number(b.amount_cents)
        return sum + (Number.isFinite(v) ? v : 0)
      }, 0)

    console.log(`Budget reserved: ${budgetReservedCents} cents (excluded ${recommendedCategoryIds.size} recommended categories)`)

    // ========================================================================
    // NEXT-MONTH: INCOME ESTIMATION (only when cycleType === 'next')
    // ========================================================================

    let effectiveBalanceCents = spendableBalanceCents
    let expectedIncomeCents = 0
    let last3NonZeroCyclesCount = 0
    let envelopeSource = 'cash_current_cycle'

    if (cycleType === 'next') {
      const incomeRows = incomesResult.status === 'fulfilled' && !incomesResult.value.error
        ? (incomesResult.value.data || []) : []

      // Prefer recurring incomes whose expected_date falls within next cycle window
      const incomesInWindow = incomeRows.filter((inc: any) => {
        if (!inc.is_recurring) return false
        const ed = inc.expected_date
        if (ed && ed >= cycle.cycleStart && ed <= cycle.cycleEnd) return true
        return false
      })

      expectedIncomeCents = sumAmountCents(incomesInWindow)

      // Fallback 1: all recurring incomes (not scoped to window)
      if (expectedIncomeCents === 0) {
        const allRecurring = incomeRows.filter((inc: any) => inc.is_recurring)
        expectedIncomeCents = sumAmountCents(allRecurring)
      }

      // Fallback 2: average of last 3 completed budget cycles
      // Only counts: (A) income-category transactions OR (B) Opening Balance notes
      if (expectedIncomeCents === 0) {
        const prevWindows = getPreviousCycleWindows(y, m, d, cycleStartDay, 3)

        // Single query spanning all 3 cycle windows
        const earliestStart = prevWindows[prevWindows.length - 1].start
        const latestEnd = prevWindows[0].end

        // Explicit FK join: fk_wallet_transactions_category_id -> categories.id
        // EXCLUDE "Opening Balance" category from recurring income estimation
        let incomeTxns: any[] | null = null
        let joinWorked = true
        {
          const { data, error } = await supabaseClient
            .from('wallet_transactions')
            .select('wallet_id, amount, reporting_amount, reporting_currency, note, date, category, category_id, is_opening_balance, is_manual_topup, categories!fk_wallet_transactions_category_id(is_income, name)')
            .eq('user_id', userId)
            .gt('amount', 0)
            .gte('date', earliestStart)
            .lte('date', latestEnd)

          if (error) {
            console.warn('Income category join failed, using fallback logic:', error.message)
            joinWorked = false
            // Retry without the join
            const { data: fallbackData } = await supabaseClient
              .from('wallet_transactions')
              .select('wallet_id, amount, reporting_amount, reporting_currency, note, date, category, is_opening_balance, is_manual_topup')
              .eq('user_id', userId)
              .gt('amount', 0)
              .gte('date', earliestStart)
              .lte('date', latestEnd)
            incomeTxns = fallbackData || []
          } else {
            incomeTxns = data || []
          }
        }

        if (incomeTxns && incomeTxns.length > 0) {
          const normalizedIncome = await normalizeTransactionsToMainCurrency(
            supabaseClient,
            userId,
            primaryCurrency,
            incomeTxns as Array<Record<string, unknown>>,
          )
          incomeTxns = normalizedIncome.rows as any[]
          console.log(
            `[ai-budget-intelligence] income currency normalization: normalized=${normalizedIncome.metrics.normalized_rows_used}, fx=${normalizedIncome.metrics.temporary_converted_rows_used}, same=${normalizedIncome.metrics.raw_same_currency_rows_used}, missing=${normalizedIncome.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalizedIncome.metrics.fx_lookup_failures}`
          )

          // Sum qualifying income per cycle window
          const cycleIncomeCents: number[] = prevWindows.map(w => {
            return (incomeTxns as any[])
              .filter((t: any) => {
                const d = toDateKey(t.date)
                return d >= w.start && d <= w.end
              })
              .reduce((sum: number, t: any) => {
                const isIncomeCategory =
                  (joinWorked && (t as any).categories?.is_income === true) ||
                  isIncomeCategoryText((t as any).categories?.name) ||
                  isIncomeCategoryText((t as any).category)
                const categoryName = joinWorked ? (t as any).categories?.name : null
                const isOpeningBalanceFlag = (t as any).is_opening_balance === true
                const isManualTopup = (t as any).is_manual_topup === true
                
                // EXCLUDE from recurring income:
                // - Opening Balance category (one-time wallet setup)
                // - is_opening_balance flag (explicit opening balance)
                // - is_manual_topup flag (manual "add money" actions)
                if (categoryName === 'Opening Balance') return sum
                if (isOpeningBalanceFlag) return sum
                if (isManualTopup) return sum
                
                // Include only income-category transactions
                if (!isIncomeCategory) return sum
                
                // wallet_transactions.amount is numeric(12,2) dollars - convert to cents
                return sum + Math.max(0, dollarsToCents((t as any).amount))
              }, 0)
          })

          // Average over cycles that have at least some income
          const nonZeroCycles = cycleIncomeCents.filter(c => c > 0)
          if (nonZeroCycles.length > 0) {
            const total = nonZeroCycles.reduce((s: number, c: number) => s + c, 0)
            expectedIncomeCents = Math.round(total / nonZeroCycles.length)
            
            // Store nonZeroCycles count for reliability check later
            last3NonZeroCyclesCount = nonZeroCycles.length
            
            // Count income transactions (excluding Opening Balance and manual topups)
            const countIncomeTxns = (incomeTxns as any[]).filter((t: any) => {
              const isIncomeCategory =
                (joinWorked && (t as any).categories?.is_income === true) ||
                isIncomeCategoryText((t as any).categories?.name) ||
                isIncomeCategoryText((t as any).category)
              const categoryName = joinWorked ? (t as any).categories?.name : null
              const isOpeningBalanceFlag = (t as any).is_opening_balance === true
              const isManualTopup = (t as any).is_manual_topup === true
              return isIncomeCategory && categoryName !== 'Opening Balance' && !isOpeningBalanceFlag && !isManualTopup
            }).length
            
            const countOpeningBalanceFlagged = (incomeTxns as any[]).filter((t: any) => 
              (t as any).is_opening_balance === true
            ).length
            
            const countManualTopups = (incomeTxns as any[]).filter((t: any) => 
              (t as any).is_manual_topup === true
            ).length
            
            const perCycleDollars = cycleIncomeCents.map(c => (c / 100).toFixed(2))
            
            console.log(`Income fallback (txn_avg_last_3_cycles): ${nonZeroCycles.length} cycles, avg=${expectedIncomeCents} cents ($${(expectedIncomeCents/100).toFixed(2)}), perCycle=[$${perCycleDollars.join(', $')}], countIncomeTxns=${countIncomeTxns}, countOpeningBalanceFlagged=${countOpeningBalanceFlagged}, countManualTopups=${countManualTopups}`)
          }
        }
      }

      // Fallback 3: can't estimate - ask user (plain message, Android-safe)
      if (expectedIncomeCents === 0) {
        const response: MessageResponse = {
          ok: true,
          message: 'I don\'t have enough income data to plan next month\'s budget. What\'s your expected monthly income? (e.g., "3000")'
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: CORS_HEADERS
        })
      }

      // Determine income source for logging
      let incomeSourceUsed = 'none'
      if (expectedIncomeCents > 0) {
        // Check which path was used (reverse order of fallbacks)
        const incomesInWindow = incomeRows.filter((inc: any) => {
          if (!inc.is_recurring) return false
          const ed = inc.expected_date
          if (ed && ed >= cycle.cycleStart && ed <= cycle.cycleEnd) return true
          return false
        })
        if (incomesInWindow.length > 0) {
          incomeSourceUsed = 'incomes_table'
        } else {
          const allRecurring = incomeRows.filter((inc: any) => inc.is_recurring)
          if (allRecurring.length > 0) {
            incomeSourceUsed = 'incomes_table'
          } else {
            incomeSourceUsed = 'txn_avg_last_3_cycles'
          }
        }
      }

      console.log(`Next-month expected income: ${expectedIncomeCents} cents ($${(expectedIncomeCents / 100).toFixed(2)}), source=${incomeSourceUsed}`)
      
      // ====================================================================
      // ENVELOPE SELECTION: Income-based vs Cash-based
      // ====================================================================
      // Extract nonZeroCycles count for reliability check
      const nonZeroCyclesCount = last3NonZeroCyclesCount
      
      // Income reliability check: use cash fallback if income is unreliable
      const incomeUnreliable = (
        expectedIncomeCents <= 0 ||
        incomeSourceUsed === 'none' ||
        (incomeSourceUsed === 'txn_avg_last_3_cycles' && nonZeroCyclesCount < 1)
      )
      
      if (incomeUnreliable) {
        effectiveBalanceCents = spendableBalanceCents
        envelopeSource = 'cash_fallback_income_unreliable'
      } else {
        effectiveBalanceCents = expectedIncomeCents
        envelopeSource = 'income_next_cycle'
      }
    } else {
      // Current cycle: always use cash-based envelope
      envelopeSource = 'cash_current_cycle'
    }
    
    // Log envelope summary
    console.log(`Envelope summary: source=${envelopeSource}, base=$${(effectiveBalanceCents/100).toFixed(2)}, spendable=$${(spendableBalanceCents/100).toFixed(2)}, expectedIncome=$${(expectedIncomeCents/100).toFixed(2)}`)

    // ========================================================================
    // DISCRETIONARY CEILING + SAFETY BUFFER
    // ========================================================================

    const safetyBufferCents = Math.min(Math.round(effectiveBalanceCents * 0.10), 5000)

    let availableDiscretionaryCents = Math.max(
      0,
      effectiveBalanceCents - fixedRemainingThisCycle - budgetReservedCents - safetyBufferCents
    )

    console.log(`Discretionary: balance=${effectiveBalanceCents}, obligations=${fixedRemainingThisCycle}, reserved=${budgetReservedCents}, buffer=${safetyBufferCents}, available=${availableDiscretionaryCents}`)

    // --- Over-extended warning ---
    if (availableDiscretionaryCents === 0) {
      const response: BudgetWarningResponse = {
        ok: true,
        warning: {
          type: 'budget_warning',
          warningCode: 'over_extended',
          message: 'Your upcoming obligations and existing budgets already exceed your available balance. I can\'t recommend new budget caps right now without risking overspending. Consider reviewing your existing budgets or obligations first.',
          metadata: {
            cycleType,
            daysRemaining: cycle.daysRemaining,
            availableDiscretionaryCents: 0,
            safetyBufferCents,
            spendableBalanceCents: effectiveBalanceCents,
            fixedObligationsCents: fixedRemainingThisCycle,
            budgetReservedCents,
            currencyCode: primaryCurrency,
            currencyWarning: currencyWarning || undefined
          }
        }
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: CORS_HEADERS
      })
    }

    // ========================================================================
    // CAP ALLOCATION WITH GUARDRAILS
    // ========================================================================

    // Per-category ceiling: 100% for 1 category, 80% for 2+
    const perCategoryCeilingCents = topCategories.length === 1
      ? availableDiscretionaryCents
      : Math.floor(availableDiscretionaryCents * 0.8)

    // Clamp raw caps
    const clampedCategories = topCategories.map(cat => {
      let cap = Math.min(cat.suggestedCapCents, perCategoryCeilingCents)
      // Do NOT use alreadySpent as a floor â€” these are "remaining rest-of-cycle" caps
      // alreadySpent is included as context only
      return { ...cat, suggestedCapCents: cap }
    })

    // Round to nearest $10 (1000 cents), but never $0 if raw > 0
    const roundedCategories = clampedCategories.map(cat => {
      let rounded = Math.round(cat.suggestedCapCents / 1000) * 1000
      if (cat.suggestedCapCents > 0 && rounded === 0) rounded = 1000
      return { ...cat, suggestedCapCents: rounded }
    })

    // --- Post-rounding enforcement: sum(caps) <= availableDiscretionaryCents ---
    let totalCaps = roundedCategories.reduce((s, c) => s + c.suggestedCapCents, 0)

    if (totalCaps > availableDiscretionaryCents && totalCaps > 0) {
      const scaleFactor = availableDiscretionaryCents / totalCaps
      for (const cat of roundedCategories) {
        cat.suggestedCapCents = Math.max(0, Math.round((cat.suggestedCapCents * scaleFactor) / 1000) * 1000)
      }
      // Recalculate after scaling
      totalCaps = roundedCategories.reduce((s, c) => s + c.suggestedCapCents, 0)
      // If still slightly over due to rounding, shave from the largest
      if (totalCaps > availableDiscretionaryCents) {
        roundedCategories.sort((a, b) => b.suggestedCapCents - a.suggestedCapCents)
        roundedCategories[0].suggestedCapCents -= (totalCaps - availableDiscretionaryCents)
        if (roundedCategories[0].suggestedCapCents < 0) roundedCategories[0].suggestedCapCents = 0
      }
      // Re-sort by score
      roundedCategories.sort((a, b) => b.score - a.score)
    }

    // ========================================================================
    // MINIMUM CAP ENFORCEMENT: Prevent $0.00 suggestions when discretionary > 0
    // ========================================================================
    
    // If all caps are zero but we have discretionary, give it all to top 1 category
    const allCapsZero = roundedCategories.every(c => c.suggestedCapCents === 0)
    
    if (availableDiscretionaryCents > 0 && allCapsZero && roundedCategories.length > 0) {
      // Reduce to 1 recommendation with all discretionary
      const topCategory = roundedCategories[0]
      roundedCategories.length = 0
      roundedCategories.push({
        ...topCategory,
        suggestedCapCents: availableDiscretionaryCents
      })
      console.log(`All caps were $0, reduced to 1 category with full discretionary: ${topCategory.name}=$${(availableDiscretionaryCents/100).toFixed(2)}`)
    }
    
    // Ensure minimum $10 cap for any selected category (after rounding)
    roundedCategories.forEach(cat => {
      if (cat.suggestedCapCents > 0 && cat.suggestedCapCents < 1000) {
        cat.suggestedCapCents = 1000 // minimum $10
      }
    })
    
    const totalCapsCents = roundedCategories.reduce((sum, c) => sum + c.suggestedCapCents, 0)
    console.log(`Final caps: ${roundedCategories.map(c => `${c.name}=$${(c.suggestedCapCents/100).toFixed(2)}`).join(', ')}, total=$${(totalCapsCents/100).toFixed(2)}, discretionary=$${(availableDiscretionaryCents/100).toFixed(2)}`)

    // ========================================================================
    // BUILD RESPONSE
    // ========================================================================

    const recommendedCategories: RecommendedCategory[] = roundedCategories.map(cat => ({
      categoryId: cat.categoryId,
      categoryKey: normalizeCategoryKey(cat.name),
      title: cat.name,
      suggestedCapCents: cat.suggestedCapCents,
      reasonTag: cat.reasonTag,
      reasonText: cat.reasonText,
      lastMonthSpendCents: cat.lastMonthSpendCents,
      currentMonthToDateSpendCents: cat.currentMonthToDateSpendCents,
      alreadySpentThisCycleCents: cat.currentCycleSpendCents
    }))

    const actions: BudgetAction[] = [
      ...roundedCategories.map(cat => ({
        id: 'toggle_category',
        title: cat.name,
        categoryId: cat.categoryId,
        categoryKey: normalizeCategoryKey(cat.name)
      })),
      { id: 'add_other', title: 'Add other' },
      { id: 'continue', title: 'Continue' }
    ]

    const metadata: BudgetMetadata = {
      cycleType,
      daysRemaining: cycle.daysRemaining,
      availableDiscretionaryCents,
      safetyBufferCents,
      spendableBalanceCents: effectiveBalanceCents,
      fixedObligationsCents: fixedRemainingThisCycle,
      budgetReservedCents,
      currencyCode: primaryCurrency,
      ...(currencyWarning ? { currencyWarning } : {}),
      ...(cycleType === 'current' && cycle.daysRemaining <= 7 ? { suggestNextCycle: true } : {})
    }

    const response: BudgetRecommendationsResponse = {
      ok: true,
      recommendations: {
        type: 'budget_category_recommendations',
        recommendationId: `budget_rec_${Date.now()}`,
        timeframeLabel: cycleType === 'current'
          ? `Rest of cycle: ${cycle.daysRemaining} days remaining`
          : `Next cycle: ${cycle.cycleStart} to ${cycle.cycleEnd}`,
        recommendedCategories,
        actions,
        metadata
      }
    }

    console.log(`Budget recommendations: ${recommendedCategories.length} categories, totalCaps=${roundedCategories.reduce((s, c) => s + c.suggestedCapCents, 0)}, discretionary=${availableDiscretionaryCents}`)

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: CORS_HEADERS
    })

  } catch (error) {
    console.error('Budget intelligence error:', error)
    return new Response(JSON.stringify({ error: (error as Error).message || 'Internal server error' }), {
      status: 500,
      headers: CORS_HEADERS
    })
  }
})
