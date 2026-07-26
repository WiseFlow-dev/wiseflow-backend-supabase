import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import { getCanonicalObligations, type CanonicalObligationLine } from './obligations.ts'
import {
    normalizeCurrencyCode,
    normalizeTransactionsToMainCurrency,
    normalizeWalletBalancesToMainCurrency,
} from '../_shared/currencyReporting.ts'
import {
    normalizeCanonicalObligationLinesToMainCurrency,
} from '../_shared/obligationCurrency.ts'

/**
 * AI Advisor - Phase 3: Cash Flow Intelligence
 * 
 * This function computes professional financial analysis:
 * - Cash flow breakdown (fixed vs variable expenses)
 * - Income stability assessment
 * - Disposable income calculation
 * - Daily safe spend
 * 
 * Evidence-first approach: Never invent numbers, return partial results + clarifying questions when data is missing.
 */

// Timing helper
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Income categories (strict whitelist from Phase 1)
const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Income', 'Wages', 'Bonus']

const INCOME_CATEGORIES_NORMALIZED = new Set(
    INCOME_CATEGORIES.map((c) => c.trim().toLowerCase()),
)

const INCOME_KEYWORDS = ['salary', 'freelance', 'wages', 'bonus', 'income']

function isIncomeCategory(category: unknown): boolean {
    if (typeof category !== 'string') return false
    const normalized = category.trim().toLowerCase()
    if (INCOME_CATEGORIES_NORMALIZED.has(normalized)) return true
    return INCOME_KEYWORDS.some((k) => normalized.includes(k))
}

function isIncomeTransaction(tx: any): boolean {
    const catRel = tx?.categories
    const isIncomeFlag =
        (catRel && typeof catRel === 'object' && !Array.isArray(catRel) && catRel.is_income === true) ||
        (Array.isArray(catRel) && catRel.some((c) => c?.is_income === true))

    if (isIncomeFlag) return true

    // Fallback: legacy string category matching (best-effort)
    return isIncomeCategory(tx?.category)
}

// Fixed expense categories (deterministic classification)
const FIXED_CATEGORIES = ['Rent', 'Mortgage', 'Insurance', 'Loan Payment', 'Utilities', 'Internet', 'Phone']

// Transfer-like categories to exclude from spending
const TRANSFER_CATEGORIES = ['transfer', 'internal-transfer', 'wallet-transfer', 'money-transfer']

export function isExcludedTxForCashFlow(tx: any): boolean {
    if (!tx) return true
    if (tx.is_opening_balance === true) return true
    if (tx.is_manual_topup === true) return true

    const categoryRaw = typeof tx.category === 'string' ? tx.category : ''
    const category = categoryRaw.toLowerCase()

    if (TRANSFER_CATEGORIES.some((t) => category.includes(t))) return true
    if (category.includes('opening balance')) return true
    if (category.includes('opening-balance')) return true
    if (category.includes('owner contribution')) return true

    return false
}

export function isExcludedTxForOpeningBalanceIncome(tx: any): boolean {
    if (!tx) return true
    if (tx.is_manual_topup === true) return true

    const categoryRaw = typeof tx.category === 'string' ? tx.category : ''
    const category = categoryRaw.toLowerCase()

    if (TRANSFER_CATEGORIES.some((t) => category.includes(t))) return true
    if (category.includes('owner contribution')) return true

    return false
}

export function isOpeningBalanceLike(tx: any): boolean {
    if (tx?.is_opening_balance === true) return true

    const categoryRaw = typeof tx?.category === 'string' ? tx.category : ''
    const category = categoryRaw.toLowerCase()
    return category.includes('opening-balance') || category.includes('opening balance')
}

function asNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0
    if (typeof value === 'string') {
        const n = Number(value)
        return Number.isFinite(n) ? n : 0
    }
    return 0
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

const TX_FETCH_WINDOW_DAYS = 60
const TX_FETCH_ROW_LIMIT = 1000
const OBLIGATION_MATCH_LOOKBACK_DAYS = 10
const ENABLE_OBLIGATIONS_SMOKE = (Deno.env.get('ENABLE_OBLIGATIONS_SMOKE') || 'false').toLowerCase() === 'true'

type CurrencyScope = {
    primaryCurrency: string
    walletIds: Set<string>
    warning: string | null
}

type UpcomingObligationLine = {
    source: 'bill' | 'planned_payment' | 'subscription'
    name: string
    category: string
    amountCents: number
    dueDate: string | null
    walletId: string | null
}

type UpcomingObligationsResult = {
    billsTotalCents: number
    plannedPaymentsTotalCents: number
    subscriptionsTotalCents: number
    goalAutoSaveCents: number
    obligationsTotalCents: number
    overdueTotalCents: number
    grandTotalCents: number
    obligationLines: UpcomingObligationLine[]
    normalizationWarning?: string | null
    items: {
        billsCount: number
        plannedPaymentsCount: number
        subscriptionsCount: number
        goalAutoSaveCount: number
        overdueCount: number
    }
}

type SummarizedObligationLine = {
    source: 'bill' | 'planned_payment' | 'subscription' | 'goal_auto_save'
    name: string | null
    category: string | null
    amountCents: number
    walletId: string | null
    isOverdue: boolean
    dueDate: string | null
}

type TolerantObligationCurrencyLookup = {
    walletCurrencyById: Map<string, string>
    sourceCurrencyByKey: Map<string, string>
    lookupWarnings: string[]
}

function walletScopeCount(scope?: Set<string> | null): number {
    if (!scope) return 0
    return scope.size
}

function obligationSourceCurrencyKey(
    source: CanonicalObligationLine['source'] | SummarizedObligationLine['source'],
    sourceId: string | null,
): string | null {
    if (!sourceId) return null
    return `${source}:${sourceId}`
}

function summarizeUpcomingObligationLines(
    lines: SummarizedObligationLine[],
    normalizationWarning: string | null = null,
): UpcomingObligationsResult {
    const obligationLines: UpcomingObligationLine[] = lines
        .filter((line) => !line.isOverdue && line.source !== 'goal_auto_save')
        .map((line) => ({
            source: line.source as UpcomingObligationLine['source'],
            name: line.name || '',
            category: line.category || '',
            amountCents: line.amountCents,
            dueDate: line.dueDate,
            walletId: line.walletId,
        }))

    let billsTotalCents = 0
    let plannedPaymentsTotalCents = 0
    let subscriptionsTotalCents = 0
    let goalAutoSaveCents = 0
    let overdueTotalCents = 0

    let billsCount = 0
    let plannedPaymentsCount = 0
    let subscriptionsCount = 0
    let goalAutoSaveCount = 0
    let overdueCount = 0

    for (const line of lines) {
        if (line.isOverdue) {
            overdueTotalCents += line.amountCents
            overdueCount += 1
            continue
        }

        if (line.source === 'bill') {
            billsTotalCents += line.amountCents
            billsCount += 1
            continue
        }
        if (line.source === 'planned_payment') {
            plannedPaymentsTotalCents += line.amountCents
            plannedPaymentsCount += 1
            continue
        }
        if (line.source === 'subscription') {
            subscriptionsTotalCents += line.amountCents
            subscriptionsCount += 1
            continue
        }
        if (line.source === 'goal_auto_save') {
            goalAutoSaveCents += line.amountCents
            goalAutoSaveCount += 1
        }
    }

    const obligationsTotalCents = billsTotalCents + plannedPaymentsTotalCents + subscriptionsTotalCents + goalAutoSaveCents
    const grandTotalCents = obligationsTotalCents + overdueTotalCents

    return {
        billsTotalCents,
        plannedPaymentsTotalCents,
        subscriptionsTotalCents,
        goalAutoSaveCents,
        obligationsTotalCents,
        overdueTotalCents,
        grandTotalCents,
        obligationLines,
        normalizationWarning,
        items: {
            billsCount,
            plannedPaymentsCount,
            subscriptionsCount,
            goalAutoSaveCount,
            overdueCount,
        },
    }
}

async function loadTolerantObligationCurrencyLookup(
    supabase: any,
    userId: string,
    canonicalLines: CanonicalObligationLine[],
): Promise<TolerantObligationCurrencyLookup> {
    const walletCurrencyById = new Map<string, string>()
    const sourceCurrencyByKey = new Map<string, string>()
    const lookupWarnings: string[] = []

    const walletIds = [...new Set(
        canonicalLines
            .map((line) => (typeof line?.walletId === 'string' ? line.walletId.trim() : ''))
            .filter((walletId) => walletId.length > 0),
    )]

    if (walletIds.length > 0) {
        try {
            const { data, error } = await supabase
                .from('wallets')
                .select('id,currency_code')
                .eq('user_id', userId)
                .in('id', walletIds)

            if (error) {
                lookupWarnings.push(`wallet currency lookup failed: ${error.message}`)
            } else {
                for (const row of data ?? []) {
                    const walletId = typeof row?.id === 'string' ? row.id : null
                    const currencyCode = normalizeCurrencyCode(row?.currency_code)
                    if (walletId && currencyCode) {
                        walletCurrencyById.set(walletId, currencyCode)
                    }
                }
            }
        } catch (error) {
            lookupWarnings.push(`wallet currency lookup failed: ${String((error as any)?.message || error)}`)
        }
    }

    const sourceTableByType: Record<string, string> = {
        bill: 'bills',
        planned_payment: 'planned_payments',
        subscription: 'subscriptions',
        goal_auto_save: 'goals',
    }

    for (const sourceType of Object.keys(sourceTableByType)) {
        const sourceIds = [...new Set(
            canonicalLines
                .filter((line) => line?.source === sourceType)
                .map((line) => (typeof line?.sourceId === 'string' ? line.sourceId.trim() : ''))
                .filter((sourceId) => sourceId.length > 0),
        )]

        if (sourceIds.length === 0) continue

        try {
            const { data, error } = await supabase
                .from(sourceTableByType[sourceType])
                .select('id,currency_code')
                .eq('user_id', userId)
                .in('id', sourceIds)

            if (error) {
                lookupWarnings.push(`${sourceType} currency lookup failed: ${error.message}`)
                continue
            }

            for (const row of data ?? []) {
                const sourceId = typeof row?.id === 'string' ? row.id : null
                const currencyCode = normalizeCurrencyCode(row?.currency_code)
                const lookupKey = obligationSourceCurrencyKey(sourceType, sourceId)
                if (lookupKey && currencyCode) {
                    sourceCurrencyByKey.set(lookupKey, currencyCode)
                }
            }
        } catch (error) {
            lookupWarnings.push(`${sourceType} currency lookup failed: ${String((error as any)?.message || error)}`)
        }
    }

    return { walletCurrencyById, sourceCurrencyByKey, lookupWarnings }
}

async function buildSameCurrencyObligationsFallback(
    supabase: any,
    userId: string,
    canonicalLines: CanonicalObligationLine[],
    mainCurrency: string,
    normalizationErrorMessage: string,
): Promise<UpcomingObligationsResult> {
    const { walletCurrencyById, sourceCurrencyByKey, lookupWarnings } = await loadTolerantObligationCurrencyLookup(
        supabase,
        userId,
        canonicalLines,
    )

    const fallbackLines: SummarizedObligationLine[] = []
    let excludedLineCount = 0

    for (const line of canonicalLines) {
        const sourceType = String(line?.source || '')
        if (
            sourceType !== 'bill' &&
            sourceType !== 'planned_payment' &&
            sourceType !== 'subscription' &&
            sourceType !== 'goal_auto_save'
        ) {
            continue
        }

        const sourceCurrency = sourceCurrencyByKey.get(
            obligationSourceCurrencyKey(sourceType, typeof line?.sourceId === 'string' ? line.sourceId : null) ?? '',
        ) ?? null
        const walletCurrency = typeof line?.walletId === 'string' ? (walletCurrencyById.get(line.walletId) ?? null) : null
        const effectiveCurrency = sourceCurrency || walletCurrency

        if (effectiveCurrency !== mainCurrency) {
            excludedLineCount += 1
            continue
        }

        fallbackLines.push({
            source: sourceType,
            name: typeof line?.name === 'string' ? line.name : null,
            category: typeof line?.category === 'string' ? line.category : null,
            amountCents: Math.max(0, Math.round(Number(line?.amountCents) || 0)),
            walletId: typeof line?.walletId === 'string' ? line.walletId : null,
            isOverdue: line?.isOverdue === true,
            dueDate: typeof line?.occurrenceDate === 'string' ? line.occurrenceDate : null,
        })
    }

    const warningParts = [
        `Obligation normalization failed, so only ${mainCurrency} obligation lines were included.`,
        excludedLineCount > 0 ? `${excludedLineCount} obligation line(s) were excluded because their currency could not be safely confirmed.` : null,
        lookupWarnings.length > 0 ? lookupWarnings.join(' ') : null,
        `Normalization error: ${normalizationErrorMessage}`,
    ].filter(Boolean)

    return summarizeUpcomingObligationLines(fallbackLines, warningParts.join(' '))
}

