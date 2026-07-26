import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import {
  normalizeTransactionsToMainCurrency,
  normalizeWalletBalancesToMainCurrency,
  resolveMainCurrencyCode,
} from '../_shared/currencyReporting.ts'
import {
  buildCentNormalizationWarning,
  normalizeCentFieldsToMainCurrency,
  type CentCurrencyNormalizationResult,
} from '../_shared/centCurrency.ts'

/**
 * Financial Health Score - Phase 1: Data Fetching Layer
 * 
 * Computes a 0-100 financial health score with 5 component breakdown:
 * - Emergency Preparedness (months of runway)
 * - Debt Health (DTI ratio)
 * - Savings Rate (% of income saved)
 * - Budget Discipline (% of budgets on track)
 * - Spending Health (% of income spent)
 * 
 * Evidence-first: Returns partial results if data is missing.
 */

// Timing helper
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const HEALTH_SCORE_TX_WINDOW_DAYS = 90
const HEALTH_SCORE_TX_ROW_LIMIT = 1000

function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function formatCurrency(amount: number, currencyCode: string, fractionDigits = 2): string {
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

// Income detection helpers
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

// Transfer categories to exclude
const TRANSFER_CATEGORIES = ['transfer', 'internal-transfer', 'wallet-transfer', 'money-transfer']

function isExcludedTxForCashFlow(tx: any): boolean {
  if (!tx) return true
  if (tx.is_opening_balance === true) return true
  if (tx.is_manual_topup === true) return true

  const categoryRaw = typeof tx.category === 'string' ? tx.category : ''
  const category = categoryRaw.toLowerCase()

  if (TRANSFER_CATEGORIES.some((t) => category.includes(t))) return true
  if (category.includes('opening balance')) return true
  if (category.includes('owner contribution')) return true

  return false
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return n
}

function safeDivide(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
  return n / d
}

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(inMin) || !Number.isFinite(inMax) || inMax === inMin) return outMin
  const t = (value - inMin) / (inMax - inMin)
  const tt = clamp01(t)
  return outMin + (outMax - outMin) * tt
}

type ComponentStatus = 'critical' | 'warning' | 'good' | 'excellent' | 'unknown'
type DebtAssessmentMode = 'none' | 'structured_payment' | 'manual_progress' | 'insufficient_data'
type HealthComponentKey =
  | 'emergency_preparedness'
  | 'debt_health'
  | 'savings_rate'
  | 'budget_discipline'
  | 'spending_health'
type QueryFailureKey =
  | 'wallets_query_failed'
  | 'transactions_query_failed'
  | 'debts_query_failed'
  | 'budgets_query_failed'
  | 'goals_query_failed'
  | 'subscriptions_query_failed'
  | 'bills_query_failed'
  | 'preferences_query_failed'
  | 'planned_payments_query_failed'
type BlockedComponentReasons = Partial<Record<HealthComponentKey, QueryFailureKey[]>>

interface EmergencyPreparednessComponent {
  score: number
  status: ComponentStatus
  emergencyBalance: number
  monthlyEssentials: number | null
  monthsCovered: number | null
}

interface DebtHealthComponent {
  score: number
  status: ComponentStatus
  assessmentMode: DebtAssessmentMode
  monthlyDebtPayments: number | null
  monthlyIncome: number | null
  dtiPercent: number | null
  activeDebtCount: number
  activeDebtMissingPaymentCount: number
  remainingDebtTotal: number
  totalDebtOriginal: number
  totalDebtPaid: number
  repaymentProgressPercent: number | null
  remainingDebtToIncomePercent: number | null
  remainingDebtToBalancePercent: number | null
  oldestActiveDebtAgeDays: number | null
}

interface SavingsRateComponent {
  score: number
  status: ComponentStatus
  monthlyIncome: number | null
  monthlyExpenses: number | null
  monthlyNet: number | null
  savingsRatePercent: number | null
  method: 'net_income_minus_expenses'
}

interface BudgetDisciplineComponent {
  score: number
  status: ComponentStatus
  budgetsTotal: number
  budgetsOnTrack: number
  adherencePercent: number | null
  averagePacePercent: number | null
  budgetsOverPace: number
}

interface SpendingHealthComponent {
  score: number
  status: ComponentStatus
  monthlyIncome: number | null
  monthlyExpenses: number | null
  spendingRatePercent: number | null
}

interface ScoreBreakdown {
  key: string
  title: string
  descriptorKey: string
  params: Record<string, unknown>
  description: string
  status: ComponentStatus
}

interface DebtPaymentSummary {
  activeDebtCount: number
  activeDebtMissingPaymentCount: number
  monthlyDebtPayments: number | null
  remainingDebtTotal: number
  totalDebtOriginal: number
  totalDebtPaid: number
  oldestActiveDebtAgeDays: number | null
}

interface BudgetScoreWindow {
  start: Date
  endExclusive: Date
  totalDays: number
  daysElapsed: number
  daysRemaining: number
  elapsedRatio: number
}

interface CashFlowWindowAggregate {
  monthlyIncome: number | null
  monthlyExpenses: number | null
  windowDays: number
}

const QUERY_FAILURE_LABELS: Record<QueryFailureKey, string> = {
  wallets_query_failed: 'wallet balances',
  transactions_query_failed: 'transactions',
  debts_query_failed: 'debts',
  budgets_query_failed: 'budgets',
  goals_query_failed: 'goals',
  subscriptions_query_failed: 'subscriptions',
  bills_query_failed: 'bills',
  preferences_query_failed: 'cycle settings',
  planned_payments_query_failed: 'planned payments',
}

const COMPONENT_QUERY_DEPENDENCIES: Record<HealthComponentKey, QueryFailureKey[]> = {
  emergency_preparedness: [
    'wallets_query_failed',
    'subscriptions_query_failed',
    'bills_query_failed',
    'planned_payments_query_failed',
    'preferences_query_failed',
  ],
  debt_health: [
    'debts_query_failed',
    'transactions_query_failed',
    'wallets_query_failed',
  ],
  savings_rate: ['transactions_query_failed'],
  budget_discipline: [
    'budgets_query_failed',
    'transactions_query_failed',
    'preferences_query_failed',
  ],
  spending_health: ['transactions_query_failed'],
}

