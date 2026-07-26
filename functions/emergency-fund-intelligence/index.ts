import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import {
  normalizeTransactionsToMainCurrency,
  normalizeWalletBalancesToMainCurrency,
  resolveMainCurrencyCode,
} from '../_shared/currencyReporting.ts'
import { allocateCappedCuts, computeNormalizationFactor } from '../_shared/planner-core.ts'
import type { EligibleCategory } from '../_shared/planner-types.ts'

/**
 * Emergency Fund Intelligence - Phase 4.1
 * 
 * Computes emergency fund status:
 * - Balance from EMERGENCY wallets
 * - Essential monthly expenses (from cash flow fixed expenses)
 * - Runway calculation (months covered)
 * - Gap to user's goal (3/6/12 months)
 * 
 * Evidence-first: Returns partial results if data is missing.
 */

// Timing helper
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function normalizeDateKey(value: unknown, fallbackDate: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const parsed = new Date(text)
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  return fallbackDate
}

function readObligationSourceCurrency(row: any): string | null {
  const candidates = [
    row?.currency_code,
    row?.currency,
    row?.source_currency,
    row?.iso_currency_code,
    row?.unofficial_currency_code,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const code = candidate.trim().toUpperCase()
    if (/^[A-Z]{3}$/.test(code)) return code
  }

  // Older local rows were created before per-obligation currency fields.
  // If no wallet can supply currency, treat those legacy obligation cents as USD
  // instead of labelling the raw number as the selected main currency.
  const walletId = typeof row?.wallet_id === 'string' ? row.wallet_id.trim() : ''
  return walletId ? null : 'USD'
}

type ObligationNormalizeInput = {
  amountCents: number
  walletId: string | null
  sourceCurrency: string | null
  dateKey: string
}

type ObligationNormalizeMetrics = {
  normalized_rows_used: number
  temporary_converted_rows_used: number
  raw_same_currency_rows_used: number
  rows_with_missing_reporting_fields: number
  fx_lookup_failures: number
}

type ObligationNormalizePrepared = ObligationNormalizeInput & {
  rowIndex: number
}

type ObligationNormalizeResult = {
  normalizedAmountCentsByIndex: Map<number, number>
  preparedByIndex: Map<number, ObligationNormalizePrepared>
  excludedRowCount: number
  metrics: ObligationNormalizeMetrics
}

async function normalizeObligationAmountsToMainCurrency(
  supabase: any,
  userId: string,
  mainCurrency: string,
  rows: ObligationNormalizeInput[],
): Promise<ObligationNormalizeResult> {
  const preparedByIndex = new Map<number, ObligationNormalizePrepared>()
  const prepared: ObligationNormalizePrepared[] = []

  rows.forEach((row, rowIndex) => {
    const amountCents = Math.max(0, Math.round(asNumber(row?.amountCents)))
    if (!(amountCents > 0)) return

    const walletId = typeof row?.walletId === 'string' ? row.walletId.trim() : ''
    const sourceCurrency = typeof row?.sourceCurrency === 'string' ? row.sourceCurrency.trim().toUpperCase() : ''
    const preparedRow: ObligationNormalizePrepared = {
      rowIndex,
      amountCents,
      walletId: walletId || null,
      sourceCurrency: sourceCurrency || null,
      dateKey: normalizeDateKey(row?.dateKey, new Date().toISOString().slice(0, 10)),
    }
    prepared.push(preparedRow)
    preparedByIndex.set(rowIndex, preparedRow)
  })

  if (prepared.length === 0) {
    return {
      normalizedAmountCentsByIndex: new Map<number, number>(),
      preparedByIndex,
      excludedRowCount: 0,
      metrics: {
        normalized_rows_used: 0,
        temporary_converted_rows_used: 0,
        raw_same_currency_rows_used: 0,
        rows_with_missing_reporting_fields: 0,
        fx_lookup_failures: 0,
      },
    }
  }

  const syntheticRows = prepared.map((row) => ({
    row_index: row.rowIndex,
    wallet_id: row.walletId,
    amount: row.amountCents / 100,
    reporting_amount: null,
    reporting_currency: null,
    source_currency: row.sourceCurrency,
    date: row.dateKey,
  }))

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrency,
    syntheticRows,
  )

  const normalizedAmountCentsByIndex = new Map<number, number>()
  for (const row of normalized.rows || []) {
    const rowIndex = Math.round(asNumber((row as any)?.row_index))
    if (!(rowIndex >= 0)) continue
    const amount = asNumber((row as any)?.amount)
    if (!(amount >= 0)) continue
    normalizedAmountCentsByIndex.set(rowIndex, Math.max(0, Math.round(amount * 100)))
  }

  let excludedRowCount = 0
  for (const preparedRow of prepared) {
    if (normalizedAmountCentsByIndex.has(preparedRow.rowIndex)) continue
    if (!preparedRow.walletId && preparedRow.sourceCurrency === mainCurrency) {
      // Same-currency legacy rows are safe to keep raw.
      normalizedAmountCentsByIndex.set(preparedRow.rowIndex, preparedRow.amountCents)
      continue
    }
    excludedRowCount += 1
  }

  return {
    normalizedAmountCentsByIndex,
    preparedByIndex,
    excludedRowCount,
    metrics: normalized.metrics,
  }
}