function normalizeToken(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function toCategoryKey(value: unknown): string {
    if (typeof value !== 'string') return 'other'
    const trimmed = value.trim()
    if (!trimmed) return 'other'
    return trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'other'
}

function isTransferLikeCategoryKey(categoryKey: string): boolean {
    return (
        categoryKey === 'transfer' ||
        categoryKey === 'internal-transfer' ||
        categoryKey === 'wallet-transfer' ||
        categoryKey === 'money-transfer' ||
        categoryKey === 'deposit' ||
        categoryKey === 'cash-deposit' ||
        categoryKey === 'bank-deposit' ||
        categoryKey === 'initial-balance' ||
        categoryKey === 'withdrawal' ||
        categoryKey === 'cash-withdrawal' ||
        categoryKey === 'atm' ||
        categoryKey === 'atm-withdrawal'
    )
}

type EssentialState = 'essential' | 'non_essential' | 'unknown'

function getRelatedCategoryRecord(tx: any): any | null {
    const rel = tx?.categories
    if (rel && typeof rel === 'object' && !Array.isArray(rel)) return rel
    if (Array.isArray(rel)) {
        const firstRecord = rel.find((entry) => entry && typeof entry === 'object')
        return firstRecord || null
    }
    return null
}

function getEssentialStateFromCategoryMeta(category: any): EssentialState {
    if (!category || typeof category !== 'object') return 'unknown'
    if (category.is_fixed_obligation === true) return 'essential'

    const tier = String(category.expense_tier || '').trim().toLowerCase()
    if (!tier) return 'unknown'
    if (tier === 'essential') return 'essential'
    return 'non_essential'
}

function isTransactionEssentialByMetadata(tx: any): boolean {
    const related = getRelatedCategoryRecord(tx)
    return getEssentialStateFromCategoryMeta(related) === 'essential'
}

function mergeEssentialState(current: EssentialState, incoming: EssentialState): EssentialState {
    if (current === 'essential' || incoming === 'essential') return 'essential'
    if (current === 'non_essential' || incoming === 'non_essential') return 'non_essential'
    return 'unknown'
}

function isGoalTransferLike(tx: any): boolean {
    const categoryKey = toCategoryKey(tx?.category)
    if (categoryKey === 'my-goals' || categoryKey === 'goals') return true

    const title = String(tx?.title || '').toLowerCase()
    const note = String(tx?.note || '').toLowerCase()
    const category = String(tx?.category || '').toLowerCase()
    return (
        title.includes('transfer to goal') ||
        title.includes('transfer from goal') ||
        note.includes('transfer to goal') ||
        note.includes('transfer from goal') ||
        category.includes('transfer to goal') ||
        category.includes('transfer from goal')
    )
}

function detectCurrencyScope(wallets: any[], preferredCurrency: unknown): CurrencyScope {
    const allWallets = Array.isArray(wallets) ? wallets : []
    const pref = typeof preferredCurrency === 'string' ? preferredCurrency.trim().toUpperCase() : ''

    if (allWallets.length === 0) {
        return {
            primaryCurrency: pref || 'USD',
            walletIds: new Set<string>(),
            warning: null,
        }
    }

    const counts = new Map<string, number>()
    for (const wallet of allWallets) {
        const cc = String(wallet?.currency_code || 'USD').trim().toUpperCase() || 'USD'
        counts.set(cc, (counts.get(cc) || 0) + 1)
    }

    let primary = pref || 'USD'
    if (!pref) {
        let best = 'USD'
        let bestCount = -1
        for (const [cc, count] of counts.entries()) {
            if (count > bestCount) {
                best = cc
                bestCount = count
            }
        }
        primary = best
    }

    const walletIds = new Set<string>()
    for (const wallet of allWallets) {
        const walletId = typeof wallet?.id === 'string' ? wallet.id : null
        const archived = wallet?.archived === true
        if (walletId && !archived) {
            walletIds.add(walletId)
        }
    }

    const warning = counts.size > 1
        ? `Multiple currencies detected (${[...counts.keys()].join(', ')}). Main analysis currency is ${primary}.`
        : null

    return { primaryCurrency: primary, walletIds, warning }
}

async function convertAmountToMainCurrency(
    supabase: any,
    userId: string,
    amount: number,
    fromCurrency: string | null,
    toCurrency: string,
    asOfDate: string,
): Promise<{ amount: number; warning: string | null; converted: boolean }> {
    const sourceCurrency = normalizeCurrencyCode(fromCurrency)
    const targetCurrency = normalizeCurrencyCode(toCurrency) || 'USD'

    if (!Number.isFinite(amount) || amount <= 0 || !sourceCurrency || sourceCurrency === targetCurrency) {
        return { amount, warning: null, converted: false }
    }

    const normalized = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        targetCurrency,
        [{
            wallet_id: null,
            amount,
            reporting_amount: null,
            reporting_currency: null,
            source_currency: sourceCurrency,
            date: asOfDate,
        }],
    )

    const convertedAmount = Number((normalized.rows?.[0] as { amount?: unknown } | undefined)?.amount)
    if (Number.isFinite(convertedAmount) && convertedAmount > 0) {
        return {
            amount: convertedAmount,
            warning: `Converted ${formatCurrency(amount, sourceCurrency)} from ${sourceCurrency} to ${formatCurrency(convertedAmount, targetCurrency)} for this check.`,
            converted: true,
        }
    }

    return {
        amount,
        warning: `I couldn't safely convert ${sourceCurrency} into ${targetCurrency} for this check.`,
        converted: false,
    }
}

function filterByCurrencyWalletIds(data: any, walletIds: Set<string>): any {
    const hasScope = walletIds.size > 0
    const inScope = (walletId: unknown): boolean => {
        if (!hasScope) return true
        if (!walletId || typeof walletId !== 'string') return false
        return walletIds.has(walletId)
    }

    return {
        ...data,
        wallets: (data?.wallets || []).filter((w: any) => inScope(w?.id)),
        transactions: (data?.transactions || []).filter((tx: any) => inScope(tx?.wallet_id)),
        subscriptions: (data?.subscriptions || []).filter((s: any) => inScope(s?.wallet_id)),
        bills: (data?.bills || []).filter((b: any) => inScope(b?.wallet_id)),
        incomes: (data?.incomes || []).filter((i: any) => inScope(i?.wallet_id)),
        goals: (data?.goals || []).filter((g: any) => {
            const linkedWalletId = g?.linked_wallet_id
            if (!hasScope) return true
            if (!linkedWalletId || typeof linkedWalletId !== 'string') return true
            return walletIds.has(linkedWalletId)
        }),
        plannedPayments: (data?.plannedPayments || []).filter((p: any) => inScope(p?.wallet_id)),
        // Keep global budgets (wallet_id is null/empty) in scope for all currencies.
        budgets: (data?.budgets || []).filter((b: any) => {
            if (!hasScope) return true
            const walletId = b?.wallet_id
            if (!walletId || typeof walletId !== 'string') return true
            return walletIds.has(walletId)
        }),
    }
}

async function applyCurrencyScopeAndNormalization(
    supabase: any,
    userId: string,
    data: any,
): Promise<{ scopedData: any; currencyScope: CurrencyScope }> {
    const currencyScope = detectCurrencyScope(data?.wallets || [], data?.preferredCurrency)
    const scopedData = filterByCurrencyWalletIds(data, currencyScope.walletIds)
    const scopedTx = scopedData?.transactions || []
    if (scopedTx.length > 0) {
        const normalized = await normalizeTransactionsToMainCurrency(
            supabase,
            userId,
            currencyScope.primaryCurrency,
            scopedTx as Array<Record<string, unknown>>,
        )
        scopedData.transactions = normalized.rows
        console.log(
            `[ai-advisor] tx currency normalization: normalized=${normalized.metrics.normalized_rows_used}, fx=${normalized.metrics.temporary_converted_rows_used}, same=${normalized.metrics.raw_same_currency_rows_used}, missing=${normalized.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalized.metrics.fx_lookup_failures}`
        )
    }
    return { scopedData, currencyScope }
}

async function computeNormalizedAssetWalletBalance(
    supabase: any,
    userId: string,
    wallets: any[],
    mainCurrency: string,
): Promise<{
    total: number
    walletCount: number
    normalizedWallets: number
    excludedWallets: number
}> {
    const activeAssetWallets = (wallets || []).filter((wallet: any) => {
        const archived = wallet?.archived === true
        const accountClass = String(wallet?.account_class || 'ASSET').trim().toUpperCase()
        return !archived && accountClass !== 'LIABILITY'
    })
    if (activeAssetWallets.length === 0) {
        return {
            total: 0,
            walletCount: 0,
            normalizedWallets: 0,
            excludedWallets: 0,
        }
    }

    const normalizedBalances = await normalizeWalletBalancesToMainCurrency(
        supabase,
        userId,
        mainCurrency,
        activeAssetWallets,
    )

    return {
        total: normalizedBalances.total,
        walletCount: activeAssetWallets.length,
        normalizedWallets: normalizedBalances.metrics.normalized_wallet_rows,
        excludedWallets: normalizedBalances.metrics.excluded_wallet_rows,
    }
}

async function normalizeCentCollectionsToMainCurrency(
    supabase: any,
    userId: string,
    mainCurrency: string,
    data: any,
): Promise<any> {
    const today = new Date().toISOString().slice(0, 10)
    const clampDateKey = (raw: unknown): string => {
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (!text) return today
        const d = new Date(text)
        if (!Number.isFinite(d.getTime())) return today
        const key = d.toISOString().slice(0, 10)
        return key > today ? today : key
    }
    const nextData = { ...data }

    const normalizeCollection = async (
        rows: any[],
        amountField: string,
        dateField: string,
    ): Promise<any[]> => {
        if (!Array.isArray(rows) || rows.length === 0) return rows || []

        const syntheticRows = rows.map((row: any, index: number) => ({
            row_index: index,
            wallet_id: typeof row?.wallet_id === 'string' ? row.wallet_id : null,
            amount: asNumber(row?.[amountField]) / 100,
            reporting_amount: null,
            reporting_currency: null,
            source_currency: typeof row?.currency_code === 'string' ? row.currency_code : null,
            date: clampDateKey(row?.[dateField]),
        })).filter((row: any) => Number.isFinite(row.amount) && row.amount >= 0)

        if (syntheticRows.length === 0) return rows

        const normalized = await normalizeTransactionsToMainCurrency(
            supabase,
            userId,
            mainCurrency,
            syntheticRows as Array<Record<string, unknown>>,
        )

        const normalizedByIndex = new Map<number, number>()
        for (const row of normalized.rows as any[]) {
            const idx = Math.round(asNumber(row?.row_index))
            const amount = asNumber(row?.amount)
            if (idx >= 0 && Number.isFinite(amount) && amount >= 0) {
                normalizedByIndex.set(idx, Math.round(amount * 100))
            }
        }

        return rows.map((row: any, index: number) => {
            const normalizedCents = normalizedByIndex.get(index)
            if (typeof normalizedCents === 'number') {
                return { ...row, [amountField]: normalizedCents }
            }
            return row
        })
    }

    nextData.incomes = await normalizeCollection(nextData.incomes || [], 'amount_cents', 'expected_date')
    nextData.bills = await normalizeCollection(nextData.bills || [], 'amount_cents', 'due_date')
    nextData.plannedPayments = await normalizeCollection(nextData.plannedPayments || [], 'amount_cents', 'due_date')
    nextData.subscriptions = await normalizeCollection(nextData.subscriptions || [], 'amount_cents', 'next_billing_date')
    nextData.debts = await normalizeCollection(nextData.debts || [], 'minimum_payment_cents', 'updated_at')

    return nextData
}

function isLikelyFixedTransitionPayment(tx: any, obligations: UpcomingObligationLine[], now: Date): boolean {
    if (!tx || obligations.length === 0) return false

    const txDate = new Date(tx.date)
    if (Number.isNaN(txDate.getTime())) return false
    const lookbackStart = new Date(now.getTime() - OBLIGATION_MATCH_LOOKBACK_DAYS * 86400000)
    if (txDate < lookbackStart || txDate > now) return false

    const txAmount = Math.round(Math.abs(asNumber(tx.amount)) * 100)
    if (txAmount <= 0) return false

    const txName = normalizeToken(tx.title)
    const txNote = normalizeToken(tx.note)
    const txCategory = normalizeToken(tx.category)

    for (const ob of obligations) {
        const obAmount = Math.max(0, ob.amountCents)
        if (obAmount <= 0) continue
        const tolerance = Math.max(500, Math.round(obAmount * 0.2)) // >= $5 or 20%
        if (Math.abs(txAmount - obAmount) > tolerance) continue

        const obName = normalizeToken(ob.name)
        const obCategory = normalizeToken(ob.category)

        const nameMatch = obName.length > 0 && (
            txName.includes(obName) ||
            txNote.includes(obName) ||
            txCategory.includes(obName) ||
            obName.includes(txName)
        )

        const categoryMatch = obCategory.length > 0 && (
            txCategory.includes(obCategory) ||
            txNote.includes(obCategory) ||
            obCategory.includes(txCategory)
        )

        if (nameMatch || categoryMatch) {
            return true
        }
    }

    return false
}

interface CashFlowAnalysis {
    // Status Indicator (Phase 3.2)
    status: {
        level: 'excellent' | 'good' | 'warning' | 'overspending' | 'critical'
        message: string
    }

    // Income Analysis
    totalIncome: number
    incomeStability: 'stable' | 'variable' | 'irregular' | 'unknown'
    incomeVariance: number | null  // Coefficient of variation (0-1)
    incomeSources: IncomeSource[]

    // Fixed vs Variable Breakdown
    fixedExpenses: {
        total: number
        items: FixedExpense[]
        percentageOfIncome: number | null
    }

    variableExpenses: {
        total: number
        categories: { [key: string]: number }
        percentageOfIncome: number | null
    }

    // The "Freedom Number"
    disposableIncome: number | null
    discretionaryBudget: number | null

    // Cash Flow Projection
    projectedEndOfMonth: number | null
    daysUntilPayday: number | null
    dailySafeSpend: number | null

    // Data Quality Flags
    missingData: string[]
    clarifyingQuestion: string | null
}

interface IncomeSource {
    source: string
    amount: number
    frequency: 'monthly' | 'irregular'
}

interface FixedExpense {
    name: string
    amount: number
    category: string
    source: 'subscription' | 'bill' | 'debt' | 'transaction'
}