function listToSentence(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function getComponentBlockingState(missingData: string[]): {
  blockedComponents: HealthComponentKey[]
  componentFailureReasons: BlockedComponentReasons
} {
  const queryFailures = new Set<QueryFailureKey>()
  for (const item of missingData) {
    if (Object.prototype.hasOwnProperty.call(QUERY_FAILURE_LABELS, item)) {
      queryFailures.add(item as QueryFailureKey)
    }
  }

  const blockedComponents: HealthComponentKey[] = []
  const componentFailureReasons: BlockedComponentReasons = {}

  ;(Object.keys(COMPONENT_QUERY_DEPENDENCIES) as HealthComponentKey[]).forEach((componentKey) => {
    const failures = COMPONENT_QUERY_DEPENDENCIES[componentKey].filter((failure) => queryFailures.has(failure))
    if (failures.length > 0) {
      blockedComponents.push(componentKey)
      componentFailureReasons[componentKey] = failures
    }
  })

  return { blockedComponents, componentFailureReasons }
}

function describeComponentFailureReasons(reasons: QueryFailureKey[] | undefined): string {
  if (!reasons || reasons.length === 0) {
    return 'Wisey could not load all of the required data for this row right now.'
  }

  const labels = reasons
    .map((reason) => QUERY_FAILURE_LABELS[reason])
    .filter((label): label is string => Boolean(label))

  if (labels.length === 0) {
    return 'Wisey could not load all of the required data for this row right now.'
  }

  return `Wisey could not load ${listToSentence(labels)} right now, so this row is temporarily unavailable.`
}

function markEmergencyPreparednessUnavailable(component: EmergencyPreparednessComponent): EmergencyPreparednessComponent {
  return {
    ...component,
    score: 0,
    status: 'unknown',
    monthlyEssentials: null,
    monthsCovered: null,
  }
}

function markDebtHealthUnavailable(component: DebtHealthComponent): DebtHealthComponent {
  return {
    ...component,
    score: 0,
    status: 'unknown',
    assessmentMode: 'insufficient_data',
    monthlyDebtPayments: null,
    monthlyIncome: null,
    dtiPercent: null,
    repaymentProgressPercent: null,
    remainingDebtToIncomePercent: null,
    remainingDebtToBalancePercent: null,
    oldestActiveDebtAgeDays: null,
  }
}

function markSavingsRateUnavailable(component: SavingsRateComponent): SavingsRateComponent {
  return {
    ...component,
    score: 0,
    status: 'unknown',
    monthlyIncome: null,
    monthlyExpenses: null,
    monthlyNet: null,
    savingsRatePercent: null,
  }
}

function markBudgetDisciplineUnavailable(component: BudgetDisciplineComponent): BudgetDisciplineComponent {
  return {
    ...component,
    score: 0,
    status: 'unknown',
    adherencePercent: null,
    averagePacePercent: null,
  }
}

function markSpendingHealthUnavailable(component: SpendingHealthComponent): SpendingHealthComponent {
  return {
    ...component,
    score: 0,
    status: 'unknown',
    monthlyIncome: null,
    monthlyExpenses: null,
    spendingRatePercent: null,
  }
}

function looksLikeDebtPlannedPayment(planned: any, debts: any[]): boolean {
  if (!planned) return false
  if (!debts || !debts.length) return false

  const nameRaw = typeof planned?.name === 'string' ? planned.name : ''
  const name = nameRaw.trim().toLowerCase()
  if (!name) return false

  const keywords = ['loan', 'debt', 'payment', 'installment', 'emi']
  const hasKeyword = keywords.some((k) => name.includes(k))
  if (!hasKeyword) return false

  const plannedAmountDollars = amountCentsToDollars(planned?.amount_cents)
  if (!(plannedAmountDollars > 0)) return false

  // If the planned payment amount matches any debt's monthly payment (or minimum payment)
  // within a reasonable tolerance ($50 or 5%), assume it is an auto-generated debt payment
  // and should not also count as an essential.
  return (debts || []).some((d) => {
    const mp = asNumber(d?.monthly_payment_cents)
    const minp = asNumber(d?.minimum_payment_cents)
    const chosenCents = mp > 0 ? mp : minp
    const chosenDollars = chosenCents > 0 ? chosenCents / 100 : 0

    if (!(chosenDollars > 0)) return false

    const diff = Math.abs(chosenDollars - plannedAmountDollars)
    const tolerance = Math.max(50, chosenDollars * 0.05) // $50 or 5% tolerance

    return diff <= tolerance
  })
}

function parseDateOnlyUtc(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  const ms = d.getTime()
  if (!Number.isFinite(ms)) return null
  return startOfDayUtc(d)
}

function parseDateTimeUtc(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  const ms = d.getTime()
  if (!Number.isFinite(ms)) return null
  return d
}

function amountCentsToDollars(value: unknown): number {
  const cents = asNumber(value)
  return cents / 100
}

function monthlyizeByFrequency(amount: number, freq: unknown): number {
  const f = typeof freq === 'string' ? freq.trim().toLowerCase() : ''
  if (f === 'weekly') return amount * 4.33
  if (f === 'quarterly') return amount / 3
  if (f === 'yearly') return amount / 12
  // Default MONTHLY or unknown
  return amount
}

function monthlyizeBySubscriptionBillingCycle(amount: number, cycle: unknown): number {
  const c = typeof cycle === 'string' ? cycle.trim().toLowerCase() : ''
  // Keep factors consistent with monthlyizeByFrequency (4.33 ~= 52/12).
  if (c === 'daily') return amount * 30.42 // ~= 365/12
  if (c === 'weekly') return amount * 4.33
  if (c === 'yearly') return amount / 12
  // Default MONTHLY or unknown
  return amount
}

function statusFromScore(score: number): ComponentStatus {
  const s = clampPercent(score)
  if (s <= 30) return 'critical'
  if (s <= 60) return 'warning'
  if (s <= 80) return 'good'
  return 'excellent'
}

function ratingFromOverallScore(score: number): ComponentStatus {
  return statusFromScore(score)
}

function computeOverallScore(scores: number[]): number {
  const valid = (scores || []).filter((s) => Number.isFinite(s))
  if (!valid.length) return 0
  const avg = valid.reduce((sum, s) => sum + s, 0) / valid.length
  return clampPercent(avg)
}

function buildScoreBreakdowns(params: {
  emergency: EmergencyPreparednessComponent
  debt: DebtHealthComponent
  savings: SavingsRateComponent
  budget: BudgetDisciplineComponent
  spending: SpendingHealthComponent
  windowDays: number
  currencyCode: string
  componentFailureReasons: BlockedComponentReasons
}): ScoreBreakdown[] {
  const breakdowns: ScoreBreakdown[] = []

  // Emergency Preparedness
  const emergencyFailureReasons = params.componentFailureReasons.emergency_preparedness
  if (emergencyFailureReasons?.length) {
    breakdowns.push({
      key: 'emergency_preparedness',
      title: 'Emergency Preparedness',
      descriptorKey: 'component_unavailable',
      params: {
        failureReasonKeys: emergencyFailureReasons,
      },
      status: 'unknown',
      description: describeComponentFailureReasons(emergencyFailureReasons),
    })
  } else if (params.emergency.monthlyEssentials === null) {
    breakdowns.push({
      key: 'emergency_preparedness',
      title: 'Emergency Preparedness',
      descriptorKey: 'emergency_needs_data',
      params: {},
      status: params.emergency.status,
      description: 'Requires data. We need to sync your bills, subscriptions, or planned payments to calculate your monthly essentials base. Only wallets marked as Emergency count toward this row.',
    })
  } else if (params.emergency.monthlyEssentials === 0) {
    breakdowns.push({
      key: 'emergency_preparedness',
      title: 'Emergency Preparedness',
      descriptorKey: 'emergency_no_obligations',
      params: {},
      status: params.emergency.status,
      description: 'Excellent. You currently have absolutely no recorded monthly essentials or fixed obligations. Only wallets marked as Emergency count toward this row.',
    })
  } else {
    const bal = formatCurrency(params.emergency.emergencyBalance, params.currencyCode, 0)
    const mos = params.emergency.monthsCovered?.toFixed(1) || '0'
    breakdowns.push({
      key: 'emergency_preparedness',
      title: 'Emergency Preparedness',
      descriptorKey: 'emergency_computed',
      params: {
        emergencyBalance: params.emergency.emergencyBalance,
        currencyCode: params.currencyCode,
        monthsCovered: params.emergency.monthsCovered,
      },
      status: params.emergency.status,
      description: `Based on your monthly essentials, your emergency balance of ${bal} covers roughly ${mos} months. Only wallets marked as Emergency count toward this row.`,
    })
  }

  // Debt Health
  const debtFailureReasons = params.componentFailureReasons.debt_health
  if (debtFailureReasons?.length) {
    breakdowns.push({
      key: 'debt_health',
      title: 'Debt Health',
      descriptorKey: 'component_unavailable',
      params: {
        failureReasonKeys: debtFailureReasons,
      },
      status: 'unknown',
      description: describeComponentFailureReasons(debtFailureReasons),
    })
  } else if (params.debt.activeDebtCount === 0) {
    breakdowns.push({
      key: 'debt_health',
      title: 'Debt Health',
      descriptorKey: 'debt_none',
      params: {},
      status: params.debt.status,
      description: 'Perfect score. You currently have zero recorded active debts, meaning your debt-to-income pressure is 0%.',
    })
  } else if (params.debt.assessmentMode === 'manual_progress') {
    const remaining = formatCurrency(params.debt.remainingDebtTotal, params.currencyCode, 0)
    const paid = formatCurrency(params.debt.totalDebtPaid, params.currencyCode, 0)
    const original = formatCurrency(params.debt.totalDebtOriginal, params.currencyCode, 0)
    const progress = params.debt.repaymentProgressPercent !== null
      ? params.debt.repaymentProgressPercent.toFixed(0)
      : '0'
    const pressureText = params.debt.remainingDebtToIncomePercent !== null
      ? ` The remaining debt is about ${params.debt.remainingDebtToIncomePercent.toFixed(0)}% of your typical monthly income (based on the last ${params.windowDays} days).`
      : params.debt.remainingDebtToBalancePercent !== null
        ? ` The remaining debt is about ${params.debt.remainingDebtToBalancePercent.toFixed(0)}% of your current wallet balance.`
        : ''
    const ageText = params.debt.oldestActiveDebtAgeDays !== null
      ? ` The oldest active debt has been tracked for ${params.debt.oldestActiveDebtAgeDays} day(s).`
      : ''
    const reasonType = params.debt.monthlyDebtPayments !== null && params.debt.monthlyDebtPayments > 0
      ? 'no_income'
      : 'no_payment_terms'
    const reasonText = reasonType === 'no_income'
      ? 'because monthly income is not available for a debt-to-income ratio'
      : 'because these debt records do not have monthly payment terms'
    const pressureType = params.debt.remainingDebtToIncomePercent !== null
      ? 'income'
      : params.debt.remainingDebtToBalancePercent !== null
        ? 'balance'
        : 'none'
    const pressurePercent = params.debt.remainingDebtToIncomePercent !== null
      ? params.debt.remainingDebtToIncomePercent
      : params.debt.remainingDebtToBalancePercent
    breakdowns.push({
      key: 'debt_health',
      title: 'Debt Health',
      descriptorKey: 'debt_manual_progress',
      params: {
        remainingDebtTotal: params.debt.remainingDebtTotal,
        totalDebtPaid: params.debt.totalDebtPaid,
        totalDebtOriginal: params.debt.totalDebtOriginal,
        currencyCode: params.currencyCode,
        activeDebtCount: params.debt.activeDebtCount,
        repaymentProgressPercent: params.debt.repaymentProgressPercent,
        reasonType,
        pressureType,
        pressurePercent: pressurePercent ?? null,
        windowDays: params.windowDays,
        oldestActiveDebtAgeDays: params.debt.oldestActiveDebtAgeDays,
      },
      status: params.debt.status,
      description: `Limited confidence. You have ${remaining} remaining across ${params.debt.activeDebtCount} active debt(s). Wisey scored this from repayment progress ${reasonText}: ${paid} paid from ${original} total (${progress}% repaid).${pressureText}${ageText}`,
    })
  } else if (params.debt.assessmentMode === 'insufficient_data') {
    const needsCashFlowWindow =
      params.debt.monthlyDebtPayments !== null &&
      params.debt.monthlyIncome === null
    breakdowns.push({
      key: 'debt_health',
      title: 'Debt Health',
      descriptorKey: needsCashFlowWindow
        ? 'debt_insufficient_needs_cashflow'
        : 'debt_insufficient_needs_amount',
      params: {},
      status: params.debt.status,
      description: needsCashFlowWindow
        ? 'Requires data. We need at least 30 days of transactions to calculate your debt-to-income ratio.'
        : 'Requires data. Wisey needs at least a remaining debt amount or a total debt amount before it can score this row.',
    })
  } else {
    const dti = params.debt.dtiPercent?.toFixed(1) || '0'
    const partialText = params.debt.activeDebtMissingPaymentCount > 0
      ? ` ${params.debt.activeDebtMissingPaymentCount} active debt(s) are still missing monthly payment terms, so the score is capped until those are filled in.`
      : ''
    breakdowns.push({
      key: 'debt_health',
      title: 'Debt Health',
      descriptorKey: 'debt_dti',
      params: {
        dtiPercent: params.debt.dtiPercent,
        windowDays: params.windowDays,
        activeDebtMissingPaymentCount: params.debt.activeDebtMissingPaymentCount,
      },
      status: params.debt.status,
      description: `Your debt-to-income ratio is ${dti}%. This reflects how much of your typical monthly income (based on the last ${params.windowDays} days) is tied up in minimum debt obligations.${partialText}`,
    })
  }

  // Savings Rate
  const savingsFailureReasons = params.componentFailureReasons.savings_rate
  if (savingsFailureReasons?.length) {
    breakdowns.push({
      key: 'savings_rate',
      title: 'Savings Rate',
      descriptorKey: 'component_unavailable',
      params: {
        failureReasonKeys: savingsFailureReasons,
      },
      status: 'unknown',
      description: describeComponentFailureReasons(savingsFailureReasons),
    })
  } else if (params.savings.savingsRatePercent === null) {
    breakdowns.push({
      key: 'savings_rate',
      title: 'Savings Rate',
      descriptorKey: 'savings_needs_data',
      params: {},
      status: params.savings.status,
      description: 'Requires data. We need at least 30 days of transactions to calculate this row.',
    })
  } else {
    const rate = params.savings.savingsRatePercent.toFixed(1)
    const verb = params.savings.savingsRatePercent >= 15 ? 'successfully saving' : 'saving'
    breakdowns.push({
      key: 'savings_rate',
      title: 'Savings Rate',
      descriptorKey: 'savings_computed',
      params: {
        windowDays: params.windowDays,
        savingsRatePercent: params.savings.savingsRatePercent,
      },
      status: params.savings.status,
      description: `Based on your last ${params.windowDays} days of transactions, you are ${verb} ${rate}% of your income after total monthly expenses are deducted.`,
    })
  }

  // Budget Discipline
  const budgetFailureReasons = params.componentFailureReasons.budget_discipline
  if (budgetFailureReasons?.length) {
    breakdowns.push({
      key: 'budget_discipline',
      title: 'Budget Discipline',
      descriptorKey: 'component_unavailable',
      params: {
        failureReasonKeys: budgetFailureReasons,
      },
      status: 'unknown',
      description: describeComponentFailureReasons(budgetFailureReasons),
    })
  } else if (params.budget.adherencePercent === null) {
    breakdowns.push({
      key: 'budget_discipline',
      title: 'Budget Discipline',
      descriptorKey: 'budget_needs_data',
      params: {},
      status: params.budget.status,
      description: 'Requires data. Create at least one active budget to start tracking your discipline.',
    })
  } else {
    breakdowns.push({
      key: 'budget_discipline',
      title: 'Budget Discipline',
      descriptorKey: 'budget_computed',
      params: {
        budgetsOnTrack: params.budget.budgetsOnTrack,
        budgetsTotal: params.budget.budgetsTotal,
        averagePacePercent: params.budget.averagePacePercent,
      },
      status: params.budget.status,
      description: `You are on pace for ${params.budget.budgetsOnTrack} out of ${params.budget.budgetsTotal} active budgets. Average budget pace is ${(params.budget.averagePacePercent ?? 0).toFixed(0)}% of the planned daily speed.`,
    })
  }

  // Spending Health
  const spendingFailureReasons = params.componentFailureReasons.spending_health
  if (spendingFailureReasons?.length) {
    breakdowns.push({
      key: 'spending_health',
      title: 'Spending Health',
      descriptorKey: 'component_unavailable',
      params: {
        failureReasonKeys: spendingFailureReasons,
      },
      status: 'unknown',
      description: describeComponentFailureReasons(spendingFailureReasons),
    })
  } else if (params.spending.spendingRatePercent === null) {
    breakdowns.push({
      key: 'spending_health',
      title: 'Spending Health',
      descriptorKey: 'spending_needs_data',
      params: {},
      status: params.spending.status,
      description: 'Requires data. We need at least 30 days of transactions to calculate this row.',
    })
  } else {
    const rate = params.spending.spendingRatePercent.toFixed(1)
    breakdowns.push({
      key: 'spending_health',
      title: 'Spending Health',
      descriptorKey: 'spending_computed',
      params: {
        windowDays: params.windowDays,
        spendingRatePercent: params.spending.spendingRatePercent,
      },
      status: params.spending.status,
      description: `Based on your last ${params.windowDays} days of transactions, your monthly lifestyle spending equates to ${rate}% of your total income.`,
    })
  }

  return breakdowns
}

function getTxAmount(tx: any): number {
  const amt = asNumber(tx?.amount)
  return amt
}

function sumTxIncome(transactions: any[]): number {
  return (transactions || [])
    .filter((t) => !isExcludedTxForCashFlow(t))
    .filter((t) => getTxAmount(t) > 0)
    .filter((t) => isIncomeTransaction(t))
    .reduce((sum, t) => sum + getTxAmount(t), 0)
}

function sumTxExpenses(transactions: any[]): number {
  return (transactions || [])
    .filter((t) => !isExcludedTxForCashFlow(t))
    .filter((t) => getTxAmount(t) < 0)
    .filter((t) => !isIncomeTransaction(t))
    .reduce((sum, t) => sum + Math.abs(getTxAmount(t)), 0)
}

function monthlyizeFromWindow(windowDays: number | null, amountInWindow: number): number | null {
  if (!windowDays || !Number.isFinite(windowDays) || windowDays <= 0) return null
  const factor = 30 / windowDays
  return amountInWindow * factor
}

function computeTypicalMonthlyCashFlow(transactions: any[], now: Date): CashFlowWindowAggregate {
  const dayMs = 24 * 60 * 60 * 1000
  const nowTime = now.getTime()
  const ninetyDaysAgoMs = nowTime - (90 * dayMs)

  const datedTransactions = (transactions || []).filter((tx) => {
    const dt = new Date(String(tx?.date || ''))
    const ms = dt.getTime()
    return Number.isFinite(ms) && ms >= ninetyDaysAgoMs && ms <= nowTime
  })

  if (datedTransactions.length === 0) {
    return {
      monthlyIncome: null,
      monthlyExpenses: null,
      windowDays: 0,
    }
  }

  const earliestNonExcludedMs = datedTransactions.reduce<number | null>((earliest, tx) => {
    if (isExcludedTxForCashFlow(tx)) return earliest
    const ms = new Date(String(tx?.date || '')).getTime()
    if (!Number.isFinite(ms)) return earliest
    return earliest === null ? ms : Math.min(earliest, ms)
  }, null)

  const earliestFallbackMs = datedTransactions.reduce<number | null>((earliest, tx) => {
    const ms = new Date(String(tx?.date || '')).getTime()
    if (!Number.isFinite(ms)) return earliest
    return earliest === null ? ms : Math.min(earliest, ms)
  }, null)

  const earliestMs = earliestNonExcludedMs ?? earliestFallbackMs
  if (earliestMs === null) {
    return {
      monthlyIncome: null,
      monthlyExpenses: null,
      windowDays: 0,
    }
  }

  const windowStartMs = Math.max(earliestMs, ninetyDaysAgoMs)
  const windowTransactions = datedTransactions.filter((tx) => {
    const ms = new Date(String(tx?.date || '')).getTime()
    return Number.isFinite(ms) && ms >= windowStartMs
  })
  const windowDays = Math.max(1, Math.ceil((nowTime - windowStartMs) / dayMs))
  const incomeInWindow = sumTxIncome(windowTransactions)
  const expensesInWindow = sumTxExpenses(windowTransactions)

  if (windowDays < 30) {
    return {
      monthlyIncome: null,
      monthlyExpenses: null,
      windowDays,
    }
  }

  return {
    monthlyIncome: monthlyizeFromWindow(windowDays, incomeInWindow),
    monthlyExpenses: monthlyizeFromWindow(windowDays, expensesInWindow),
    windowDays,
  }
}

function getRemainingDebtCents(debt: any): number {
  const remaining = asNumber(debt?.remaining_amount_cents)
  if (remaining > 0) return remaining

  const total = asNumber(debt?.total_amount_cents)
  const paid = asNumber(debt?.amount_paid_cents)
  const inferred = total - paid
  return inferred > 0 ? inferred : 0
}

function getOriginalDebtCents(debt: any): number {
  const remaining = getRemainingDebtCents(debt)
  const total = asNumber(debt?.total_amount_cents)
  if (total > 0) return Math.max(total, remaining)
  return remaining
}

function getDebtAgeDays(debt: any, now: Date): number | null {
  const raw = debt?.created_at || debt?.updated_at
  if (!raw) return null

  const created = new Date(String(raw))
  const ms = created.getTime()
  if (!Number.isFinite(ms)) return null

  const ageMs = Math.max(0, now.getTime() - ms)
  return Math.floor(ageMs / (24 * 60 * 60 * 1000))
}

function computeDebtPaymentSummary(debts: any[], now: Date = new Date()): DebtPaymentSummary {
  const active = (debts || []).filter((d) => d && getRemainingDebtCents(d) > 0)

  if (!active.length) {
    return {
      activeDebtCount: 0,
      activeDebtMissingPaymentCount: 0,
      monthlyDebtPayments: 0,
      remainingDebtTotal: 0,
      totalDebtOriginal: 0,
      totalDebtPaid: 0,
      oldestActiveDebtAgeDays: null,
    }
  }

  let paymentCentsTotal = 0
  let remainingCentsTotal = 0
  let originalCentsTotal = 0
  let paidCentsTotal = 0
  let missingPaymentCount = 0
  let oldestActiveDebtAgeDays: number | null = null

  for (const debt of active) {
    const remainingCents = getRemainingDebtCents(debt)
    const originalCents = getOriginalDebtCents(debt)
    const paidCents = Math.max(0, originalCents - remainingCents)
    const ageDays = getDebtAgeDays(debt, now)

    remainingCentsTotal += remainingCents
    originalCentsTotal += originalCents
    paidCentsTotal += paidCents
    if (ageDays !== null) {
      oldestActiveDebtAgeDays = oldestActiveDebtAgeDays === null
        ? ageDays
        : Math.max(oldestActiveDebtAgeDays, ageDays)
    }

    const monthlyPayment = asNumber(debt?.monthly_payment_cents)
    const minimumPayment = asNumber(debt?.minimum_payment_cents)
    const chosenPayment = monthlyPayment > 0 ? monthlyPayment : minimumPayment

    if (chosenPayment > 0) {
      paymentCentsTotal += chosenPayment
    } else {
      missingPaymentCount += 1
    }
  }

  return {
    activeDebtCount: active.length,
    activeDebtMissingPaymentCount: missingPaymentCount,
    monthlyDebtPayments: paymentCentsTotal > 0 ? paymentCentsTotal / 100 : null,
    remainingDebtTotal: remainingCentsTotal / 100,
    totalDebtOriginal: originalCentsTotal / 100,
    totalDebtPaid: paidCentsTotal / 100,
    oldestActiveDebtAgeDays,
  }
}

function computeMonthlyEssentialsFromObligations(
  subscriptions: any[],
  bills: any[],
  plannedPayments: any[],
  window: { start: Date; endExclusive: Date },
): number | null {
  // Essentials definition (per Mo): bills + planned payments + subscriptions
  // Evidence-first: if we have none of the sources, return null.
  const hasAny =
    (subscriptions && subscriptions.length > 0) ||
    (bills && bills.length > 0) ||
    (plannedPayments && plannedPayments.length > 0)

  if (!hasAny) return null

  const subsMonthly = (subscriptions || []).reduce((sum, s) => {
    // subscriptions.amount_cents is stored as the billing amount for its billing_cycle.
    const amt = amountCentsToDollars(s?.amount_cents)
    if (!(amt > 0)) return sum
    const monthlyEq = monthlyizeBySubscriptionBillingCycle(amt, s?.billing_cycle)
    return sum + Math.max(0, monthlyEq)
  }, 0)

  const billsMonthly = (bills || []).reduce((sum, b) => {
    const isPaid = b?.is_paid === true
    if (isPaid) return sum

    const amt = amountCentsToDollars(b?.amount_cents)
    if (!(amt > 0)) return sum

    const isRecurring = b?.is_recurring === true
    const due = parseDateOnlyUtc(b?.due_date)

    if (isRecurring) {
      return sum + monthlyizeByFrequency(amt, b?.recurring_frequency)
    }

    // One-off bill: include only if due within the current cycle window.
    if (!due) return sum
    const ms = due.getTime()
    if (ms >= window.start.getTime() && ms < window.endExclusive.getTime()) {
      return sum + amt
    }
    return sum
  }, 0)

  const plannedMonthly = (plannedPayments || []).reduce((sum, p) => {
    const isPaid = p?.is_paid === true
    if (isPaid) return sum

    const amt = amountCentsToDollars(p?.amount_cents)
    if (!(amt > 0)) return sum

    const isRecurring = p?.is_recurring === true
    const due = parseDateOnlyUtc(p?.due_date)

    if (isRecurring) {
      return sum + monthlyizeByFrequency(amt, p?.recurring_frequency)
    }

    // One-off planned payment: include only if due within the current cycle window.
    if (!due) return sum
    const ms = due.getTime()
    if (ms >= window.start.getTime() && ms < window.endExclusive.getTime()) {
      return sum + amt
    }
    return sum
  }, 0)

  return subsMonthly + billsMonthly + plannedMonthly
}

function scoreEmergencyPreparedness(emergencyBalance: number, monthlyEssentials: number | null): EmergencyPreparednessComponent {
  if (monthlyEssentials === null) {
    return {
      score: 0,
      status: 'critical',
      emergencyBalance,
      monthlyEssentials,
      monthsCovered: null,
    }
  }

  // No essentials = excellent (infinite runway)
  if (monthlyEssentials === 0) {
    return {
      score: 100,
      status: 'excellent',
      emergencyBalance,
      monthlyEssentials,
      monthsCovered: 999,
    }
  }

  const monthsCovered = monthlyEssentials > 0 ? emergencyBalance / monthlyEssentials : null

  let score = 0
  if (monthsCovered === null) {
    score = 0
  } else if (monthsCovered < 1) {
    score = mapRange(monthsCovered, 0, 1, 0, 30)
  } else if (monthsCovered < 3) {
    score = mapRange(monthsCovered, 1, 3, 31, 60)
  } else if (monthsCovered < 6) {
    score = mapRange(monthsCovered, 3, 6, 61, 80)
  } else {
    score = 81 + Math.min(19, (monthsCovered - 6) * 3)
  }

  score = clampPercent(score)
  return {
    score,
    status: statusFromScore(score),
    emergencyBalance,
    monthlyEssentials,
    monthsCovered,
  }
}

function scoreDebtRepaymentProgress(progressPercent: number | null, ageDays: number | null): number {
  if (progressPercent === null) return 35

  let score = 0
  if (progressPercent <= 0) {
    score = 35
  } else if (progressPercent < 25) {
    score = mapRange(progressPercent, 0, 25, 35, 58)
  } else if (progressPercent < 50) {
    score = mapRange(progressPercent, 25, 50, 59, 75)
  } else if (progressPercent < 80) {
    score = mapRange(progressPercent, 50, 80, 76, 90)
  } else {
    score = mapRange(Math.min(progressPercent, 100), 80, 100, 91, 100)
  }

  // Be gentle with debts that were just created, but do not let old untouched debts look healthy.
  if (ageDays !== null && ageDays < 14 && progressPercent < 10) {
    score = Math.min(55, score + 10)
  } else if (ageDays !== null && ageDays > 120 && progressPercent < 10) {
    score = Math.max(20, score - 10)
  }

  return clampPercent(score)
}

function scoreRemainingDebtPressure(remainingDebtTotal: number, monthlyIncome: number | null, activeAssetBalance: number | null): number {
  const incomeRatio = monthlyIncome !== null && monthlyIncome > 0
    ? (remainingDebtTotal / monthlyIncome) * 100
    : null

  if (incomeRatio !== null) {
    if (incomeRatio <= 25) return mapRange(incomeRatio, 0, 25, 100, 90)
    if (incomeRatio <= 50) return mapRange(incomeRatio, 25, 50, 89, 75)
    if (incomeRatio <= 100) return mapRange(incomeRatio, 50, 100, 74, 55)
    if (incomeRatio <= 200) return mapRange(incomeRatio, 100, 200, 54, 30)
    return mapRange(Math.min(incomeRatio, 400), 200, 400, 29, 5)
  }

  const balanceRatio = activeAssetBalance !== null && activeAssetBalance > 0
    ? (remainingDebtTotal / activeAssetBalance) * 100
    : null

  if (balanceRatio !== null) {
    if (balanceRatio <= 10) return mapRange(balanceRatio, 0, 10, 100, 95)
    if (balanceRatio <= 25) return mapRange(balanceRatio, 10, 25, 94, 80)
    if (balanceRatio <= 50) return mapRange(balanceRatio, 25, 50, 79, 60)
    if (balanceRatio <= 100) return mapRange(balanceRatio, 50, 100, 59, 35)
    return mapRange(Math.min(balanceRatio, 300), 100, 300, 34, 10)
  }

  return 50
}

function buildManualDebtHealth(
  debtSummary: DebtPaymentSummary,
  monthlyIncome: number | null,
  activeAssetBalance: number | null,
  monthlyDebtPayments: number | null = null,
): DebtHealthComponent {
  const totalDebtOriginal = debtSummary.totalDebtOriginal
  const totalDebtPaid = debtSummary.totalDebtPaid
  const remainingDebtTotal = debtSummary.remainingDebtTotal
  const repaymentProgressPercent = totalDebtOriginal > 0
    ? clampPercent((totalDebtPaid / totalDebtOriginal) * 100)
    : null
  const remainingDebtToIncomePercent = monthlyIncome !== null && monthlyIncome > 0
    ? (remainingDebtTotal / monthlyIncome) * 100
    : null
  const remainingDebtToBalancePercent = activeAssetBalance !== null && activeAssetBalance > 0
    ? (remainingDebtTotal / activeAssetBalance) * 100
    : null

  const progressScore = scoreDebtRepaymentProgress(repaymentProgressPercent, debtSummary.oldestActiveDebtAgeDays)
  const pressureScore = scoreRemainingDebtPressure(remainingDebtTotal, monthlyIncome, activeAssetBalance)
  const debtCountPenalty = Math.max(0, debtSummary.activeDebtCount - 1) * 2
  const score = clampPercent((progressScore * 0.58) + (pressureScore * 0.42) - debtCountPenalty)

  return {
    score,
    status: statusFromScore(score),
    assessmentMode: 'manual_progress',
    monthlyDebtPayments,
    monthlyIncome,
    dtiPercent: null,
    activeDebtCount: debtSummary.activeDebtCount,
    activeDebtMissingPaymentCount: debtSummary.activeDebtMissingPaymentCount,
    remainingDebtTotal,
    totalDebtOriginal,
    totalDebtPaid,
    repaymentProgressPercent,
    remainingDebtToIncomePercent,
    remainingDebtToBalancePercent,
    oldestActiveDebtAgeDays: debtSummary.oldestActiveDebtAgeDays,
  }
}

function scoreDebtHealth(
  debtSummary: DebtPaymentSummary,
  monthlyIncome: number | null,
  activeAssetBalance: number | null,
): DebtHealthComponent {
  // No debt = excellent (DTI = 0%)
  if (debtSummary.activeDebtCount === 0) {
    return {
      score: 100,
      status: 'excellent',
      assessmentMode: 'none',
      monthlyDebtPayments: 0,
      monthlyIncome,
      dtiPercent: 0,
      activeDebtCount: 0,
      activeDebtMissingPaymentCount: 0,
      remainingDebtTotal: 0,
      totalDebtOriginal: 0,
      totalDebtPaid: 0,
      repaymentProgressPercent: null,
      remainingDebtToIncomePercent: null,
      remainingDebtToBalancePercent: null,
      oldestActiveDebtAgeDays: null,
    }
  }

  if (debtSummary.remainingDebtTotal <= 0 && debtSummary.totalDebtOriginal <= 0) {
    return {
      score: 0,
      status: 'critical',
      assessmentMode: 'insufficient_data',
      monthlyDebtPayments: null,
      monthlyIncome,
      dtiPercent: null,
      activeDebtCount: debtSummary.activeDebtCount,
      activeDebtMissingPaymentCount: debtSummary.activeDebtMissingPaymentCount,
      remainingDebtTotal: debtSummary.remainingDebtTotal,
      totalDebtOriginal: debtSummary.totalDebtOriginal,
      totalDebtPaid: debtSummary.totalDebtPaid,
      repaymentProgressPercent: null,
      remainingDebtToIncomePercent: null,
      remainingDebtToBalancePercent: null,
      oldestActiveDebtAgeDays: debtSummary.oldestActiveDebtAgeDays,
    }
  }

  const hasMissingDebtPayments = debtSummary.activeDebtMissingPaymentCount > 0
  if (debtSummary.monthlyDebtPayments === null || debtSummary.monthlyDebtPayments === 0) {
    return buildManualDebtHealth(debtSummary, monthlyIncome, activeAssetBalance, null)
  }

  if (monthlyIncome === null) {
    return {
      score: 0,
      status: 'critical',
      assessmentMode: 'insufficient_data',
      monthlyDebtPayments: debtSummary.monthlyDebtPayments,
      monthlyIncome,
      dtiPercent: null,
      activeDebtCount: debtSummary.activeDebtCount,
      activeDebtMissingPaymentCount: debtSummary.activeDebtMissingPaymentCount,
      remainingDebtTotal: debtSummary.remainingDebtTotal,
      totalDebtOriginal: debtSummary.totalDebtOriginal,
      totalDebtPaid: debtSummary.totalDebtPaid,
      repaymentProgressPercent: null,
      remainingDebtToIncomePercent: null,
      remainingDebtToBalancePercent: null,
      oldestActiveDebtAgeDays: debtSummary.oldestActiveDebtAgeDays,
    }
  }

  const monthlyDebtPayments = debtSummary.monthlyDebtPayments
  const dti = monthlyIncome !== null ? safeDivide(monthlyDebtPayments, monthlyIncome) : null
  const dtiPercent = dti !== null ? dti * 100 : null

  if (dtiPercent === null) {
    return buildManualDebtHealth(debtSummary, monthlyIncome, activeAssetBalance, monthlyDebtPayments)
  }

  let score = 0
  if (dtiPercent <= 36) {
    score = mapRange(dtiPercent, 0, 36, 100, 81)
  } else if (dtiPercent <= 43) {
    score = mapRange(dtiPercent, 36, 43, 80, 61)
  } else if (dtiPercent <= 50) {
    score = mapRange(dtiPercent, 43, 50, 60, 31)
  } else {
    score = mapRange(Math.min(dtiPercent, 80), 50, 80, 30, 0)
  }

  score = clampPercent(score)
  if (hasMissingDebtPayments) {
    score = Math.min(score, 80)
  }
  const repaymentProgressPercent = debtSummary.totalDebtOriginal > 0
    ? clampPercent((debtSummary.totalDebtPaid / debtSummary.totalDebtOriginal) * 100)
    : null
  const remainingDebtToIncomePercent = monthlyIncome !== null && monthlyIncome > 0
    ? (debtSummary.remainingDebtTotal / monthlyIncome) * 100
    : null
  const remainingDebtToBalancePercent = activeAssetBalance !== null && activeAssetBalance > 0
    ? (debtSummary.remainingDebtTotal / activeAssetBalance) * 100
    : null
  return {
    score,
    status: statusFromScore(score),
    assessmentMode: 'structured_payment',
    monthlyDebtPayments,
    monthlyIncome,
    dtiPercent,
    activeDebtCount: debtSummary.activeDebtCount,
    activeDebtMissingPaymentCount: debtSummary.activeDebtMissingPaymentCount,
    remainingDebtTotal: debtSummary.remainingDebtTotal,
    totalDebtOriginal: debtSummary.totalDebtOriginal,
    totalDebtPaid: debtSummary.totalDebtPaid,
    repaymentProgressPercent,
    remainingDebtToIncomePercent,
    remainingDebtToBalancePercent,
    oldestActiveDebtAgeDays: debtSummary.oldestActiveDebtAgeDays,
  }
}

function scoreSavingsRate(monthlyIncome: number | null, monthlyExpenses: number | null): SavingsRateComponent {
  // No income = cannot compute
  if (monthlyIncome === null || monthlyIncome === 0) {
    return {
      score: 0,
      status: 'critical',
      monthlyIncome,
      monthlyExpenses,
      monthlyNet: null,
      savingsRatePercent: null,
      method: 'net_income_minus_expenses',
    }
  }

  const monthlyNet = monthlyExpenses !== null ? monthlyIncome - monthlyExpenses : null
  const rate = monthlyNet !== null ? monthlyNet / monthlyIncome : null
  const ratePercent = rate !== null ? rate * 100 : null

  let score = 0
  if (ratePercent === null) {
    score = 0
  } else if (ratePercent < 5) {
    score = mapRange(ratePercent, 0, 5, 0, 30)
  } else if (ratePercent < 10) {
    score = mapRange(ratePercent, 5, 10, 31, 50)
  } else if (ratePercent < 15) {
    score = mapRange(ratePercent, 10, 15, 51, 70)
  } else if (ratePercent < 20) {
    score = mapRange(ratePercent, 15, 20, 71, 85)
  } else {
    score = 86 + Math.min(14, (ratePercent - 20) * 0.7)
  }

  score = clampPercent(score)
  return {
    score,
    status: statusFromScore(score),
    monthlyIncome,
    monthlyExpenses,
    monthlyNet,
    savingsRatePercent: ratePercent,
    method: 'net_income_minus_expenses',
  }
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function addBudgetCategoryId(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  const normalized = value.trim()
  if (normalized) target.add(normalized)
}

function addBudgetCategoryIdsFromRaw(target: Set<string>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) addBudgetCategoryId(target, item)
    return
  }

  if (typeof value !== 'string') return
  const raw = value.trim()
  if (!raw) return

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const item of parsed) addBudgetCategoryId(target, item)
      return
    }
  } catch {
    // Some old payloads are comma-separated instead of JSON arrays.
  }

  for (const part of raw.split(',')) {
    addBudgetCategoryId(target, part)
  }
}

