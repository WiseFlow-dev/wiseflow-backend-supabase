import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { getServiceSupabaseClient, getUserFromAuthHeader } from './_shared/supabaseClient.ts'
import { log, logError } from './_shared/logger.ts'
import { getCanonicalObligations } from '../ai-planner/obligations.ts'
import { normalizeTransactionsToMainCurrency } from '../_shared/currencyReporting.ts'

// Demo mode toggles (set in Supabase Function env):
// WISEY_DEMO=true, WISEY_DEMO_SHIFT_WEEKS=1 (or 0)
const DEMO = ((Deno.env.get('WISEY_DEMO') ?? '').toLowerCase() === 'true')
const DEMO_SHIFT_WEEKS = Number.parseInt(Deno.env.get('WISEY_DEMO_SHIFT_WEEKS') ?? '0') || 0
const DAY_MS = 86_400_000

const GLOBAL_ACTIONABLE_MAX_PER_DAY = 1
const GLOBAL_ACTIONABLE_MAX_PER_7D = 3

const DEFAULT_CYCLE_LEFTOVER_TRIGGER_DAYS_REMAINING = 7
type PolicyEvalRequest = {
  currencyCode?: unknown
  userIds?: unknown
  includePerUserResults?: unknown
}

type PolicyEvalUserResult = {
  userId: string
  periodKey: string
  created: string[]
}

type PolicyEvalBatchResult = {
  userId: string
  periodKey?: string
  created: string[]
  error?: string
}

type ExpenseTier = 'essential' | 'flexible_essential' | 'discretionary'

function asExpenseTier(raw: unknown): ExpenseTier | null {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'essential') return 'essential'
  if (value === 'flexible_essential') return 'flexible_essential'
  if (value === 'discretionary') return 'discretionary'
  return null
}

async function fetchExpenseTierMaps(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, user_id, expense_tier, is_income')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .limit(2000)

  if (error || !Array.isArray(data)) {
    return {
      byCategoryId: {} as Record<string, ExpenseTier>,
      byCategoryKey: {} as Record<string, ExpenseTier>,
    }
  }

  const byCategoryId: Record<string, ExpenseTier> = {}
  const byCategoryKey: Record<string, ExpenseTier> = {}
  const keyHasUserOverride = new Set<string>()

  for (const row of data as any[]) {
    if (row?.is_income === true) continue
    const tier = asExpenseTier(row?.expense_tier)
    if (!tier) continue

    const id = String(row?.id ?? '').trim()
    if (id) byCategoryId[id] = tier

    const key = normalizeText(String(row?.name ?? ''))
    if (!key) continue

    const hasUser = Boolean(row?.user_id)
    if (hasUser) {
      byCategoryKey[key] = tier
      keyHasUserOverride.add(key)
      continue
    }

    if (!keyHasUserOverride.has(key) && !byCategoryKey[key]) {
      byCategoryKey[key] = tier
    }
  }

  return { byCategoryId, byCategoryKey }
}

/**
 * Categories that are always treated as "essential" (fixed obligations),
 * regardless of what tier the database says. This prevents the policy engine
 * from proposing challenges or budget suggestions for utility/system categories
 * (ATM, uncategorized) and unavoidable financial obligations (debt payments,
 * fees, taxes). Challenges and budget nudges only make sense for truly
 * discretionary / flexible-essential spending.
 */
const HARDCODED_ESSENTIAL_CATEGORY_KEYS = new Set<string>([
  // System / utility — no meaningful pattern to propose action on
  'atm-withdrawals',
  'atm',
  'uncategorized',
  'opening-balance',
  'balance-adjustment',
  // Fixed financial obligations — challenging these makes no sense
  'debt',
  'buy-now-pay-later',
  'bnpl',
  'interest-paid',
  'credit-card-payment',
  'loan-payment',
  'loan-principal',
  // Fees, taxes & fixed costs — user has no real discretion here
  'bank-fees',
  'credit-card-fees',
  'taxes',
  'insurance-other',
  'hoa-fees',
  'property-tax',
])

function resolveExpenseTierForCategory(
  categoryKey: string,
  categoryId: string | null | undefined,
  tierMaps: { byCategoryId: Record<string, ExpenseTier>; byCategoryKey: Record<string, ExpenseTier> },
): ExpenseTier | null {
  // Hardcoded override: these are always essential regardless of DB value.
  if (HARDCODED_ESSENTIAL_CATEGORY_KEYS.has(categoryKey)) return 'essential'
  const id = String(categoryId ?? '').trim()
  if (id && tierMaps.byCategoryId[id]) return tierMaps.byCategoryId[id]
  return tierMaps.byCategoryKey[categoryKey] ?? null
}

function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((date as any) - (yearStart as any)) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()

    // Support two modes:
    // 1) Normal: Authorized user request
    // 2) Admin/cron: headers X-Cron-Secret + X-Run-As to run for a specific user
    const cronSecret = Deno.env.get('WISEY_CRON_SECRET') ?? ''
    const reqSecret = req.headers.get('X-Cron-Secret') ?? req.headers.get('x-cron-secret') ?? ''
    const runAs = req.headers.get('X-Run-As') ?? ''
    const isAdminCronRequest = Boolean(cronSecret && reqSecret && cronSecret === reqSecret)

    let requestBody: PolicyEvalRequest = {}
    try {
      requestBody = (await req.json()) as PolicyEvalRequest
    } catch {
      requestBody = {}
    }
    const requestedCurrency =
      normalizeCurrencyCodeOrNull(req.headers.get('x-main-currency'))
      ?? normalizeCurrencyCodeOrNull(requestBody?.currencyCode)
    const requestedUserIds = isAdminCronRequest ? normalizeUserIdList(requestBody?.userIds) : []
    const includePerUserResults = parseBoolean(requestBody?.includePerUserResults)

    let userId = ''
    if (!requestedUserIds.length) {
      if (isAdminCronRequest && runAs) {
        userId = runAs
      } else {
        const user = await getUserFromAuthHeader(supabase, req)
        userId = user.id as string
      }
    }

    if (requestedUserIds.length > 0) {
      const users = await runPolicyEvalForUsersBatch(
        supabase,
        requestedUserIds,
        requestedCurrency,
      )
      const createdUsers = users.filter((entry) => !entry.error && entry.created.length > 0).length
      const failedUsers = users.filter((entry) => Boolean(entry.error)).length
      const uniqueCreatedRules = Array.from(
        new Set(
          users.flatMap((entry) => entry.created),
        ),
      )

      log('policy_eval.batch_completed', {
        requested_user_count: requestedUserIds.length,
        processed_user_count: users.length,
        created_user_count: createdUsers,
        failed_user_count: failedUsers,
        created_rules: uniqueCreatedRules,
        requested_currency: requestedCurrency,
      })

      return json({
        ok: true,
        batch: true,
        processed: users.length,
        created_user_count: createdUsers,
        failed_user_count: failedUsers,
        created_rules: uniqueCreatedRules,
        users: includePerUserResults
          ? users.map((entry) => ({
              user_id: entry.userId,
              period_key: entry.periodKey ?? null,
              created: entry.created,
              error: entry.error,
            }))
          : undefined,
      }, 200)
    }

    const result = await runPolicyEvalForUser(supabase, userId, requestedCurrency)
    return json({ ok: true, period_key: result.periodKey, created: result.created }, 200)
  } catch (e) {
    logError('policy_eval.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } })
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function normalizeUserIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const userIds: string[] = []
  for (const entry of raw) {
    const userId = String(entry ?? '').trim()
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    userIds.push(userId)
  }
  return userIds
}

async function runPolicyEvalForUsersBatch(
  supabase: any,
  userIds: string[],
  requestedCurrency: string | null,
): Promise<PolicyEvalBatchResult[]> {
  const results: PolicyEvalBatchResult[] = []

  for (const userId of userIds) {
    try {
      const result = await runPolicyEvalForUser(supabase, userId, requestedCurrency)
      results.push(result)
    } catch (error) {
      logError('policy_eval.batch_user_failed', { userId, error: String(error) })
      results.push({
        userId,
        created: [],
        error: String(error),
      })
    }
  }

  return results
}

async function runPolicyEvalForUser(
  supabase: any,
  userId: string,
  requestedCurrency: string | null,
): Promise<PolicyEvalUserResult> {
  // Compute period key (optionally shifted in demo mode)
  const base = new Date()
  if (DEMO && DEMO_SHIFT_WEEKS) base.setUTCDate(base.getUTCDate() + 7 * DEMO_SHIFT_WEEKS)
  const nowKey = weekKey(base)
  const created: string[] = []

  const results: Array<{ rule_id: string; created: boolean }> = []
  const evaluators = [
    () => evaluate_emergency_wallet_booster_v1(supabase, userId, nowKey, requestedCurrency),
    () => evaluate_cycle_leftover_to_savings_wallet_v1(supabase, userId, nowKey, requestedCurrency),
    () => evaluate_budget_suggestion_v1(supabase, userId, nowKey, requestedCurrency),
    () => evaluate_challenge_suggestion_v1(supabase, userId, nowKey, requestedCurrency),
    // Subscription review stays in wisey-updates notifications (review CTA only).
    () => evaluate_subscription_hike_unused_v1(supabase, userId, nowKey),
  ]

  for (const evaluate of evaluators) {
    const result = await safeEvaluateRule(userId, evaluate)
    results.push(result)
    if (result.created) break
  }

  results.push(await safeEvaluateRule(
    userId,
    () => evaluate_budget_coaching_v1(supabase, userId, nowKey),
  ))

  for (const result of results) {
    if (result?.created) created.push(result.rule_id)
  }

  log('policy_eval.completed', {
    userId,
    created,
    period_key: nowKey,
    requested_currency: requestedCurrency,
  })

  return {
    userId,
    periodKey: nowKey,
    created,
  }
}

async function safeEvaluateRule(
  userId: string,
  evaluate: () => Promise<{ rule_id: string; created: boolean }>
) {
  try {
    return await evaluate()
  } catch (error) {
    logError('policy_eval.rule_failed', { userId, error: String(error) })
    return { rule_id: 'rule_failed', created: false }
  }
}

function daysAgo(n: number) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

function normalizeText(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeCategoryKeyLocal(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return ''
  return value
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const SUPPRESSED_PROPOSAL_CATEGORY_KEYS = new Set([
  'uncategorized',
  'other',
  'other expense',
  'other income',
  'misc',
  'miscellaneous',
  'unknown',
])

function isSuppressedProposalCategory(raw: unknown): boolean {
  return SUPPRESSED_PROPOSAL_CATEGORY_KEYS.has(normalizeText(String(raw ?? '')))
}

function normalizeCurrencyCodeOrNull(raw: unknown): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

function tokenizeNormalized(value: string) {
  return normalizeText(value).split(' ').filter(Boolean)
}

function hasAllTokens(haystack: Set<string>, tokens: string[]) {
  if (!tokens.length) return false
  return tokens.every((token) => haystack.has(token))
}

function resolveChallengePolicyForCategory(
  categoryLabel: string,
  categoryKey: string,
  policyMap: Record<string, { display_name: string; is_challengeable: boolean; keywords: string[] }>,
) {
  const direct = policyMap[categoryKey]
  if (direct) {
    return { key: categoryKey, entry: direct }
  }

  const categoryTokens = new Set(tokenizeNormalized(categoryLabel || categoryKey))
  if (categoryTokens.size === 0) return null

  for (const [policyKey, entry] of Object.entries(policyMap)) {
    const policyKeyTokens = tokenizeNormalized(policyKey)
    if (hasAllTokens(categoryTokens, policyKeyTokens)) {
      return { key: policyKey, entry }
    }

    const keywords = Array.isArray(entry.keywords) ? entry.keywords : []
    for (const keyword of keywords) {
      const keywordTokens = tokenizeNormalized(String(keyword ?? ''))
      if (hasAllTokens(categoryTokens, keywordTokens)) {
        return { key: policyKey, entry }
      }
    }
  }

  return null
}

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.round(parsed))
}

function toPositiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, parsed)
}