type CashFlowStatusLevel = 'excellent' | 'good' | 'warning' | 'overspending' | 'critical'

interface CashFlowResponse {
    type: 'cash_flow' | 'afford_check' | 'error'
    currencyCode?: string
    currencyWarning?: string | null
    status: {
        level: CashFlowStatusLevel
        message: string
    }
    timeframe: {
        type: string
        label: string
        startDate: string
        endDate: string
    }
    summary: {
        income: number
        fixedExpenses: number
        variableExpenses: number
        disposableIncome: number | null
        dailySafeSpend: number | null
        daysRemaining: number | null
    }
    safeDailySpendScenarios?: Array<{
        percent: number
        saveAmount: number
        dailySpend: number
    }> | null
    breakdown?: {
        income: {
            total: number
            items: Array<{ source: string; amount: number }>
            stability: 'stable' | 'variable' | 'irregular' | 'unknown'
            variance: number | null
        }
        fixed: {
            total: number
            items: Array<{ name: string; amount: number; source: 'subscription' | 'bill' | 'debt' | 'transaction' }>
        }
        variable: {
            total: number
            categories: Array<{ name: string; amount: number }>
        }
    }
    alerts?: Array<{ type: 'info' | 'warning' | 'critical'; message: string }>
    clarifyingQuestion?: string | null
    plannedExpenseId?: string | null
}

function fmtDateUtc(d: Date): string {
    return d.toISOString().slice(0, 10)
}

function computeTimeframeMeta(timeframe: string, window: { start: Date; endExclusive: Date; daysRemaining: number }): {
    type: string
    label: string
    startDate: string
    endDate: string
} {
    const startDate = fmtDateUtc(window.start)
    const endDate = fmtDateUtc(new Date(window.endExclusive.getTime() - 1))

    if (timeframe === 'this_year') {
        return {
            type: 'this_year',
            label: `This Year (${startDate} - ${endDate})`,
            startDate,
            endDate,
        }
    }

    if (timeframe === 'last_cycle') {
        return {
            type: 'last_cycle',
            label: `Last Cycle (${startDate} - ${endDate})`,
            startDate,
            endDate,
        }
    }

    return {
        type: 'current_cycle',
        label: `This Cycle (${startDate} - ${endDate})`,
        startDate,
        endDate,
    }
}