function getBudgetCategoryIds(budget: any): Set<string> {
  const ids = new Set<string>()
  addBudgetCategoryId(ids, budget?.category_id)
  addBudgetCategoryIdsFromRaw(ids, budget?.category_ids)
  return ids
}

function resolveBudgetScoreWindow(
  budget: any,
  cycleWindow: { start: Date; endExclusive: Date },
  now: Date,
): BudgetScoreWindow | null {
  let start = cycleWindow.start
  let endExclusive = cycleWindow.endExclusive

  const explicitStart = parseDateOnlyUtc(budget?.start_date)
  if (explicitStart && explicitStart.getTime() > start.getTime()) {
    start = explicitStart
  }

  const trackingStart = parseDateTimeUtc(budget?.tracking_start_date)
  if (
    trackingStart &&
    trackingStart.getTime() > start.getTime() &&
    trackingStart.getTime() < endExclusive.getTime()
  ) {
    start = trackingStart
  }

  const explicitEnd = parseDateOnlyUtc(budget?.end_date)
  if (explicitEnd) {
    const explicitEndExclusive = addDaysUtc(explicitEnd, 1)
    if (explicitEndExclusive.getTime() < endExclusive.getTime()) {
      endExclusive = explicitEndExclusive
    }
  }

  if (endExclusive.getTime() <= start.getTime()) return null

  const totalMs = endExclusive.getTime() - start.getTime()
  const elapsedMs = Math.min(Math.max(now.getTime() - start.getTime(), 0), totalMs)
  const remainingMs = Math.max(endExclusive.getTime() - now.getTime(), 0)
  const dayMs = 24 * 60 * 60 * 1000

  return {
    start,
    endExclusive,
    totalDays: Math.max(1, Math.ceil(totalMs / dayMs)),
    daysElapsed: elapsedMs <= 0 ? 0 : Math.max(1, Math.ceil(elapsedMs / dayMs)),
    daysRemaining: Math.max(0, Math.ceil(remainingMs / dayMs)),
    elapsedRatio: totalMs > 0 ? clamp01(elapsedMs / totalMs) : 0,
  }
}