async function fetchRuleSettingsRow(supabase: any, userId: string, ruleId: string) {
  const { data, error } = await supabase
    .from('action_rule_settings')
    .select('user_id, is_enabled, min_leftover_cents, transfer_ratio, hard_cap_cents, trigger_days_remaining, target_coverage_months, min_suggestion_cents')
    .eq('rule_id', ruleId)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .limit(10)

  if (error || !Array.isArray(data) || data.length === 0) return null

  const userRow = data.find((row: any) => row?.user_id === userId)
  if (userRow) return userRow
  return data.find((row: any) => row?.user_id == null) ?? null
}

async function getCycleLeftoverSettings(supabase: any, userId: string) {
  const row = await fetchRuleSettingsRow(supabase, userId, 'cycle_leftover_to_savings_wallet_v1')
  return {
    is_enabled: row?.is_enabled !== false,
    trigger_days_remaining: toPositiveInt(row?.trigger_days_remaining, DEFAULT_CYCLE_LEFTOVER_TRIGGER_DAYS_REMAINING),
    min_leftover_cents: toPositiveInt(row?.min_leftover_cents, 0),
    transfer_ratio: toPositiveNumber(row?.transfer_ratio, 0),
    hard_cap_cents: toPositiveInt(row?.hard_cap_cents, 0),
    min_suggestion_cents: toPositiveInt(row?.min_suggestion_cents, 0),
  }
}

async function getEmergencyBoosterSettings(supabase: any, userId: string) {
  const row = await fetchRuleSettingsRow(supabase, userId, 'emergency_wallet_booster_v1')
  return {
    is_enabled: row?.is_enabled !== false,
    min_leftover_cents: toPositiveInt(row?.min_leftover_cents, 0),
    transfer_ratio: toPositiveNumber(row?.transfer_ratio, 0),
    hard_cap_cents: toPositiveInt(row?.hard_cap_cents, 0),
    min_suggestion_cents: toPositiveInt(row?.min_suggestion_cents, 0),
  }
}

function recommendedBudgetAmountCents(spendCents: number, reductionPct: number) {
  const spend = Math.max(0, Math.round(spendCents))
  if (spend <= 0) return 0

  const parsedReductionPct = Number.isFinite(reductionPct) ? reductionPct : 0
  const safeReductionPct = Math.min(0.95, Math.max(0, parsedReductionPct))
  const reduced = Math.round(spend * (1 - safeReductionPct))
  return Math.max(0, Math.min(spend, reduced))
}

async function fetchRecentTransactions(
  supabase: any,
  userId: string,
  sinceISO: string,
  walletIds?: string[],
  mainCurrencyCode?: string,
) {
  if (Array.isArray(walletIds) && walletIds.length === 0) return []

  let query = supabase
    .from('wallet_transactions')
    .select('amount, reporting_amount, reporting_currency, category, category_id, date, wallet_id, is_opening_balance, is_manual_topup')
    .eq('user_id', userId)
    .gte('date', sinceISO)

  if (Array.isArray(walletIds) && walletIds.length > 0) {
    query = query.in('wallet_id', walletIds)
  }

  const { data, error } = await query
  if (error) return []
  const rows = (data || []) as Array<{
    amount: number
    reporting_amount?: number | null
    reporting_currency?: string | null
    category: string | null
    category_id: string | null
    date: string
    wallet_id: string | null
    is_opening_balance: boolean | null
    is_manual_topup: boolean | null
  }>

  const normalizedCurrency = normalizeCurrencyCodeOrNull(mainCurrencyCode)
  if (!normalizedCurrency || rows.length === 0) return rows

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    normalizedCurrency,
    rows,
  )
  return normalized.rows as typeof rows
}