function buildCashFlowResponse(
    analysis: CashFlowAnalysis,
    timeframe: string,
    window: { start: Date; endExclusive: Date; daysRemaining: number },
    currencyCode: string,
    currencyWarning: string | null,
): CashFlowResponse {
    const timeframeMeta = computeTimeframeMeta(timeframe, window)

    // PHASE 3.2: Use status from analysis (already calculated with full logic)
    const status = analysis.status

    const alerts: Array<{ type: 'info' | 'warning' | 'critical'; message: string }> = []
    if (analysis.incomeVariance !== null && analysis.incomeVariance >= 0.3) {
        alerts.push({
            type: 'warning',
            message: `Income varies ${(analysis.incomeVariance * 100).toFixed(0)}% month-to-month`,
        })
    }

    const categoriesArray = Object.entries(analysis.variableExpenses.categories || {})
        .map(([name, amount]) => ({ name, amount }))
        .sort((a, b) => b.amount - a.amount)

    // Compute Safe Daily Spend Scenarios (only for current cycle with days remaining)
    let safeDailySpendScenarios: Array<{ percent: number; saveAmount: number; dailySpend: number }> | null = null

    if (
        timeframe === 'current_cycle' &&
        window.daysRemaining > 0 &&
        analysis.disposableIncome !== null &&
        Number.isFinite(analysis.disposableIncome)
    ) {
        const disposable = analysis.disposableIncome
        const daysRemaining = window.daysRemaining
        const percentages = [0, 5, 10, 15]

        safeDailySpendScenarios = percentages.map(percent => {
            const saveAmount = Math.round((disposable * (percent / 100)) * 100) / 100
            const spendable = disposable - saveAmount
            const dailySpend = Math.round((spendable / daysRemaining) * 100) / 100

            return {
                percent,
                saveAmount,
                dailySpend
            }
        })
    }

    const response: CashFlowResponse = {
        type: 'cash_flow',
        currencyCode,
        currencyWarning,
        status,
        timeframe: timeframeMeta,
        summary: {
            income: analysis.totalIncome,
            fixedExpenses: analysis.fixedExpenses.total,
            variableExpenses: analysis.variableExpenses.total,
            disposableIncome: analysis.disposableIncome,
            dailySafeSpend: analysis.dailySafeSpend,
            daysRemaining: window.daysRemaining > 0 ? window.daysRemaining : null,
        },
        safeDailySpendScenarios,
        breakdown: {
            income: {
                total: analysis.totalIncome,
                items: (analysis.incomeSources || []).map((s) => ({ source: s.source, amount: s.amount })),
                stability: analysis.incomeStability,
                variance: analysis.incomeVariance,
            },
            fixed: {
                total: analysis.fixedExpenses.total,
                items: (analysis.fixedExpenses.items || []).map((i) => ({ name: i.name, amount: i.amount, source: i.source })),
            },
            variable: {
                total: analysis.variableExpenses.total,
                categories: categoriesArray,
            },
        },
        alerts: alerts.length ? alerts : undefined,
        clarifyingQuestion: analysis.clarifyingQuestion,
        plannedExpenseId: null,
    }

    return response
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
        const { message, persona = 'companion', timeframe = 'current_cycle', intentType = 'cash_flow' } = body

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

        if (intentType === 'obligations_smoke') {
            if (!ENABLE_OBLIGATIONS_SMOKE) {
                return new Response(JSON.stringify({
                    type: 'error',
                    error: 'obligations_smoke is disabled'
                }), {
                    status: 404,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            }
            console.log(`[ai-advisor] Obligations smoke for user ${userId.substring(0, 8)}...`)
            return await handleObligationsSmoke(supabaseClient, userId)
        }

        // PHASE 3.4: Handle afford_check intent
        if (intentType === 'afford_check') {
            console.log(`ðŸ’° AI Advisor - Afford Check for user ${userId.substring(0, 8)}...`)
            return await handleAffordCheck(supabaseClient, userId, message, persona)
        }

        if (intentType !== 'cash_flow' && intentType !== 'obligations_smoke' && intentType !== 'afford_check') {
            return new Response(JSON.stringify({
                error: `Unsupported intentType for ai-advisor: ${intentType}`
            }), {
                status: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            })
        }

        // Default: cash flow analysis
        console.log(`ðŸ“Š AI Advisor - Phase 3: Cash Flow Analysis for user ${userId.substring(0, 8)}... (timeframe: ${timeframe})`)

        // Fetch all required data
        const cashFlowData = await fetchCashFlowData(supabaseClient, userId)
        const { scopedData, currencyScope } = await applyCurrencyScopeAndNormalization(
            supabaseClient,
            userId,
            cashFlowData,
        )

        const normalizedAssetBalance = await computeNormalizedAssetWalletBalance(
            supabaseClient,
            userId,
            cashFlowData.wallets || [],
            currencyScope.primaryCurrency,
        )
        const balanceExclusionWarning = normalizedAssetBalance.excludedWallets > 0
            ? `${normalizedAssetBalance.excludedWallets} wallet balance(s) were excluded because FX conversion to ${currencyScope.primaryCurrency} was unavailable.`
            : null
        const combinedCurrencyWarning = [currencyScope.warning, balanceExclusionWarning].filter(Boolean).join(' ').trim() || null

        const scopedDataNormalized = await normalizeCentCollectionsToMainCurrency(
            supabaseClient,
            userId,
            currencyScope.primaryCurrency,
            scopedData,
        )

        // Calculate cash flow analysis with timeframe support
        const analysis = calculateCashFlowAnalysis(scopedDataNormalized, timeframe, normalizedAssetBalance.total)

        const cycleStartDay = clampCycleStartDay(scopedDataNormalized.cycleStartDay ?? cashFlowData.cycleStartDay)
        const window = computeCycleWindowUtc(new Date(), cycleStartDay, timeframe)
        const responsePayload = buildCashFlowResponse(
            analysis,
            timeframe,
            window,
            currencyScope.primaryCurrency,
            combinedCurrencyWarning,
        )

        return new Response(JSON.stringify({
            success: true,
            ...responsePayload,
            analysis,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        })

    } catch (error) {
        console.error('âŒ AI Advisor error:', error)
        return new Response(JSON.stringify({
            error: String((error as any)?.message || 'Internal server error')
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        })
    }
})

async function handleObligationsSmoke(supabase: any, userId: string): Promise<Response> {
    const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }

    try {
        const now = new Date()
        const todayISO = fmtDateUtc(now)
        const next30ISO = fmtDateUtc(new Date(now.getTime() + 30 * 86400000))

        const [walletsRes, prefsRes] = await Promise.all([
            supabase.from('wallets').select('id, currency_code').eq('user_id', userId),
            supabase.from('user_preferences').select('cycle_start_day, currency').eq('user_id', userId).maybeSingle(),
        ])
        if (walletsRes.error) {
            throw new Error(`wallets query failed: ${walletsRes.error.message}`)
        }
        if (prefsRes.error) {
            throw new Error(`user_preferences query failed: ${prefsRes.error.message}`)
        }
        const wallets = walletsRes.data || []
        const prefs = prefsRes.data || null

        const cycleStartDay = clampCycleStartDay(prefs?.cycle_start_day ?? 1)
        const currencyScope = detectCurrencyScope(wallets, prefs?.currency)
        const walletIds = currencyScope.walletIds

        console.log(
            `[ai-advisor] obligations_smoke request: user=${userId.substring(0, 8)}, cycleStartDay=${cycleStartDay}, walletScopeCount=${walletScopeCount(walletIds)}, currency=${currencyScope.primaryCurrency}`
        )

        const [currentCycle, next30Days] = await Promise.all([
            getCanonicalObligations(supabase, {
                mode: 'current_cycle',
                anchorDate: todayISO,
                cycleStartDay,
                walletIds,
                includeOverdue: true,
                includeLines: false,
            }),
            getCanonicalObligations(supabase, {
                mode: 'custom',
                windowStart: todayISO,
                windowEnd: next30ISO,
                walletIds,
                includeOverdue: true,
                includeLines: false,
            }),
        ])

        return new Response(JSON.stringify({
            type: 'obligations_smoke',
            ok: true,
            request: {
                today: todayISO,
                next30End: next30ISO,
                cycleStartDay,
                walletScopeCount: walletScopeCount(walletIds),
                currency: currencyScope.primaryCurrency,
                currencyWarning: currencyScope.warning,
            },
            snapshots: {
                currentCycle: {
                    window: currentCycle.window,
                    totals: currentCycle.totals,
                    counts: currentCycle.counts,
                    warnings: currentCycle.warnings,
                },
                next30Days: {
                    window: next30Days.window,
                    totals: next30Days.totals,
                    counts: next30Days.counts,
                    warnings: next30Days.warnings,
                },
            },
            timestamp: new Date().toISOString(),
        }), { status: 200, headers: CORS })
    } catch (error) {
        const errMsg = String((error as any)?.message || error)
        console.error('[ai-advisor] obligations_smoke failed:', errMsg)
        return new Response(JSON.stringify({
            type: 'error',
            error: `obligations_smoke_failed: ${errMsg}`
        }), { status: 500, headers: CORS })
    }
}

function isLikelyModeledObligationTransaction(tx: any, obligations: UpcomingObligationLine[]): boolean {
    if (!tx || obligations.length === 0) return false

    const txAmount = Math.round(Math.abs(asNumber(tx.amount)) * 100)
    if (txAmount <= 0) return false

    const txName = normalizeToken(tx.title)
    const txNote = normalizeToken(tx.note)
    const txCategory = normalizeToken(tx.category)
    const txCategoryKey = toCategoryKey(tx?.category)

    for (const ob of obligations) {
        const obAmount = Math.max(0, ob.amountCents)
        if (obAmount <= 0) continue

        const tolerance = Math.max(500, Math.round(obAmount * 0.2))
        if (Math.abs(txAmount - obAmount) > tolerance) continue

        const obName = normalizeToken(ob.name)
        const obCategory = normalizeToken(ob.category)
        const obCategoryKey = toCategoryKey(ob.category)

        const nameMatch = obName.length > 0 && (
            txName.includes(obName) ||
            txNote.includes(obName) ||
            txCategory.includes(obName) ||
            obName.includes(txName)
        )

        const categoryMatch = obCategory.length > 0 && (
            txCategory.includes(obCategory) ||
            txNote.includes(obCategory) ||
            obCategory.includes(txCategory)
        )

        const categoryKeyMatch = !!txCategoryKey && !!obCategoryKey && (
            txCategoryKey === obCategoryKey ||
            txCategoryKey.includes(obCategoryKey) ||
            obCategoryKey.includes(txCategoryKey)
        )

        if (nameMatch || categoryMatch || categoryKeyMatch) {
            return true
        }
    }

    return false
}

type RunwaySpendSummary = {
    lookbackDays: number
    totalSpendCents: number
    transactionCount: number
    activeDays: number
    averageDailySpendCents: number
}

function computeRecentRunwaySpendSummary(
    transactions: any[],
    now: Date,
    lookbackDays: number = 30
): RunwaySpendSummary {
    const safeLookbackDays = Math.max(7, Math.min(60, Math.floor(asNumber(lookbackDays)) || 30))
    const dayMs = 86400000
    const todayStart = startOfDayUtc(now)
    const windowStart = new Date(todayStart.getTime() - (safeLookbackDays - 1) * dayMs)
    const windowEndExclusive = new Date(todayStart.getTime() + dayMs)

    let totalSpendCents = 0
    let transactionCount = 0
    const activeDays = new Set<string>()

    for (const tx of (transactions || [])) {
        if (isExcludedTxForCashFlow(tx)) continue
        if (isIncomeTransaction(tx)) continue
        if (isOpeningBalanceLike(tx)) continue
        if (tx?.categories?.is_fixed_obligation === true) continue
        if (isGoalTransferLike(tx)) continue

        const txCategoryKey = toCategoryKey(tx?.category)
        if (isTransferLikeCategoryKey(txCategoryKey)) continue
        if (txCategoryKey.includes('receivable') || txCategoryKey.includes('repayment')) continue

        const rel = tx?.categories
        const relName = (rel && typeof rel === 'object' && !Array.isArray(rel) && typeof rel.name === 'string')
            ? rel.name
            : null
        const relCategoryKey = toCategoryKey(relName)
        if (isTransferLikeCategoryKey(relCategoryKey)) continue
        if (relCategoryKey.includes('receivable') || relCategoryKey.includes('repayment')) continue

        const txAmount = asNumber(tx?.amount)
        if (txAmount >= 0) continue

        const txDate = new Date(tx?.date)
        if (Number.isNaN(txDate.getTime()) || txDate < windowStart || txDate >= windowEndExclusive) continue

        const cents = Math.round(Math.abs(txAmount) * 100)
        if (cents <= 0) continue

        totalSpendCents += cents
        transactionCount += 1
        activeDays.add(fmtDateUtc(txDate))
    }

    const averageDailySpendCents = safeLookbackDays > 0
        ? Math.round(totalSpendCents / safeLookbackDays)
        : 0

    return {
        lookbackDays: safeLookbackDays,
        totalSpendCents,
        transactionCount,
        activeDays: activeDays.size,
        averageDailySpendCents,
    }
}

/**
 * PHASE 3.4: Handle Afford Check Intent
 * Determines if user can afford a purchase and optionally creates planned payment
 */
async function handleAffordCheck(supabase: any, userId: string, message: string, persona: string) {
    try {
        // PHASE 3.4 FIX 2: Replace regex with JSON.parse for action parsing
        const trimmed = String(message || '').trim()
        let actionObj: any = null

        if (trimmed.startsWith('{')) {
            try {
                actionObj = JSON.parse(trimmed)
            } catch (jsonError) {
                console.log('[ai-advisor] Not valid JSON, treating as regular message')
                actionObj = null
            }
        }

        // Check if this is an action confirmation request
        if (actionObj && actionObj.action === 'dismiss') {
            // Dismiss just removes the follow-up question. We return the same afford-check card
            // but without confirmation actions.
            const payload = actionObj.payload || {}
            const amount = typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount > 0
                ? payload.amount
                : null

            const name = typeof payload.name === 'string' && payload.name.trim().length > 0
                ? payload.name.trim()
                : null

            const dueDate = typeof payload.dueDate === 'string' && payload.dueDate.trim().length > 0
                ? payload.dueDate.trim()
                : null

            const disposableIncome = typeof payload.availableNow === 'number' && Number.isFinite(payload.availableNow)
                ? payload.availableNow
                : null

            const dailySafeSpend = typeof payload.dailySafeSpendNow === 'number' && Number.isFinite(payload.dailySafeSpendNow)
                ? payload.dailySafeSpendNow
                : null

            const daysRemaining = typeof payload.daysRemaining === 'number' && Number.isFinite(payload.daysRemaining)
                ? payload.daysRemaining
                : null

            const obligations = payload.obligations && typeof payload.obligations === 'object'
                ? payload.obligations
                : null
            const cycleImpact = payload.cycleImpact && typeof payload.cycleImpact === 'object'
                ? payload.cycleImpact
                : null

            const verdict: 'yes' | 'no' | 'maybe' = payload.verdict === 'no' ? 'no' : payload.verdict === 'maybe' ? 'maybe' : 'yes'
            const headline = typeof payload.headline === 'string' ? payload.headline : (verdict === 'yes' ? 'Yes, you can afford it' : 'Not right now')
            const explanation = typeof payload.explanation === 'string' ? payload.explanation : ''

            return new Response(JSON.stringify({
                type: 'afford_check',
                verdict,
                headline,
                explanation,
                input: { itemName: name, amount, dueDate },
                affordability: {
                    disposableIncome,
                    dailySafeSpend,
                    daysRemaining
                },
                obligations,
                recommendation: cycleImpact ? { cycleImpact } : null,
                confirm: null,
                plannedPayment: null,
                clarifyingQuestion: null
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            })
        }

        if (actionObj && actionObj.action === 'start_planned_payment' && actionObj.payload) {
            try {
                const payload = actionObj.payload

                const amount = typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount > 0
                    ? payload.amount
                    : 0
                if (amount <= 0) throw new Error('Invalid amount: must be a positive number')

                const name = typeof payload.name === 'string' && payload.name.trim().length > 0
                    ? payload.name.trim()
                    : 'Planned Purchase'

                const category = typeof payload.category === 'string' && payload.category.trim().length > 0
                    ? payload.category.trim()
                    : inferPlannedPaymentCategory(name)

                const obligations = payload.obligations && typeof payload.obligations === 'object'
                    ? payload.obligations
                    : null
                const cycleImpact = payload.cycleImpact && typeof payload.cycleImpact === 'object'
                    ? payload.cycleImpact
                    : null

                const dueOptions = buildDueDateOptions(
                    typeof payload.endOfCycle === 'string' ? payload.endOfCycle : null
                )

                return new Response(JSON.stringify({
                    type: 'afford_check',
                    verdict: payload.verdict === 'no' ? 'no' : payload.verdict === 'maybe' ? 'maybe' : 'yes',
                    headline: typeof payload.headline === 'string' ? payload.headline : 'Yes, you can afford it',
                    explanation: typeof payload.explanation === 'string' ? payload.explanation : '',
                    input: { itemName: name, amount, dueDate: null },
                    affordability: {
                        disposableIncome: typeof payload.availableNow === 'number' && Number.isFinite(payload.availableNow) ? payload.availableNow : null,
                        dailySafeSpend: typeof payload.dailySafeSpendNow === 'number' && Number.isFinite(payload.dailySafeSpendNow) ? payload.dailySafeSpendNow : null,
                        daysRemaining: typeof payload.daysRemaining === 'number' && Number.isFinite(payload.daysRemaining) ? payload.daysRemaining : null,
                    },
                    obligations,
                    recommendation: cycleImpact ? { cycleImpact } : null,
                    confirm: {
                        question: 'When do you want to add it?',
                        actions: dueOptions.map((opt) => ({
                            id: 'create_planned_payment',
                            title: opt.label,
                            payload: {
                                name,
                                amount,
                                dueDate: opt.value,
                                category,
                                isRecurring: false,
                                availableNow: typeof payload.availableNow === 'number' && Number.isFinite(payload.availableNow) ? payload.availableNow : null,
                                dailySafeSpendNow: typeof payload.dailySafeSpendNow === 'number' && Number.isFinite(payload.dailySafeSpendNow) ? payload.dailySafeSpendNow : null,
                                daysRemaining: typeof payload.daysRemaining === 'number' && Number.isFinite(payload.daysRemaining) ? payload.daysRemaining : null,
                                endOfCycle: typeof payload.endOfCycle === 'string' ? payload.endOfCycle : null,
                                obligations,
                                cycleImpact
                            }
                        }))
                    },
                    plannedPayment: null,
                    clarifyingQuestion: null
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            } catch (startError) {
                const err = startError as any
                console.error('âŒ Failed to start planned payment flow:', err)
                return new Response(JSON.stringify({
                    type: 'error',
                    error: err?.message || 'Failed to start planned payment flow'
                }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            }
        }

        if (actionObj && actionObj.action === 'create_planned_payment' && actionObj.payload) {
            try {
                const payload = actionObj.payload

                const disposableIncome = typeof payload.availableNow === 'number' && Number.isFinite(payload.availableNow)
                    ? payload.availableNow
                    : null

                const dailySafeSpend = typeof payload.dailySafeSpendNow === 'number' && Number.isFinite(payload.dailySafeSpendNow)
                    ? payload.dailySafeSpendNow
                    : null

                const daysRemaining = typeof payload.daysRemaining === 'number' && Number.isFinite(payload.daysRemaining)
                    ? payload.daysRemaining
                    : null

                const obligations = payload.obligations && typeof payload.obligations === 'object'
                    ? payload.obligations
                    : null
                const cycleImpact = payload.cycleImpact && typeof payload.cycleImpact === 'object'
                    ? payload.cycleImpact
                    : null

                // Validate and sanitize fields
                const amount = typeof payload.amount === 'number' && Number.isFinite(payload.amount) && payload.amount > 0
                    ? payload.amount
                    : 0

                if (amount <= 0) {
                    throw new Error('Invalid amount: must be a positive number')
                }

                const name = typeof payload.name === 'string' && payload.name.trim().length > 0
                    ? payload.name.trim()
                    : 'Planned Purchase'

                const category = typeof payload.category === 'string' && payload.category.trim().length > 0
                    ? payload.category.trim()
                    : inferPlannedPaymentCategory(name)

                // Parse due date with fallback to 7 days from now
                let dueDate: string
                if (payload.dueDate && typeof payload.dueDate === 'string') {
                    try {
                        const parsed = new Date(payload.dueDate)
                        if (!isNaN(parsed.getTime())) {
                            dueDate = payload.dueDate
                        } else {
                            // Invalid date, use 7 days from now
                            const sevenDaysFromNow = new Date()
                            sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
                            dueDate = sevenDaysFromNow.toISOString().split('T')[0]
                        }
                    } catch {
                        const sevenDaysFromNow = new Date()
                        sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
                        dueDate = sevenDaysFromNow.toISOString().split('T')[0]
                    }
                } else {
                    const sevenDaysFromNow = new Date()
                    sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)
                    dueDate = sevenDaysFromNow.toISOString().split('T')[0]
                }

                const amountCents = Math.round(amount * 100)

                // Get user's wallet with fallback priority: spending > cash > bank > any
                const { data: allWallets, error: walletsError } = await supabase
                    .from('wallets')
                    .select('id, type, archived')
                    .eq('user_id', userId)
                    .eq('archived', false)

                if (walletsError) {
                    console.error('[ai-advisor] wallets query failed:', walletsError)
                }

                if (!allWallets || allWallets.length === 0) {
                    // Fallback: check if user only has archived wallets
                    const { data: archivedWallets } = await supabase
                        .from('wallets')
                        .select('id, type, archived')
                        .eq('user_id', userId)

                    if (archivedWallets && archivedWallets.length > 0) {
                        console.error('[ai-advisor] User only has archived wallets')
                        return new Response(JSON.stringify({
                            type: 'afford_check',
                            verdict: 'maybe',
                            headline: 'All wallets are archived',
                            explanation: 'Please unarchive a wallet before adding planned payments.',
                            input: { itemName: name, amount: amount, dueDate: dueDate },
                            affordability: null,
                            recommendation: null,
                            confirm: null,
                            plannedPayment: null,
                            clarifyingQuestion: null
                        }), {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                                'Access-Control-Allow-Origin': '*'
                            }
                        })
                    }

                    console.error('[ai-advisor] No wallets found for user')
                    return new Response(JSON.stringify({
                        type: 'afford_check',
                        verdict: 'maybe',
                        headline: 'No wallet found',
                        explanation: 'Please create a wallet first before adding planned payments.',
                        input: { itemName: name, amount: amount, dueDate: dueDate },
                        affordability: null,
                        recommendation: null,
                        confirm: null,
                        plannedPayment: null,
                        clarifyingQuestion: null
                    }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        }
                    })
                }

                // Priority: spending > cash > bank > first available
                let chosenWallet = allWallets.find((w: any) => w.type === 'spending')
                if (!chosenWallet) chosenWallet = allWallets.find((w: any) => w.type === 'cash')
                if (!chosenWallet) chosenWallet = allWallets.find((w: any) => w.type === 'bank')
                if (!chosenWallet) chosenWallet = allWallets[0]

                console.log(`[ai-advisor] Selected wallet: type=${chosenWallet.type}, id=${chosenWallet.id}`)

                // Get category icon_key
                const { data: categoryData } = await supabase
                    .from('categories')
                    .select('icon_key')
                    .eq('user_id', userId)
                    .eq('name', category)
                    .single()

                const iconKey = categoryData?.icon_key || '🛍️'

                console.log(`[ai-advisor] Creating planned payment: user=${userId.substring(0, 8)}, name="${name}", amount=${amount}, date=${dueDate}, category=${category}, wallet=${chosenWallet.id}, icon=${iconKey}`)

                // Insert into planned_payments
                const { data: insertedPayment, error: insertError } = await supabase
                    .from('planned_payments')
                    .insert([{
                        user_id: userId,
                        wallet_id: chosenWallet.id,
                        name: name,
                        amount_cents: amountCents,
                        due_date: dueDate,
                        category: category || 'Planned',
                        icon_key: iconKey,
                        is_recurring: payload.isRecurring || false,
                        is_paid: false,
                        created_at: new Date().toISOString()
                    }])
                    .select('id')
                    .single()

                if (insertError) {
                    console.error('[ai-advisor] planned_payments insert failed:', insertError)
                    console.error('[ai-advisor] Insert error details:', JSON.stringify(insertError, null, 2))

                    return new Response(JSON.stringify({
                        type: 'afford_check',
                        verdict: 'maybe',
                        headline: 'Could not add planned payment',
                        explanation: `Failed to save planned payment. ${insertError.message || 'Please try again.'}`,
                        input: { itemName: name, amount: amount, dueDate: dueDate },
                        affordability: null,
                        recommendation: null,
                        confirm: null,
                        plannedPayment: null,
                        clarifyingQuestion: null
                    }), {
                        status: 200,
                        headers: {
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        }
                    })
                }

                console.log(`Planned payment created: id=${insertedPayment.id}`)

                return new Response(JSON.stringify({
                    type: 'afford_check',
                    verdict: 'yes',
                    headline: 'Added to planned payments',
                    explanation: `I've added "${name}" ($${amount.toFixed(2)}) to your planned payments for ${dueDate}.`,
                    input: { itemName: name, amount: amount, dueDate: dueDate },
                    affordability: {
                        disposableIncome,
                        dailySafeSpend,
                        daysRemaining
                    },
                    obligations,
                    recommendation: cycleImpact ? { cycleImpact } : null,
                    confirm: null,
                    plannedPayment: {
                        created: true,
                        plannedPaymentId: insertedPayment.id,
                        name: name,
                        amountCents: amountCents,
                        dueDate: dueDate,
                        category: category,
                        walletId: chosenWallet.id,
                        iconKey: iconKey
                    },
                    clarifyingQuestion: null
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            } catch (actionError) {
                console.error('[ai-advisor] Failed to process action:', actionError)
                return new Response(JSON.stringify({
                    type: 'afford_check',
                    verdict: 'maybe',
                    headline: 'Something went wrong',
                    explanation: 'Failed to process your request. Please try again.',
                    input: null,
                    affordability: null,
                    recommendation: null,
                    confirm: null,
                    plannedPayment: null,
                    clarifyingQuestion: null
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            }
        }

        // Resolve afford-check inputs.
        // Prefer the structured payload from the afford dialog so we never rely on regex math;
        // fall back to parsing free text for legacy / typed afford questions.
        let parsed: { amount: number | null; itemName: string | null; dueDate: string | null }
        let payloadCurrency: string | null = null
        if (actionObj && actionObj.action === 'afford_check' && actionObj.payload && typeof actionObj.payload === 'object') {
            const p = actionObj.payload
            // amountCents is minor units (e.g. 50000 -> 500.00). Convert to major units before any math.
            const centsRaw = typeof p.amountCents === 'number' ? p.amountCents : Number(p.amountCents)
            const amountMajor = Number.isFinite(centsRaw) && centsRaw > 0 ? centsRaw / 100 : null
            const itemName = typeof p.itemName === 'string' && p.itemName.trim().length > 0 ? p.itemName.trim() : null
            payloadCurrency = typeof p.currencyCode === 'string' && /^[A-Za-z]{3}$/.test(p.currencyCode.trim())
                ? p.currencyCode.trim().toUpperCase()
                : null
            parsed = { amount: amountMajor, itemName, dueDate: null }
        } else {
            parsed = parseAffordCheckMessage(message)
        }

        // If amount is missing, ask for it
        if (!parsed.amount) {
            return new Response(JSON.stringify({
                type: 'afford_check',
                verdict: 'maybe',
                headline: 'How much does it cost?',
                explanation: 'I need to know the amount to check if you can afford it.',
                input: { itemName: parsed.itemName, amount: null, dueDate: parsed.dueDate },
                affordability: null,
                recommendation: null,
                confirm: null,
                plannedPayment: null,
                clarifyingQuestion: 'How much does it cost?'
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            })
        }

        const todayISO = new Date().toISOString().split('T')[0]

        // Fetch cash flow data
        const cashFlowData = await fetchCashFlowData(supabase, userId)
        const { scopedData: scopedCashFlowData, currencyScope } = await applyCurrencyScopeAndNormalization(
            supabase,
            userId,
            cashFlowData,
        )
        let amount = parsed.amount
        let amountConversionWarning: string | null = null
        if (payloadCurrency) {
            const convertedAmount = await convertAmountToMainCurrency(
                supabase,
                userId,
                amount,
                payloadCurrency,
                currencyScope.primaryCurrency,
                todayISO,
            )
            if (payloadCurrency !== currencyScope.primaryCurrency && !convertedAmount.converted) {
                const reason = convertedAmount.warning || `I couldn't safely convert ${payloadCurrency} into ${currencyScope.primaryCurrency} for this check.`
                return new Response(JSON.stringify({
                    type: 'afford_check',
                    currencyCode: currencyScope.primaryCurrency,
                    currencyWarning: reason,
                    verdict: 'maybe',
                    headline: "Couldn't complete the check",
                    explanation: `${reason} I didn't guess, so please try again in ${currencyScope.primaryCurrency} or after FX becomes available.`,
                    input: { itemName: parsed.itemName, amount: parsed.amount, dueDate: null },
                    affordability: null,
                    recommendation: null,
                    confirm: null,
                    plannedPayment: null,
                    clarifyingQuestion: null
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                })
            }
            amount = convertedAmount.amount
            amountConversionWarning = convertedAmount.warning
        }

        // Currency safety: never compare an amount in one currency against balances in another.
        // Convert the requested amount into the analysis currency when possible; otherwise stop honestly.
        if (payloadCurrency && payloadCurrency !== currencyScope.primaryCurrency && !amountConversionWarning) {
            return new Response(JSON.stringify({
                type: 'afford_check',
                currencyCode: currencyScope.primaryCurrency,
                currencyWarning: `Main analysis currency is ${currencyScope.primaryCurrency}.`,
                verdict: 'maybe',
                headline: "Couldn't complete the check",
                explanation: `This amount is in ${payloadCurrency}, but your account works in ${currencyScope.primaryCurrency}. I couldn't safely convert it, so I didn't guess.`,
                input: { itemName: parsed.itemName, amount: parsed.amount, dueDate: null },
                affordability: null,
                recommendation: null,
                confirm: null,
                plannedPayment: null,
                clarifyingQuestion: null
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            })
        }

        const cycleStartDay = clampCycleStartDay(cashFlowData.cycleStartDay)
        const now = new Date()
        const window = computeCycleWindowUtc(now, cycleStartDay, 'current_cycle')

        const normalizedAssetBalance = await computeNormalizedAssetWalletBalance(
            supabase,
            userId,
            cashFlowData.wallets || [],
            currencyScope.primaryCurrency,
        )

        // Calculate cash flow analysis
        const scopedCashFlowDataNormalized = await normalizeCentCollectionsToMainCurrency(
            supabase,
            userId,
            currencyScope.primaryCurrency,
            scopedCashFlowData,
        )

        const analysis = calculateCashFlowAnalysis(
            scopedCashFlowDataNormalized,
            'current_cycle',
            normalizedAssetBalance.total,
        )

        // Make the decision
        const currentBalance = normalizedAssetBalance.total
        const excludedWalletBalanceCount = normalizedAssetBalance.excludedWallets

        // Fetch upcoming obligations within current cycle
        const endOfCycleISO = new Date(window.endExclusive.getTime() - 1).toISOString().split('T')[0]

        console.log(`[ai-advisor] Fetching obligations from ${todayISO} to ${endOfCycleISO}`)
        let obligationsWarning: string | null = null
        let obligations: UpcomingObligationsResult
        try {
            obligations = await fetchUpcomingObligations(
                supabase,
                userId,
                todayISO,
                endOfCycleISO,
                currencyScope.walletIds,
                currencyScope.primaryCurrency,
            )
        } catch (obligationError) {
            const errMsg = String((obligationError as any)?.message || obligationError)
            console.error(`[ai-advisor] afford_check obligations unavailable: ${errMsg}`)
            obligationsWarning = 'Upcoming obligations could not be loaded, so this check only uses current wallet cash and is incomplete.'
            obligations = {
                billsTotalCents: 0,
                plannedPaymentsTotalCents: 0,
                subscriptionsTotalCents: 0,
                goalAutoSaveCents: 0,
                obligationsTotalCents: 0,
                overdueTotalCents: 0,
                grandTotalCents: 0,
                obligationLines: [],
                normalizationWarning: null,
                items: {
                    billsCount: 0,
                    plannedPaymentsCount: 0,
                    subscriptionsCount: 0,
                    goalAutoSaveCount: 0,
                    overdueCount: 0,
                },
            }
        }

        const obligationsTotal = obligations.obligationsTotalCents / 100
        const obligationsTotalFormatted = formatCurrency(obligationsTotal, currencyScope.primaryCurrency)
        console.log(`[ai-advisor] Total obligations: ${obligationsTotalFormatted} (${obligations.items.billsCount} bills, ${obligations.items.plannedPaymentsCount} planned payments, ${obligations.items.subscriptionsCount} subscriptions)`)

        const cycleIncomeExcludingOpeningBalance = analyzeCycleIncomeExcludingOpeningBalance(
            scopedCashFlowDataNormalized.transactions || [],
            scopedCashFlowDataNormalized.incomes || [],
            window.start,
            window.endExclusive,
        )
        const cycleDisposableExcludingOpeningBalance = cycleIncomeExcludingOpeningBalance > 0
            ? cycleIncomeExcludingOpeningBalance - analysis.fixedExpenses.total - analysis.variableExpenses.total
            : null

        // If we don't have real cycle income data, still answer the *cash right now* question.
        // We only need income for cycle budgeting / daily-safe-spend. For a one-time purchase,
        // wallet cash minus upcoming obligations is sufficient to say "yes" or "no".
        const missingIncomeData = cycleDisposableExcludingOpeningBalance === null

        // IMPORTANT: For a one-time purchase, we should not claim affordability based solely on
        // "cycle disposable income" if the user's current cash balance is lower.
        // Cap available funds to what they actually have right now, AFTER accounting for obligations.
        const availableAfterObligations = Math.max(0, currentBalance - obligationsTotal)
        // Cycle-disposable income is context only (powers daily-safe-spend and the daily-budget tile).
        // It intentionally excludes Opening Balance so "This Cycle" means real monthly income minus spending.
        const cycleDisposable: number | null = cycleDisposableExcludingOpeningBalance

        const dailySafeSpendNow = (cycleDisposable !== null && window.daysRemaining > 0)
            ? (Math.max(0, cycleDisposable) / window.daysRemaining)
            : null

        // Hard gate: can you cover it with real cash after obligations?
        // Cycle-disposable income and runway are warning tiers only — never a hard block.
        const canAffordNow = amount <= availableAfterObligations
        const runwaySpend = computeRecentRunwaySpendSummary(scopedCashFlowDataNormalized.transactions || [], now, 30)
        const minimumRunwayDailySpendCents = 1000
        const hasRunwayHistory = runwaySpend.totalSpendCents > 0
            || runwaySpend.transactionCount >= 5
            || runwaySpend.activeDays >= 5
        const runwayDailySpendCents = hasRunwayHistory
            ? Math.max(minimumRunwayDailySpendCents, runwaySpend.averageDailySpendCents)
            : 0
        const runwayNeedCents = window.daysRemaining > 0
            ? runwayDailySpendCents * window.daysRemaining
            : 0
        const runwaySafetyBufferRatio = 1.1
        const runwayNeedWithSafetyCents = Math.ceil(runwayNeedCents * runwaySafetyBufferRatio)
        const postPurchaseCents = Math.max(0, Math.round((availableAfterObligations - amount) * 100))
        const amountCents = Math.round(amount * 100)
        const cycleImpact = cycleDisposable !== null
            ? (() => {
                const rawCycleLeftCents = Math.round(cycleDisposable * 100)
                const cycleLeftCents = Math.max(0, rawCycleLeftCents)
                const cycleLeftAfterPurchaseCents = Math.max(0, rawCycleLeftCents - amountCents)
                const dailyBeforePurchaseCents = window.daysRemaining > 0
                    ? Math.round(cycleLeftCents / window.daysRemaining)
                    : null
                const dailyAfterPurchaseCents = window.daysRemaining > 0
                    ? Math.round(cycleLeftAfterPurchaseCents / window.daysRemaining)
                    : null
                const dailyChangeCents = window.daysRemaining > 0
                    ? Math.round(amountCents / window.daysRemaining)
                    : null
                const cycleShortfallCents = Math.max(0, amountCents - rawCycleLeftCents)

                return {
                    cycleLeftCents,
                    cycleLeftAfterPurchaseCents,
                    dailyBeforePurchaseCents,
                    dailyAfterPurchaseCents,
                    dailyChangeCents,
                    cycleShortfallCents,
                }
            })()
            : null
        const runwayCoveragePct = runwayNeedCents > 0
            ? Math.round((postPurchaseCents / runwayNeedCents) * 100)
            : null
        const hasRunwayCheck = canAffordNow && window.daysRemaining > 0 && runwayNeedCents > 0

        let verdict: 'yes' | 'no' | 'maybe'
        if (!canAffordNow) {
            verdict = 'no'
        } else if (obligationsWarning) {
            verdict = 'maybe'
        } else if (!hasRunwayCheck) {
            verdict = 'yes'
        } else if (postPurchaseCents >= runwayNeedWithSafetyCents) {
            verdict = 'yes'
        } else {
            // Affordable from cash, but it leaves the rest of the cycle tight vs recent spend.
            // This is a caution, not a hard "no" — the cash is genuinely there.
            verdict = 'maybe'
        }

        let headline: string
        if (obligationsWarning && canAffordNow) {
            headline = 'Looks affordable, but obligations are incomplete'
        } else if (verdict === 'yes') {
            headline = 'Yes, you can afford it'
        } else if (verdict === 'maybe') {
            headline = 'You can buy it, but this cycle will be tight'
        } else {
            headline = 'Not right now'
        }

        const baseSummary = obligationsWarning
            ? `I could verify ${formatCurrency(currentBalance, currencyScope.primaryCurrency)} in current wallet cash, but I couldn't safely include upcoming obligations.`
            : obligationsTotal > 0
            ? `You have ${formatCurrency(currentBalance, currencyScope.primaryCurrency)} now. Upcoming obligations before cycle end total ${formatCurrency(obligationsTotal, currencyScope.primaryCurrency)}, leaving ${formatCurrency(availableAfterObligations, currencyScope.primaryCurrency)}.`
            : `You have ${formatCurrency(availableAfterObligations, currencyScope.primaryCurrency)} available right now.`

        // Build explanation that combines immediate affordability and remaining-cycle runway.
        let explanation: string
        if (!canAffordNow) {
            explanation = `${baseSummary} ${formatCurrency(amount, currencyScope.primaryCurrency)} exceeds this by ${formatCurrency(amount - availableAfterObligations, currencyScope.primaryCurrency)}.`
        } else if (!hasRunwayCheck) {
            explanation = `${baseSummary} ${formatCurrency(amount, currencyScope.primaryCurrency)} fits your budget right now.`
        } else {
            const runwayNeed = runwayNeedCents / 100
            const runwayNeedWithSafety = runwayNeedWithSafetyCents / 100
            const postPurchase = postPurchaseCents / 100
            const runwayDailySpend = runwayDailySpendCents / 100
            const runwayGap = Math.max(0, runwayNeedWithSafety - postPurchase)

            if (verdict === 'yes') {
                explanation = `${baseSummary} After this purchase, you would keep about ${formatCurrency(postPurchase, currencyScope.primaryCurrency)} for the remaining ${window.daysRemaining} days. Your recent average spend is about ${formatCurrency(runwayDailySpend, currencyScope.primaryCurrency)}/day (roughly ${formatCurrency(runwayNeed, currencyScope.primaryCurrency)} needed), so this stays within a safety buffer.`
            } else if (verdict === 'maybe') {
                explanation = `${baseSummary} The purchase fits today, but after buying it you would keep about ${formatCurrency(postPurchase, currencyScope.primaryCurrency)} for the remaining ${window.daysRemaining} days. Your recent average spend is about ${formatCurrency(runwayDailySpend, currencyScope.primaryCurrency)}/day (roughly ${formatCurrency(runwayNeed, currencyScope.primaryCurrency)} needed), so this is tight.`
            } else {
                explanation = `${baseSummary} Even though this amount fits right now, after purchase you would keep about ${formatCurrency(postPurchase, currencyScope.primaryCurrency)} for the remaining ${window.daysRemaining} days. Your recent average spend is about ${formatCurrency(runwayDailySpend, currencyScope.primaryCurrency)}/day, and a safer runway is about ${formatCurrency(runwayNeedWithSafety, currencyScope.primaryCurrency)}. Gap: ${formatCurrency(runwayGap, currencyScope.primaryCurrency)}.`
            }
        }
        const balanceExclusionWarning = excludedWalletBalanceCount > 0
            ? `${excludedWalletBalanceCount} wallet balance(s) were excluded because FX conversion to ${currencyScope.primaryCurrency} was unavailable.`
            : null
        const combinedCurrencyWarning = [
            amountConversionWarning,
            balanceExclusionWarning,
            obligations.normalizationWarning || null,
            obligationsWarning,
        ].filter(Boolean).join(' ').trim() || null

        if (combinedCurrencyWarning) {
            explanation += ` ${combinedCurrencyWarning}`
        }

        console.log(
            `[ai-advisor] Afford check runway: amount=${Math.round(amount * 100)}c, availAfterOblig=${Math.round(availableAfterObligations * 100)}c, cycleDisposable=${cycleDisposable === null ? 'null' : Math.round(cycleDisposable * 100) + 'c'}, postPurchase=${postPurchaseCents}c, daysRemaining=${window.daysRemaining}, runwayDaily=${runwayDailySpendCents}c, runwayNeed=${runwayNeedCents}c, runwayNeedSafe=${runwayNeedWithSafetyCents}c, coverage=${runwayCoveragePct ?? -1}%, verdict=${verdict}`
        )
        console.log(
            `[ai-advisor] Afford check balance normalization: primary=${currencyScope.primaryCurrency}, activeAssetWallets=${normalizedAssetBalance.walletCount}, normalized=${normalizedAssetBalance.normalizedWallets}, excluded=${excludedWalletBalanceCount}`
        )

        // Build confirmation actions (only if can afford)
        const endOfCycle = endOfCycleISO
        const inferredCategory = inferPlannedPaymentCategory(parsed.itemName || '')
        const confirmPayload = {
            name: parsed.itemName || 'Purchase',
            amount,
            category: inferredCategory,
            verdict,
            headline,
            explanation,
            availableNow: cycleDisposable,
            dailySafeSpendNow,
            daysRemaining: window.daysRemaining,
            endOfCycle,
            obligations: {
                window: {
                    startDate: todayISO,
                    endDate: endOfCycleISO
                },
                totals: {
                    billsCents: obligations.billsTotalCents,
                    plannedPaymentsCents: obligations.plannedPaymentsTotalCents,
                    subscriptionsCents: obligations.subscriptionsTotalCents,
                    goalAutoSaveCents: obligations.goalAutoSaveCents,
                    obligationsCents: obligations.obligationsTotalCents,
                    overdueCents: obligations.overdueTotalCents,
                    grandTotalCents: obligations.grandTotalCents,
                },
                counts: {
                    bills: obligations.items.billsCount,
                    plannedPayments: obligations.items.plannedPaymentsCount,
                    subscriptions: obligations.items.subscriptionsCount,
                    goalAutoSave: obligations.items.goalAutoSaveCount,
                    overdue: obligations.items.overdueCount,
                },
                availableAfterObligationsCents: Math.round(availableAfterObligations * 100)
            },
            cycleImpact
        }

        const confirm = verdict !== 'no' && !obligationsWarning ? {
            question: verdict === 'maybe'
                ? 'This looks tight for the rest of your cycle. Add it as a planned payment anyway?'
                : 'Do you want to add this as a planned payment?',
            actions: [
                {
                    id: 'start_planned_payment',
                    title: 'Yes, add it',
                    payload: confirmPayload
                },
                {
                    id: 'dismiss',
                    title: 'No',
                    payload: confirmPayload
                }
            ]
        } : null

        const suggestedMaxAmount = hasRunwayCheck
            ? Math.max(0, (Math.round(availableAfterObligations * 100) - runwayNeedWithSafetyCents) / 100)
            : Math.max(0, availableAfterObligations)

        return new Response(JSON.stringify({
            type: 'afford_check',
            currencyCode: currencyScope.primaryCurrency,
            currencyWarning: combinedCurrencyWarning,
            verdict,
            headline,
            explanation,
            input: {
                itemName: parsed.itemName,
                amount,
                dueDate: parsed.dueDate
            },
            affordability: {
                disposableIncome: cycleDisposable,
                dailySafeSpend: dailySafeSpendNow,
                daysRemaining: window.daysRemaining
            },
            obligations: {
                window: {
                    startDate: todayISO,
                    endDate: endOfCycleISO
                },
                totals: {
                    billsCents: obligations.billsTotalCents,
                    plannedPaymentsCents: obligations.plannedPaymentsTotalCents,
                    subscriptionsCents: obligations.subscriptionsTotalCents,
                    goalAutoSaveCents: obligations.goalAutoSaveCents,
                    obligationsCents: obligations.obligationsTotalCents,
                    overdueCents: obligations.overdueTotalCents,
                    grandTotalCents: obligations.grandTotalCents,
                },
                counts: {
                    bills: obligations.items.billsCount,
                    plannedPayments: obligations.items.plannedPaymentsCount,
                    subscriptions: obligations.items.subscriptionsCount,
                    goalAutoSave: obligations.items.goalAutoSaveCount,
                    overdue: obligations.items.overdueCount,
                },
                availableAfterObligationsCents: Math.round(availableAfterObligations * 100)
            },
            recommendation: {
                suggestedMaxAmount,
                suggestedDailySpendAfter: cycleImpact?.dailyAfterPurchaseCents != null
                    ? cycleImpact.dailyAfterPurchaseCents / 100
                    : canAffordNow && window.daysRemaining > 0
                        ? (availableAfterObligations - amount) / window.daysRemaining
                        : null,
                cycleImpact,
                runway: {
                    lookbackDays: runwaySpend.lookbackDays,
                    averageDailySpendCents: runwayDailySpendCents,
                    totalSpendCents: runwaySpend.totalSpendCents,
                    transactionCount: runwaySpend.transactionCount,
                    activeDays: runwaySpend.activeDays,
                    neededCents: runwayNeedCents,
                    neededWithSafetyCents: runwayNeedWithSafetyCents,
                    postPurchaseCents,
                    coveragePct: runwayCoveragePct,
                },
            },
            confirm,
            plannedPayment: null,
            clarifyingQuestion: missingIncomeData && runwaySpend.transactionCount === 0
                ? "I can check this purchase against your cash right now, but I need your income to assess your daily budget. What's your monthly income?"
                : null
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        })

    } catch (error) {
        console.error('âŒ Afford check error:', error)
        return new Response(JSON.stringify({
            type: 'error',
            error: String((error as any)?.message || 'Failed to process afford check')
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        })
    }
}

/**
 * TASK D: Infer category from item name using heuristic mapping
 */
function inferCategory(itemName: string): string {
    const name = itemName.toLowerCase().trim()

    // Transportation
    if (/\b(car|vehicle|auto|gas|fuel|petrol|uber|lyft|taxi|bus|train|metro|parking)\b/.test(name)) {
        return 'Transport'
    }

    // Shopping & Clothing
    if (/\b(shoe|shoes|shirt|pants|dress|clothes|clothing|fashion|jacket|coat|jeans)\b/.test(name)) {
        return 'Shopping'
    }

    // Food & Dining
    if (/\b(food|restaurant|dinner|lunch|breakfast|meal|pizza|burger|coffee|cafe|grocery|groceries)\b/.test(name)) {
        return 'Food & Dining'
    }

    // Entertainment
    if (/\b(movie|cinema|concert|game|gaming|netflix|spotify|entertainment|ticket|show)\b/.test(name)) {
        return 'Entertainment'
    }

    // Health & Fitness
    if (/\b(gym|fitness|doctor|medical|health|medicine|pharmacy|hospital|dental|therapy)\b/.test(name)) {
        return 'Health & Fitness'
    }

    // Electronics & Tech
    if (/\b(phone|laptop|computer|tablet|headphone|camera|tech|electronic|gadget|iphone|ipad|macbook)\b/.test(name)) {
        return 'Electronics'
    }

    // Home & Garden
    if (/\b(furniture|home|house|garden|decor|appliance|kitchen|bedroom|living room)\b/.test(name)) {
        return 'Home & Garden'
    }

    // Travel
    if (/\b(flight|hotel|vacation|travel|trip|airbnb|booking)\b/.test(name)) {
        return 'Travel'
    }

    // Education
    if (/\b(book|course|class|education|school|university|tuition|learning)\b/.test(name)) {
        return 'Education'
    }

    // Gifts
    if (/\b(gift|present|birthday|anniversary|wedding)\b/.test(name)) {
        return 'Gifts'
    }

    // Default
    return 'Shopping'
}

/**
 * Build due date options for planned payment
 */
function buildDueDateOptions(endOfCycle: string | null): Array<{ label: string; value: string }> {
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const nextWeek = new Date(today)
    nextWeek.setDate(nextWeek.getDate() + 7)
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0)

    const formatDate = (d: Date) => d.toISOString().split('T')[0]

    return [
        { label: 'Today', value: formatDate(today) },
        { label: 'Tomorrow', value: formatDate(tomorrow) },
        { label: 'Next Week', value: formatDate(nextWeek) },
        { label: 'End of Month', value: formatDate(endOfMonth) }
    ]
}

/**
 * Infer planned payment category (alias for inferCategory)
 */
function inferPlannedPaymentCategory(itemName: string): string {
    return inferCategory(itemName)
}

/**
 * Fetch upcoming obligations (bills, subscriptions, planned payments) within a date window
 */
async function fetchUpcomingObligations(
    supabase: any,
    userId: string,
    startDateISO: string,
    endDateISO: string,
    scopedWalletIds?: Set<string>,
    mainCurrency: string = 'USD',
): Promise<UpcomingObligationsResult> {
    const scopeCount = walletScopeCount(scopedWalletIds)
    console.log(
        `[ai-advisor] obligations request: mode=custom, window=${startDateISO}..${endDateISO}, walletScopeCount=${scopeCount}, includeOverdue=true, includeLines=true`
    )

    try {
        const canonical = await getCanonicalObligations(supabase, {
            mode: 'custom',
            windowStart: startDateISO,
            windowEnd: endDateISO,
            walletIds: scopedWalletIds || null,
            includeOverdue: true,
            includeLines: true,
        })

        if (Array.isArray(canonical?.warnings) && canonical.warnings.length > 0) {
            console.log(`[ai-advisor] Canonical obligations warnings: ${canonical.warnings.join(' | ')}`)
        }

        try {
            const normalized = await normalizeCanonicalObligationLinesToMainCurrency(
                supabase,
                userId,
                mainCurrency,
                canonical.lines || [],
                endDateISO,
            )

            if (normalized.excludedLineCount > 0) {
                console.log(
                    `[ai-advisor] obligations normalization excluded ${normalized.excludedLineCount} wallet-scoped line(s) due to unavailable FX conversion to ${mainCurrency}`
                )
            }
            if (normalized.metrics.fx_lookup_failures > 0) {
                console.log(
                    `[ai-advisor] obligations normalization FX lookups failed: ${normalized.metrics.fx_lookup_failures}`
                )
            }
            const normalizationWarning = [
                normalized.excludedLineCount > 0
                    ? `${normalized.excludedLineCount} obligation line(s) were excluded because FX conversion to ${mainCurrency} was unavailable.`
                    : null,
                normalized.metrics.fx_lookup_failures > 0
                    ? `Some obligation FX lookups to ${mainCurrency} failed; values may be conservative.`
                    : null,
            ].filter(Boolean).join(' ').trim() || null

            const summarized = summarizeUpcomingObligationLines(
                normalized.lines.map((line) => ({
                    source: line.source,
                    name: line.name,
                    category: line.category,
                    amountCents: line.amountCents,
                    walletId: line.walletId,
                    isOverdue: line.isOverdue,
                    dueDate: line.dateKey,
                })),
                normalizationWarning,
            )

            console.log(
                `[ai-advisor] obligations response: version=${canonical?.version || 'v1'}, window=${canonical?.window?.startDate || startDateISO}..${canonical?.window?.endDate || endDateISO}, bills=${summarized.billsTotalCents}, planned=${summarized.plannedPaymentsTotalCents}, subscriptions=${summarized.subscriptionsTotalCents}, goalAutoSave=${summarized.goalAutoSaveCents}, overdue=${summarized.overdueTotalCents}, grand=${summarized.grandTotalCents}, total=${summarized.obligationsTotalCents}`
            )

            return summarized
        } catch (normalizationError) {
            const errMsg = String((normalizationError as any)?.message || normalizationError)
            console.error(`[ai-advisor] obligations normalization failure: ${errMsg}`)

            const fallback = await buildSameCurrencyObligationsFallback(
                supabase,
                userId,
                canonical.lines || [],
                mainCurrency,
                errMsg,
            )

            console.log(
                `[ai-advisor] obligations fallback response: version=${canonical?.version || 'v1'}, window=${canonical?.window?.startDate || startDateISO}..${canonical?.window?.endDate || endDateISO}, bills=${fallback.billsTotalCents}, planned=${fallback.plannedPaymentsTotalCents}, subscriptions=${fallback.subscriptionsTotalCents}, goalAutoSave=${fallback.goalAutoSaveCents}, overdue=${fallback.overdueTotalCents}, grand=${fallback.grandTotalCents}, total=${fallback.obligationsTotalCents}`
            )

            return fallback
        }
    } catch (error) {
        const errMsg = String((error as any)?.message || error)
        console.error(`[ai-advisor] obligations failure: mode=custom, window=${startDateISO}..${endDateISO}, walletScopeCount=${scopeCount}, error=${errMsg}`)
        throw new Error(`Failed to fetch obligations via get_obligations_v1: ${errMsg}`)
    }
}

/**
 * Parse afford check message to extract amount, item name, and due date
 */
function parseAffordCheckMessage(message: string): {
    amount: number | null
    itemName: string | null
    dueDate: string | null
} {
    const msg = message.toLowerCase()

    // Extract amount (look for currency patterns)
    let amount: number | null = null
    const amountPatterns = [
        // "$100", "100$", "100 dollars", "100dollars", "100dolrs", "100dlrs" (any variation)
        /(\d+(?:\.\d{1,2})?)\s*(?:d[o0]?l+[a@]?r?s?|usd|\$|â‚¬|Â£|cents?)/i,
        /(?:d[o0]?l+[a@]?r?s?|usd|\$|â‚¬|Â£)\s*(\d+(?:\.\d{1,2})?)/i,
        // Just a number (fallback, but only if it looks like a price)
        /\b(\d+(?:\.\d{1,2})?)\b/
    ]

    for (const pattern of amountPatterns) {
        const match = message.match(pattern)
        if (match) {
            const parsed = parseFloat(match[1])
            if (!isNaN(parsed) && parsed > 0) {
                amount = parsed
                break
            }
        }
    }

    // If message is JUST a number (like "100"), treat it as amount
    const justNumberMatch = message.trim().match(/^(\d+(?:\.\d{1,2})?)$/)
    if (justNumberMatch && !amount) {
        const parsed = parseFloat(justNumberMatch[1])
        if (!isNaN(parsed) && parsed > 0) {
            amount = parsed
        }
    }

    // Extract item name (text after "afford" or "buy")
    let itemName: string | null = null
    const itemPatterns = [
        /(?:afford|buy|purchase|get)\s+(?:a|an|the)?\s*(\d+(?:\.\d{1,2})?\s*(?:d[o0]?l+[a@]?r?s?|usd|\$|â‚¬|Â£)?\s*)?([a-z0-9\s]+?)(?:\s+for|\s+at|\s*\?|$)/i,
        /(?:for|buy)\s+([a-z\s]+)/i
    ]

    for (const pattern of itemPatterns) {
        const match = message.match(pattern)
        if (match) {
            // Get the item name (last capture group)
            const captured = match[match.length - 1]
            if (captured) {
                itemName = captured.trim()
                // Remove amount from item name if present
                itemName = itemName.replace(/\d+(?:\.\d{1,2})?\s*(?:d[o0]?l+[a@]?r?s?|usd|\$|â‚¬|Â£)?/gi, '').trim()
                if (itemName.length > 0) break
            }
        }
    }

    // Due date: default to null (will use cycle end)
    const dueDate: string | null = null

    return { amount, itemName, dueDate }
}

async function fetchCashFlowData(supabase: any, userId: string) {
    const startTime = nowMs()

    // Fetch recent transaction window for income stability + cash flow.
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - TX_FETCH_WINDOW_DAYS)

    const [
        walletsRes,
        txRes,
        subsRes,
        billsRes,
        debtsRes,
        incomesRes,
        goalsRes,
        plannedPaymentsRes,
        budgetsRes,
        prefsRes,
    ] = await Promise.all([
        supabase.from('wallets').select('id, balance, currency_code, archived, account_class, created_at, updated_at').eq('user_id', userId),
        supabase.from('wallet_transactions')
            .select('id, wallet_id, amount, reporting_amount, reporting_currency, category, category_id, title, note, date, created_at, is_opening_balance, is_manual_topup, categories(id, name, is_income, is_fixed_obligation, expense_tier)')
            .eq('user_id', userId)
            .gte('date', sixtyDaysAgo.toISOString())
            .order('date', { ascending: false })
            .limit(TX_FETCH_ROW_LIMIT),
        supabase.from('subscriptions').select('name, amount_cents, billing_cycle, is_active, wallet_id, next_billing_date, created_at, updated_at').eq('user_id', userId).eq('is_active', true),
        supabase.from('bills').select('name, amount_cents, category, is_paid, wallet_id, due_date, created_at, updated_at').eq('user_id', userId).eq('is_paid', false),
        supabase.from('debts').select('name, minimum_payment_cents').eq('user_id', userId),
        supabase.from('incomes').select('name, source, amount_cents, expected_date, wallet_id, is_received, created_at, updated_at').eq('user_id', userId).eq('is_received', false),
        supabase.from('goals').select('id, name, linked_wallet_id, target_amount_cents, current_amount_cents, target_date_millis, is_deduction_paused, is_wish, is_challenge, currency_code, created_at, updated_at').eq('user_id', userId),
        supabase.from('planned_payments').select('name, amount_cents, category, is_recurring, wallet_id, is_paid, due_date, created_at, updated_at').eq('user_id', userId).eq('is_paid', false),
        supabase.from('budgets').select('name, category_id, start_date, end_date, is_active, wallet_id, created_at, updated_at, categories(name)').eq('user_id', userId),
        supabase.from('user_preferences').select('cycle_start_day, currency').eq('user_id', userId).maybeSingle(),
    ])

    const elapsed = nowMs() - startTime
    console.log(`âœ… Data fetched in ${elapsed.toFixed(0)}ms`)

    return {
        wallets: walletsRes.data || [],
        transactions: txRes.data || [],
        subscriptions: subsRes.data || [],
        bills: billsRes.data || [],
        debts: debtsRes.data || [],
        incomes: incomesRes.data || [],
        goals: goalsRes.data || [],
        plannedPayments: plannedPaymentsRes.data || [],
        budgets: budgetsRes.data || [],
        cycleStartDay: prefsRes.data?.cycle_start_day ?? 1,
        preferredCurrency: prefsRes.data?.currency ?? null,
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

function computeCycleWindowUtc(now: Date, cycleStartDay: number, timeframe: string = 'current_cycle'): { start: Date; endExclusive: Date; daysRemaining: number } {
    const startDay = clampCycleStartDay(cycleStartDay)
    const today = startOfDayUtc(now)
    const y = today.getUTCFullYear()
    const m = today.getUTCMonth()
    const thisMonthAnchor = buildCycleAnchorUtc(y, m, startDay)
    const currentCycleStart = today.getTime() >= thisMonthAnchor.getTime()
        ? thisMonthAnchor
        : buildCycleAnchorUtc(y, m - 1, startDay)

    if (timeframe === 'last_cycle') {
        // Previous complete cycle
        const lastCycleStart = buildCycleAnchorUtc(
            currentCycleStart.getUTCFullYear(),
            currentCycleStart.getUTCMonth() - 1,
            startDay
        )
        const lastCycleEnd = currentCycleStart

        return { start: lastCycleStart, endExclusive: lastCycleEnd, daysRemaining: 0 }
    }

    if (timeframe === 'this_year') {
        // Year to date (Jan 1 to today)
        const yearStart = startOfDayUtc(new Date(Date.UTC(y, 0, 1)))
        const tomorrow = startOfDayUtc(new Date(Date.UTC(y, m, today.getUTCDate() + 1)))
        return { start: yearStart, endExclusive: tomorrow, daysRemaining: 0 }
    }

    // Default: current_cycle
    const start = currentCycleStart
    const endExclusive = buildCycleAnchorUtc(start.getUTCFullYear(), start.getUTCMonth() + 1, startDay)
    const ms = endExclusive.getTime() - today.getTime()
    const daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)))
    return { start, endExclusive, daysRemaining }
}

/**
 * PHASE 3.2: Calculate status level based on spending pace and cycle progress
 * Returns one of 5 levels: excellent / good / warning / overspending / critical
 */
function calculateStatusLevel(
    disposableIncome: number | null,
    totalIncome: number,
    fixedExpensesTotal: number,
    variableExpensesTotal: number,
    cycleProgress: number,
    missingData: string[],
    timeframe: string,
    timeframeLabel: string
): { level: 'excellent' | 'good' | 'warning' | 'overspending' | 'critical', message: string } {

    // Evidence-first: if income is missing, be cautious
    if (missingData.includes('income')) {
        return {
            level: 'warning',
            message: "I need your income data to assess your spending pace accurately."
        }
    }

    // Only warn about early cycle for current_cycle (not for historical timeframes)
    if (timeframe === 'current_cycle' && cycleProgress < 0.2) {
        return {
            level: 'warning',
            message: "Your cycle just started - not enough data yet to assess spending pace."
        }
    }

    // Critical: spending more than earning
    if (disposableIncome !== null && disposableIncome < 0) {
        return {
            level: 'critical',
            message: `You're spending more than you earn for ${timeframeLabel}. This isn't sustainable.`
        }
    }

    // Calculate spending pace
    const actualSpendingSoFar = fixedExpensesTotal + variableExpensesTotal
    const expectedSpendingSoFar = totalIncome * cycleProgress

    // Avoid division by zero
    const spendingPace = expectedSpendingSoFar > 0
        ? actualSpendingSoFar / expectedSpendingSoFar
        : 0

    // Map to status level
    if (spendingPace > 1.5) {
        return {
            level: 'overspending',
            message: `You're spending 50%+ faster than expected for ${timeframeLabel}. Slow down to stay on track.`
        }
    }

    if (spendingPace > 1.2) {
        return {
            level: 'warning',
            message: `You're spending a bit faster than usual for ${timeframeLabel}.`
        }
    }

    if (spendingPace < 0.8) {
        return {
            level: 'excellent',
            message: `You're spending slower than usual for ${timeframeLabel} - great job!`
        }
    }

    return {
        level: 'good',
        message: `You're on track for ${timeframeLabel}.`
    }
}

/**
 * Calculate comprehensive cash flow analysis
 */
function calculateCashFlowAnalysis(
    data: any,
    timeframe: string = 'current_cycle',
    currentBalanceOverride: number | null = null,
): CashFlowAnalysis {
    const missingData: string[] = []
    let clarifyingQuestion: string | null = null

    const now = new Date()
    const cycleStartDay = clampCycleStartDay(data.cycleStartDay)
    const cycleWindow = computeCycleWindowUtc(now, cycleStartDay, timeframe)

    // 1. INCOME ANALYSIS
    const incomeAnalysis = analyzeIncome(data.transactions, data.incomes, cycleWindow.start, cycleWindow.endExclusive)
    if (incomeAnalysis.totalIncome === 0) {
        missingData.push('income')
        // Clarifying question will be set later with proper priority ordering (Phase 3.3)
    }

    // 2. FIXED EXPENSES ANALYSIS
    const fixedExpenses = analyzeFixedExpenses(
        data.transactions,
        data.subscriptions,
        data.bills,
        data.debts,
        data.plannedPayments
    )

    // 3. VARIABLE EXPENSES ANALYSIS
    const variableExpenses = analyzeVariableExpenses(data.transactions, fixedExpenses.items, cycleWindow.start, cycleWindow.endExclusive)

    // 4. DISPOSABLE INCOME CALCULATION
    let disposableIncome: number | null = null
    let discretionaryBudget: number | null = null
    let percentageOfIncomeFixed: number | null = null
    let percentageOfIncomeVariable: number | null = null

    if (incomeAnalysis.totalIncome > 0) {
        disposableIncome = incomeAnalysis.totalIncome - fixedExpenses.total - variableExpenses.total
        discretionaryBudget = disposableIncome // Same for now, can refine later

        percentageOfIncomeFixed = (fixedExpenses.total / incomeAnalysis.totalIncome) * 100
        percentageOfIncomeVariable = (variableExpenses.total / incomeAnalysis.totalIncome) * 100
    }

    // 5. DAILY SAFE SPEND CALCULATION
    let dailySafeSpend: number | null = null
    let daysUntilPayday: number | null = null

    if (disposableIncome !== null && disposableIncome > 0) {
        if (cycleWindow.daysRemaining > 0) {
            dailySafeSpend = disposableIncome / cycleWindow.daysRemaining
            daysUntilPayday = cycleWindow.daysRemaining
        }
    }

    // 6. END OF MONTH PROJECTION
    let projectedEndOfMonth: number | null = null
    if (disposableIncome !== null) {
        const hasCurrentBalanceOverride = typeof currentBalanceOverride === 'number' && Number.isFinite(currentBalanceOverride)
        const currentBalance = hasCurrentBalanceOverride
            ? currentBalanceOverride
            : data.wallets.reduce((sum: number, w: any) => sum + asNumber(w.balance), 0)
        projectedEndOfMonth = currentBalance + (disposableIncome || 0)
    }

    // PHASE 3.2: CALCULATE CYCLE PROGRESS AND STATUS
    const today = startOfDayUtc(now)
    const dayMs = 1000 * 60 * 60 * 24
    const totalDays = Math.max(1, Math.ceil((cycleWindow.endExclusive.getTime() - cycleWindow.start.getTime()) / dayMs))

    // FIX #2: Use floor for elapsed days to avoid inflating progress early
    const elapsedDaysRaw = Math.floor((today.getTime() - cycleWindow.start.getTime()) / dayMs)
    const elapsedDays = Math.max(0, Math.min(totalDays, elapsedDaysRaw))

    // Clamp cycle progress between 0 and 1
    const cycleProgress = Math.max(0, Math.min(1, elapsedDays / totalDays))

    // FIX #1: Compute timeframe label for status messages
    const timeframeLabel = timeframe === 'this_year'
        ? 'This Year'
        : timeframe === 'last_cycle'
            ? 'Last Cycle'
            : 'This Cycle'

    const status = calculateStatusLevel(
        disposableIncome,
        incomeAnalysis.totalIncome,
        fixedExpenses.total,
        variableExpenses.total,
        cycleProgress,
        missingData,
        timeframe,
        timeframeLabel
    )

    // PHASE 3.3: CLARIFYING QUESTIONS (Priority-ordered, product-grade)
    // Priority 1: Missing income (most critical)
    if (missingData.includes('income')) {
        clarifyingQuestion = "I don't see any income transactions yet. What's your monthly income?"
    }
    // Priority 2: Cycle just started (only for current_cycle, not historical)
    else if (timeframe === 'current_cycle' && elapsedDays < 3) {
        clarifyingQuestion = "Your cycle just started, so there isn't much data yet. Want to see last cycle instead?"
    }
    // Otherwise: no clarifying question needed
    else {
        clarifyingQuestion = null
    }

    return {
        status,
        totalIncome: incomeAnalysis.totalIncome,
        incomeStability: incomeAnalysis.stability,
        incomeVariance: incomeAnalysis.variance,
        incomeSources: incomeAnalysis.sources,
        fixedExpenses: {
            total: fixedExpenses.total,
            items: fixedExpenses.items,
            percentageOfIncome: percentageOfIncomeFixed
        },
        variableExpenses: {
            total: variableExpenses.total,
            categories: variableExpenses.categories,
            percentageOfIncome: percentageOfIncomeVariable
        },
        disposableIncome,
        discretionaryBudget,
        projectedEndOfMonth,
        daysUntilPayday,
        dailySafeSpend,
        missingData,
        clarifyingQuestion
    }
}

/**
 * Analyze income from transactions and planned income
 */
function analyzeIncome(transactions: any[], plannedIncomes: any[], windowStart: Date, windowEnd: Date) {
    // Get regular income transactions (strict whitelist)
    const regularIncomeTransactions = transactions.filter(t =>
        asNumber(t.amount) > 0 && !isExcludedTxForCashFlow(t) && isIncomeTransaction(t)
    )

    // Get opening balance transactions (count as income)
    const openingBalanceTransactions = transactions.filter(t =>
        asNumber(t.amount) > 0 && !isExcludedTxForOpeningBalanceIncome(t) && isOpeningBalanceLike(t)
    )

    const allIncomeTransactions = [...regularIncomeTransactions, ...openingBalanceTransactions]

    // Calculate total income within window
    const recentIncome = allIncomeTransactions.filter(t => {
        const txDate = new Date(t.date)
        return txDate >= windowStart && txDate < windowEnd
    })

    const totalIncomeFromTx = recentIncome.reduce((sum, t) => sum + asNumber(t.amount), 0)

    // Group by source
    const sourceMap = new Map<string, number>()
    recentIncome.forEach(t => {
        let source = t.category || 'Other'
        if (isOpeningBalanceLike(t)) {
            source = t.category?.includes('opening') ? t.category : 'Opening Balance'
        }
        sourceMap.set(source, (sourceMap.get(source) || 0) + asNumber(t.amount))
    })

    const planned = Array.isArray(plannedIncomes) ? plannedIncomes : []
    const plannedRecent = planned.filter((p) => {
        const d = p.expected_date ? new Date(p.expected_date) : null
        if (!d || Number.isNaN(d.getTime())) return true
        return d >= windowStart && d < windowEnd
    })

    const totalIncomeFromPlanned = plannedRecent
        .reduce((sum, p) => sum + (asNumber(p.amount_cents) / 100), 0)

    plannedRecent.forEach((p) => {
        const source = p.name || p.source || p.category || 'Planned Income'
        const amount = asNumber(p.amount_cents) / 100
        if (amount > 0) {
            sourceMap.set(source, (sourceMap.get(source) || 0) + amount)
        }
    })

    const sources: IncomeSource[] = Array.from(sourceMap.entries()).map(([source, amount]) => ({
        source,
        amount,
        frequency: 'monthly' as const
    }))

    // Calculate income stability (coefficient of variation over last 3 months)
    const { stability, variance } = calculateIncomeStability(transactions)

    return {
        totalIncome: totalIncomeFromTx > 0 ? totalIncomeFromTx : totalIncomeFromPlanned,
        stability,
        variance,
        sources
    }
}

function analyzeCycleIncomeExcludingOpeningBalance(
    transactions: any[],
    plannedIncomes: any[],
    windowStart: Date,
    windowEnd: Date,
): number {
    const incomeTx = transactions.filter((t) => {
        const amount = asNumber(t?.amount)
        if (amount <= 0) return false
        if (isExcludedTxForCashFlow(t)) return false
        if (!isIncomeTransaction(t)) return false

        const txDate = new Date(t?.date)
        return !Number.isNaN(txDate.getTime()) && txDate >= windowStart && txDate < windowEnd
    })

    const incomeFromTx = incomeTx.reduce((sum, t) => sum + asNumber(t?.amount), 0)
    if (incomeFromTx > 0) return incomeFromTx

    const planned = Array.isArray(plannedIncomes) ? plannedIncomes : []
    return planned
        .filter((p) => {
            const d = p?.expected_date ? new Date(p.expected_date) : null
            if (!d || Number.isNaN(d.getTime())) return true
            return d >= windowStart && d < windowEnd
        })
        .reduce((sum, p) => sum + (asNumber(p?.amount_cents) / 100), 0)
}

/**
 * Calculate income stability using coefficient of variation
 */
function calculateIncomeStability(transactions: any[]): {
    stability: 'stable' | 'variable' | 'irregular' | 'unknown',
    variance: number | null
} {
    // One-pass bucketing for last 3 months to avoid repeated full-array scans.
    const now = new Date()
    const keyForOffset = (offset: number) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    }

    const monthKeys = [keyForOffset(0), keyForOffset(1), keyForOffset(2)]
    const monthlyMap = new Map<string, number>(monthKeys.map((k) => [k, 0]))

    for (const tx of transactions) {
        const amount = asNumber(tx?.amount)
        if (amount <= 0) continue

        const isStandardIncome = !isExcludedTxForCashFlow(tx) && isIncomeTransaction(tx)
        const isOpeningBalance = !isExcludedTxForOpeningBalanceIncome(tx) && isOpeningBalanceLike(tx)
        if (!isStandardIncome && !isOpeningBalance) continue

        const txDate = new Date(tx?.date)
        if (Number.isNaN(txDate.getTime())) continue
        const key = `${txDate.getUTCFullYear()}-${String(txDate.getUTCMonth() + 1).padStart(2, '0')}`
        if (!monthlyMap.has(key)) continue

        monthlyMap.set(key, (monthlyMap.get(key) || 0) + amount)
    }

    const monthlyIncomes: number[] = monthKeys.map((k) => monthlyMap.get(k) || 0)

    // Need at least 2 months of data
    const validMonths = monthlyIncomes.filter(m => m > 0)
    if (validMonths.length < 2) {
        return { stability: 'unknown', variance: null }
    }

    // Calculate coefficient of variation
    const mean = validMonths.reduce((a, b) => a + b, 0) / validMonths.length
    if (mean === 0) {
        return { stability: 'unknown', variance: null }
    }

    const variance = validMonths.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / validMonths.length
    const stdDev = Math.sqrt(variance)
    const coefficientOfVariation = stdDev / mean

    // Classify stability
    let stability: 'stable' | 'variable' | 'irregular'
    if (coefficientOfVariation < 0.10) {
        stability = 'stable'      // <10% variance
    } else if (coefficientOfVariation < 0.30) {
        stability = 'variable'    // 10-30% variance
    } else {
        stability = 'irregular'   // >30% variance
    }

    return { stability, variance: coefficientOfVariation }
}

function analyzeFixedExpenses(
    transactions: any[],
    subscriptions: any[],
    bills: any[],
    debts: any[],
    plannedPayments: any[]
): { total: number, items: FixedExpense[] } {
    console.log('--- Fixed Expenses Debug ---')
    console.log(`Subscriptions: ${subscriptions?.length || 0}`)
    console.log(`Bills: ${bills?.length || 0}`)
    console.log(`Debts: ${debts?.length || 0}`)
    console.log(`Planned Payments: ${plannedPayments?.length || 0}`)

    const items: FixedExpense[] = []

    // 1. Active subscriptions (authoritative source)
    subscriptions.forEach(sub => {
        const amount = (sub.amount_cents || 0) / 100
        if (amount > 0) {
            // Convert to monthly amount
            let monthlyAmount = amount
            if (sub.billing_cycle === 'YEARLY') {
                monthlyAmount = amount / 12
            } else if (sub.billing_cycle === 'WEEKLY') {
                monthlyAmount = amount * 4.33 // Average weeks per month
            }

            items.push({
                name: sub.name || 'Subscription',
                amount: monthlyAmount,
                category: 'Subscription',
                source: 'subscription'
            })
        }
    })

    // 2. Active bills (authoritative source)
    bills.forEach(bill => {
        const amount = (bill.amount_cents || 0) / 100
        if (amount > 0) {
            items.push({
                name: bill.name || 'Bill',
                amount,
                category: bill.category || 'Bill',
                source: 'bill'
            })
        }
    })

    // 3. Debt minimum payments (authoritative source)
    debts.forEach(debt => {
        const minPayment = asNumber(debt.minimum_payment_cents) / 100
        if (minPayment > 0) {
            items.push({
                name: debt.name || 'Debt Payment',
                amount: minPayment,
                category: 'Debt Payment',
                source: 'debt'
            })
        }
    })

    // 4. Planned payments (recurring only!)
    plannedPayments.forEach(payment => {
        if (payment.is_recurring) {
            const amount = asNumber(payment.amount_cents) / 100
            if (amount > 0) {
                items.push({
                    name: payment.name || 'Planned Payment',
                    amount,
                    category: payment.category || 'Payment',
                    source: 'bill'
                })
            }
        }
    })

    // Excluded: Fixed expenses from transactions (e.g. 'mortgage (tx)') have been removed based on the latest specification. 
    // Fixed payments are strictly from authoritative sources (Subscriptions, Bills, Debts, Recurring Planned Payments).

    const total = items.reduce((sum, item) => sum + item.amount, 0)

    console.log(`Total fixed items mapped: ${items.length}`)
    console.log(`Final Fixed Total: $${total}`)

    return { total, items }
}

/**
 * Analyze variable expenses (everything not fixed)
 */
function analyzeVariableExpenses(
    transactions: any[],
    fixedItems: FixedExpense[],
    windowStart: Date,
    windowEnd: Date
): { total: number, categories: { [key: string]: number }, categoryStates: { [key: string]: EssentialState } } {
    // Get fixed categories to exclude
    const fixedCategories = new Set(fixedItems.map(item => item.category.toLowerCase()))

    const categories: { [key: string]: number } = {}
    const categoryStates: { [key: string]: EssentialState } = {}
    for (const t of transactions) {
        if (asNumber(t?.amount) >= 0) continue
        const txDate = new Date(t?.date)
        if (Number.isNaN(txDate.getTime()) || txDate < windowStart || txDate >= windowEnd) continue

        const categoryLower = String(t?.category || '').toLowerCase()
        if (TRANSFER_CATEGORIES.some(transfer => categoryLower.includes(transfer))) continue
        if (fixedCategories.has(categoryLower)) continue

        const category = t.category || 'Other'
        const amount = Math.abs(asNumber(t.amount))
        categories[category] = (categories[category] || 0) + amount

        const incomingState = getEssentialStateFromCategoryMeta(getRelatedCategoryRecord(t))
        const currentState = categoryStates[category] || 'unknown'
        categoryStates[category] = mergeEssentialState(currentState, incomingState)
    }

    const total = Object.values(categories).reduce((sum, amount) => sum + amount, 0)

    return { total, categories, categoryStates }
}