function isBudgetSpendTransaction(tx: any): boolean {
  return getTxAmount(tx) < 0 && !isExcludedTxForCashFlow(tx) && !isIncomeTransaction(tx)
}

function doesTransactionMatchBudgetCategory(tx: any, budget: any): boolean {
  const budgetCategoryIds = getBudgetCategoryIds(budget)
  if (budgetCategoryIds.size === 0) return true

  const txCategoryId = normalizeId(tx?.category_id)
  return txCategoryId.length > 0 && budgetCategoryIds.has(txCategoryId)
}

function doesTransactionMatchBudgetWallet(tx: any, budget: any): boolean {
  const budgetWalletId = normalizeId(budget?.wallet_id)
  if (!budgetWalletId) return true
  return normalizeId(tx?.wallet_id) === budgetWalletId
}

function computeBudgetTrackedSpentCentsFromTransactions(
  budget: any,
  transactions: any[],
  budgetWindow: BudgetScoreWindow,
): number {
  const budgetId = normalizeId(budget?.id)
  if (!budgetId) return 0

  const seen = new Set<string>()
  let spent = 0

  const addTransactionSpend = (tx: any) => {
    const txId = normalizeId(tx?.id)
    if (txId && seen.has(txId)) return
    if (txId) seen.add(txId)
    spent += Math.abs(getTxAmount(tx))
  }

  for (const tx of transactions || []) {
    if (!isBudgetSpendTransaction(tx)) continue

    const txDate = parseDateTimeUtc(tx?.date)
    if (!txDate) continue

    const txMs = txDate.getTime()
    if (txMs < budgetWindow.start.getTime() || txMs >= budgetWindow.endExclusive.getTime()) continue

    const txBudgetId = normalizeId(tx?.budget_id)

    // Explicit budget membership is the strongest signal. This is how the app
    // records transactions that the user deliberately included in the budget.
    if (txBudgetId === budgetId) {
      addTransactionSpend(tx)
      continue
    }

    // Implicit membership mirrors the app's fresh-budget behavior: only
    // unassigned transactions inside the effective tracking window can count.
    if (
      !txBudgetId &&
      doesTransactionMatchBudgetWallet(tx, budget) &&
      doesTransactionMatchBudgetCategory(tx, budget)
    ) {
      addTransactionSpend(tx)
    }
  }

  return Math.round(spent * 100)
}

