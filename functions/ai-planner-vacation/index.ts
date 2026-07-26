/**
 * WiseFlow AI Planner - Vacation Affordability
 * Phase 1: Isolated vacation planning function
 * 
 * Uses shared planner core for all math calculations.
 * Evidence-first: Never invents numbers, returns partial results + clarifying questions when data is missing.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import { cors } from '../_shared/cors.ts'
import { log, logError } from '../_shared/logger.ts'
import { getServiceSupabaseClient, getUserFromAuthHeader } from '../_shared/supabaseClient.ts'
import {
  computeNormalizationFactor,
  computeAdjustedRequiredCentsVacation,
  computeGapCents,
  allocateCappedCuts,
  computeCoverage,
  computeVerdict,
} from '../_shared/planner-core.ts'
import type { EligibleCategory } from '../_shared/planner-types.ts'
import {
  buildBudgetLockContext,
  categoryLookupKeys,
} from '../_shared/budgetLocks.ts'
import { normalizeTransactionsToMainCurrency, resolveMainCurrencyCode } from '../_shared/currencyReporting.ts'
import {
  buildObligationNormalizationWarning,
  formatCurrencyTextFromCents,
  normalizeCanonicalObligationLinesToMainCurrency,
  sumNormalizedObligationTotals,
} from '../_shared/obligationCurrency.ts'

// Constants
const TX_FETCH_WINDOW_DAYS = 60
const MIN_TRANSACTIONS_FOR_GOOD_QUALITY = 10
const LONG_TERM_OBLIGATION_AVERAGE_MIN_MONTHS = 3
const OBLIGATION_AVERAGE_CYCLES = 3
const INCOME_AVERAGE_CYCLES = 3

const TRANSFER_CATEGORIES = ['transfer', 'internal-transfer', 'wallet-transfer', 'money-transfer']

type ExpenseTierState = 'essential' | 'flexible_essential' | 'discretionary' | 'unknown'

// Types
interface VacationPlannerRequest {
  vacationName?: string
  costCents?: number
  targetMonth?: string
  languageCode?: string
  localeTag?: string
  mainCurrencyCode?: string
  numberFormatMode?: string
}

interface VacationPlannerDependencies {
  supabase: any
  userId: string
}

type ObligationTotals = {
  billsCents: number
  plannedPaymentsCents: number
  subscriptionsCents: number
  goalAutoSaveCents: number
  totalCents: number
  grandTotalCents: number
}

type ObligationWindow = {
  label: string
  startDateISO: string
  endDateISO: string
}

function buildUserScopedSupabaseClient(authHeader: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

  if (!supabaseUrl || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY')
  }

  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  })
}

// Helper functions
function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

async function resolveMainCurrencySafe(
  supabase: any,
  userId: string,
  mainCurrencyCode?: string,
): Promise<string> {
  try {
    const resolved = await resolveMainCurrencyCode(supabase, userId, {
      bodyCurrency: mainCurrencyCode,
    })
    return resolved.currency
  } catch (error) {
    log('vacation_planner_currency_fallback', {
      userId,
      error: String((error as any)?.message || error),
    })
    return 'USD'
  }
}

function dollarsToCents(value: number): number {
  return Math.round(value * 100)
}

function toDateISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function normalizeCategoryNameKey(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function getCycleEndDateFromStart(cycleStartDate: Date): Date {
  const cycleEndDate = new Date(cycleStartDate)
  cycleEndDate.setMonth(cycleEndDate.getMonth() + 1)
  cycleEndDate.setDate(cycleEndDate.getDate() - 1)
  return cycleEndDate
}

// Sum income (in cents) from transactions that fall within [startDate, endDate].
// Salary is a lump sum, so it is summed as-is and never scaled by the partial-cycle factor.
function sumIncomeCentsInRange(transactions: any[], startDate: Date, endDate: Date): number {
  return transactions.reduce((sum: number, tx: any) => {
    if (isExcludedTransaction(tx)) return sum
    if (!isIncomeTransaction(tx)) return sum
    const txDate = new Date(tx.date)
    if (Number.isNaN(txDate.getTime())) return sum
    if (txDate < startDate || txDate > endDate) return sum
    const amount = asNumber(tx.amount)
    return sum + Math.max(0, dollarsToCents(Math.abs(amount)))
  }, 0)
}

// Build a cycle window shifted by `offset` whole cycles from the current cycle start.
// Negative offsets point to past cycles.
function getCycleWindowFromOffset(cycleStartDate: Date, offset: number): { start: Date; end: Date } {
  const start = new Date(cycleStartDate)
  start.setMonth(start.getMonth() + offset)
  const end = getCycleEndDateFromStart(start)
  return { start, end }
}

function parseObligationTotals(raw: any): ObligationTotals {
  const totals = raw?.totals || {}
  const billsCents = Math.max(0, Math.round(asNumber(totals.billsCents)))
  const plannedPaymentsCents = Math.max(0, Math.round(asNumber(totals.plannedPaymentsCents)))
  const subscriptionsCents = Math.max(0, Math.round(asNumber(totals.subscriptionsCents)))
  const goalAutoSaveCents = Math.max(0, Math.round(asNumber(totals.goalAutoSaveCents)))

  return {
    billsCents,
    plannedPaymentsCents,
    subscriptionsCents,
    goalAutoSaveCents,
    totalCents: billsCents + plannedPaymentsCents + subscriptionsCents + goalAutoSaveCents,
    grandTotalCents: Math.max(0, Math.round(asNumber(totals.grandTotalCents))),
  }
}

function averageObligationTotals(samples: ObligationTotals[]): ObligationTotals {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      billsCents: 0,
      plannedPaymentsCents: 0,
      subscriptionsCents: 0,
      goalAutoSaveCents: 0,
      totalCents: 0,
      grandTotalCents: 0,
    }
  }

  const count = samples.length
  const sum = samples.reduce((acc, sample) => {
    acc.billsCents += sample.billsCents
    acc.plannedPaymentsCents += sample.plannedPaymentsCents
    acc.subscriptionsCents += sample.subscriptionsCents
    acc.goalAutoSaveCents += sample.goalAutoSaveCents
    acc.totalCents += sample.totalCents
    acc.grandTotalCents += sample.grandTotalCents
    return acc
  }, {
    billsCents: 0,
    plannedPaymentsCents: 0,
    subscriptionsCents: 0,
    goalAutoSaveCents: 0,
    totalCents: 0,
    grandTotalCents: 0,
  })

  return {
    billsCents: Math.round(sum.billsCents / count),
    plannedPaymentsCents: Math.round(sum.plannedPaymentsCents / count),
    subscriptionsCents: Math.round(sum.subscriptionsCents / count),
    goalAutoSaveCents: Math.round(sum.goalAutoSaveCents / count),
    totalCents: Math.round(sum.totalCents / count),
    grandTotalCents: Math.round(sum.grandTotalCents / count),
  }
}

function isIncomeTransaction(tx: any): boolean {
  const catRel = tx?.categories
  const isIncomeFlag =
    (catRel && typeof catRel === 'object' && !Array.isArray(catRel) && catRel.is_income === true) ||
    (Array.isArray(catRel) && catRel.some((c: any) => c?.is_income === true))
  
  if (isIncomeFlag) return true
  
  // Fallback: check category name
  const category = typeof tx?.category === 'string' ? tx.category.toLowerCase() : ''
  return (
    category.includes('salary') ||
    category.includes('income') ||
    category.includes('wages') ||
    category.includes('freelance') ||
    category.includes('bonus')
  )
}

function isExcludedTransaction(tx: any): boolean {
  if (!tx) return true
  if (tx.is_opening_balance === true) return true
  if (tx.is_manual_topup === true) return true
  
  const categoryRaw = typeof tx.category === 'string' ? tx.category : ''
  const category = categoryRaw.toLowerCase()
  
  if (TRANSFER_CATEGORIES.some((t) => category.includes(t))) return true
  if (category.includes('opening balance') || category.includes('opening-balance')) return true
  if (category.includes('owner contribution')) return true
  
  return false
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

function mergeExpenseTierState(current: ExpenseTierState, incoming: ExpenseTierState): ExpenseTierState {
  const priority: Record<ExpenseTierState, number> = {
    essential: 4,
    flexible_essential: 3,
    discretionary: 2,
    unknown: 1,
  }
  return priority[incoming] > priority[current] ? incoming : current
}

// Get cycle dates
function getCycleAnchorDate(year: number, month: number, cycleStartDay: number): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const safeDay = Math.min(Math.max(1, Math.floor(cycleStartDay || 1)), daysInMonth)
  return new Date(year, month, safeDay)
}

function getCycleDates(cycleStartDay: number): {
  cycleStartDate: Date
  cycleEndDate: Date
  cycleTotalDays: number
  rawElapsedDays: number
  cycleRemainingDays: number
} {
  const now = new Date()
  const currentMonth = now.getMonth()
  const currentYear = now.getFullYear()
  
  let cycleStartDate = getCycleAnchorDate(currentYear, currentMonth, cycleStartDay)
  if (now < cycleStartDate) {
    cycleStartDate = getCycleAnchorDate(currentYear, currentMonth - 1, cycleStartDay)
  }
  
  const cycleEndDate = new Date(cycleStartDate)
  cycleEndDate.setMonth(cycleEndDate.getMonth() + 1)
  cycleEndDate.setDate(cycleEndDate.getDate() - 1)
  
  const cycleTotalDays = Math.ceil((cycleEndDate.getTime() - cycleStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
  const rawElapsedDays = Math.max(0, Math.ceil((now.getTime() - cycleStartDate.getTime()) / (1000 * 60 * 60 * 24)))
  const cycleRemainingDays = Math.max(0, cycleTotalDays - rawElapsedDays)
  
  return {
    cycleStartDate,
    cycleEndDate,
    cycleTotalDays,
    rawElapsedDays,
    cycleRemainingDays
  }
}

type TargetMonthValidation =
  | { valid: true; year: number; month: number }
  | { valid: false; error: string }

// Validate and parse target month format
function validateTargetMonth(targetMonth: string): TargetMonthValidation {
  const match = /^(\d{4})-(\d{2})$/.exec(targetMonth.trim())
  if (!match) {
    return { valid: false, error: 'Target month must be in YYYY-MM format (e.g., "2026-06")' }
  }

  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return { valid: false, error: 'Invalid target month date' }
  }

  const parsed = new Date(year, month - 1, 1)
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1) {
    return { valid: false, error: 'Invalid target month date' }
  }

  return { valid: true, year, month }
}

// Main handler (exported for testing)
export async function handleVacationPlannerRequest(
  body: VacationPlannerRequest,
  deps: VacationPlannerDependencies
) {
  const { supabase, userId } = deps
  const { vacationName, costCents, targetMonth } = body
  
  log('vacation_planner_request', {
    userId,
    vacationName,
    costCents,
    targetMonth
  })
  
  // Validate inputs
  if (!vacationName || typeof vacationName !== 'string') {
    return {
      type: 'clarifying_question',
      question: 'What would you like to name this vacation?'
    }
  }
  
  if (!costCents || costCents <= 0) {
    return {
      type: 'clarifying_question',
      question: 'How much do you estimate this vacation will cost?'
    }
  }
  
  if (!targetMonth) {
    return {
      type: 'clarifying_question',
      question: 'When are you planning to take this vacation? (e.g., "2026-06")'
    }
  }
  
  // Validate target month format
  const validation = validateTargetMonth(targetMonth)
  if (!validation.valid) {
    return {
      type: 'error',
      error: validation.error
    }
  }
  
  // Parse target month and compute month-distance using calendar months.
  const now = new Date()
  const rawMonthsToSave =
    (validation.year - now.getFullYear()) * 12 +
    ((validation.month - 1) - now.getMonth())
  
  // Validate target is in the future
  if (rawMonthsToSave <= 0) {
    return {
      type: 'error',
      error: 'Target month must be in the future'
    }
  }
  
  const monthsToSave = rawMonthsToSave
  
  // Get cycle start day from user_preferences (source of truth).
  const { data: preferences, error: preferencesError } = await supabase
    .from('user_preferences')
    .select('cycle_start_day')
    .eq('user_id', userId)
    .maybeSingle()

  if (preferencesError) {
    log('preferences_fetch_error', { userId, error: preferencesError.message })
  }

  const rawCycleStart = Math.floor(asNumber(preferences?.cycle_start_day))
  const cycleStartDay = rawCycleStart >= 1 && rawCycleStart <= 31 ? rawCycleStart : 1
  
  // Get cycle dates
  const cycleDates = getCycleDates(cycleStartDay)
  const { cycleStartDate, cycleEndDate, cycleTotalDays, rawElapsedDays, cycleRemainingDays } = cycleDates
  
  // Compute normalization factor
  const normalization = computeNormalizationFactor(cycleTotalDays, rawElapsedDays)
  const { normalizationFactor, warnings } = normalization

  const currencyCode = await resolveMainCurrencySafe(supabase, userId, body.mainCurrencyCode)
  
  const useAverageFixedObligations = monthsToSave >= LONG_TERM_OBLIGATION_AVERAGE_MIN_MONTHS
  const useAverageIncome = monthsToSave >= LONG_TERM_OBLIGATION_AVERAGE_MIN_MONTHS
  const obligationWindowCount = useAverageFixedObligations ? OBLIGATION_AVERAGE_CYCLES : 1
  const obligationWindows: ObligationWindow[] = []
  const obligationCurrencyWarnings = new Set<string>()
  for (let offset = 0; offset < obligationWindowCount; offset++) {
    const cycleStart = new Date(cycleStartDate)
    cycleStart.setMonth(cycleStart.getMonth() + offset)
    const cycleEnd = getCycleEndDateFromStart(cycleStart)

    obligationWindows.push({
      label: offset === 0 ? 'Current Cycle' : `Cycle +${offset}`,
      startDateISO: toDateISO(cycleStart),
      endDateISO: toDateISO(cycleEnd),
    })
  }

  const obligationSamples: ObligationTotals[] = []
  const obligationsDiagnostics: any[] = []
  for (const window of obligationWindows) {
    const obligationsParams = {
      p_mode: 'custom',
      p_anchor_date: null,
      p_cycle_start_day: cycleStartDay,
      p_window_start: window.startDateISO,
      p_window_end: window.endDateISO,
      p_wallet_ids: null,
      p_include_overdue: true,
      p_include_lines: true,
    }

    const { data: obligationsData, error: obligationsError } = await supabase.rpc('get_obligations_v1', obligationsParams)
    if (obligationsError) {
      log('obligations_fetch_error', {
        userId,
        windowStart: window.startDateISO,
        windowEnd: window.endDateISO,
        error: obligationsError.message,
      })
      obligationsDiagnostics.push({ label: window.label, error: String(obligationsError.message || obligationsError) })
      continue
    }

    const rawObligationLineCount = Array.isArray(obligationsData?.lines) ? obligationsData.lines.length : 0
    log('planner_obligations_window_raw', {
      userId,
      currencyCode,
      windowLabel: window.label,
      windowStart: window.startDateISO,
      windowEnd: window.endDateISO,
      rawLineCount: rawObligationLineCount,
      rawTotals: obligationsData?.totals ?? null,
      rawWarnings: obligationsData?.warnings ?? null,
    })

    const normalizedObligations = await normalizeCanonicalObligationLinesToMainCurrency(
      supabase,
      userId,
      currencyCode,
      obligationsData?.lines || [],
      window.endDateISO,
    )
    const normalizationWarning = buildObligationNormalizationWarning(normalizedObligations, currencyCode)
    if (normalizationWarning) {
      obligationCurrencyWarnings.add(normalizationWarning)
      warnings.push(normalizationWarning)
    }
    const totals = sumNormalizedObligationTotals(normalizedObligations.lines)
    log('planner_obligations_window_normalized', {
      userId,
      currencyCode,
      windowLabel: window.label,
      windowStart: window.startDateISO,
      windowEnd: window.endDateISO,
      normalizedLineCount: normalizedObligations.lines.length,
      excludedLineCount: normalizedObligations.excludedLineCount,
      fxMetrics: normalizedObligations.metrics,
      normalizedTotals: {
        billsCents: totals.billsCents,
        plannedPaymentsCents: totals.plannedPaymentsCents,
        subscriptionsCents: totals.subscriptionsCents,
        goalAutoSaveCents: totals.goalAutoSaveCents,
        totalCents: totals.totalCents,
        grandTotalCents: totals.grandTotalCents,
      },
    })
    obligationSamples.push({
      billsCents: totals.billsCents,
      plannedPaymentsCents: totals.plannedPaymentsCents,
      subscriptionsCents: totals.subscriptionsCents,
      goalAutoSaveCents: totals.goalAutoSaveCents,
      totalCents: totals.totalCents,
      grandTotalCents: totals.grandTotalCents,
    })
    obligationsDiagnostics.push({
      label: window.label,
      windowStart: window.startDateISO,
      windowEnd: window.endDateISO,
      rawLineCount: rawObligationLineCount,
      normalizedLineCount: normalizedObligations.lines.length,
      excludedLineCount: normalizedObligations.excludedLineCount,
      fxFailures: normalizedObligations.metrics?.fx_lookup_failures ?? null,
      normalizedTotalCents: totals.totalCents,
    })
  }

  const obligations = averageObligationTotals(obligationSamples)
  log('planner_obligations_summary', {
    userId,
    currencyCode,
    sampleCount: obligationSamples.length,
    windowCount: obligationWindowCount,
    averagedObligations: obligations,
  })
  if (useAverageFixedObligations) {
    warnings.push(
      `Using average fixed obligations across ${obligationSamples.length || obligationWindowCount} cycle(s) for long-term planning.`
    )
  }
  
  // Fetch transactions from wallet_transactions.
  // When averaging income for long-term plans, extend the look-back so the prior income
  // cycles are included in the fetch.
  const baseWindowStart = new Date(cycleStartDate)
  baseWindowStart.setDate(baseWindowStart.getDate() - TX_FETCH_WINDOW_DAYS)
  const incomeWindowStart = new Date(cycleStartDate)
  incomeWindowStart.setMonth(incomeWindowStart.getMonth() - INCOME_AVERAGE_CYCLES)
  const windowStart = useAverageIncome && incomeWindowStart < baseWindowStart
    ? incomeWindowStart
    : baseWindowStart

  const { data: transactions, error: txError } = await supabase
    .from('wallet_transactions')
    .select('*, categories(*)')
    .eq('user_id', userId)
    .gte('date', toDateISO(windowStart))
    .order('date', { ascending: false })
  
  if (txError) {
    logError('transactions_fetch_error', { userId, error: txError.message })
    return {
      type: 'error',
      error: 'Failed to fetch transaction data'
    }
  }

  let normalizedTransactions = transactions || []
  if (normalizedTransactions.length > 0) {
    const normalized = await normalizeTransactionsToMainCurrency(
      supabase,
      userId,
      currencyCode,
      normalizedTransactions as Array<Record<string, unknown>>,
    )
    normalizedTransactions = normalized.rows as any[]
    log('vacation_planner_currency_normalization', {
      userId,
      currencyCode,
      ...normalized.metrics,
    })
  }
  const allTransactions = normalizedTransactions
  
  // Fetch existing vacation goal
  const { data: goals } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .eq('is_wish', false)
    .ilike('name', '%vacation%')
  
  let existingGoal = {
    exists: false,
    goalName: null as string | null,
    estimatedMonthlyCents: 0
  }
  
  const isWishGoal = (g: any) =>
    !g?.is_challenge &&
    (g?.is_wish === true || (g?.is_wish !== false && Number(g?.target_amount_cents ?? 0) <= 0))

  const eligibleGoals = (goals || []).filter((g: any) =>
    g?.is_challenge !== true && !isWishGoal(g)
  )

  if (eligibleGoals.length > 0) {
    const goal = eligibleGoals[0]
    const targetCents = Math.max(0, Math.round(asNumber(goal.target_amount_cents)))
    const currentCents = Math.max(0, Math.round(asNumber(goal.current_amount_cents)))
    const remainingCents = Math.max(0, targetCents - currentCents)
    
    // Estimate monthly contribution (assume 6 months if no deadline)
    const estimatedMonthlyCents = Math.ceil(remainingCents / 6)
    
    existingGoal = {
      exists: true,
      goalName: goal.name || 'Vacation',
      estimatedMonthlyCents
    }
  }
  
  // Fetch budgets
  const { data: budgetsData, error: budgetsError } = await supabase
    .from('budgets')
    .select('category_id, amount_cents, start_date, end_date, is_active, name, wallet_id, categories(name)')
    .eq('user_id', userId)
  
  const budgetRows = budgetsError ? [] : (budgetsData || [])

  // Fetch canonical expense categories for the same lock behavior as ai-budget-intelligence.
  const { data: expenseCategoriesData, error: categoriesError } = await supabase
    .from('categories')
    .select('id, name, is_income, expense_tier, is_fixed_obligation')
    .eq('is_income', false)

  const expenseCategories = categoriesError ? [] : (expenseCategoriesData || [])
  const categoryByNormalizedName = new Map<string, any>()
  const categoryByCanonicalKey = new Map<string, any>()
  for (const c of expenseCategories) {
    const key = String(c?.name || '').trim().toLowerCase()
    if (key && !categoryByNormalizedName.has(key)) {
      categoryByNormalizedName.set(key, c)
    }
    const canonicalKey = normalizeCategoryNameKey(c?.name)
    if (canonicalKey && !categoryByCanonicalKey.has(canonicalKey)) {
      categoryByCanonicalKey.set(canonicalKey, c)
    }
  }
  const otherCategory = categoryByNormalizedName.get('other') || null
  
  // Filter transactions for current cycle
  const cycleTransactions = allTransactions.filter((tx: any) => {
    if (isExcludedTransaction(tx)) return false
    const txDate = new Date(tx.date)
    return txDate >= cycleStartDate && txDate <= cycleEndDate
  })
  
  // Calculate income.
  // Salary is a lump sum, not a daily-accruing flow, so it is NOT scaled by the partial-cycle
  // normalization factor (this matches the savings planner and avoids inflating income up to 2x).
  const currentCycleIncomeCents = sumIncomeCentsInRange(allTransactions, cycleStartDate, cycleEndDate)

  // For long-term plans, base income on an average of recent cycles so a paycheck that has not
  // yet landed in the current cycle does not zero out the plan. Mirrors the fixed-obligation
  // averaging above. Cycles with no income are skipped so they don't drag the average down.
  let incomeCentsForPlanning = currentCycleIncomeCents
  let incomeCyclesUsed = 1
  let incomeWindowAveraged = false
  if (useAverageIncome) {
    const incomeSamples: number[] = []
    if (currentCycleIncomeCents > 0) incomeSamples.push(currentCycleIncomeCents)
    for (let offset = 1; offset <= INCOME_AVERAGE_CYCLES; offset++) {
      const win = getCycleWindowFromOffset(cycleStartDate, -offset)
      const incomeCents = sumIncomeCentsInRange(allTransactions, win.start, win.end)
      if (incomeCents > 0) incomeSamples.push(incomeCents)
    }
    if (incomeSamples.length > 0) {
      incomeCentsForPlanning = Math.round(incomeSamples.reduce((a, b) => a + b, 0) / incomeSamples.length)
      incomeCyclesUsed = incomeSamples.length
      incomeWindowAveraged = true
      warnings.push(`Using average income across ${incomeSamples.length} recent cycle(s) for long-term planning.`)
    }
  }

  // Guard: Missing income
  if (incomeCentsForPlanning === 0) {
    return {
      type: 'clarifying_question',
      question: useAverageIncome
        ? "I don't see any income transactions in your recent cycles. Can you add your income or salary transactions?"
        : "I don't see any income transactions in your current cycle yet. Can you add your income or salary transactions?",
      partialData: {
        fixedObligationsCents: obligations.totalCents
      }
    }
  }
  
  // Calculate variable spending by category
  const spendingTransactions = cycleTransactions.filter((tx: any) => !isIncomeTransaction(tx))
  const categorySpending = new Map<string, { name: string; spendCents: number; categoryId: string; tier: ExpenseTierState }>()
  const fallbackCategorySpending = new Map<string, { name: string; spendCents: number; categoryId: string; tier: ExpenseTierState }>()

  const resolveCategory = (tx: any): { categoryId: string; categoryName: string; tier: ExpenseTierState } => {
    // Canonical category resolution (same pattern as ai-budget-intelligence):
    // tx.categories relation -> normalized legacy name -> "other" fallback.
    const rel = tx?.categories
    const relCategory =
      (rel && typeof rel === 'object' && !Array.isArray(rel) && typeof rel.id === 'string')
        ? rel
        : (Array.isArray(rel) ? rel.find((r: any) => typeof r?.id === 'string') : null)

    const legacyName = typeof tx?.category === 'string' ? tx.category.trim() : ''
    const normalizedLegacyName = legacyName.toLowerCase()
    const canonicalLegacyKey = normalizeCategoryNameKey(legacyName)
    const mappedLegacyCategory = normalizedLegacyName
      ? (
        categoryByNormalizedName.get(normalizedLegacyName) ||
        (canonicalLegacyKey ? categoryByCanonicalKey.get(canonicalLegacyKey) : null) ||
        null
      )
      : null
    const resolvedCategory = relCategory || mappedLegacyCategory || otherCategory

    const categoryName = (() => {
      if (typeof resolvedCategory?.name === 'string' && resolvedCategory.name.trim()) {
        return resolvedCategory.name.trim()
      }
      if (legacyName) return legacyName
      return 'Uncategorized'
    })()

    const categoryId = (() => {
      if (typeof resolvedCategory?.id === 'string' && resolvedCategory.id.trim()) {
        return resolvedCategory.id.trim()
      }
      if (typeof tx?.category_id === 'string' && tx.category_id.trim()) {
        return tx.category_id.trim()
      }
      return categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    })()

    const tier = getExpenseTierStateFromCategoryMeta(resolvedCategory)
    return { categoryId, categoryName, tier }
  }

  const addSpendToMap = (
    map: Map<string, { name: string; spendCents: number; categoryId: string; tier: ExpenseTierState }>,
    tx: any
  ) => {
    const amount = asNumber(tx.amount)
    const amountCents = Math.max(0, dollarsToCents(Math.abs(amount)))
    if (amountCents <= 0) return

    const { categoryId, categoryName, tier } = resolveCategory(tx)

    if (!map.has(categoryId)) {
      map.set(categoryId, {
        name: categoryName,
        spendCents: 0,
        categoryId,
        tier
      })
    }

    const cat = map.get(categoryId)!
    cat.tier = mergeExpenseTierState(cat.tier, tier)
    cat.spendCents += amountCents
  }

  for (const tx of spendingTransactions) {
    addSpendToMap(categorySpending, tx)
  }

  // Previous completed cycle candidate pool for long-term cut suggestions.
  // Vacation planning should not be driven by one tiny current-cycle sample.
  const fallbackStartDate = new Date(cycleStartDate)
  fallbackStartDate.setDate(fallbackStartDate.getDate() - 30)
  const fallbackTransactions = allTransactions.filter((tx: any) => {
    if (isExcludedTransaction(tx)) return false
    if (isIncomeTransaction(tx)) return false
    const txDate = new Date(tx.date)
    if (Number.isNaN(txDate.getTime())) return false
    return txDate >= fallbackStartDate && txDate < cycleStartDate
  })

  for (const tx of fallbackTransactions) {
    addSpendToMap(fallbackCategorySpending, tx)
  }
  
  // Normalize spending to full month
  for (const cat of categorySpending.values()) {
    cat.spendCents = Math.round(cat.spendCents * normalizationFactor)
  }

  // Build the cut-suggestion spend pool from stable history first, then current projection.
  // This mirrors the Emergency Fund planner: previous cycle is trusted more for long-term
  // planning, while current-cycle-only categories are ignored during the first week.
  const cutCategorySpending = new Map<string, { name: string; spendCents: number; categoryId: string; tier: ExpenseTierState }>()
  const cutSourceCategoryIds = new Set<string>([
    ...Array.from(fallbackCategorySpending.keys()),
    ...Array.from(categorySpending.keys())
  ])
  let usedFallbackCategories = false

  for (const categoryId of cutSourceCategoryIds) {
    const historical = fallbackCategorySpending.get(categoryId)
    const current = categorySpending.get(categoryId)
    const historicalSpendCents = historical?.spendCents ?? 0
    const currentSpendCents = current?.spendCents ?? 0

    let spendCents = 0
    if (historicalSpendCents > 0 && currentSpendCents > 0) {
      spendCents = Math.round((historicalSpendCents * 0.6) + (currentSpendCents * 0.4))
      usedFallbackCategories = true
    } else if (historicalSpendCents > 0) {
      spendCents = historicalSpendCents
      usedFallbackCategories = true
    } else if (rawElapsedDays >= 7) {
      spendCents = currentSpendCents
    }

    if (spendCents <= 0) continue

    let tier: ExpenseTierState = historical?.tier || 'unknown'
    if (current) {
      tier = mergeExpenseTierState(tier, current.tier)
    }

    cutCategorySpending.set(categoryId, {
      name: current?.name || historical?.name || 'Uncategorized',
      spendCents,
      categoryId,
      tier
    })
  }
  
  // Build category name map for budget lock context
  const categoryNameById = new Map<string, string>()
  for (const cat of categorySpending.values()) {
    categoryNameById.set(cat.categoryId, cat.name)
  }
  for (const cat of fallbackCategorySpending.values()) {
    if (!categoryNameById.has(cat.categoryId)) {
      categoryNameById.set(cat.categoryId, cat.name)
    }
  }
  for (const cat of cutCategorySpending.values()) {
    if (!categoryNameById.has(cat.categoryId)) {
      categoryNameById.set(cat.categoryId, cat.name)
    }
  }
  
  // Build budget lock context to exclude budgeted categories
  const budgetLocks = buildBudgetLockContext({
    budgets: budgetRows,
    windowStartISO: toDateISO(cycleStartDate),
    windowEndISO: toDateISO(cycleEndDate),
    categoryNameById
  })
  const budgetedCategoryIds = budgetLocks.lockedCategoryIds
  const budgetedCategoryKeys = budgetLocks.lockedCategoryKeys

  // Strict source-of-truth lock for planner cuts:
  // exclude any category that has an active budget row, regardless of date window.
  const activeBudgetRows = budgetRows.filter((b: any) => b && b.is_active !== false)
  const activeBudgetCategoryIds = new Set<string>()
  const activeBudgetCategoryKeys = new Set<string>()
  for (const b of activeBudgetRows) {
    const cid = typeof b?.category_id === 'string' ? b.category_id.trim() : ''
    if (cid) activeBudgetCategoryIds.add(cid)

    const bName = typeof b?.name === 'string' ? b.name : ''
    for (const k of categoryLookupKeys(bName)) activeBudgetCategoryKeys.add(k)

    const rel = b?.categories
    const relName =
      (rel && typeof rel === 'object' && !Array.isArray(rel) && typeof rel.name === 'string')
        ? rel.name
        : (Array.isArray(rel) ? String(rel.find((r: any) => typeof r?.name === 'string')?.name || '') : '')
    for (const k of categoryLookupKeys(relName)) activeBudgetCategoryKeys.add(k)
  }
  
  log('vacation_planner_budget_locks', {
    userId,
    totalBudgets: budgetLocks.totalBudgets,
    activeBudgets: budgetLocks.activeBudgets.length,
    overlappingBudgets: budgetLocks.overlappingBudgets.length,
    lockedCategoryIds: budgetedCategoryIds.size,
    lockedCategoryKeys: budgetedCategoryKeys.size,
    strictActiveLockedIds: activeBudgetCategoryIds.size,
    strictActiveLockedKeys: activeBudgetCategoryKeys.size
  })
  
  // Split essential vs non-essential
  const essentialVariableCents = Array.from(categorySpending.values())
    .filter((cat) => cat.tier === 'essential')
    .reduce((sum, cat) => sum + cat.spendCents, 0)
  
  const nonEssentialVariableCents = Array.from(categorySpending.values())
    .filter((cat) => cat.tier !== 'essential')
    .reduce((sum, cat) => sum + cat.spendCents, 0)
  
  const variableSpendCents = essentialVariableCents + nonEssentialVariableCents
  
  // Calculate base capacity
  const fixedObligationsCents = obligations.totalCents
  const baseCapacityCents = incomeCentsForPlanning - fixedObligationsCents - essentialVariableCents - nonEssentialVariableCents
  
  // Calculate required monthly savings
  const requiredMonthlyCents = Math.ceil(costCents / monthsToSave)
  
  // Compute adjusted requirement (avoid double-counting)
  const adjustedRequiredCents = computeAdjustedRequiredCentsVacation(
    requiredMonthlyCents,
    existingGoal.estimatedMonthlyCents,
    obligations.goalAutoSaveCents
  )
  
  // Calculate gap
  const gapCents = computeGapCents(adjustedRequiredCents, baseCapacityCents)
  
  // Build eligible categories: discretionary first, flexible essentials second, never essentials.
  const skippedBudgetedCategories: string[] = []
  let excludedByBudgetId = 0
  let excludedByBudgetKey = 0
  
  const eligibleCategories: EligibleCategory[] = []
  const seenEligibleCategoryIds = new Set<string>()
  const isBudgetLockedCategory = (categoryId: string, categoryName: string): boolean => {
    if (budgetedCategoryIds.has(categoryId) || activeBudgetCategoryIds.has(categoryId)) {
      excludedByBudgetId++
      return true
    }

    const catKeys = categoryLookupKeys(categoryName)
    if (catKeys.some((k) => budgetedCategoryKeys.has(k) || activeBudgetCategoryKeys.has(k))) {
      excludedByBudgetKey++
      return true
    }

    return false
  }

  for (const cat of cutCategorySpending.values()) {
    if (cat.tier !== 'discretionary' && cat.tier !== 'flexible_essential') continue
    
    // Skip zero spend
    if (cat.spendCents <= 0) continue
    
    if (isBudgetLockedCategory(cat.categoryId, cat.name)) {
      skippedBudgetedCategories.push(cat.name)
      continue
    }

    // Category is eligible for cuts
    seenEligibleCategoryIds.add(cat.categoryId)
    eligibleCategories.push({
      name: cat.name,
      spendCents: cat.spendCents,
      categoryId: cat.categoryId,
      categoryKey: cat.categoryId,
      expenseTier: cat.tier
    })
  }

  const totalEligibleSpendCents = eligibleCategories.reduce((sum, cat) => sum + Math.max(0, cat.spendCents), 0)
  
  log('vacation_planner_category_filtering', {
    userId,
    currentCycleCategories: categorySpending.size,
    fallbackCategories: fallbackCategorySpending.size,
    cutSourceCategories: cutCategorySpending.size,
    usedFallbackCategories,
    eligibleCategories: eligibleCategories.length,
    excludedByBudgetId,
    excludedByBudgetKey,
    skippedBudgetedCategories: skippedBudgetedCategories.join(', ')
  })
  
  // Guard: All categories budgeted
  if (eligibleCategories.length === 0 && skippedBudgetedCategories.length > 0) {
    warnings.push('All spending categories have active budgets. Consider adjusting budget caps to free up room for this goal.')
  }
  
  // Optional-only cut suggestions (never required for verdict).
  // We still target the monthly goal amount for optional planning.
  // allocateCappedCuts applies tier-aware caps: discretionary first, flexible essentials lower.
  const cutTargetCents = adjustedRequiredCents
  const cutAllocation = allocateCappedCuts(eligibleCategories, cutTargetCents)
  const { trimCategories, totalTrimmableCents, selectedCutCents } = cutAllocation
  const requiredCutPctOfEligibleSpend = adjustedRequiredCents > 0 && totalEligibleSpendCents > 0
    ? (adjustedRequiredCents / totalEligibleSpendCents) * 100
    : 0
  
  // Compute coverage (with optional cuts for projection visibility only)
  const coverage = computeCoverage(baseCapacityCents, adjustedRequiredCents, totalTrimmableCents)
  const { baseCoveragePct, comfortCoveragePct, maxCoveragePct } = coverage
  
  // Verdict is base-capacity only (cuts are optional and never required for verdict).
  const verdict = computeVerdict(baseCapacityCents, adjustedRequiredCents, baseCoveragePct)
  
  // Single cut mode for vacation planner.
  const cutMode = 'optional_buffer'
  
  // Calculate projections (recurring capacity)
  const monthlyAchievableCents = Math.max(0, baseCapacityCents + selectedCutCents)
  const projections = {
    month3Cents: monthlyAchievableCents * 3,
    month6Cents: monthlyAchievableCents * 6,
    month12Cents: monthlyAchievableCents * 12
  }
  
  // Generate explanation
  let wiseyTip = ''
  if (verdict === 'yes' && gapCents === 0) {
    if (selectedCutCents > 0) {
      wiseyTip = `Great news! You can already afford this plan. Optional cuts can additionally free up about ${formatCurrencyTextFromCents(selectedCutCents, currencyCode)}/month toward your ${vacationName} goal.`
    } else {
      wiseyTip = `Great news! You can save ${formatCurrencyTextFromCents(requiredMonthlyCents, currencyCode)}/month for your ${vacationName} without cutting anything.`
    }
  } else if (verdict === 'yes' && gapCents > 0) {
    wiseyTip = `You can reach this with your current monthly flow. Optional trims can still improve your buffer by about ${formatCurrencyTextFromCents(selectedCutCents, currencyCode)}/month.`
  } else if (verdict === 'close') {
    wiseyTip = `You're close based on current monthly flow. Optional trims can improve your safety buffer.`
  } else {
    wiseyTip = `Hard reach with current monthly flow. Optional trims can help, but they are not required for verdict.`
  }
  
  // Data quality assessment
  const dataQuality = cycleTransactions.length >= MIN_TRANSACTIONS_FOR_GOOD_QUALITY ? 'good' : 'limited'
  if (dataQuality === 'limited') {
    warnings.push('Limited transaction history. Add more transactions for better accuracy.')
  }
  
  // Log calculation
  log('vacation_planner_calculation', {
    userId,
    vacationName,
    costCents,
    monthsToSave,
    currentCycleIncomeCents,
    incomeCentsForPlanning,
    incomeCyclesUsed,
    incomeWindowAveraged,
    fixedObligationsCents,
    variableSpendCents,
    baseCapacityCents,
    adjustedRequiredCents,
    gapCents,
    requiredCutPctOfEligibleSpend: requiredCutPctOfEligibleSpend.toFixed(2),
    cutTargetCents,
    eligibleCategoriesCount: eligibleCategories.length,
    totalEligibleSpendCents,
    totalTrimmableCents,
    selectedCutCents,
    baseCoveragePct: baseCoveragePct.toFixed(1),
    maxCoveragePct: maxCoveragePct.toFixed(1),
    verdict,
    warnings: warnings.join(' | ')
  })
  
  // Build response
  return {
    type: 'vacation_plan',
    vacationName,
    costCents,
    targetMonth,
    monthsToSave,
    verdict,
    monthlySurplusCents: baseCapacityCents,
    requiredMonthlySavingCents: requiredMonthlyCents,
    fixedObligationsCents,
    trimCategories,
    totalTrimmableCents,
    selectedCutCents,
    maxOptionalCutCapacityCents: 0,
    baseCoveragePct,
    comfortCoveragePct,
    maxCoveragePct,
    cutMode,
    requiredCutToTargetCents: 0,
    requiredCutPctOfEligibleSpend,
    remainingMonthlySavingCents: adjustedRequiredCents,
    existingAutoSaving: {
      exists: existingGoal.exists,
      goalName: existingGoal.goalName,
      estimatedMonthlyCents: existingGoal.estimatedMonthlyCents
    },
    projections,
    wiseyTip,
    currencyCode,
    currencyWarning: Array.from(obligationCurrencyWarnings).join(' ') || null,
    daysRemainingInCycle: cycleRemainingDays,
    skippedBudgetedCategories,
    calculationContext: {
      mode: 'current_cycle',
      modeLabel: 'Current Cycle',
      incomeWindow: {
        label: incomeWindowAveraged
          ? `Average of ${incomeCyclesUsed} recent cycle(s)`
          : 'Current Cycle',
        startDate: incomeWindowAveraged
          ? toDateISO(getCycleWindowFromOffset(cycleStartDate, -INCOME_AVERAGE_CYCLES).start)
          : toDateISO(cycleStartDate),
        endDate: toDateISO(cycleEndDate)
      },
      fixedObligationsWindow: {
        label: useAverageFixedObligations
          ? `Average of next ${obligationWindowCount} cycles`
          : 'Current Cycle',
        startDate: obligationWindows[0]?.startDateISO || toDateISO(cycleStartDate),
        endDate: obligationWindows[obligationWindows.length - 1]?.endDateISO || toDateISO(cycleEndDate)
      },
      variableSpendWindow: {
        label: 'Current Cycle',
        startDate: toDateISO(cycleStartDate),
        endDate: toDateISO(cycleEndDate)
      },
      fixedObligationsBreakdown: {
        billsCents: obligations.billsCents,
        plannedPaymentsCents: obligations.plannedPaymentsCents,
        subscriptionsCents: obligations.subscriptionsCents,
        goalAutoSaveCents: obligations.goalAutoSaveCents,
        totalCents: obligations.totalCents
      }
    },
    dataQuality,
    cyclesUsed: useAverageFixedObligations ? obligationWindowCount : 'current',
    obligationsDiagnostics,
    warnings
  }
}

// Serve wrapper
serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }
  
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing Authorization header')
    }

    const serviceSupabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(serviceSupabase, req)
    const userId = user.id

    // Use user-scoped client for reads/RPC so auth.uid() works in RPC policies.
    const userScopedSupabase = buildUserScopedSupabaseClient(authHeader)
    
    const body = await req.json()
    
    const result = await handleVacationPlannerRequest(body, { supabase: userScopedSupabase, userId })
    
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    })
    
  } catch (error: any) {
    logError('vacation_planner_error', {
      error: error.message,
      stack: error.stack
    })
    
    return new Response(
      JSON.stringify({
        type: 'error',
        error: error.message || 'Internal server error'
      }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