async function evaluate_challenge_suggestion_v1(
  supabase: any,
  userId: string,
  periodKey: string,
  forcedCurrency?: string | null,
) {
  const rule_id = 'challenge_suggestion_v1'
  if (!(await canCreateActionableProposal(supabase, userId, rule_id))) return { rule_id, created: false }

  // Enforce: only 1 active challenge at a time
  const { data: activeChallenge } = await supabase
    .from('challenges')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  if (activeChallenge) return { rule_id, created: false }

  // Settings (per user)
  const { data: settingsRow } = await supabase
    .from('challenge_suggestion_settings')
    .select('max_suggestions_per_day, min_tx_count_last_7d, min_spend_cents_last_7d, threshold_pct_of_income_last_7d, min_income_cents')
    .eq('user_id', userId)
    .maybeSingle()

  const maxPerDay = Number(settingsRow?.max_suggestions_per_day ?? 1)
  const minSpendCents = Number(settingsRow?.min_spend_cents_last_7d ?? 0)
  const minIncomeCents = Number(settingsRow?.min_income_cents ?? 0)
  const thresholdPctOfIncome = Number(settingsRow?.threshold_pct_of_income_last_7d ?? 0.07)

  // V2 rule: behavior-based trigger.
  // Suggest only when user shows a repeat pattern in the last 8 days.
  const minTxCount = Number(settingsRow?.min_tx_count_last_7d ?? 3)
  const windowDays = 8

  if (maxPerDay <= 0) return { rule_id, created: false }

  // Monthly per-category cap
  const monthKey = monthKeyUTC(new Date())
  const alreadySuggested = await getCategorySuggestionsThisMonth(supabase, userId, monthKey, [rule_id])
  const { walletIds, primaryCurrency } = await getPrimaryCurrencyWalletScope(supabase, userId, undefined, forcedCurrency)

  // Policies: challengeable + keywords
  const { data: policyRows } = await supabase
    .from('challenge_category_policy')
    .select('user_id, category_key, display_name, is_challengeable, keywords')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .limit(500)

  const merged: Record<string, { display_name: string; is_challengeable: boolean; keywords: string[] }> = {}
  for (const row of (policyRows || []) as any[]) {
    const rawKey = String(row.category_key ?? '')
    const key = normalizeText(rawKey)
    if (!key) continue

    const keywords = Array.isArray(row.keywords) ? row.keywords : []
    const normKeywords = keywords
      .map((k: any) => normalizeText(String(k ?? '')))
      .filter(Boolean)

    // User override wins. Global only applies if no user override exists.
    if (row.user_id) {
      merged[key] = {
        display_name: String(row.display_name ?? rawKey).trim() || rawKey,
        is_challengeable: Boolean(row.is_challengeable),
        keywords: normKeywords
      }
    } else if (!merged[key]) {
      merged[key] = {
        display_name: String(row.display_name ?? rawKey).trim() || rawKey,
        is_challengeable: Boolean(row.is_challengeable),
        keywords: normKeywords
      }
    }
  }

  // Evaluate last 8 days for habit frequency/spend
  const sinceXd = daysAgo(windowDays).toISOString()
  const txnsXd = await fetchRecentTransactions(
    supabase,
    userId,
    sinceXd,
    walletIds,
    primaryCurrency,
  )
  const incomeCentsXd = sumEligibleIncomeCents(txnsXd)

  if (minIncomeCents > 0 && incomeCentsXd < minIncomeCents) return { rule_id, created: false }

  const spendByKey: Record<string, number> = {}
  const txCountByKey: Record<string, number> = {}
  const walletByKey: Record<string, Record<string, number>> = {}
  const categoryIdByKey: Record<string, string> = {}
  const categoryLabelByKey: Record<string, string> = {}
  const policyKeyByCategoryKey: Record<string, string> = {}

  for (const t of txnsXd) {
    if (isExcludedTxForCashFlow(t)) continue
    const cents = moneyToCents((t as any).amount)
    if (cents >= 0) continue

    const rawCategory = (t as any).category
    const catName = (rawCategory == null ? '' : String(rawCategory)).trim()
    const catKey = catName ? normalizeText(catName) : ''

    if (!catKey) continue
    if (isSuppressedProposalCategory(catName)) continue
    if (!categoryLabelByKey[catKey]) categoryLabelByKey[catKey] = catName

    // Category-only matching. Keep discretionary categories eligible by default.
    // Policy is treated as an optional override layer (exact key or keyword-based).
    const policyMatch = resolveChallengePolicyForCategory(catName, catKey, merged)
    if (policyMatch) {
      policyKeyByCategoryKey[catKey] = policyMatch.key
      if ((policyMatch.entry.is_challengeable ?? true) === false) continue
    }

    if (!categoryIdByKey[catKey] && typeof t.category_id === 'string' && t.category_id.trim()) {
      categoryIdByKey[catKey] = t.category_id.trim()
    }

    spendByKey[catKey] = (spendByKey[catKey] || 0) + Math.abs(cents)
    txCountByKey[catKey] = (txCountByKey[catKey] || 0) + 1

    const wid = (t as any).wallet_id
    if (wid) {
      walletByKey[catKey] = walletByKey[catKey] || {}
      walletByKey[catKey][String(wid)] = (walletByKey[catKey][String(wid)] || 0) + Math.abs(cents)
    }
  }

  const keys = Object.keys(spendByKey)
  if (keys.length === 0) return { rule_id, created: false }
  const tierMaps = await fetchExpenseTierMaps(supabase, userId)

  const candidates = keys
    .filter((k) => {
      const policyKey = policyKeyByCategoryKey[k]
      if (alreadySuggested.has(k)) return false
      if (policyKey && alreadySuggested.has(policyKey)) return false
      return true
    })
    .filter((k) => {
      const tier = resolveExpenseTierForCategory(k, categoryIdByKey[k] || null, tierMaps)
      return tier === 'discretionary'
    })
    .filter((k) => {
      const policyKey = policyKeyByCategoryKey[k]
      if (!policyKey) return true
      return (merged[policyKey]?.is_challengeable ?? true) === true
    })
    .filter(k => (txCountByKey[k] || 0) >= minTxCount)
    .map(k => ({
      category_key: k,
      display_name: (() => {
        const policyKey = policyKeyByCategoryKey[k]
        if (policyKey && merged[policyKey]?.display_name) return merged[policyKey].display_name
        return categoryLabelByKey[k] || k
      })(),
      spend_cents: spendByKey[k] || 0,
      tx_count: txCountByKey[k] || 0,
    }))
    .filter(x => x.spend_cents >= minSpendCents)
    .filter((x) => {
      if (thresholdPctOfIncome <= 0) return true
      if (incomeCentsXd <= 0) return false
      return x.spend_cents >= Math.round(incomeCentsXd * thresholdPctOfIncome)
    })
    .sort((a, b) => b.spend_cents - a.spend_cents)

  const top = candidates[0]
  if (!top) return { rule_id, created: false }

  const topWalletSpend = walletByKey[top.category_key] || {}
  const topWalletId = Object.keys(topWalletSpend)
    .sort((a, b) => (topWalletSpend[b] || 0) - (topWalletSpend[a] || 0))[0] || null

  const spentDisplay = formatMoneyWhole(top.spend_cents, primaryCurrency)
  const title = `Try a ${top.display_name} reset?`
  const body = `We noticed ${top.display_name} spending popped up ${top.tx_count} times in the last ${windowDays} days (about ${spentDisplay}). Want a strict ${top.display_name} no-spend challenge?`

  const proposalPeriodKey = `${monthKey}:${top.category_key}`
  const { data: pending } = await supabase
    .from('action_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', rule_id)
    .eq('status', 'pending')
    .eq('period_key', proposalPeriodKey)
    .limit(1)
    .maybeSingle()
  if (pending) return { rule_id, created: false }

  await insertProposal(supabase, {
    user_id: userId,
    rule_id,
    title,
    body,
    cta_json: {
      label: 'Create challenge',
      payload: {
        challenge_type: 'NO_SPEND',
        strict_mode: true,
        duration_days: 7,
        category_key: top.category_key,
        display_name: top.display_name,
        wallet_id: topWalletId,
        baseline_spend_cents: top.spend_cents,
        baseline_tx_count: top.tx_count,
        baseline_window_days: windowDays,
        currencyCode: primaryCurrency,
        currency_code: primaryCurrency,
      }
    },
    risk_level: 'low',
    consent_required: 'smart',
    period_key: proposalPeriodKey,
    status: 'pending',
    metadata: {
      category_key: top.category_key,
      month_key: monthKey,
      currencyCode: primaryCurrency,
      currency_code: primaryCurrency,
    }
  })

  await logSuggestion(supabase, userId, rule_id, monthKey, top.category_key)

  return { rule_id, created: true }
}

function moneyToCents(raw: unknown) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

function monthKeyUTC(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function startOfUTCDayISO(d = new Date()) {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x.toISOString()
}

function toDateKeyUTC(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function clampCycleStartDay(raw: unknown) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(31, Math.round(value)))
}

function buildCycleAnchorUtcMs(year: number, month: number, cycleStartDay: number) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const safeDay = Math.min(clampCycleStartDay(cycleStartDay), daysInMonth)
  return Date.UTC(year, month, safeDay)
}

function getCurrentCycleWindow(now = new Date(), cycleStartDay = 1) {
  const safeDay = clampCycleStartDay(cycleStartDay)
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const day = now.getUTCDate()
  const todayMidUtc = Date.UTC(year, month, day)
  const thisMonthAnchorUtc = buildCycleAnchorUtcMs(year, month, safeDay)
  const startUtc = todayMidUtc >= thisMonthAnchorUtc
    ? thisMonthAnchorUtc
    : buildCycleAnchorUtcMs(year, month - 1, safeDay)
  const startDate = new Date(startUtc)
  const nextStartUtc = buildCycleAnchorUtcMs(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth() + 1,
    safeDay,
  )
  const endUtc = nextStartUtc - DAY_MS
  const totalDays = Math.floor((endUtc - startUtc) / DAY_MS) + 1
  const daysElapsed = Math.max(0, Math.floor((todayMidUtc - startUtc) / DAY_MS))
  const daysRemaining = Math.max(0, totalDays - daysElapsed)

  return {
    cycleStart: toDateKeyUTC(new Date(startUtc)),
    cycleEnd: toDateKeyUTC(new Date(endUtc)),
    daysRemaining,
    totalDays,
  }
}

async function fetchUserPreferences(supabase: any, userId: string) {
  const { data } = await supabase
    .from('user_preferences')
    .select('cycle_start_day, currency')
    .eq('user_id', userId)
    .maybeSingle()

  return {
    cycle_start_day: clampCycleStartDay(data?.cycle_start_day ?? 1),
    currency: typeof data?.currency === 'string' ? data.currency : null,
  }
}

async function fetchUserWallets(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from('wallets')
    .select('id, name, type, balance, archived, currency_code')
    .eq('user_id', userId)
  if (error) return []
  return (data || []) as Array<{
    id: string
    name: string | null
    type: string | null
    balance: number | string | null
    archived: boolean | null
    currency_code: string | null
  }>
}

function getWalletCurrencyCode(wallet: any) {
  return normalizeCurrencyCode(wallet?.currency_code)
}

function determinePrimaryCurrency(userPrefCurrency: string | null, wallets: any[]) {
  void wallets
  const preferred = normalizeCurrencyCodeOrNull(userPrefCurrency)
  if (preferred) return preferred
  throw new Error('user_preferences.currency is missing or invalid for this user')
}