function scoreSingleBudgetPace(spentCents: number, expectedSpentCents: number, capCents: number): number {
  if (!(capCents > 0)) return 0
  if (spentCents <= 0) return 100
  if (spentCents > capCents) return 0
  if (spentCents === capCents) return expectedSpentCents >= capCents ? 100 : 0
  if (!(expectedSpentCents > 0)) return spentCents > 0 ? 0 : 100

  const paceRatio = spentCents / expectedSpentCents
  if (paceRatio <= 1) return 100
  if (paceRatio <= 1.25) return mapRange(paceRatio, 1, 1.25, 99, 80)
  if (paceRatio <= 1.5) return mapRange(paceRatio, 1.25, 1.5, 79, 60)
  if (paceRatio <= 2) return mapRange(paceRatio, 1.5, 2, 59, 30)
  return mapRange(Math.min(paceRatio, 3), 2, 3, 29, 0)
}

function attachBudgetPaceState(
  budget: any,
  transactions: any[],
  cycleWindow: { start: Date; endExclusive: Date },
  now: Date,
): any | null {
  const budgetWindow = resolveBudgetScoreWindow(budget, cycleWindow, now)
  if (!budgetWindow) return null

  // Future or ended budgets should not affect today's health score.
  if (now.getTime() < budgetWindow.start.getTime()) return null
  if (now.getTime() >= budgetWindow.endExclusive.getTime()) return null

  const capCents = asNumber(budget?.amount_cents)
  const spentCents = computeBudgetTrackedSpentCentsFromTransactions(budget, transactions, budgetWindow)
  const expectedSpentCents = Math.round(capCents * budgetWindow.elapsedRatio)
  const score = clampPercent(scoreSingleBudgetPace(spentCents, expectedSpentCents, capCents))
  const pacePercent = expectedSpentCents > 0
    ? (spentCents / expectedSpentCents) * 100
    : (spentCents > 0 ? 999 : 0)

  return {
    ...budget,
    spent_cents: spentCents,
    _health_score_spent_source: 'budget_tracking_state',
    _health_score_budget_score: score,
    _health_score_expected_spent_cents: expectedSpentCents,
    _health_score_pace_percent: pacePercent,
    _health_score_days_elapsed: budgetWindow.daysElapsed,
    _health_score_days_remaining: budgetWindow.daysRemaining,
    _health_score_total_days: budgetWindow.totalDays,
  }
}