type ExpenseTierState = 'essential' | 'flexible_essential' | 'discretionary' | 'unknown'

function formatCurrency(amount: number, currencyCode: string, fractionDigits = 0): string {
  if (!Number.isFinite(amount)) return '0'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount)
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currencyCode}`
  }
}

function clampCycleStartDay(value: unknown): number {
  const n = Math.floor(asNumber(value))
  if (n < 1) return 1
  if (n > 31) return 31
  return n
}

function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function buildCycleAnchorUtc(year: number, month: number, cycleStartDay: number): Date {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const safeDay = Math.min(clampCycleStartDay(cycleStartDay), daysInMonth)
  return startOfDayUtc(new Date(Date.UTC(year, month, safeDay)))
}

function computeCycleWindowUtc(
  now: Date,
  cycleStartDay: number,
): { start: Date; endExclusive: Date; daysRemaining: number } {
  const startDay = clampCycleStartDay(cycleStartDay)
  const today = startOfDayUtc(now)
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const thisMonthAnchor = buildCycleAnchorUtc(y, m, startDay)
  const start = today.getTime() >= thisMonthAnchor.getTime()
    ? thisMonthAnchor
    : buildCycleAnchorUtc(y, m - 1, startDay)

  const endExclusive = buildCycleAnchorUtc(start.getUTCFullYear(), start.getUTCMonth() + 1, startDay)
  const ms = endExclusive.getTime() - today.getTime()
  const daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
  return { start, endExclusive, daysRemaining }
}

function getPreviousCycleWindowUtc(
  currentWindow: { start: Date },
  cycleStartDay: number,
): { start: Date; endExclusive: Date } {
  const currentStart = currentWindow.start
  return {
    start: buildCycleAnchorUtc(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - 1, cycleStartDay),
    endExclusive: currentStart,
  }
}

function isExcludedTxForCashFlow(tx: any): boolean {
  if (!tx) return true

  // Explicit flags that should never influence analysis
  if (tx.is_opening_balance === true) return true
  if (tx.is_manual_topup === true) return true

  const categoryRaw = typeof tx.category === 'string' ? tx.category : ''
  const category = categoryRaw.toLowerCase()

  // Transfers should never be treated as expenses/income
  if (TRANSFER_CATEGORIES.some((t) => category.includes(t))) return true

  // "Opening Balance" and "Owner Contribution" are not real recurring income/expenses
  if (category.includes('opening balance')) return true
  if (category.includes('owner contribution')) return true

  return false
}

function getRelatedCategoryRecord(tx: any): any | null {
  const rel = tx?.categories
  if (rel && typeof rel === 'object' && !Array.isArray(rel)) return rel
  if (Array.isArray(rel)) {
    const firstRecord = rel.find((entry) => entry && typeof entry === 'object')
    return firstRecord || null
  }
  return null
}

function getExpenseTierStateFromCategoryMeta(category: any): ExpenseTierState {
  if (!category || typeof category !== 'object') return 'unknown'
  if (category.is_fixed_obligation === true) return 'essential'

  const tier = String(category.expense_tier || '').trim().toLowerCase()
  if (!tier) return 'unknown'
  if (tier === 'essential') return 'essential'
  if (tier === 'flexible_essential') return 'flexible_essential'
  if (tier === 'discretionary' || tier === 'non_essential') return 'discretionary'
  return 'unknown'
}

function isTransactionEssentialByMetadata(tx: any): boolean {
  const related = getRelatedCategoryRecord(tx)
  return getExpenseTierStateFromCategoryMeta(related) === 'essential'
}

function mergeExpenseTierState(current: ExpenseTierState, incoming: ExpenseTierState): ExpenseTierState {
  const priority: Record<ExpenseTierState, number> = {
    essential: 4,
    flexible_essential: 3,
    discretionary: 2,
    unknown: 1,
  }
  return priority[incoming] > priority[current] ? incoming : current
}

interface FixedExpenseItem {
  name: string
  amount: number
  category: string
  source: 'subscription' | 'bill' | 'debt' | 'planned_payment'
}

function analyzeFixedExpenses(
  subscriptions: any[],
  bills: any[],
  debts: any[],
  plannedPayments: any[],
): { total: number; items: FixedExpenseItem[] } {
  const items: FixedExpenseItem[] = []

  const getAmountInMainCurrency = (row: any, fallbackCentsKey: string): number => {
    const normalizedRaw = (row as any)?.normalized_amount_main_currency_cents
    if (normalizedRaw !== null && normalizedRaw !== undefined) {
      const normalizedCents = asNumber(normalizedRaw)
      return normalizedCents / 100
    }
    if ((row as any)?.normalization_excluded === true) return 0
    return asNumber(row?.[fallbackCentsKey]) / 100
  }

  const toMonthlyAmount = (amount: number, frequency: unknown): number => {
    const f = (typeof frequency === 'string' ? frequency : '').toUpperCase().trim()
    if (!f || f === 'MONTHLY') return amount
    if (f === 'WEEKLY') return amount * 4.33
    if (f === 'BIWEEKLY') return amount * 2.165
    if (f === 'YEARLY' || f === 'ANNUALLY' || f === 'ANNUAL') return amount / 12
    if (f === 'QUARTERLY') return amount / 3
    return amount
  }

  // 1) Active subscriptions
  subscriptions.forEach((sub) => {
    const amount = getAmountInMainCurrency(sub, 'amount_cents')
    if (amount > 0) {
      let monthlyAmount = amount
      if (sub.billing_cycle === 'YEARLY') {
        monthlyAmount = amount / 12
      } else if (sub.billing_cycle === 'WEEKLY') {
        monthlyAmount = amount * 4.33
      }

      items.push({
        name: sub.name || 'Subscription',
        amount: monthlyAmount,
        category: sub.category || 'Subscription',
        source: 'subscription',
      })
    }
  })

  // 2) Active bills
  bills.forEach((bill) => {
    // Only recurring bills count toward monthly essentials.
    // One-off unpaid bills can dramatically inflate the monthly estimate.
    if (bill?.is_recurring !== true) return

    const amount = getAmountInMainCurrency(bill, 'amount_cents')
    if (amount > 0) {
      const monthlyAmount = toMonthlyAmount(amount, bill.recurring_frequency)
      items.push({
        name: bill.name || 'Bill',
        amount: monthlyAmount,
        category: bill.category || 'Bill',
        source: 'bill',
      })
    }
  })

  // 3) Debt minimum payments
  debts.forEach((debt) => {
    const minPayment = getAmountInMainCurrency(debt, 'minimum_payment_cents')
    if (minPayment > 0) {
      items.push({
        name: debt.name || 'Debt Payment',
        amount: minPayment,
        category: 'Debt Payment',
        source: 'debt',
      })
    }
  })

  // 4) Planned payments (if recurring)
  plannedPayments.forEach((payment) => {
    if (payment?.is_recurring) {
      const amount = getAmountInMainCurrency(payment, 'amount_cents')
      if (amount > 0) {
        items.push({
          name: payment.name || 'Planned Payment',
          amount,
          category: payment.category || 'Payment',
          source: 'planned_payment',
        })
      }
    }
  })

  const total = items.reduce((sum, item) => sum + item.amount, 0)
  return { total, items }
}

function analyzeVariableExpenses(
  transactions: any[],
  fixedItems: FixedExpenseItem[],
  windowStart: Date,
  windowEnd: Date,
): { total: number; categories: Record<string, number>; categoryStates: Record<string, ExpenseTierState> } {
  const fixedCategories = new Set(fixedItems.map((item) => (item.category || '').toLowerCase()))

  const variableTransactions = transactions.filter((t) => {
    if (isExcludedTxForCashFlow(t)) return false
    if (asNumber(t.amount) >= 0) return false

    const txDate = new Date(t.date)
    if (txDate < windowStart || txDate >= windowEnd) return false

    const category = (t.category || '').toLowerCase()
    if (fixedCategories.has(category)) return false

    return true
  })

  const categories: Record<string, number> = {}
  const categoryStates: Record<string, ExpenseTierState> = {}
  variableTransactions.forEach((t) => {
    const category = t.category || 'Other'
    const amount = Math.abs(asNumber(t.amount))
    categories[category] = (categories[category] || 0) + amount

    const incomingState = getExpenseTierStateFromCategoryMeta(getRelatedCategoryRecord(t))
    const currentState = categoryStates[category] || 'unknown'
    categoryStates[category] = mergeExpenseTierState(currentState, incomingState)
  })

  const total = Object.values(categories).reduce((sum, amount) => sum + amount, 0)
  return { total, categories, categoryStates }
}

// Income categories (for detecting income transactions)
const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Income', 'Wages', 'Bonus']
const INCOME_CATEGORIES_NORMALIZED = new Set(INCOME_CATEGORIES.map(c => c.trim().toLowerCase()))
const INCOME_KEYWORDS = ['salary', 'freelance', 'wages', 'bonus', 'income']

function isIncomeCategory(category: unknown): boolean {
  if (typeof category !== 'string') return false
  const normalized = category.trim().toLowerCase()
  if (INCOME_CATEGORIES_NORMALIZED.has(normalized)) return true
  return INCOME_KEYWORDS.some(k => normalized.includes(k))
}

function isIncomeTransaction(tx: any): boolean {
  const catRel = tx?.categories
  const isIncomeFlag =
    (catRel && typeof catRel === 'object' && !Array.isArray(catRel) && catRel.is_income === true) ||
    (Array.isArray(catRel) && catRel.some(c => c?.is_income === true))

  if (isIncomeFlag) return true
  return isIncomeCategory(tx?.category)
}

// Transfer-like categories to exclude
const TRANSFER_CATEGORIES = ['transfer', 'internal-transfer', 'wallet-transfer', 'money-transfer']

interface EmergencyFundResponse {
  type: 'emergency_fund'
  status: 'on_track' | 'building' | 'needs_attention' | 'no_fund'
  currencyCode: string
  
  // Balance from EMERGENCY wallets
  balance: number
  hasEmergencyWallet: boolean
  emergencyWalletCount: number
  
  // Essential expenses (monthly)
  monthlyEssentials: number | null
  essentialsBreakdown: Array<{ name: string; amount: number; category: string }> | null
  
  // Runway
  runwayMonths: number | null
  runwayFormatted: string | null  // e.g., "2.4 months"
  
  // Goal tracking
  goalMonths: number  // User's target (3, 6, or 12)
  goalAmount: number | null  // monthlyEssentials * goalMonths
  progressPercent: number | null
  gapToGoal: number | null
  gapFormatted: string | null  // e.g., "$1,288 more to reach 6 months"
  cutMode: 'needed_to_hit_target' | 'optional_buffer'
  
  // Savings tips (Phase 4.4 - optional, returned when requested)
  savingsTips: Array<{
    emoji: string
    category: string
    currentSpend: number
    suggestedSavings: number
    monthlyImpact: number
  }> | null
  
  // Impact preview (Phase 4.4 - optional)
  impactPreview: {
    monthlySavings: number
    targetDate: string
    monthsToGoal: number
  } | null
  
  // Data quality
  hasEnoughData: boolean
  missingData: string[]
  clarifyingQuestion: string | null
  
  // Input from dialog
  requestedGoalMonths: number | null
  requestedMonthlyContribution: number | null
}

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
    const body = await req.json()
    const { 
      goalMonths = 6,  // Default to 6 months if not specified
      monthlyContribution = null,  // Optional: user's planned monthly savings
      includeTips = false  // Whether to include savings tips (Phase 4.4)
    } = body
    
    // Get auth header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabaseClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } }
    })

    // Get user
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const userId = user.id
    console.log(`🚨 Emergency Fund Intelligence for user ${userId.substring(0, 8)}... (goal: ${goalMonths} months)`)

    // Fetch all required data
    const data = await fetchEmergencyFundData(supabaseClient, userId)
    
    // Calculate emergency fund status
    const response = calculateEmergencyFundStatus(data, goalMonths, monthlyContribution, includeTips)

    return new Response(JSON.stringify({
      success: true,
      ...response,
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })

  } catch (error) {
    console.error('❌ Emergency Fund Intelligence error:', error)
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal server error'
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
})

/**
 * Fetch all data needed for emergency fund calculation
 */
async function fetchEmergencyFundData(supabase: any, userId: string) {
  const startTime = nowMs()

  // Fetch 60 days of transactions for expense analysis
  const sixtyDaysAgo = new Date()
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

  const [
    walletsRes,
    txRes,
    subsRes,
    billsRes,
    debtsRes,
    plannedPaymentsRes,
    incomesRes,
    prefsRes,
  ] = await Promise.all([
    // All wallets (to find EMERGENCY type and calculate total balance)
    supabase.from('wallets').select('*').eq('user_id', userId).eq('archived', false),
    // Transactions for expense analysis
    supabase.from('wallet_transactions')
      .select('*, categories(name, is_income, expense_tier, is_fixed_obligation)')
      .eq('user_id', userId)
      .gte('date', sixtyDaysAgo.toISOString()).order('date', { ascending: false }),
    // Active subscriptions (for fixed expenses)
    supabase.from('subscriptions').select('*').eq('user_id', userId).eq('is_active', true),
    // Unpaid bills (for fixed expenses)
    supabase.from('bills').select('*').eq('user_id', userId).eq('is_paid', false),
    // Debts (for minimum payments)
    supabase.from('debts').select('*').eq('user_id', userId),
    // Planned payments (to include recurring planned payments in fixed expenses)
    supabase.from('planned_payments').select('*').eq('user_id', userId).eq('is_paid', false),
    // Incomes (not used yet for essentials, but keeps parity with Phase 3 future needs)
    supabase.from('incomes').select('*').eq('user_id', userId).eq('is_received', false),
    // User preferences (cycle start day)
    supabase.from('user_preferences').select('cycle_start_day').eq('user_id', userId).maybeSingle(),
  ])

  const elapsed = nowMs() - startTime
  console.log(`✅ Data fetched in ${elapsed.toFixed(0)}ms`)

  let mainCurrencyCode = 'USD'
  try {
    const resolved = await resolveMainCurrencyCode(supabase, userId)
    mainCurrencyCode = resolved.currency
  } catch (error) {
    console.warn('[emergency-fund-intelligence] Failed to resolve main currency, defaulting to USD:', String((error as any)?.message || error))
  }

  const wallets = walletsRes.data || []
  const activeAssetWallets = wallets.filter((wallet: any) => {
    const archived = wallet?.archived === true
    const accountClass = String(wallet?.account_class || 'ASSET').trim().toUpperCase()
    return !archived && accountClass !== 'LIABILITY'
  })
  const normalizedWalletBalances = await normalizeWalletBalancesToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    activeAssetWallets,
  )
  console.log(
    `[emergency-fund-intelligence] wallet balance normalization: usable=${normalizedWalletBalances.metrics.usable_wallet_rows}, normalized=${normalizedWalletBalances.metrics.normalized_wallet_rows}, excluded=${normalizedWalletBalances.metrics.excluded_wallet_rows}, fxFailures=${normalizedWalletBalances.metrics.fx_lookup_failures}`,
  )
  const normalizedWalletBalanceById = normalizedWalletBalances.balancesByWalletId
  const walletsWithNormalizedBalance = wallets.map((wallet: any) => ({
    ...wallet,
    normalized_balance_main_currency:
      normalizedWalletBalanceById.get(String(wallet?.id || '').trim()) ?? null,
  }))

  let normalizedTransactions = txRes.data || []
  if (normalizedTransactions.length > 0) {
    const normalized = await normalizeTransactionsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      normalizedTransactions as Array<Record<string, unknown>>,
    )
    normalizedTransactions = normalized.rows
    console.log(
      `[emergency-fund-intelligence] tx currency normalization: normalized=${normalized.metrics.normalized_rows_used}, fx=${normalized.metrics.temporary_converted_rows_used}, same=${normalized.metrics.raw_same_currency_rows_used}, missing=${normalized.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalized.metrics.fx_lookup_failures}`
    )
  }

  const todayDateKey = new Date().toISOString().slice(0, 10)
  const subscriptionsRaw = subsRes.data || []
  const billsRaw = billsRes.data || []
  const debtsRaw = debtsRes.data || []
  const plannedPaymentsRaw = plannedPaymentsRes.data || []

  const [normalizedSubscriptions, normalizedBills, normalizedDebts, normalizedPlannedPayments] = await Promise.all([
    normalizeObligationAmountsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      subscriptionsRaw.map((sub: any) => ({
        amountCents: asNumber(sub?.amount_cents),
        walletId: typeof sub?.wallet_id === 'string' ? sub.wallet_id : null,
        sourceCurrency: readObligationSourceCurrency(sub),
        dateKey: sub?.next_billing_date ?? todayDateKey,
      })),
    ),
    normalizeObligationAmountsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      billsRaw.map((bill: any) => ({
        amountCents: asNumber(bill?.amount_cents),
        walletId: typeof bill?.wallet_id === 'string' ? bill.wallet_id : null,
        sourceCurrency: readObligationSourceCurrency(bill),
        dateKey: bill?.due_date ?? todayDateKey,
      })),
    ),
    normalizeObligationAmountsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      debtsRaw.map((debt: any) => ({
        amountCents: asNumber(debt?.minimum_payment_cents),
        walletId: typeof debt?.wallet_id === 'string' ? debt.wallet_id : null,
        sourceCurrency: readObligationSourceCurrency(debt),
        dateKey: debt?.due_date ?? todayDateKey,
      })),
    ),
    normalizeObligationAmountsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      plannedPaymentsRaw.map((payment: any) => ({
        amountCents: asNumber(payment?.amount_cents),
        walletId: typeof payment?.wallet_id === 'string' ? payment.wallet_id : null,
        sourceCurrency: readObligationSourceCurrency(payment),
        dateKey: payment?.due_date ?? todayDateKey,
      })),
    ),
  ])

  const annotateRowsWithNormalizedAmounts = (rows: any[], normalized: ObligationNormalizeResult) =>
    rows.map((row: any, rowIndex: number) => {
      const normalizedAmountCents = normalized.normalizedAmountCentsByIndex.get(rowIndex)
      const prepared = normalized.preparedByIndex.get(rowIndex)
      const normalizationExcluded =
        Boolean(prepared) &&
        normalizedAmountCents === undefined

      return {
        ...row,
        normalized_amount_main_currency_cents:
          typeof normalizedAmountCents === 'number' ? normalizedAmountCents : null,
        normalization_excluded: normalizationExcluded,
      }
    })

  const subscriptions = annotateRowsWithNormalizedAmounts(subscriptionsRaw, normalizedSubscriptions)
  const bills = annotateRowsWithNormalizedAmounts(billsRaw, normalizedBills)
  const debts = annotateRowsWithNormalizedAmounts(debtsRaw, normalizedDebts)
  const plannedPayments = annotateRowsWithNormalizedAmounts(plannedPaymentsRaw, normalizedPlannedPayments)

  console.log(
    `[emergency-fund-intelligence] obligations normalization: subscriptionsExcluded=${normalizedSubscriptions.excludedRowCount}, billsExcluded=${normalizedBills.excludedRowCount}, debtsExcluded=${normalizedDebts.excludedRowCount}, plannedExcluded=${normalizedPlannedPayments.excludedRowCount}, fxFailures=${normalizedSubscriptions.metrics.fx_lookup_failures + normalizedBills.metrics.fx_lookup_failures + normalizedDebts.metrics.fx_lookup_failures + normalizedPlannedPayments.metrics.fx_lookup_failures}`
  )

  return {
    wallets: walletsWithNormalizedBalance,
    transactions: normalizedTransactions,
    subscriptions,
    bills,
    debts,
    plannedPayments,
    incomes: incomesRes.data || [],
    cycleStartDay: prefsRes.data?.cycle_start_day ?? 1,
    mainCurrencyCode,
  }
}

/**
 * Calculate emergency fund status from fetched data
 */
function calculateEmergencyFundStatus(
  data: {
    wallets: any[]
    transactions: any[]
    subscriptions: any[]
    bills: any[]
    debts: any[]
    plannedPayments: any[]
    incomes: any[]
    cycleStartDay: number
    mainCurrencyCode: string
  },
  goalMonths: number,
  monthlyContribution: number | null,
  includeTips: boolean
): EmergencyFundResponse {
  const missingData: string[] = []
  
  // 1. Find EMERGENCY wallets and calculate balance
  const emergencyWallets = data.wallets.filter(w => {
    const walletType = String(w?.type || '').toLowerCase()
    const accountClass = String(w?.account_class || 'ASSET').trim().toUpperCase()
    return walletType === 'emergency' && accountClass !== 'LIABILITY'
  })
  const hasEmergencyWallet = emergencyWallets.length > 0
  
  const balance = emergencyWallets.reduce((sum, w) => {
    const b = asNumber((w as any)?.normalized_balance_main_currency)
    return sum + b
  }, 0)
  
  if (!hasEmergencyWallet) {
    missingData.push('no_emergency_wallet')
  }
  
  // 2. Calculate essential monthly expenses (Phase 3 logic)
  const now = new Date()
  const cycleStartDay = clampCycleStartDay(data.cycleStartDay)
  const window = computeCycleWindowUtc(now, cycleStartDay)

  const fixedExpenses = analyzeFixedExpenses(
    data.subscriptions,
    data.bills,
    data.debts,
    data.plannedPayments,
  )

  const variableExpenses = analyzeVariableExpenses(
    data.transactions,
    fixedExpenses.items,
    window.start,
    window.endExclusive,
  )
  const previousWindow = getPreviousCycleWindowUtc(window, cycleStartDay)
  const previousVariableExpenses = analyzeVariableExpenses(
    data.transactions,
    fixedExpenses.items,
    previousWindow.start,
    previousWindow.endExclusive,
  )
  const dayMs = 24 * 60 * 60 * 1000
  const cycleTotalDays = Math.max(1, Math.ceil((window.endExclusive.getTime() - window.start.getTime()) / dayMs))
  const elapsedCycleDays = Math.max(0, Math.ceil((now.getTime() - window.start.getTime()) / dayMs))
  const { normalizationFactor } = computeNormalizationFactor(cycleTotalDays, elapsedCycleDays)

  const monthlyEssentialsRaw = fixedExpenses.total
  const monthlyEssentials = monthlyEssentialsRaw > 0 ? monthlyEssentialsRaw : null
  
  if (!monthlyEssentials || monthlyEssentials === 0) {
    missingData.push('no_expenses')
  }
  
  // 3. Calculate runway (months covered)
  let runwayMonths: number | null = null
  let runwayFormatted: string | null = null
  
  if (monthlyEssentials && monthlyEssentials > 0) {
    runwayMonths = balance / monthlyEssentials
    runwayFormatted = formatRunway(runwayMonths)
  }
  
  // 4. Calculate goal progress
  const goalAmount = monthlyEssentials ? monthlyEssentials * goalMonths : null
  const progressPercent = goalAmount ? Math.min(100, (balance / goalAmount) * 100) : null
  const gapToGoal = goalAmount ? Math.max(0, goalAmount - balance) : null
  const gapFormatted = gapToGoal
    ? `${formatCurrency(gapToGoal, data.mainCurrencyCode, 0)} more to reach ${goalMonths} months (${formatCurrency(goalAmount || 0, data.mainCurrencyCode, 0)})`
    : null
  
  // 5. Determine status
  let status: EmergencyFundResponse['status']
  if (!hasEmergencyWallet) {
    status = 'no_fund'
  } else if (!runwayMonths || runwayMonths < 1) {
    status = 'needs_attention'
  } else if (runwayMonths < goalMonths) {
    status = 'building'
  } else {
    status = 'on_track'
  }
  
  // 6. Generate savings tips (tier-aware, dynamic cut percentages)
  let savingsTips: EmergencyFundResponse['savingsTips'] = null
  let impactPreview: EmergencyFundResponse['impactPreview'] = null
  
  // Priority: discretionary first, then flexible_essential.
  const allVariableCategories = new Set([
    ...Object.keys(previousVariableExpenses.categories || {}),
    ...Object.keys(variableExpenses.categories || {}),
  ])
  if (allVariableCategories.size > 0) {
    const categorizedSpending = Array.from(allVariableCategories)
      .map((category) => {
        const previousCycleAmount = previousVariableExpenses.categories[category] || 0
        const currentCycleAmount = variableExpenses.categories[category] || 0
        const projectedCurrentAmount = currentCycleAmount * normalizationFactor
        const monthlyAmount = previousCycleAmount > 0
          ? currentCycleAmount > 0
            ? (previousCycleAmount * 0.6) + (projectedCurrentAmount * 0.4)
            : previousCycleAmount
          : elapsedCycleDays >= 7
            ? projectedCurrentAmount
            : 0
        const tier = mergeExpenseTierState(
          previousVariableExpenses.categoryStates[category] || 'unknown',
          variableExpenses.categoryStates[category] || 'unknown',
        )

        return {
          category,
          monthlyAmount,
          tier,
        }
      })
      .filter((row) => row.monthlyAmount > 0)

    const discretionarySpending = categorizedSpending
      .filter((row) => row.tier === 'discretionary')
      .sort((a, b) => b.monthlyAmount - a.monthlyAmount)

    const flexibleEssentialSpending = categorizedSpending
      .filter((row) => row.tier === 'flexible_essential')
      .sort((a, b) => b.monthlyAmount - a.monthlyAmount)

    const prioritizedSpending = [
      ...discretionarySpending,
      ...flexibleEssentialSpending,
    ].slice(0, 3)

    const hasRoomToCut = prioritizedSpending.length > 0
    const remainingGoalAmount = gapToGoal || 0
    const cutMode: EmergencyFundResponse['cutMode'] = remainingGoalAmount > 0
      ? 'needed_to_hit_target'
      : 'optional_buffer'
    const monthlyCutTarget = monthlyContribution && monthlyContribution > 0
      ? monthlyContribution
      : monthlyEssentials || 0
    const cutTargetAmount = cutMode === 'needed_to_hit_target'
      ? Math.min(remainingGoalAmount, monthlyCutTarget)
      : monthlyCutTarget
    const eligibleCategories: EligibleCategory[] = prioritizedSpending.map((item) => ({
      name: item.category,
      spendCents: Math.round(item.monthlyAmount * 100),
      categoryKey: item.category,
      expenseTier: item.tier === 'flexible_essential' ? 'flexible_essential' : 'discretionary',
    }))
    const cutAllocation = allocateCappedCuts(eligibleCategories, Math.round(cutTargetAmount * 100))
    const shouldShowTips = (includeTips || hasRoomToCut) && cutAllocation.trimCategories.length > 0
    
    if (shouldShowTips) {
      const emojiMap: { [key: string]: string } = {
        'dining': '🍕',
        'food': '🍕',
        'coffee': '☕',
        'entertainment': '🎬',
        'shopping': '🛍️',
        'groceries': '🛒',
        'transport': '🚗',
        'travel': '✈️',
        'subscriptions': '📺',
      }
      
      savingsTips = cutAllocation.trimCategories.map(item => {
        const catLower = item.name.toLowerCase()
        const emoji = Object.entries(emojiMap).find(([key]) => catLower.includes(key))?.[1] || '💰'
        const currentSpend = item.currentAmountCents / 100
        const suggestedSavings = (item.currentAmountCents - item.recommendedCapCents) / 100
        
        return {
          emoji,
          category: item.name,
          currentSpend,
          suggestedSavings,
          monthlyImpact: suggestedSavings
        }
      })
      
      // Calculate impact preview
      const totalMonthlySavings = savingsTips.reduce((sum, tip) => sum + tip.monthlyImpact, 0)
      
      if (totalMonthlySavings > 0 && gapToGoal && gapToGoal > 0) {
        const monthsToGoal = Math.ceil(gapToGoal / totalMonthlySavings)
        const targetDate = new Date()
        targetDate.setMonth(targetDate.getMonth() + monthsToGoal)
        
        impactPreview = {
          monthlySavings: totalMonthlySavings,
          targetDate: targetDate.toISOString().split('T')[0],
          monthsToGoal
        }
      }
    }
  }
  
  // 7. Build clarifying question if data is missing
  let clarifyingQuestion: string | null = null
  if (missingData.includes('no_emergency_wallet')) {
    clarifyingQuestion = "You don't have an Emergency wallet yet. Would you like to create one?"
  } else if (missingData.includes('no_expenses')) {
    clarifyingQuestion = "I don't have enough expense data to calculate your essentials. Add some transactions first!"
  }
  
  const hasEnoughData = missingData.length === 0

  return {
    type: 'emergency_fund',
    status,
    currencyCode: data.mainCurrencyCode,
    balance,
    hasEmergencyWallet,
    emergencyWalletCount: emergencyWallets.length,
    monthlyEssentials,
    essentialsBreakdown: fixedExpenses.items.length > 0
      ? fixedExpenses.items.map((i) => ({ name: i.name, amount: i.amount, category: i.category }))
      : null,
    runwayMonths,
    runwayFormatted,
    goalMonths,
    goalAmount,
    progressPercent,
    gapToGoal,
    gapFormatted,
    cutMode: (gapToGoal || 0) > 0 ? 'needed_to_hit_target' : 'optional_buffer',
    savingsTips,
    impactPreview,
    hasEnoughData,
    missingData,
    clarifyingQuestion,
    requestedGoalMonths: goalMonths,
    requestedMonthlyContribution: monthlyContribution
  }
}

/**
 * Format runway months for display
 */
function formatRunway(months: number): string {
  if (months < 1) {
    const days = Math.round(months * 30)
    return `${days} days`
  }
  
  const wholeMonths = Math.floor(months)
  const fraction = months - wholeMonths
  const days = Math.round(fraction * 30)
  
  if (days === 0) {
    return `${wholeMonths} month${wholeMonths !== 1 ? 's' : ''}`
  }
  
  return `${months.toFixed(1)} months`
}