function normalizeCurrencyCode(raw: unknown) {
  const code = String(raw ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

async function getPrimaryCurrencyWalletScope(
  supabase: any,
  userId: string,
  userPrefs?: { currency: string | null },
  forcedCurrency?: string | null,
) {
  void forcedCurrency
  const basePrefs = userPrefs ?? await fetchUserPreferences(supabase, userId)
  const prefs = basePrefs
  const allWallets = (await fetchUserWallets(supabase, userId)).filter(isWalletActive)
  const primaryCurrency = determinePrimaryCurrency(prefs.currency, allWallets)
  // Use all active wallets for evaluation and normalize transactions to primaryCurrency.
  const wallets = allWallets
  const walletIds = wallets
    .map((wallet) => String(wallet?.id ?? '').trim())
    .filter(Boolean)

  return {
    userPrefs: prefs,
    primaryCurrency,
    wallets,
    walletIds,
  }
}

function isWalletActive(wallet: any) {
  return wallet?.archived !== true
}

function getWalletTypeKey(wallet: any) {
  return String(wallet?.type ?? '')
    .trim()
    .toLowerCase()
}

function isSavingsWallet(wallet: any) {
  const typeKey = getWalletTypeKey(wallet)
  if (typeKey === 'savings') return true
  const nameKey = normalizeText(String(wallet?.name ?? ''))
  return nameKey.includes('saving') || nameKey.includes('savings')
}

function isEmergencyWallet(wallet: any) {
  const typeKey = getWalletTypeKey(wallet)
  if (typeKey === 'emergency') return true
  const nameKey = normalizeText(String(wallet?.name ?? ''))
  return nameKey.includes('emergency')
}

function formatMoneyWhole(cents: number, currencyCode: string) {
  const safeCurrency = normalizeCurrencyCode(currencyCode)
  const major = Math.max(0, Math.round(cents / 100))
  const grouped = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(major)
  if (!safeCurrency) {
    return grouped
  }
  const fallbackSymbol = currencySymbolForCode(safeCurrency)
  if (fallbackSymbol !== safeCurrency) {
    return `${fallbackSymbol}${grouped}`
  }
  try {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: safeCurrency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(major)
    if (!formatted.toUpperCase().includes(safeCurrency)) {
      return formatted
    }
  } catch {
    // Fall through to ISO-code fallback below.
  }
  return `${safeCurrency} ${grouped}`
}

function currencySymbolForCode(currencyCode: string): string {
  const code = normalizeCurrencyCode(currencyCode)
  if (!code) return String(currencyCode ?? '').trim().toUpperCase()
  const symbolMap: Record<string, string> = {
    USD: '$',
    EUR: '\u20AC',
    GBP: '\u00A3',
    TRY: '\u20BA',
    JPY: '\u00A5',
    CNY: '\u00A5',
    INR: '\u20B9',
    RUB: '\u20BD',
    KRW: '\u20A9',
    AUD: 'A$',
    CAD: 'C$',
    CHF: 'CHF',
    SEK: 'kr',
    NOK: 'kr',
    DKK: 'kr',
    PLN: 'z\u0142',
    BRL: 'R$',
    MXN: '$',
    ZAR: 'R',
    AED: 'AED',
    SAR: '\uFDFC',
  }
  return symbolMap[code] ?? code
}
function formatCoverageMonths(months: number) {
  if (!Number.isFinite(months) || months <= 0) return '0.0'
  return months.toFixed(1)
}

function isExcludedTxForCashFlow(txn: {
  category: string | null
  is_opening_balance?: boolean | null
  is_manual_topup?: boolean | null
}) {
  if (!txn) return true
  if (txn.is_opening_balance === true) return true
  if (txn.is_manual_topup === true) return true

  return false
}

function isTransferLikeCategoryKey(categoryKey: string) {
  return (
    categoryKey === 'transfer' ||
    categoryKey === 'internal-transfer' ||
    categoryKey === 'wallet-transfer' ||
    categoryKey === 'money-transfer' ||
    categoryKey === 'account-transfer'
  )
}

function isTransferOrRefundCategory(txn: { category: string | null }) {
  const categoryKey = normalizeCategoryKeyLocal(txn?.category ?? '')
  if (!categoryKey) return false
  return (
    isTransferLikeCategoryKey(categoryKey) ||
    categoryKey === 'refund' ||
    categoryKey === 'tax-refund' ||
    categoryKey === 'cashback' ||
    categoryKey === 'cash-back' ||
    categoryKey === 'reimbursement' ||
    categoryKey === 'reimbursements' ||
    categoryKey === 'reversal' ||
    categoryKey === 'return' ||
    categoryKey === 'credit'
  )
}

function sumEligibleIncomeCents(txns: Array<{ amount: number; category: string | null; is_opening_balance?: boolean | null; is_manual_topup?: boolean | null }>) {
  return txns.reduce((sum, txn) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    const cents = moneyToCents(txn.amount)
    if (cents <= 0) return sum
    return sum + cents
  }, 0)
}

function sumSavingsRuleIncomeCents(
  txns: Array<{
    amount: number
    category: string | null
    is_opening_balance?: boolean | null
    is_manual_topup?: boolean | null
  }>
) {
  return txns.reduce((sum, txn) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    if (isTransferOrRefundCategory(txn)) return sum
    const cents = moneyToCents(txn.amount)
    if (cents <= 0) return sum
    return sum + cents
  }, 0)
}

function sumSavingsRuleSpendCents(
  txns: Array<{
    amount: number
    category: string | null
    is_opening_balance?: boolean | null
    is_manual_topup?: boolean | null
  }>
) {
  return txns.reduce((sum, txn) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    if (isTransferOrRefundCategory(txn)) return sum
    const cents = moneyToCents(txn.amount)
    if (cents >= 0) return sum
    return sum + Math.abs(cents)
  }, 0)
}

function getSavingsTargetRate(unspentRatio: number) {
  if (!Number.isFinite(unspentRatio) || unspentRatio < 0.05) return 0
  if (unspentRatio >= 0.40) return 0.20
  if (unspentRatio >= 0.20) return 0.10
  if (unspentRatio >= 0.10) return 0.05
  return 0.02
}

function getEmergencyTargetRate(unspentRatio: number) {
  if (!Number.isFinite(unspentRatio) || unspentRatio < 0.15) return 0
  if (unspentRatio >= 0.60) return 0.05
  if (unspentRatio >= 0.40) return 0.03
  if (unspentRatio >= 0.25) return 0.02
  return 0.01
}

async function logSuggestion(
  supabase: any,
  userId: string,
  suggestionType: string,
  monthKey: string,
  categoryKey: string | null = null,
) {
  try {
    await supabase
      .from('action_suggestion_log')
      .insert([{
        user_id: userId,
        suggestion_type: suggestionType,
        category_key: categoryKey,
        month_key: monthKey,
      }])
  } catch (_error) {
  }
}

function getRuleCaps(ruleId: string) {
  // Rule-specific capacity so budget/challenge do not block each other.
  const caps: Record<string, { perDay: number; per7d: number }> = {
    budget_suggestion_v1: { perDay: 1, per7d: 3 },
    challenge_suggestion_v1: { perDay: 1, per7d: 3 },
    emergency_wallet_booster_v1: { perDay: 1, per7d: 3 },
    cycle_leftover_to_savings_wallet_v1: { perDay: 1, per7d: 3 },
    subscription_hike_unused_v1: { perDay: 1, per7d: 3 },
  }
  return caps[ruleId] ?? { perDay: GLOBAL_ACTIONABLE_MAX_PER_DAY, per7d: GLOBAL_ACTIONABLE_MAX_PER_7D }
}

async function hasActionableSuggestionCapacity(supabase: any, userId: string, ruleId: string) {
  const daySince = startOfUTCDayISO(new Date())
  const weekSince = daysAgo(7).toISOString()
  const caps = getRuleCaps(ruleId)

  const [{ count: dayCount, error: dayError }, { count: weekCount, error: weekError }] = await Promise.all([
    supabase
      .from('action_suggestion_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('suggestion_type', ruleId)
      .gte('created_at', daySince),
    supabase
      .from('action_suggestion_log')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('suggestion_type', ruleId)
      .gte('created_at', weekSince),
  ])

  if (dayError || weekError) return false

  return (dayCount ?? 0) < caps.perDay
    && (weekCount ?? 0) < caps.per7d
}

async function canCreateActionableProposal(supabase: any, userId: string, ruleId: string) {
  if (await hasRecentDecision(supabase, userId, ruleId, 7)) return false
  return hasActionableSuggestionCapacity(supabase, userId, ruleId)
}

async function getRecentlyDeclinedCategoryKeys(
  supabase: any,
  userId: string,
  ruleId: string,
  daysWindow: number,
) {
  const sinceISO = daysAgo(daysWindow).toISOString()
  const { data, error } = await supabase
    .from('action_proposals')
    .select('period_key, metadata, created_at')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('status', 'declined')
    .gte('created_at', sinceISO)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error || !Array.isArray(data)) return new Set<string>()

  const keys = new Set<string>()
  for (const row of data as any[]) {
    const fromMetadata = normalizeText(String(row?.metadata?.category_key ?? ''))
    if (fromMetadata) {
      keys.add(fromMetadata)
      continue
    }

    const periodKey = String(row?.period_key ?? '')
    const idx = periodKey.indexOf(':')
    if (idx >= 0 && idx < periodKey.length - 1) {
      const fromPeriodKey = normalizeText(periodKey.slice(idx + 1))
      if (fromPeriodKey) keys.add(fromPeriodKey)
    }
  }

  return keys
}

async function getCategorySuggestionsThisMonth(
  supabase: any,
  userId: string,
  monthKey: string,
  ruleIds: string[],
) {
  if (!Array.isArray(ruleIds) || ruleIds.length === 0) return new Set<string>()
  const { data } = await supabase
    .from('action_suggestion_log')
    .select('category_key')
    .eq('user_id', userId)
    .eq('month_key', monthKey)
    .in('suggestion_type', ruleIds)
    .limit(500)

  return new Set(
    (data || [])
      .map((row: any) => normalizeText(String(row?.category_key ?? '')))
      .filter(Boolean)
  )
}