function attachBudgetPaceStates(
  budgets: any[],
  transactions: any[],
  cycleWindow: { start: Date; endExclusive: Date },
  now: Date,
): any[] {
  return (budgets || [])
    .map((budget) => attachBudgetPaceState(budget, transactions, cycleWindow, now))
    .filter((budget) => budget !== null)
}

function scoreBudgetDiscipline(budgets: any[]): BudgetDisciplineComponent {
  const active = (budgets || []).filter((b) =>
    b &&
    (b.is_active === true || b.is_active === null || b.is_active === undefined) &&
    asNumber(b?.amount_cents) > 0
  )
  const total = active.length

  if (total === 0) {
    return {
      score: 0,
      status: 'critical',
      budgetsTotal: 0,
      budgetsOnTrack: 0,
      adherencePercent: null,
      averagePacePercent: null,
      budgetsOverPace: 0,
    }
  }

  const scores = active.map((b) => clampPercent(asNumber(b?._health_score_budget_score)))
  const onTrack = active.reduce((sum, b) => {
    const cap = asNumber(b?.amount_cents)
    const spent = asNumber(b?.spent_cents)
    const expected = asNumber(b?._health_score_expected_spent_cents)
    if (cap > 0 && spent <= cap && spent <= expected) return sum + 1
    return sum
  }, 0)

  const adherence = (onTrack / total) * 100
  const score = computeOverallScore(scores)
  const paceValues = active
    .map((b) => asNumber(b?._health_score_pace_percent))
    .filter((pace) => Number.isFinite(pace))
  const averagePacePercent = paceValues.length > 0
    ? paceValues.reduce((sum, pace) => sum + pace, 0) / paceValues.length
    : null

  return {
    score,
    status: statusFromScore(score),
    budgetsTotal: total,
    budgetsOnTrack: onTrack,
    adherencePercent: adherence,
    averagePacePercent,
    budgetsOverPace: total - onTrack,
  }
}

function scoreSpendingHealth(monthlyIncome: number | null, monthlyExpenses: number | null): SpendingHealthComponent {
  // No income = cannot compute
  if (monthlyIncome === null || monthlyIncome === 0) {
    return {
      score: 0,
      status: 'critical',
      monthlyIncome,
      monthlyExpenses,
      spendingRatePercent: null,
    }
  }

  const rate = monthlyExpenses !== null ? monthlyExpenses / monthlyIncome : null
  const ratePercent = rate !== null ? rate * 100 : null

  let score = 0
  if (ratePercent === null) {
    score = 0
  } else if (ratePercent <= 70) {
    // Low spending rate = excellent
    score = mapRange(ratePercent, 0, 70, 100, 81)
  } else if (ratePercent <= 90) {
    score = mapRange(ratePercent, 70, 90, 80, 61)
  } else if (ratePercent <= 100) {
    score = mapRange(ratePercent, 90, 100, 60, 31)
  } else {
    // Overspending (spending > income)
    score = mapRange(Math.min(ratePercent, 150), 100, 150, 30, 0)
  }

  score = clampPercent(score)
  return {
    score,
    status: statusFromScore(score),
    monthlyIncome,
    monthlyExpenses,
    spendingRatePercent: ratePercent,
  }
}

function logCentNormalization(
  label: string,
  result: CentCurrencyNormalizationResult<Record<string, unknown>>,
): void {
  for (const summary of result.summaries) {
    console.log(
      `[ai-health-score] ${label}.${summary.field} normalization: usable=${summary.usableRows}, normalized=${summary.normalizedRows}, zeroed=${summary.zeroedRows}, keptRaw=${summary.keptRawRows}, fx=${summary.metrics.temporary_converted_rows_used}, same=${summary.metrics.raw_same_currency_rows_used}, missing=${summary.metrics.rows_with_missing_reporting_fields}, fxFailures=${summary.metrics.fx_lookup_failures}`,
    )
  }
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

    const body = req.method === 'POST' ? parseJsonObject(await req.text()) : {}

    // Get user
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const userId = user.id
    console.log(`ðŸ’š Financial Health Score - Phase 1: Data Fetching for user ${userId.substring(0, 8)}...`)

    // Fetch all required data
    const healthData = await fetchHealthScoreData(supabaseClient, userId, body.mainCurrencyCode)

    const now = new Date()
    const window = computeCycleWindowUtc(now, clampCycleStartDay(healthData.cycleStartDay))

    console.log('ðŸ§¾ Health Score debug: cycle window (for budgets & one-offs)')
    console.log(`  - start(UTC): ${window.start.toISOString()}`)
    console.log(`  - endExclusive(UTC): ${window.endExclusive.toISOString()}`)
    console.log(`  - daysRemaining: ${window.daysRemaining}`)
    console.log(`  - tx total fetched: ${(healthData.transactions || []).length}`)

    const { monthlyIncome, monthlyExpenses, windowDays } = computeTypicalMonthlyCashFlow(
      healthData.transactions,
      now,
    )

    console.log('ðŸ§¾ Health Score debug: cash flow inputs (Typical monthly average)')
    console.log(`  - windowDays: ${windowDays}`)
    console.log(`  - monthlyIncome: ${monthlyIncome === null ? 'null' : monthlyIncome.toFixed(2)}`)
    console.log(`  - monthlyExpenses: ${monthlyExpenses === null ? 'null' : monthlyExpenses.toFixed(2)}`)

    const monthlyEssentials = computeMonthlyEssentialsFromObligations(
      healthData.subscriptions,
      healthData.bills,
      (healthData.plannedPayments || []).filter((p: any) => !looksLikeDebtPlannedPayment(p, healthData.debts || [])),
      window,
    )

    console.log('ðŸ§¾ Health Score debug: essentials inputs')
    console.log(`  - subscriptions count: ${(healthData.subscriptions || []).length}`)
    console.log(`  - bills count: ${(healthData.bills || []).length}`)
    console.log(`  - planned payments count: ${(healthData.plannedPayments || []).length}`)
    console.log(`  - monthlyEssentials: ${monthlyEssentials === null ? 'null' : monthlyEssentials.toFixed(2)}`)

    const emergencyWallets = getEmergencyWallets(healthData.wallets)
    const emergencyBalance = emergencyWallets.reduce(
      (sum, w) => sum + asNumber((w as any)?.normalized_balance_main_currency),
      0,
    )
    const activeAssetBalance = (healthData.wallets || []).reduce((sum: number, w: any) => {
      const archived = w?.archived === true
      const accountClass = String(w?.account_class || 'ASSET').trim().toUpperCase()
      if (archived || accountClass === 'LIABILITY') return sum
      return sum + asNumber(w?.normalized_balance_main_currency)
    }, 0)

    const { blockedComponents, componentFailureReasons } = getComponentBlockingState(healthData.missingData)
    const blockedComponentSet = new Set<HealthComponentKey>(blockedComponents)

    let emergencyComponent = scoreEmergencyPreparedness(emergencyBalance, monthlyEssentials)
    const debtSummary = computeDebtPaymentSummary(healthData.debts, now)
    let debtComponent = scoreDebtHealth(debtSummary, monthlyIncome, activeAssetBalance)
    let savingsComponent = scoreSavingsRate(monthlyIncome, monthlyExpenses)
    const budgetsForScore = attachBudgetPaceStates(healthData.budgets, healthData.transactions, window, now)
    let budgetComponent = scoreBudgetDiscipline(budgetsForScore)
    let spendingComponent = scoreSpendingHealth(monthlyIncome, monthlyExpenses)

    if (blockedComponentSet.has('emergency_preparedness')) {
      emergencyComponent = markEmergencyPreparednessUnavailable(emergencyComponent)
    }
    if (blockedComponentSet.has('debt_health')) {
      debtComponent = markDebtHealthUnavailable(debtComponent)
    }
    if (blockedComponentSet.has('savings_rate')) {
      savingsComponent = markSavingsRateUnavailable(savingsComponent)
    }
    if (blockedComponentSet.has('budget_discipline')) {
      budgetComponent = markBudgetDisciplineUnavailable(budgetComponent)
    }
    if (blockedComponentSet.has('spending_health')) {
      spendingComponent = markSpendingHealthUnavailable(spendingComponent)
    }

    console.log('ðŸ§¾ Health Score debug: component outputs')
    console.log(`  - Emergency: balance=${emergencyComponent.emergencyBalance.toFixed(2)} essentials=${emergencyComponent.monthlyEssentials === null ? 'null' : emergencyComponent.monthlyEssentials.toFixed(2)} monthsCovered=${emergencyComponent.monthsCovered === null ? 'null' : emergencyComponent.monthsCovered.toFixed(2)} score=${emergencyComponent.score.toFixed(0)} status=${emergencyComponent.status}`)
    console.log(`  - Debt: mode=${debtComponent.assessmentMode} active=${debtComponent.activeDebtCount} missingPayments=${debtComponent.activeDebtMissingPaymentCount} remaining=${debtComponent.remainingDebtTotal.toFixed(2)} paid=${debtComponent.totalDebtPaid.toFixed(2)} progress=${debtComponent.repaymentProgressPercent === null ? 'null' : debtComponent.repaymentProgressPercent.toFixed(2)} monthlyDebtPayments=${debtComponent.monthlyDebtPayments === null ? 'null' : debtComponent.monthlyDebtPayments.toFixed(2)} monthlyIncome=${debtComponent.monthlyIncome === null ? 'null' : debtComponent.monthlyIncome.toFixed(2)} dtiPercent=${debtComponent.dtiPercent === null ? 'null' : debtComponent.dtiPercent.toFixed(2)} score=${debtComponent.score.toFixed(0)} status=${debtComponent.status}`)
    console.log(`  - Savings: monthlyIncome=${savingsComponent.monthlyIncome === null ? 'null' : savingsComponent.monthlyIncome.toFixed(2)} monthlyExpenses=${savingsComponent.monthlyExpenses === null ? 'null' : savingsComponent.monthlyExpenses.toFixed(2)} monthlyNet=${savingsComponent.monthlyNet === null ? 'null' : savingsComponent.monthlyNet.toFixed(2)} savingsRatePercent=${savingsComponent.savingsRatePercent === null ? 'null' : savingsComponent.savingsRatePercent.toFixed(2)} score=${savingsComponent.score.toFixed(0)} status=${savingsComponent.status}`)
    console.log(`  - Budget: budgetsTotal=${budgetComponent.budgetsTotal} budgetsOnTrack=${budgetComponent.budgetsOnTrack} adherencePercent=${budgetComponent.adherencePercent === null ? 'null' : budgetComponent.adherencePercent.toFixed(2)} score=${budgetComponent.score.toFixed(0)} status=${budgetComponent.status}`)
    console.log(`  - Spending: monthlyIncome=${spendingComponent.monthlyIncome === null ? 'null' : spendingComponent.monthlyIncome.toFixed(2)} monthlyExpenses=${spendingComponent.monthlyExpenses === null ? 'null' : spendingComponent.monthlyExpenses.toFixed(2)} spendingRatePercent=${spendingComponent.spendingRatePercent === null ? 'null' : spendingComponent.spendingRatePercent.toFixed(2)} score=${spendingComponent.score.toFixed(0)} status=${spendingComponent.status}`)

    const missingComponents = [...blockedComponents]
    if (emergencyComponent.monthlyEssentials === null) missingComponents.push('emergency_preparedness')
    if (debtComponent.assessmentMode === 'insufficient_data') missingComponents.push('debt_health')
    if (savingsComponent.savingsRatePercent === null) missingComponents.push('savings_rate')
    if (budgetComponent.adherencePercent === null) missingComponents.push('budget_discipline')
    if (spendingComponent.spendingRatePercent === null) missingComponents.push('spending_health')
    const uniqueMissingComponents = [...new Set(missingComponents)]

    const canComputeOverall = uniqueMissingComponents.length === 0
    const overallScore = canComputeOverall
      ? computeOverallScore([
        emergencyComponent.score,
        debtComponent.score,
        savingsComponent.score,
        budgetComponent.score,
        spendingComponent.score,
      ])
      : null
    const rating = overallScore !== null ? ratingFromOverallScore(overallScore) : null
    const scoreBreakdowns = buildScoreBreakdowns({
      emergency: emergencyComponent,
      debt: debtComponent,
      savings: savingsComponent,
      budget: budgetComponent,
      spending: spendingComponent,
      windowDays,
      currencyCode: healthData.mainCurrencyCode,
      componentFailureReasons,
    })
    const clarifyingMessage = blockedComponents.length > 0
      ? 'Some parts of your health score are temporarily unavailable because Wisey could not load all of the required data right now.'
      : undefined

    // Log fetched data for Phase 1 verification
    console.log('âœ… Data fetched successfully:')
    console.log(`  - Wallets: ${healthData.wallets.length}`)
    console.log(`  - Transactions: ${healthData.transactions.length}`)
    console.log(`  - Debts: ${healthData.debts.length}`)
    console.log(`  - Budgets: ${healthData.budgets.length}`)
    console.log(`  - Goals: ${healthData.goals.length}`)
    console.log(`  - Subscriptions: ${healthData.subscriptions.length}`)
    console.log(`  - Bills: ${healthData.bills.length}`)
    console.log(`  - Cycle start day: ${healthData.cycleStartDay}`)

    return new Response(JSON.stringify({
      success: true,
      message: 'Phase 2: Component scoring complete',
      overallScore,
      rating,
      dataFetched: {
        wallets: healthData.wallets.length,
        transactions: healthData.transactions.length,
        debts: healthData.debts.length,
        budgets: healthData.budgets.length,
        goals: healthData.goals.length,
        subscriptions: healthData.subscriptions.length,
        bills: healthData.bills.length,
        cycleStartDay: healthData.cycleStartDay
      },
      missingData: healthData.missingData,
      currencyWarnings: healthData.currencyWarnings,
      missingComponents: uniqueMissingComponents,
      blockedComponents,
      componentFailureReasons,
      components: {
        emergencyPreparedness: emergencyComponent,
        debtHealth: debtComponent,
        savingsRate: savingsComponent,
        budgetDiscipline: budgetComponent,
        spendingHealth: spendingComponent,
      },
      currencyCode: healthData.mainCurrencyCode,
      scoreBreakdowns,
      clarifyingMessage,
      formulaVersion: 'v3',
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })

  } catch (error) {
    console.error('âŒ Financial Health Score error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return new Response(JSON.stringify({
      error: message
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
 * Wallet type helpers for semantic filtering
 */
function getEmergencyWallets(wallets: any[]): any[] {
  return wallets.filter(w => {
    const type = typeof w?.type === 'string' ? w.type.toLowerCase() : ''
    const accountClass = String(w?.account_class || 'ASSET').trim().toUpperCase()
    return type === 'emergency' && accountClass !== 'LIABILITY'
  })
}

/**
 * PHASE 1: Fetch all data needed for health score calculation
 * 
 * Data requirements:
 * - Wallets: For emergency wallet balance and asset-balance fallback pressure
 * - Debts: For DTI calculation
 * - Budgets: For budget discipline
 * - Goals: For goal progress
 * - Transactions: For savings rate + income calculation
 * - Subscriptions + Bills: For fixed expenses (DTI denominator)
 */
async function fetchHealthScoreData(supabase: any, userId: string, requestedMainCurrencyCode?: unknown) {
  const startTime = nowMs()
  const missingData: string[] = []

  // Bound the transaction fetch so large histories do not overwhelm scoring.
  const ninetyDaysAgo = new Date()
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - HEALTH_SCORE_TX_WINDOW_DAYS)

  const [
    walletsRes,
    txRes,
    debtsRes,
    budgetsRes,
    goalsRes,
    subsRes,
    billsRes,
    plannedPaymentsRes,
    prefsRes,
  ] = await Promise.all([
    // All wallets (for savings balance)
    supabase
      .from('wallets')
      .select('id, name, type, balance, currency_code, account_class, archived, created_at, updated_at')
      .eq('user_id', userId)
      .eq('archived', false),

    // Transactions for income/savings rate analysis
    supabase.from('wallet_transactions')
      .select('id, wallet_id, amount, reporting_amount, reporting_currency, category, category_id, title, note, date, created_at, budget_id, is_opening_balance, is_manual_topup, categories(name, is_income)')
      .eq('user_id', userId)
      .gte('date', ninetyDaysAgo.toISOString())
      .order('date', { ascending: false })
      .limit(HEALTH_SCORE_TX_ROW_LIMIT),

    // Debts for DTI calculation
    supabase
      .from('debts')
      .select('id, name, total_amount_cents, remaining_amount_cents, interest_rate, minimum_payment_cents, monthly_payment_cents, amount_paid_cents, due_date, updated_at')
      .eq('user_id', userId),

    // Budgets for discipline score
    supabase
      .from('budgets')
      .select('id, name, amount_cents, spent_cents, category_id, category_ids, wallet_id, start_date, end_date, tracking_start_date, is_active, updated_at')
      .eq('user_id', userId),

    // Goals for progress score
    supabase
      .from('goals')
      .select('id, name, target_amount_cents, current_amount_cents, target_date_millis, linked_wallet_id, is_deduction_paused, is_wish, is_challenge, currency_code, created_at, updated_at')
      .eq('user_id', userId),

    // Active subscriptions (recurring obligations for DTI)
    supabase
      .from('subscriptions')
      .select('id, name, amount_cents, billing_cycle, next_billing_date, wallet_id, is_active, currency_code, day_of_month, notes')
      .eq('user_id', userId)
      .eq('is_active', true),

    // Unpaid bills (recurring obligations for DTI)
    supabase
      .from('bills')
      .select('id, name, amount_cents, due_date, is_recurring, recurring_frequency, category, wallet_id, is_paid, currency_code, notes, updated_at')
      .eq('user_id', userId)
      .eq('is_paid', false),

    // Planned payments (recurring or one-off obligations)
    supabase
      .from('planned_payments')
      .select('id, name, amount_cents, due_date, is_recurring, recurring_frequency, category, wallet_id, is_paid, currency_code, notes, updated_at')
      .eq('user_id', userId)
      .eq('is_paid', false),

    // User preferences (cycle start day)
    supabase.from('user_preferences').select('cycle_start_day, currency').eq('user_id', userId).maybeSingle(),
  ])

  // Check for query errors and track missing data
  if (walletsRes.error) {
    console.error('âŒ Wallets query failed:', walletsRes.error)
    missingData.push('wallets_query_failed')
  }

  if (txRes.error) {
    console.error('âŒ Transactions query failed:', txRes.error)
    missingData.push('transactions_query_failed')
  }

  if (debtsRes.error) {
    console.error('âŒ Debts query failed:', debtsRes.error)
    missingData.push('debts_query_failed')
  }

  if (budgetsRes.error) {
    console.error('âŒ Budgets query failed:', budgetsRes.error)
    missingData.push('budgets_query_failed')
  }

  if (goalsRes.error) {
    console.error('âŒ Goals query failed:', goalsRes.error)
    missingData.push('goals_query_failed')
  }

  if (subsRes.error) {
    console.error('âŒ Subscriptions query failed:', subsRes.error)
    missingData.push('subscriptions_query_failed')
  }

  if (billsRes.error) {
    console.error('âŒ Bills query failed:', billsRes.error)
    missingData.push('bills_query_failed')
  }

  if (prefsRes.error) {
    console.error('âŒ User preferences query failed:', prefsRes.error)
    missingData.push('preferences_query_failed')
  }

  if (plannedPaymentsRes.error) {
    console.error('âŒ Planned payments query failed:', plannedPaymentsRes.error)
    missingData.push('planned_payments_query_failed')
  }

  const elapsed = nowMs() - startTime
  console.log(`âœ… All data fetched in ${elapsed.toFixed(0)}ms`)

  if (missingData.length > 0) {
    console.log(`âš ï¸ Missing data: ${missingData.join(', ')}`)
  }

  const wallets = walletsRes.data || []
  const subscriptions = subsRes.data || []
  const bills = billsRes.data || []
  const plannedPayments = plannedPaymentsRes.data || []
  const debts = debtsRes.data || []
  const budgets = budgetsRes.data || []
  let mainCurrencyCode = 'USD'
  try {
    const resolved = await resolveMainCurrencyCode(supabase, userId, {
      bodyCurrency: requestedMainCurrencyCode || prefsRes.data?.currency,
    })
    mainCurrencyCode = resolved.currency
  } catch (error) {
    console.warn('[ai-health-score] Failed to resolve main currency, defaulting to USD:', String((error as any)?.message || error))
  }

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
    `[ai-health-score] wallet balance normalization: usable=${normalizedWalletBalances.metrics.usable_wallet_rows}, normalized=${normalizedWalletBalances.metrics.normalized_wallet_rows}, excluded=${normalizedWalletBalances.metrics.excluded_wallet_rows}, fxFailures=${normalizedWalletBalances.metrics.fx_lookup_failures}`,
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
      `[ai-health-score] tx currency normalization: normalized=${normalized.metrics.normalized_rows_used}, fx=${normalized.metrics.temporary_converted_rows_used}, same=${normalized.metrics.raw_same_currency_rows_used}, missing=${normalized.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalized.metrics.fx_lookup_failures}`
    )
  }

  const currencyWarnings: string[] = []
  const normalizeMoneyRows = async (
    label: string,
    rows: any[],
    fields: Array<{ amountField: string; dateField?: string }>,
  ): Promise<any[]> => {
    const result = await normalizeCentFieldsToMainCurrency(
      supabase,
      userId,
      mainCurrencyCode,
      rows as Array<Record<string, unknown>>,
      fields.map((field) => ({
        ...field,
        missingConversion: 'zero' as const,
      })),
    )
    logCentNormalization(label, result)
    const warning = buildCentNormalizationWarning(label, result, mainCurrencyCode)
    if (warning) currencyWarnings.push(warning)
    return result.rows
  }

  const normalizedSubscriptions = await normalizeMoneyRows('subscriptions', subscriptions, [
    { amountField: 'amount_cents', dateField: 'next_billing_date' },
  ])
  const normalizedBills = await normalizeMoneyRows('bills', bills, [
    { amountField: 'amount_cents', dateField: 'due_date' },
  ])
  const normalizedPlannedPayments = await normalizeMoneyRows('plannedPayments', plannedPayments, [
    { amountField: 'amount_cents', dateField: 'due_date' },
  ])
  const normalizedDebts = await normalizeMoneyRows('debts', debts, [
    { amountField: 'monthly_payment_cents', dateField: 'updated_at' },
    { amountField: 'minimum_payment_cents', dateField: 'updated_at' },
    { amountField: 'remaining_amount_cents', dateField: 'updated_at' },
    { amountField: 'total_amount_cents', dateField: 'updated_at' },
    { amountField: 'amount_paid_cents', dateField: 'updated_at' },
  ])
  const normalizedBudgets = await normalizeMoneyRows('budgets', budgets, [
    { amountField: 'amount_cents', dateField: 'updated_at' },
    { amountField: 'spent_cents', dateField: 'updated_at' },
  ])

  console.log(`ðŸ“Š Bills count (is_paid=false): ${normalizedBills.length}`)
  console.log(`ðŸ“Š Subscriptions count (is_active=true): ${normalizedSubscriptions.length}`)
  console.log(`ðŸ“Š Planned payments count (is_paid=false): ${normalizedPlannedPayments.length}`)

  const goals = (goalsRes.data || []).filter((g: any) =>
    g?.is_challenge !== true &&
    g?.is_wish !== true &&
    Number(g?.target_amount_cents ?? 0) > 0
  )

  return {
    wallets: walletsWithNormalizedBalance,
    transactions: normalizedTransactions,
    debts: normalizedDebts,
    budgets: normalizedBudgets,
    goals,
    subscriptions: normalizedSubscriptions,
    bills: normalizedBills,
    plannedPayments: normalizedPlannedPayments,
    cycleStartDay: prefsRes.data?.cycle_start_day ?? 1,
    mainCurrencyCode,
    missingData,
    currencyWarnings,
  }
}