async function buildCurrentCycleSnapshot(
  supabase: any,
  userId: string,
  forcedCurrency?: string | null,
) {
  void forcedCurrency
  const { data: prefsRow, error: prefsError } = await supabase
    .from('user_preferences')
    .select('cycle_start_day, currency')
    .eq('user_id', userId)
    .maybeSingle()
  if (prefsError) {
    throw new Error(`current cycle snapshot preferences load failed: ${prefsError.message}`)
  }

  const userPrefs = {
    cycle_start_day: clampCycleStartDay(prefsRow?.cycle_start_day ?? 1),
    currency: typeof prefsRow?.currency === 'string' ? prefsRow.currency : null,
  }
  const cycle = getCurrentCycleWindow(new Date(), userPrefs.cycle_start_day)
  const { data: walletRows, error: walletsError } = await supabase
    .from('wallets')
    .select('id, name, type, balance, archived, currency_code')
    .eq('user_id', userId)
  if (walletsError) {
    throw new Error(`current cycle snapshot wallets load failed: ${walletsError.message}`)
  }

  const wallets = ((walletRows || []) as Array<{
    id: string
    name: string | null
    type: string | null
    balance: number | string | null
    archived: boolean | null
    currency_code: string | null
  }>).filter(isWalletActive)
  const primaryCurrency = determinePrimaryCurrency(userPrefs.currency, wallets)
  const walletIds = wallets
    .map((wallet) => String(wallet?.id ?? '').trim())
    .filter(Boolean)

  let txns: Array<{
    amount: number
    reporting_amount?: number | null
    reporting_currency?: string | null
    category: string | null
    category_id: string | null
    date: string
    wallet_id: string | null
    is_opening_balance: boolean | null
    is_manual_topup: boolean | null
  }> = []
  if (walletIds.length > 0) {
    const { data: txnRows, error: txnsError } = await supabase
      .from('wallet_transactions')
      .select('amount, reporting_amount, reporting_currency, category, category_id, date, wallet_id, is_opening_balance, is_manual_topup')
      .eq('user_id', userId)
      .gte('date', cycle.cycleStart)
      .in('wallet_id', walletIds)
    if (txnsError) {
      throw new Error(`current cycle snapshot transactions load failed: ${txnsError.message}`)
    }
    txns = (txnRows || []) as typeof txns
  }

  const normalizedCurrency = normalizeCurrencyCodeOrNull(primaryCurrency)
  if (normalizedCurrency && txns.length > 0) {
    const normalized = await normalizeTransactionsToMainCurrency(
      supabase,
      userId,
      normalizedCurrency,
      txns,
    )
    txns = normalized.rows as typeof txns
  }

  const incomeCents = sumEligibleIncomeCents(txns)
  let spendCents = 0
  for (const txn of txns) {
    if (isExcludedTxForCashFlow(txn)) continue
    const cents = moneyToCents(txn.amount)
    if (cents < 0) spendCents += Math.abs(cents)
  }

  const { data: plannedTransfers } = await supabase
    .from('planned_transfers')
    .select('amount_cents')
    .eq('user_id', userId)
    .in('status', ['planned', 'done'])
    .gte('created_at', `${cycle.cycleStart}T00:00:00.000Z`)

  const reservedCents = (plannedTransfers || []).reduce(
    (sum: number, row: any) => sum + Math.max(0, Math.round(Number(row?.amount_cents ?? 0))),
    0,
  )

  const emptyObligations = {
    totals: {
      grandTotalCents: 0,
      windowTotalCents: 0,
      overdueTotalCents: 0,
    },
  }

  const safeGetObligations = async (
    label: 'remaining' | 'cycle',
    params: {
      mode: 'custom'
      windowStart: string
      windowEnd: string
      cycleStartDay: number
      walletIds: string[]
      includeOverdue: boolean
      includeLines: boolean
    },
  ) => {
    try {
      return await getCanonicalObligations(supabase, params)
    } catch (error) {
      // Fail-open for actionable proposals: obligations are helpful context but
      // should never block savings/emergency suggestion generation.
      logError('policy_eval.obligations_fallback', {
        userId,
        label,
        error: String(error),
      })
      return emptyObligations
    }
  }

  const remainingObligations = walletIds.length > 0
    ? await safeGetObligations('remaining', {
      mode: 'custom',
      windowStart: toDateKeyUTC(new Date()),
      windowEnd: cycle.cycleEnd,
      cycleStartDay: userPrefs.cycle_start_day,
      walletIds,
      includeOverdue: true,
      includeLines: false,
    })
    : emptyObligations

  const cycleObligations = walletIds.length > 0
    ? await safeGetObligations('cycle', {
      mode: 'custom',
      windowStart: cycle.cycleStart,
      windowEnd: cycle.cycleEnd,
      cycleStartDay: userPrefs.cycle_start_day,
      walletIds,
      includeOverdue: true,
      includeLines: false,
    })
    : emptyObligations

  return {
    userPrefs,
    cycle,
    primaryCurrency,
    wallets,
    walletIds,
    txns,
    incomeCents,
    spendCents,
    reservedCents,
    obligationsRemainingCents: Math.max(
      remainingObligations?.totals?.grandTotalCents || 0,
      (remainingObligations?.totals?.windowTotalCents || 0) + (remainingObligations?.totals?.overdueTotalCents || 0),
    ),
    cycleObligationsCents: Math.max(
      cycleObligations?.totals?.grandTotalCents || 0,
      (cycleObligations?.totals?.windowTotalCents || 0) + (cycleObligations?.totals?.overdueTotalCents || 0),
    ),
  }
}

async function sumEssentialVariableSpendCents(
  supabase: any,
  userId: string,
  txns: Array<{
    amount: number
    category: string | null
    category_id?: string | null
    is_opening_balance?: boolean | null
    is_manual_topup?: boolean | null
  }>
) {
  const tierMaps = await fetchExpenseTierMaps(supabase, userId)
  return txns.reduce((sum, txn) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    const cents = moneyToCents(txn.amount)
    if (cents >= 0) return sum
    const categoryKey = normalizeText(String(txn.category ?? ''))
    if (!categoryKey) return sum
    const tier = resolveExpenseTierForCategory(categoryKey, txn.category_id ?? null, tierMaps)
    if (tier !== 'essential') return sum
    return sum + Math.abs(cents)
  }, 0)
}

function parseDateKeyUTC(value: string | null | undefined) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return new Date(Date.UTC(year, month - 1, day))
}

function deriveBudgetEndDateUTC(startDate: Date, endDateRaw: string | null, periodRaw: string | null) {
  const explicitEnd = parseDateKeyUTC(endDateRaw)
  if (explicitEnd) return explicitEnd

  const period = String(periodRaw ?? 'MONTHLY').trim().toUpperCase()
  switch (period) {
    case 'DAILY':
      return new Date(startDate.getTime())
    case 'WEEKLY':
      return new Date(startDate.getTime() + (6 * DAY_MS))
    case 'YEARLY':
      return new Date(Date.UTC(
        startDate.getUTCFullYear() + 1,
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
      ) - DAY_MS)
    case 'MONTHLY':
    default:
      return new Date(Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth() + 1,
        startDate.getUTCDate(),
      ) - DAY_MS)
  }
}

async function evaluate_budget_suggestion_v1(
  supabase: any,
  userId: string,
  periodKey: string,
  forcedCurrency?: string | null,
) {
  const rule_id = 'budget_suggestion_v1'
  if (!(await canCreateActionableProposal(supabase, userId, rule_id))) return { rule_id, created: false }

  const { data: settingsRow } = await supabase
    .from('budget_suggestion_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  const thresholdPctRaw = Number(settingsRow?.threshold_pct_of_income ?? 0.10)
  const thresholdPct = Number.isFinite(thresholdPctRaw)
    ? Math.min(0.95, Math.max(0, thresholdPctRaw))
    : 0.10
  const reductionPctRaw = Number(
    settingsRow?.recommended_reduction_pct ??
    settingsRow?.reduction_pct ??
    thresholdPct
  )
  const reductionPct = Number.isFinite(reductionPctRaw)
    ? Math.min(0.95, Math.max(0, reductionPctRaw))
    : thresholdPct
  const minIncomeCents = Number(settingsRow?.min_income_cents ?? 0)
  const minTxCount = Number(settingsRow?.min_tx_count_in_category ?? 2)
  const maxPerDay = Number(settingsRow?.max_suggestions_per_day ?? 1)

  if (maxPerDay <= 0) return { rule_id, created: false }

  const monthKey = monthKeyUTC(new Date())
  const alreadySuggested = await getCategorySuggestionsThisMonth(supabase, userId, monthKey, [rule_id])
  const userPrefs = await fetchUserPreferences(supabase, userId)
  const cycle = getCurrentCycleWindow(new Date(), userPrefs.cycle_start_day)
  const { walletIds, primaryCurrency } = await getPrimaryCurrencyWalletScope(supabase, userId, userPrefs, forcedCurrency)
  const txns = await fetchRecentTransactions(
    supabase,
    userId,
    cycle.cycleStart,
    walletIds,
    primaryCurrency,
  )

  const { data: activeBudgets } = await supabase
    .from('budgets')
    .select('category_id, name')
    .eq('user_id', userId)
    .eq('is_active', true)

  const budgetedCategoryIds = new Set(
    (activeBudgets || [])
      .map((budget: any) => String(budget?.category_id ?? '').trim())
      .filter(Boolean)
  )
  const budgetedNames = new Set(
    (activeBudgets || [])
      .map((budget: any) => normalizeText(String(budget?.name ?? '')))
      .filter(Boolean)
  )

  const incomeCents = sumEligibleIncomeCents(txns)

  if (incomeCents <= 0) return { rule_id, created: false }
  if (incomeCents < minIncomeCents) return { rule_id, created: false }

  const spendByCategory: Record<string, number> = {}
  const txCountByCategory: Record<string, number> = {}
  const walletByCategory: Record<string, Record<string, number>> = {}
  const labelByCategory: Record<string, string> = {}
  const categoryIdByCategory: Record<string, string> = {}

  for (const t of txns) {
    if (isExcludedTxForCashFlow(t)) continue
    if (isTransferOrRefundCategory(t)) continue
    const cents = moneyToCents((t as any).amount)
    if (cents >= 0) continue

    // Category-only matching. Do not infer from merchant/title/note text.
    const rawCategory = (t as any).category
    const catName = (rawCategory == null ? '' : String(rawCategory)).trim()
    if (!catName) continue
    if (isSuppressedProposalCategory(catName)) continue

    const catKey = normalizeText(catName)
    if (!catKey) continue

    if (!labelByCategory[catKey]) labelByCategory[catKey] = catName
    if (!categoryIdByCategory[catKey] && typeof t.category_id === 'string' && t.category_id.trim()) {
      categoryIdByCategory[catKey] = t.category_id.trim()
    }

    spendByCategory[catKey] = (spendByCategory[catKey] || 0) + Math.abs(cents)
    txCountByCategory[catKey] = (txCountByCategory[catKey] || 0) + 1

    const wid = (t as any).wallet_id
    if (wid) {
      walletByCategory[catKey] = walletByCategory[catKey] || {}
      walletByCategory[catKey][String(wid)] = (walletByCategory[catKey][String(wid)] || 0) + Math.abs(cents)
    }
  }

  const categoryKeys = Object.keys(spendByCategory)
  if (categoryKeys.length === 0) return { rule_id, created: false }
  const tierMaps = await fetchExpenseTierMaps(supabase, userId)

  const { data: policies } = await supabase
    .from('category_budget_policy')
    .select('user_id, category_key, is_budgetable')
    .or(`user_id.eq.${userId},user_id.is.null`)
    .in('category_key', categoryKeys)

  const budgetableMap: Record<string, boolean> = {}
  for (const key of categoryKeys) budgetableMap[key] = true

  for (const row of (policies || []) as any[]) {
    const key = String(row.category_key ?? '').toLowerCase()
    if (!key) continue
    const isBudgetable = Boolean(row.is_budgetable)
    if (row.user_id) {
      budgetableMap[key] = isBudgetable
    } else if (budgetableMap[key] === true && isBudgetable === false) {
      budgetableMap[key] = false
    }
  }

  const thresholdCents = Math.round(incomeCents * thresholdPct)
  const declinedCooldownKeys = await getRecentlyDeclinedCategoryKeys(
    supabase,
    userId,
    rule_id,
    7,
  )
  const candidates = categoryKeys
    .filter(k => !alreadySuggested.has(k))
    .filter(k => !declinedCooldownKeys.has(k))
    .filter((k) => {
      const categoryId = categoryIdByCategory[k] || null
      const tier = resolveExpenseTierForCategory(k, categoryId, tierMaps)
      return tier === 'flexible_essential'
    })
    .filter(k => (budgetableMap[k] ?? true) === true)
    .filter((k) => {
      const categoryId = categoryIdByCategory[k] || null
      if (categoryId && budgetedCategoryIds.has(categoryId)) return false
      return !budgetedNames.has(k)
    })
    .filter(k => (txCountByCategory[k] || 0) >= minTxCount)
    .map(k => ({
      category_key: k,
      spend_cents: spendByCategory[k] || 0,
      tx_count: txCountByCategory[k] || 0,
      category_id: categoryIdByCategory[k] || null,
    }))
    .filter(x => x.spend_cents >= thresholdCents)
    .sort((a, b) => b.spend_cents - a.spend_cents)

  const top = candidates[0]
  if (!top) return { rule_id, created: false }

  // Pick the wallet with highest spend in this category (optional).
  const walletSpend = walletByCategory[top.category_key] || {}
  const topWalletId = Object.keys(walletSpend)
    .sort((a, b) => (walletSpend[b] || 0) - (walletSpend[a] || 0))[0] || null

  const displayName = (labelByCategory[top.category_key] || top.category_key)
    .trim()
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')

  const spentDisplay = formatMoneyWhole(top.spend_cents, primaryCurrency)
  const recommendedAmountCents = recommendedBudgetAmountCents(top.spend_cents, reductionPct)
  const recommendedDisplay = formatMoneyWhole(recommendedAmountCents, primaryCurrency)
  const spentMajor = Math.round(top.spend_cents / 100)
  const incomeMajor = Math.max(1, Math.round(incomeCents / 100))
  const pct = Math.round((spentMajor / incomeMajor) * 100)
  const title = `Create a ${displayName} budget?`
  const body = `We noticed you've spent about ${spentDisplay} on ${displayName} so far this cycle (around ${pct}% of your income). A focused target is about ${recommendedDisplay} for this category.`

  const proposalPeriodKey = `${cycle.cycleStart}:${top.category_key}`

  const { data: pending } = await supabase
    .from('action_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', rule_id)
    .eq('status', 'pending')
    .eq('period_key', proposalPeriodKey)
    .limit(1)
    .maybeSingle()
  if (pending) return { rule_id, created: false }

  await insertProposal(supabase, {
    user_id: userId,
    rule_id,
    title,
    body,
    cta_json: {
      label: 'Create budget',
      payload: {
        category_id: top.category_id,
        category_key: top.category_key,
        display_name: displayName,
        budget_name: labelByCategory[top.category_key] || displayName,
        amount_cents: recommendedAmountCents,
        spent_cents: top.spend_cents,
        income_percent: pct,
        wallet_id: topWalletId,
        cycle_start: cycle.cycleStart,
        cycle_end: cycle.cycleEnd,
        currencyCode: primaryCurrency,
        currency_code: primaryCurrency,
      }
    },
    risk_level: 'low',
    consent_required: 'smart',
    period_key: proposalPeriodKey,
    status: 'pending',
    metadata: {
      category_key: top.category_key,
      category_id: top.category_id,
      month_key: monthKey,
      currencyCode: primaryCurrency,
      currency_code: primaryCurrency,
    }
  })

  await logSuggestion(supabase, userId, rule_id, monthKey, top.category_key)

  return { rule_id, created: true }
}

async function hasPendingProposal(supabase: any, userId: string, ruleId: string) {
  const { data, error } = await supabase
    .from('action_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle()
  if (error) return false
  return Boolean(data)
}

async function insertProposal(supabase: any, payload: any) {
  const { error } = await supabase.from('action_proposals').insert([payload])
  if (error) {
    const msg = String(error.message || '')
    if (msg.includes('duplicate key value') || msg.includes('already exists')) {
      return // ignore duplicates
    }
    throw new Error(`insertProposal failed: ${error.message}`)
  }
}

async function findActionProposalForPeriod(
  supabase: any,
  userId: string,
  ruleId: string,
  periodKey: string,
) {
  const { data, error } = await supabase
    .from('action_proposals')
    .select('id, status, period_key')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('period_key', periodKey)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`findActionProposalForPeriod failed: ${error.message}`)
  }
  return data as { id: string; status: string; period_key: string } | null
}

async function expirePendingActionProposalIds(
  supabase: any,
  userId: string,
  proposalIds: string[],
) {
  const targetIds = [...new Set(proposalIds.filter(Boolean))]
  if (targetIds.length === 0) return 0

  const { error } = await supabase
    .from('action_proposals')
    .update({ status: 'expired' })
    .in('id', targetIds)
    .eq('user_id', userId)
    .eq('status', 'pending')

  if (error) {
    throw new Error(`expirePendingActionProposalIds failed: ${error.message}`)
  }

  return targetIds.length
}

async function expirePendingActionProposalForPeriod(
  supabase: any,
  userId: string,
  ruleId: string,
  periodKey: string,
) {
  const proposal = await findActionProposalForPeriod(supabase, userId, ruleId, periodKey)
  if (!proposal || proposal.status !== 'pending') return 0
  return expirePendingActionProposalIds(supabase, userId, [proposal.id])
}

async function expireOlderPendingActionProposalsForRule(
  supabase: any,
  userId: string,
  ruleId: string,
  currentPeriodKey: string,
) {
  const { data, error } = await supabase
    .from('action_proposals')
    .select('id, period_key')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('status', 'pending')
    .neq('period_key', currentPeriodKey)
    .limit(200)

  if (error) {
    throw new Error(`expireOlderPendingActionProposalsForRule failed: ${error.message}`)
  }

  const ids = ((data || []) as Array<{ id: string }>).map((row) => row.id)
  return expirePendingActionProposalIds(supabase, userId, ids)
}

// Cooldown: suppress re-proposing after a recent decision
async function hasRecentDecision(
  supabase: any,
  userId: string,
  ruleId: string,
  daysWindow: number
) {
  const sinceISO = daysAgo(daysWindow).toISOString()
  // Accepted: check executed actions
  const { data: exec, error: eErr } = await supabase
    .from('executed_actions')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .gte('created_at', sinceISO)
    .limit(1)
    .maybeSingle()
  if (!eErr && exec) return true

  // Accepted but not yet executed: check proposals with accepted status.
  // Prefer metadata.accepted_at when present; fall back to created_at for older rows.
  const { data: acceptedRows, error: aErr } = await supabase
    .from('action_proposals')
    .select('id, created_at, metadata')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('status', 'accepted')
    .order('created_at', { ascending: false })
    .limit(50)
  if (!aErr && Array.isArray(acceptedRows)) {
    const hasAcceptedWithinWindow = acceptedRows.some((row: any) => {
      const acceptedAtRaw =
        typeof row?.metadata?.accepted_at === 'string' && row.metadata.accepted_at
          ? row.metadata.accepted_at
          : row?.created_at
      return typeof acceptedAtRaw === 'string' && acceptedAtRaw >= sinceISO
    })
    if (hasAcceptedWithinWindow) return true
  }

  // Declined: check proposals marked declined recently
  const { data: dec, error: dErr } = await supabase
    .from('action_proposals')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', ruleId)
    .eq('status', 'declined')
    .gte('created_at', sinceISO)
    .limit(1)
    .maybeSingle()
  if (!dErr && dec) return true

  return false
}

async function evaluate_emergency_wallet_booster_v1(
  supabase: any,
  userId: string,
  periodKey: string,
  forcedCurrency?: string | null,
) {
  void periodKey
  const rule_id = 'emergency_wallet_booster_v1'
  const settings = await getEmergencyBoosterSettings(supabase, userId)
  if (!settings.is_enabled) return { rule_id, created: false }

  let snapshot: Awaited<ReturnType<typeof buildCurrentCycleSnapshot>>
  try {
    snapshot = await buildCurrentCycleSnapshot(supabase, userId, forcedCurrency)
  } catch (error) {
    logError('policy_eval.money_snapshot_failed', { userId, rule_id, error: String(error) })
    return { rule_id, created: false }
  }

  const proposalPeriodKey = `${snapshot.cycle.cycleStart}:emergency`
  await expireOlderPendingActionProposalsForRule(supabase, userId, rule_id, proposalPeriodKey)
  const expireCurrentPendingAndStop = async () => {
    await expirePendingActionProposalForPeriod(supabase, userId, rule_id, proposalPeriodKey)
    return { rule_id, created: false }
  }

  const cycleDay = Math.max(1, snapshot.cycle.totalDays - snapshot.cycle.daysRemaining + 1)
  if (cycleDay < 5 || cycleDay > 10) return expireCurrentPendingAndStop()

  const cycleIncomeCents = sumSavingsRuleIncomeCents(snapshot.txns)
  if (cycleIncomeCents <= 0) return expireCurrentPendingAndStop()

  const cycleSpendCents = sumSavingsRuleSpendCents(snapshot.txns)
  const unspentCents = Math.max(0, cycleIncomeCents - cycleSpendCents)
  if (unspentCents <= 0) return expireCurrentPendingAndStop()
  if (unspentCents < settings.min_leftover_cents) return expireCurrentPendingAndStop()

  const unspentRatio = unspentCents / Math.max(1, cycleIncomeCents)
  const targetRate = settings.transfer_ratio > 0
    ? settings.transfer_ratio
    : getEmergencyTargetRate(unspentRatio)
  if (targetRate <= 0) return expireCurrentPendingAndStop()

  const targetEmergencyRawCents = Math.round(unspentCents * targetRate)
  const targetEmergencyCents = settings.hard_cap_cents > 0
    ? Math.min(targetEmergencyRawCents, settings.hard_cap_cents)
    : targetEmergencyRawCents
  if (targetEmergencyCents <= 0) return expireCurrentPendingAndStop()

  const emergencyWallets = snapshot.wallets.filter(isEmergencyWallet)
  const emergencyWallet = emergencyWallets.length > 0
    ? [...emergencyWallets].sort((a, b) => moneyToCents(Number(b?.balance ?? 0)) - moneyToCents(Number(a?.balance ?? 0)))[0]
    : null
  const emergencyWalletIds = new Set(
    emergencyWallets
      .map((wallet) => String(wallet?.id ?? '').trim())
      .filter(Boolean)
  )

  const alreadyMovedToEmergencyCents = snapshot.txns.reduce((sum: number, txn: any) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    const walletId = String(txn?.wallet_id ?? '').trim()
    if (!walletId || !emergencyWalletIds.has(walletId)) return sum
    const cents = moneyToCents(Number(txn?.amount ?? 0))
    if (cents <= 0) return sum
    const categoryKey = normalizeCategoryKeyLocal(String(txn?.category ?? ''))
    if (!isTransferLikeCategoryKey(categoryKey)) return sum
    return sum + cents
  }, 0)

  const remainingToTargetCents = Math.max(0, targetEmergencyCents - alreadyMovedToEmergencyCents)
  if (remainingToTargetCents <= 0) return expireCurrentPendingAndStop()

  const suggestedRawCents = Math.min(remainingToTargetCents, unspentCents)
  const suggestedCents = settings.hard_cap_cents > 0
    ? Math.min(suggestedRawCents, settings.hard_cap_cents)
    : suggestedRawCents
  if (suggestedCents <= 0) return expireCurrentPendingAndStop()
  if (suggestedCents < settings.min_suggestion_cents) return expireCurrentPendingAndStop()

  const cycleExisting = await findActionProposalForPeriod(supabase, userId, rule_id, proposalPeriodKey)
  if (cycleExisting) return { rule_id, created: false }
  if (!(await canCreateActionableProposal(supabase, userId, rule_id))) return { rule_id, created: false }

  const monthKey = monthKeyUTC(new Date())
  const currencyCode = snapshot.primaryCurrency
  const title = emergencyWallet
    ? `Move ${formatMoneyWhole(suggestedCents, currencyCode)} to Emergency Wallet`
    : `Create an Emergency Wallet and set aside ${formatMoneyWhole(suggestedCents, currencyCode)}`
  const body = emergencyWallet
    ? alreadyMovedToEmergencyCents > 0
      ? `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You already moved ${formatMoneyWhole(alreadyMovedToEmergencyCents, currencyCode)} to emergency this cycle. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} now.`
      : `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You have not moved anything to emergency yet this cycle. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} now.`
    : `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} into emergency this cycle. Create an Emergency Wallet to set it aside.`

  await insertProposal(supabase, {
    user_id: userId,
    rule_id,
    title,
    body,
    cta_json: {
      label: emergencyWallet ? `Move ${formatMoneyWhole(suggestedCents, currencyCode)}` : 'Create Emergency Wallet',
      payload: {
        amount: Math.round(suggestedCents / 100),
        amount_cents: suggestedCents,
        currencyCode,
        currency_code: currencyCode,
        cycle_income_cents: cycleIncomeCents,
        cycle_spend_cents: cycleSpendCents,
        unspent_cents: unspentCents,
        already_emergency_cents: alreadyMovedToEmergencyCents,
        target_emergency_cents: targetEmergencyCents,
        remaining_to_target_cents: remainingToTargetCents,
        cycle_start: snapshot.cycle.cycleStart,
        cycle_end: snapshot.cycle.cycleEnd,
        target_wallet_id: emergencyWallet?.id ?? null,
        target_wallet_name: emergencyWallet?.name ?? 'Emergency Wallet',
        target_wallet_type: 'emergency',
        create_wallet_if_missing: !emergencyWallet,
      }
    },
    risk_level: 'low',
    consent_required: 'smart',
    period_key: proposalPeriodKey,
    status: 'pending',
    metadata: {
      month_key: monthKey,
      cycle_start: snapshot.cycle.cycleStart,
      cycle_end: snapshot.cycle.cycleEnd,
      currencyCode,
      currency_code: currencyCode,
      target_emergency_cents: targetEmergencyCents,
      already_emergency_cents: alreadyMovedToEmergencyCents,
      autopilot_eligible: false,
    }
  })

  await logSuggestion(supabase, userId, rule_id, monthKey)
  return { rule_id, created: true }
}


async function evaluate_cycle_leftover_to_savings_wallet_v1(
  supabase: any,
  userId: string,
  periodKey: string,
  forcedCurrency?: string | null,
) {
  void periodKey
  const rule_id = 'cycle_leftover_to_savings_wallet_v1'
  const settings = await getCycleLeftoverSettings(supabase, userId)
  if (!settings.is_enabled) return { rule_id, created: false }

  let snapshot: Awaited<ReturnType<typeof buildCurrentCycleSnapshot>>
  try {
    snapshot = await buildCurrentCycleSnapshot(supabase, userId, forcedCurrency)
  } catch (error) {
    logError('policy_eval.money_snapshot_failed', { userId, rule_id, error: String(error) })
    return { rule_id, created: false }
  }

  const proposalPeriodKey = `${snapshot.cycle.cycleStart}:leftover`
  await expireOlderPendingActionProposalsForRule(supabase, userId, rule_id, proposalPeriodKey)
  const expireCurrentPendingAndStop = async () => {
    await expirePendingActionProposalForPeriod(supabase, userId, rule_id, proposalPeriodKey)
    return { rule_id, created: false }
  }

  if (snapshot.cycle.daysRemaining > settings.trigger_days_remaining) return expireCurrentPendingAndStop()

  const cycleIncomeCents = sumSavingsRuleIncomeCents(snapshot.txns)
  if (cycleIncomeCents <= 0) return expireCurrentPendingAndStop()

  const cycleSpendCents = sumSavingsRuleSpendCents(snapshot.txns)
  const unspentCents = Math.max(0, cycleIncomeCents - cycleSpendCents)
  if (unspentCents <= 0) return expireCurrentPendingAndStop()
  if (unspentCents < settings.min_leftover_cents) return expireCurrentPendingAndStop()

  const unspentRatio = unspentCents / Math.max(1, cycleIncomeCents)
  const targetRate = settings.transfer_ratio > 0
    ? settings.transfer_ratio
    : getSavingsTargetRate(unspentRatio)
  if (targetRate <= 0) return expireCurrentPendingAndStop()

  const targetSavingsRawCents = Math.round(unspentCents * targetRate)
  const targetSavingsCents = settings.hard_cap_cents > 0
    ? Math.min(targetSavingsRawCents, settings.hard_cap_cents)
    : targetSavingsRawCents
  if (targetSavingsCents <= 0) return expireCurrentPendingAndStop()

  const savingsWallets = snapshot.wallets.filter(isSavingsWallet)
  const savingsWallet = savingsWallets.length > 0
    ? [...savingsWallets].sort((a, b) => moneyToCents(Number(b?.balance ?? 0)) - moneyToCents(Number(a?.balance ?? 0)))[0]
    : null
  const savingsWalletIds = new Set(
    savingsWallets
      .map((wallet) => String(wallet?.id ?? '').trim())
      .filter(Boolean)
  )

  const alreadyMovedToSavingsCents = snapshot.txns.reduce((sum: number, txn: any) => {
    if (isExcludedTxForCashFlow(txn)) return sum
    const walletId = String(txn?.wallet_id ?? '').trim()
    if (!walletId || !savingsWalletIds.has(walletId)) return sum
    const cents = moneyToCents(Number(txn?.amount ?? 0))
    if (cents <= 0) return sum
    const categoryKey = normalizeCategoryKeyLocal(String(txn?.category ?? ''))
    if (!isTransferLikeCategoryKey(categoryKey)) return sum
    return sum + cents
  }, 0)

  const remainingToTargetCents = Math.max(0, targetSavingsCents - alreadyMovedToSavingsCents)
  if (remainingToTargetCents <= 0) return expireCurrentPendingAndStop()

  const suggestedRawCents = Math.min(remainingToTargetCents, unspentCents)
  const suggestedCents = settings.hard_cap_cents > 0
    ? Math.min(suggestedRawCents, settings.hard_cap_cents)
    : suggestedRawCents
  if (suggestedCents <= 0) return expireCurrentPendingAndStop()
  if (suggestedCents < settings.min_suggestion_cents) return expireCurrentPendingAndStop()

  const cycleExisting = await findActionProposalForPeriod(supabase, userId, rule_id, proposalPeriodKey)
  if (cycleExisting) return { rule_id, created: false }
  if (!(await canCreateActionableProposal(supabase, userId, rule_id))) return { rule_id, created: false }

  const monthKey = monthKeyUTC(new Date())
  const currencyCode = snapshot.primaryCurrency
  const title = savingsWallet
    ? `Save ${formatMoneyWhole(suggestedCents, currencyCode)} from this cycle income`
    : `Create a Savings Wallet and set aside ${formatMoneyWhole(suggestedCents, currencyCode)}`
  const body = savingsWallet
    ? alreadyMovedToSavingsCents > 0
      ? `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You already moved ${formatMoneyWhole(alreadyMovedToSavingsCents, currencyCode)} to savings this cycle. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} now.`
      : `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You have not moved anything to savings yet this cycle. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} now.`
    : `From this cycle income of ${formatMoneyWhole(cycleIncomeCents, currencyCode)}, about ${formatMoneyWhole(unspentCents, currencyCode)} is still unspent. You still have room to move about ${formatMoneyWhole(suggestedCents, currencyCode)} into savings this cycle. Create a Savings Wallet to set it aside.`

  await insertProposal(supabase, {
    user_id: userId,
    rule_id,
    title,
    body,
    cta_json: {
      label: savingsWallet ? `Move ${formatMoneyWhole(suggestedCents, currencyCode)}` : 'Create Savings Wallet',
      payload: {
        amount: Math.round(suggestedCents / 100),
        amount_cents: suggestedCents,
        currencyCode,
        currency_code: currencyCode,
        cycle_income_cents: cycleIncomeCents,
        cycle_spend_cents: cycleSpendCents,
        unspent_cents: unspentCents,
        already_saved_cents: alreadyMovedToSavingsCents,
        target_savings_cents: targetSavingsCents,
        remaining_to_target_cents: remainingToTargetCents,
        cycle_start: snapshot.cycle.cycleStart,
        cycle_end: snapshot.cycle.cycleEnd,
        target_wallet_id: savingsWallet?.id ?? null,
        target_wallet_name: savingsWallet?.name ?? 'Savings Wallet',
        target_wallet_type: 'savings',
        create_wallet_if_missing: !savingsWallet,
      }
    },
    risk_level: 'low',
    consent_required: 'smart',
    period_key: proposalPeriodKey,
    status: 'pending',
    metadata: {
      month_key: monthKey,
      cycle_start: snapshot.cycle.cycleStart,
      cycle_end: snapshot.cycle.cycleEnd,
      currencyCode,
      currency_code: currencyCode,
      target_savings_cents: targetSavingsCents,
      already_saved_cents: alreadyMovedToSavingsCents,
      autopilot_eligible: false,
    }
  })

  await logSuggestion(supabase, userId, rule_id, monthKey)
  return { rule_id, created: true }
}

// Rule: budget_coaching_v1 (medium risk, advice only)
async function evaluate_budget_coaching_v1(supabase: any, userId: string, periodKey: string) {
  const rule_id = 'budget_coaching_v1'
  const today = new Date()
  const todayKey = toDateKeyUTC(today)

  const { data: recentNudges, error: nudgeErr } = await supabase
    .from('nudges')
    .select('id, payload_json')
    .eq('user_id', userId)
    .eq('channel', 'in_app')
    .eq('trigger', rule_id)
    .gte('created_at', daysAgo(7).toISOString())
    .limit(50)
  if (nudgeErr) return { rule_id, created: false }

  const nudgedBudgetIds = new Set(
    (recentNudges || [])
      .map((row: any) => String(row?.payload_json?.budget_id ?? '').trim())
      .filter(Boolean)
  )

  const { data: budgets, error: budgetErr } = await supabase
    .from('budgets')
    .select('id, name, amount_cents, spent_cents, start_date, end_date, period')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(100)
  if (budgetErr || !Array.isArray(budgets) || budgets.length === 0) return { rule_id, created: false }

  const todayUtc = parseDateKeyUTC(todayKey)
  if (!todayUtc) return { rule_id, created: false }

  const candidates = budgets
    .map((budget: any) => {
      const budgetId = String(budget?.id ?? '').trim()
      if (!budgetId || nudgedBudgetIds.has(budgetId)) return null

      const amountCents = Math.max(0, Math.round(Number(budget?.amount_cents ?? 0)))
      const spentCents = Math.max(0, Math.round(Number(budget?.spent_cents ?? 0)))
      if (amountCents <= 0 || spentCents <= 0) return null

      const startDate = parseDateKeyUTC(budget?.start_date)
      if (!startDate) return null
      const endDate = deriveBudgetEndDateUTC(startDate, budget?.end_date ?? null, budget?.period ?? null)
      if (todayUtc < startDate || todayUtc > endDate) return null

      const totalDays = Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / DAY_MS) + 1)
      const elapsedDays = Math.max(1, Math.min(totalDays, Math.floor((todayUtc.getTime() - startDate.getTime()) / DAY_MS) + 1))
      const progressRatio = elapsedDays / totalDays
      const spendRatio = spentCents / amountCents
      const paceRatio = spendRatio / Math.max(progressRatio, 0.05)

      if (progressRatio < 0.25) return null
      if (spendRatio < 0.6) return null
      if (paceRatio < 1.35) return null

      return {
        budgetId,
        budgetName: String(budget?.name ?? 'This budget').trim() || 'This budget',
        spentCents,
        amountCents,
        progressRatio,
        spendRatio,
        paceRatio,
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      if (b.paceRatio !== a.paceRatio) return b.paceRatio - a.paceRatio
      return b.spentCents - a.spentCents
    })

  const top = candidates[0]
  if (!top) return { rule_id, created: false }

  const spendPct = Math.round(top.spendRatio * 100)
  const progressPct = Math.round(top.progressRatio * 100)
  const title = `Slow down ${top.budgetName} spending`
  const body = `You've already used ${spendPct}% of your ${top.budgetName} budget with about ${Math.max(0, 100 - progressPct)}% of the period left. Consider easing off for the rest of this cycle.`

  const { error: insertErr } = await supabase
    .from('nudges')
    .insert([{
      user_id: userId,
      trigger: rule_id,
      channel: 'in_app',
      payload_json: {
        title,
        body,
        budget_id: top.budgetId,
        type: 'pacing_high',
        ratio_pct: Math.round(top.paceRatio * 100),
        spend_pct: spendPct,
        progress_pct: progressPct,
      },
    }])
  if (insertErr) return { rule_id, created: false }

  return { rule_id, created: true }
}

// Rule: subscription_hike_unused_v1 (medium risk)
async function evaluate_subscription_hike_unused_v1(supabase: any, userId: string, periodKey: string) {
  void supabase
  void userId
  void periodKey
  const rule_id = 'subscription_hike_unused_v1'
  // Product decision:
  // Subscription review should be surfaced as a Wisey notification
  // with a Review button, not as an accept/decline proposal card.
  // Keep this evaluator wired for ordering parity, but disable proposal creation.
  return { rule_id, created: false }
}
