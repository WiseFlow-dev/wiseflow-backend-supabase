import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
    normalizeCurrencyCode,
    normalizeTransactionsToMainCurrency,
    resolveMainCurrencyCode
} from '../_shared/currencyReporting.ts'

// Badge XP rewards
const BADGE_XP_MAP: Record<string, number> = {
    first_save: 100,
    savings_champion: 200,
    growth_streak: 250,
    budget_master: 150,
    category_champion: 150,
    downtrend_legend: 200,
    challenge_starter: 100,
    streak_master: 200,
    triple_threat: 250,
    no_spend_week: 150,
    steady_eddie: 200,
    month_mastery: 300
}

// FIX #2: Defensive numeric parsing helper
// Supabase can return numeric/decimal as string - parse defensively
function toNumber(v: unknown): number {
    const n = Number.parseFloat(String(v))
    return Number.isFinite(n) ? n : 0
}

function toNullableNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null
    const raw = String(v).trim()
    if (!raw) return null
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : null
}

function valueOrFallback(v: unknown, fallback: number): number {
    const parsed = toNullableNumber(v)
    return parsed === null ? fallback : parsed
}

function readFlag(name: string, defaultValue = false): boolean {
    const raw = String(Deno.env.get(name) || '').trim().toLowerCase()
    if (!raw) return defaultValue
    return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

const WISEY_COMPARISON_CARDS_REBUILD_FLAG = 'USE_WISEY_COMPARISON_CARDS_REBUILD'
const WISEY_COMPARISON_CARDS_REBUILD_MIN_PEERS_OVERRIDE_FLAG = 'WISEY_COMPARISON_CARDS_REBUILD_MIN_PEERS_OVERRIDE'
export const WISEY_COMPARISON_CARDS_REBUILD_MIN_PEERS = 25
export const READ_THROUGH_RECOMPUTE_BACKOFF_MS = 6 * 60 * 60 * 1000

function isWiseyComparisonCardsRebuildEnabled(): boolean {
    return readFlag(WISEY_COMPARISON_CARDS_REBUILD_FLAG, false)
}

function getWiseyComparisonCardsRebuildMinPeers(): number {
    const raw = String(Deno.env.get(WISEY_COMPARISON_CARDS_REBUILD_MIN_PEERS_OVERRIDE_FLAG) || '').trim()
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
        return WISEY_COMPARISON_CARDS_REBUILD_MIN_PEERS
    }
    return parsed
}

type RebuiltComparisonMetricId =
    | 'savings_rate'
    | 'spending_control'
    | 'weekend_spend_share'

type RebuiltComparisonMetricAvailability = Record<RebuiltComparisonMetricId, boolean>

type RebuiltComparisonSelfRow = {
    savings_ratio?: unknown
    spending_ratio?: unknown
    weekend_ratio?: unknown
}

type RebuiltComparisonPeerStats = {
    median_savings_ratio?: unknown
    median_spending_ratio?: unknown
    median_weekend_ratio?: unknown
}

type DirtyQueueAttemptRow = {
    last_attempt_at?: unknown
}

function defaultComparisonMetricAvailability(): RebuiltComparisonMetricAvailability {
    return {
        savings_rate: true,
        spending_control: true,
        weekend_spend_share: true
    }
}

function formatComparisonMetricPercent(value: unknown): number | null {
    const parsed = toNullableNumber(value)
    if (parsed === null) return null
    return Number((parsed * 100).toFixed(1))
}

function buildPercentagePointComparisonText(
    differencePoints: number,
    positiveCopy: string,
    negativeCopy: string
): string {
    const rounded = Math.abs(differencePoints).toFixed(0)
    return differencePoints >= 0
        ? `${rounded} pts ${positiveCopy}`
        : `${rounded} pts ${negativeCopy}`
}

export function buildRebuiltComparisonCards(params: {
    selfRow: RebuiltComparisonSelfRow
    peerStats: RebuiltComparisonPeerStats | null
    metricAvailability?: Partial<RebuiltComparisonMetricAvailability>
}): {
    cards: any[]
    metricAvailability: RebuiltComparisonMetricAvailability
} {
    const availability: RebuiltComparisonMetricAvailability = {
        ...defaultComparisonMetricAvailability(),
        ...(params.metricAvailability || {})
    }
    const peerStats = params.peerStats || {}
    const cards: any[] = []

    const savingsSelf = toNullableNumber(params.selfRow?.savings_ratio)
    const savingsPeer = toNullableNumber(peerStats.median_savings_ratio)
    if (availability.savings_rate && savingsSelf !== null && savingsPeer !== null) {
        const diffPoints = (savingsSelf - savingsPeer) * 100
        cards.push({
            id: 'savings_rate',
            emoji: '💰',
            title: 'Savings Rate',
            your_value: formatComparisonMetricPercent(savingsSelf),
            peer_average: formatComparisonMetricPercent(savingsPeer),
            percentile: null,
            result_text: buildPercentagePointComparisonText(
                diffPoints,
                'above peers',
                'below peers'
            ),
            is_positive: diffPoints >= 0,
            has_peer_data: true
        })
    }

    const spendingSelf = toNullableNumber(params.selfRow?.spending_ratio)
    const spendingPeer = toNullableNumber(peerStats.median_spending_ratio)
    if (availability.spending_control && spendingSelf !== null && spendingPeer !== null) {
        const diffPoints = (spendingPeer - spendingSelf) * 100
        cards.push({
            id: 'spending_control',
            emoji: '🧭',
            title: 'Spending Control',
            your_value: formatComparisonMetricPercent(spendingSelf),
            peer_average: formatComparisonMetricPercent(spendingPeer),
            percentile: null,
            result_text: buildPercentagePointComparisonText(
                diffPoints,
                'lower than peers',
                'higher than peers'
            ),
            is_positive: diffPoints >= 0,
            has_peer_data: true
        })
    }

    const weekendSelf = toNullableNumber(params.selfRow?.weekend_ratio)
    const weekendPeer = toNullableNumber(peerStats.median_weekend_ratio)
    if (availability.weekend_spend_share && weekendSelf !== null && weekendPeer !== null) {
        const diffPoints = (weekendPeer - weekendSelf) * 100
        cards.push({
            id: 'weekend_spend_share',
            emoji: '🗓️',
            title: 'Weekend Spend Share',
            your_value: formatComparisonMetricPercent(weekendSelf),
            peer_average: formatComparisonMetricPercent(weekendPeer),
            percentile: null,
            result_text: buildPercentagePointComparisonText(
                diffPoints,
                'lower than peers',
                'higher than peers'
            ),
            is_positive: diffPoints >= 0,
            has_peer_data: true
        })
    }

    return {
        cards,
        metricAvailability: availability
    }
}

type ComparisonCardsSectionState = 'legacy' | 'ready' | 'no_completed_cycle' | 'sparse_cohort'

function buildComparisonCardsMeta(params: {
    state: ComparisonCardsSectionState
    featureEnabled: boolean
    peerCount?: number
    minPeerCount?: number
    peerBandLabel?: string | null
    cycleStart?: string | null
    cycleEnd?: string | null
    usedIncomeBandWidening?: boolean
    usedAdjacentMonthWidening?: boolean
    metricAvailability?: Partial<RebuiltComparisonMetricAvailability>
}): any {
    return {
        state: params.state,
        feature_enabled: params.featureEnabled,
        peer_count: params.peerCount ?? 0,
        min_peer_count: params.minPeerCount ?? 0,
        peer_band_label: params.peerBandLabel ?? null,
        cycle_start: params.cycleStart ?? null,
        cycle_end: params.cycleEnd ?? null,
        used_income_band_widening: params.usedIncomeBandWidening ?? false,
        used_adjacent_month_widening: params.usedAdjacentMonthWidening ?? false,
        metric_availability: {
            ...defaultComparisonMetricAvailability(),
            ...(params.metricAvailability || {})
        }
    }
}

function buildLegacyComparisonCardsMeta(): any {
    return buildComparisonCardsMeta({
        state: 'legacy',
        featureEnabled: false
    })
}

function buildComparisonMetricAvailabilityFromPeerCohort(peerData: any): RebuiltComparisonMetricAvailability {
    return {
        savings_rate: peerData?.savings_rate_available === true,
        spending_control: peerData?.spending_control_available === true,
        weekend_spend_share: peerData?.weekend_spend_share_available === true
    }
}

function getCurrentUtcDateOnly(): string {
    return new Date().toISOString().slice(0, 10)
}

function toTimestampMs(value: unknown): number | null {
    if (typeof value !== 'string' || !value.trim()) return null
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
}

export function shouldAttemptReadThroughRecompute(params: {
    hasStoredRow: boolean
    dirtyRows: DirtyQueueAttemptRow[]
    nowMs?: number
}): boolean {
    const dirtyRows = Array.isArray(params.dirtyRows) ? params.dirtyRows : []
    if (!params.hasStoredRow && dirtyRows.length === 0) {
        return true
    }

    if (dirtyRows.length === 0) {
        return false
    }

    const nowMs = params.nowMs ?? Date.now()
    return dirtyRows.some((row) => {
        const lastAttemptMs = toTimestampMs(row?.last_attempt_at)
        if (lastAttemptMs === null) return true
        return nowMs - lastAttemptMs >= READ_THROUGH_RECOMPUTE_BACKOFF_MS
    })
}

function computeBucketMonthForCycleWindow(cycleStartDate: string, cycleEndDate: string): string {
    const startMs = new Date(`${cycleStartDate}T00:00:00Z`).getTime()
    const endMs = new Date(`${cycleEndDate}T00:00:00Z`).getTime()
    const midpoint = new Date(Math.round((startMs + endMs) / 2))
    return `${midpoint.getUTCFullYear()}-${String(midpoint.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function computeLatestCompletedCycleWindowForDate(referenceDateOnly: string, cycleStartDay: number): {
    cycleStartDate: string
    cycleEndDate: string
    bucketMonth: string
} {
    const currentCycleStart = getCycleStartDateForAnchor(referenceDateOnly, cycleStartDay)
    const cycleEndDate = addDaysToDateOnly(currentCycleStart, -1)
    const cycleStartDate = getCycleStartDateForAnchor(cycleEndDate, cycleStartDay)
    return {
        cycleStartDate,
        cycleEndDate,
        bucketMonth: computeBucketMonthForCycleWindow(cycleStartDate, cycleEndDate)
    }
}

function computeLatestCompletedCycleWindow(cycleStartDay: number): {
    cycleStartDate: string
    cycleEndDate: string
    bucketMonth: string
} {
    return computeLatestCompletedCycleWindowForDate(getCurrentUtcDateOnly(), cycleStartDay)
}

async function getLatestCompletedCycleScoreForComparison(
    supabaseAdmin: any,
    userId: string,
    cycleStartDay: number
): Promise<{
    row: any | null
    cycleStartDate: string
    cycleEndDate: string
}> {
    const latestWindow = computeLatestCompletedCycleWindow(cycleStartDay)

    const fetchRow = async () => {
        const { data } = await supabaseAdmin
            .from('user_cycle_scores')
            .select('cycle_start_date, cycle_end_date, bucket_month, income_anchor_normalized, savings_ratio, spending_ratio, weekend_ratio, calculated_at')
            .eq('user_id', userId)
            .eq('cycle_start_date', latestWindow.cycleStartDate)
            .eq('cycle_end_date', latestWindow.cycleEndDate)
            .maybeSingle()

        return data || null
    }

    let cycleRow = await fetchRow()
    const { data: dirtyRows } = await supabaseAdmin
        .from('wisey_cycle_dirty_queue')
        .select('affected_date, last_attempt_at')
        .eq('user_id', userId)
        .gte('affected_date', latestWindow.cycleStartDate)
        .lte('affected_date', latestWindow.cycleEndDate)
        .limit(32)

    const dirtyQueueRows = Array.isArray(dirtyRows) ? dirtyRows : []
    const shouldAttemptRecompute = shouldAttemptReadThroughRecompute({
        hasStoredRow: Boolean(cycleRow),
        dirtyRows: dirtyQueueRows
    })

    if (shouldAttemptRecompute) {
        const refreshReason = !cycleRow ? 'read_through_missing' : 'read_through_stale'
        const { data: recomputeData, error: recomputeError } = await supabaseAdmin.rpc('recompute_wisey_cycle_score', {
            p_user_id: userId,
            p_cycle_start_date: latestWindow.cycleStartDate,
            p_cycle_end_date: latestWindow.cycleEndDate,
            p_refresh_reason: refreshReason
        })

        if (recomputeError) {
            console.warn(`[ComparisonCardsV2] read-through recompute failed user=${userId} reason=${refreshReason} error=${recomputeError.message}`)
        } else {
            const recomputeStatus = Array.isArray(recomputeData) ? recomputeData[0]?.status : recomputeData?.status
            if (typeof recomputeStatus === 'string' && recomputeStatus) {
                console.log(`[ComparisonCardsV2] read-through recompute status user=${userId} reason=${refreshReason} status=${recomputeStatus}`)
            }
        }

        cycleRow = await fetchRow()
    } else if (dirtyQueueRows.length > 0) {
        console.log(`[ComparisonCardsV2] read-through recompute throttled user=${userId} cycle_start=${latestWindow.cycleStartDate} cycle_end=${latestWindow.cycleEndDate}`)
    }

    return {
        row: cycleRow,
        cycleStartDate: latestWindow.cycleStartDate,
        cycleEndDate: latestWindow.cycleEndDate
    }
}

async function buildRebuiltComparisonCardsSection(
    supabaseAdmin: any,
    userId: string,
    cycleStartDay: number
): Promise<{
    cards: any[]
    meta: any
}> {
    const minPeerCount = getWiseyComparisonCardsRebuildMinPeers()
    const completedCycle = await getLatestCompletedCycleScoreForComparison(
        supabaseAdmin,
        userId,
        cycleStartDay
    )

    if (!completedCycle.row) {
        return {
            cards: [],
            meta: buildComparisonCardsMeta({
                state: 'no_completed_cycle',
                featureEnabled: true,
                minPeerCount,
                cycleStart: completedCycle.cycleStartDate,
                cycleEnd: completedCycle.cycleEndDate
            })
        }
    }

    const { data: peerCohort, error: peerCohortError } = await supabaseAdmin
        .rpc('get_wisey_comparison_peer_cohort', {
            p_user_id: userId,
            p_bucket_month: completedCycle.row.bucket_month || completedCycle.cycleStartDate,
            p_income_anchor_usd: completedCycle.row.income_anchor_normalized,
            p_min_peer_count: minPeerCount
        })
        .single()

    if (peerCohortError || !peerCohort) {
        console.warn(`[ComparisonCardsV2] cohort lookup failed user=${userId} error=${peerCohortError?.message || 'unknown'}`)
        return {
            cards: [],
            meta: buildComparisonCardsMeta({
                state: 'sparse_cohort',
                featureEnabled: true,
                minPeerCount,
                cycleStart: completedCycle.row.cycle_start_date,
                cycleEnd: completedCycle.row.cycle_end_date
            })
        }
    }

    const metricAvailability = buildComparisonMetricAvailabilityFromPeerCohort(peerCohort)
    const rebuiltCards = buildRebuiltComparisonCards({
        selfRow: completedCycle.row,
        peerStats: peerCohort,
        metricAvailability
    })

    const hasRenderableCards = rebuiltCards.cards.length > 0
    return {
        cards: rebuiltCards.cards,
        meta: buildComparisonCardsMeta({
            state: hasRenderableCards ? 'ready' : 'sparse_cohort',
            featureEnabled: true,
            peerCount: peerCohort.peer_count ?? 0,
            minPeerCount,
            peerBandLabel: peerCohort.peer_band_label ?? null,
            cycleStart: completedCycle.row.cycle_start_date,
            cycleEnd: completedCycle.row.cycle_end_date,
            usedIncomeBandWidening: peerCohort.used_income_band_widening === true,
            usedAdjacentMonthWidening: peerCohort.used_adjacent_month_widening === true,
            metricAvailability
        })
    }
}

function userHasProAccess(user: unknown): boolean {
    const u = (user ?? {}) as Record<string, unknown>
    // Only app_metadata is trustworthy: it can only be written server-side.
    // user_metadata is editable by the user via the auth API, so it must never
    // be used for entitlement checks.
    const appMeta = (u['app_metadata'] ?? {}) as Record<string, unknown>
    const asLower = (value: unknown): string => String(value ?? '').trim().toLowerCase()

    const truthyFlag = (value: unknown): boolean =>
        value === true || asLower(value) === 'true' || asLower(value) === '1'
    if (
        truthyFlag(appMeta['is_pro']) ||
        truthyFlag(appMeta['pro'])
    ) {
        return true
    }

    const planCandidates = [
        appMeta['plan'],
        appMeta['tier'],
        appMeta['subscription_tier'],
        appMeta['subscription_plan'],
    ]
        .map(asLower)
        .filter(Boolean)

    return planCandidates.some((value) =>
        value === 'pro' ||
        value === 'premium' ||
        value === 'paid' ||
        value.startsWith('pro_') ||
        value.startsWith('premium_')
    )
}

if (import.meta.main) {
serve(async (req) => {
    // Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET',
                'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
            }
        })
    }

    try {
        // Extract month from either:
        // - Query string: /wisey-analytics?month=2025-12
        // - Path suffix:  /wisey-analytics/2025-12
        const url = new URL(req.url)
        const monthParam = url.searchParams.get('month')
        const digestTimeZone = normalizeTimeZone(url.searchParams.get('timezone'))
        const locale = normalizeWiseyAnalyticsLocale(url.searchParams.get('locale'))
        const pathParts = url.pathname.split('/').filter(Boolean)
        const lastPart = pathParts[pathParts.length - 1] || ''
        const month = monthParam || (/^\d{4}-\d{2}$/.test(lastPart) ? lastPart : getCurrentMonth())

        // Validate month format (YYYY-MM)
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return new Response(JSON.stringify({ error: 'Invalid month format. Use YYYY-MM' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

        // Compute month boundaries for filtering
        const monthStart = `${month}-01T00:00:00Z`
        const monthEnd = getNextMonth(month) + '-01T00:00:00Z'
        const monthDateStart = `${month}-01`
        const monthDateEndExclusive = getNextMonth(month) + '-01'

        // Get user from JWT (NEVER from request)
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

        // User-scoped client (for reads)
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        )

        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }
        if (!userHasProAccess(user)) {
            return new Response(JSON.stringify({
                error: 'pro_required',
                message: 'Wisey Analytics is Pro only.'
            }), {
                status: 403,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

        const userId = user.id

        const mainCurrencyCode = await resolveWiseyAnalyticsMainCurrency(supabase, userId, req)

        // Service role client (for writes AND analytics_user_monthly_stats reads - Fix #5)
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )
        const cycleStartDay = await getUserCycleStartDay(supabase, userId)
        const useComparisonCardsRebuild = isWiseyComparisonCardsRebuildEnabled()
        const digestWindow = getWeeklyDigestWindow(digestTimeZone, month, cycleStartDay)
        // Extend window back an extra 7 days so computeWeeklyDigest has the prior
        // comparison week (digest week − 14 days) available for week-over-week deltas.
        const priorComparisonWeekStartIso = new Date(
            new Date(digestWindow.previousWeekStartIso).getTime() - 7 * 24 * 60 * 60 * 1000
        ).toISOString()
        const cycleStartParts = parseDateOnly(digestWindow.cycleStartDate)
        const cycleEndNextParts = parseDateOnly(addDaysToDateOnly(digestWindow.cycleEndDate, 1))
        const cycleStartIso = zonedDateTimeToUtc(cycleStartParts.year, cycleStartParts.month, cycleStartParts.day, 0, 0, 0, digestTimeZone).toISOString()
        const cycleEndExclusiveIso = zonedDateTimeToUtc(cycleEndNextParts.year, cycleEndNextParts.month, cycleEndNextParts.day, 0, 0, 0, digestTimeZone).toISOString()
        const analyticsWindowStart = getEarlierIso(getEarlierIso(monthStart, priorComparisonWeekStartIso), cycleStartIso)
        const analyticsWindowEnd = getLaterIso(getLaterIso(monthEnd, digestWindow.currentWeekEndExclusiveIso), cycleEndExclusiveIso)
        const { data: analyticsTxns, error: analyticsTxnsError } = await supabase
            .from('wallet_transactions')
            .select('*')
            .eq('user_id', userId)
            .gte('date', analyticsWindowStart)
            .lt('date', analyticsWindowEnd)

        if (analyticsTxnsError) throw new Error('Failed to fetch transactions')

        const allAnalyticsTxns = await normalizeAnalyticsTransactionsToMainCurrency(
            supabase,
            userId,
            mainCurrencyCode,
            Array.isArray(analyticsTxns) ? analyticsTxns : []
        )
        const txns = filterTransactionsByIsoRange(allAnalyticsTxns, monthStart, monthEnd)
        const cycleTxns = filterTransactionsByIsoRange(allAnalyticsTxns, cycleStartIso, cycleEndExclusiveIso)
        const cycleIncome = calculateIncome(cycleTxns)
        const { data: whatIfCategories } = await supabaseAdmin
            .from('categories')
            .select('id,name,is_income,is_fixed_obligation,user_id')
            .or(`user_id.is.null,user_id.eq.${userId}`)
        const whatIfCategoryIndex = buildWhatIfCategoryIndex(whatIfCategories || [])

        // Check if already calculated for this month (idempotency)
        const { data: existingScore } = await supabase
            .from('user_monthly_scores')
            .select('*')
            .eq('user_id', userId)
            .eq('month', month)
            .maybeSingle()


        if (existingScore) {
            const { data: xpData } = await supabase
                .from('user_xp_progress')
                .select('current_streak_days')
                .eq('user_id', userId)
                .maybeSingle()

            const personality = await getPersonalityFromHistory(
                supabase,
                userId,
                month,
                xpData?.current_streak_days || 0
            )

            const netSavings = await calculateSavingsWalletChange(supabase, userId, monthStart, monthEnd)
            const comparisonCardsPayload = useComparisonCardsRebuild
                ? await buildRebuiltComparisonCardsSection(supabaseAdmin, userId, cycleStartDay)
                : {
                    cards: buildComparisonCards(
                        txns,
                        await getPeerRankings(supabaseAdmin, supabase, userId, month, cycleStartDay),
                        netSavings
                    ),
                    meta: buildLegacyComparisonCardsMeta()
                }
            const calendar = computeDailyCalendar(
                cycleTxns,
                digestWindow.cycleStartDate,
                digestWindow.cycleEndDate,
                cycleIncome
            )
            const weeklyDigest = await computeWeeklyDigest(supabase, userId, mainCurrencyCode, digestTimeZone, month, locale, {
                cycleStartDay,
                window: digestWindow,
                txns: allAnalyticsTxns
            })
            const obligationSignal = await getWeeklyObligationCoverage(
                supabase,
                userId,
                mainCurrencyCode,
                digestWindow,
                cycleStartDay
            )


            // V2 FIX: Recalculate dynamic weights for cached path
            const [{ data: allGoals }, { data: wallets }, rawUpcomingBills] = await Promise.all([
                supabase
                    .from('goals')
                    .select('*')
                    .eq('user_id', userId),
                supabase
                    .from('wallets')
                    .select('*')
                    .eq('user_id', userId),
                fetchWhatIfUpcomingBills(supabase, userId, monthDateStart, monthDateEndExclusive)
            ])
            const upcomingBills = await normalizeUpcomingBillsToMainCurrency(
                supabase,
                userId,
                mainCurrencyCode,
                rawUpcomingBills || []
            )

            const goalsResult = await calculateGoalsHealthV2(supabase, userId, monthStart, monthEnd)
            const challengesResult = await calculateChallengeScoreV2(supabase, userId, allGoals || [], monthStart, monthEnd)
            const weights = calculateDynamicWeights(goalsResult.hasGoals, challengesResult.hasWiseyChallenges)
            const whatIfScenariosRaw = await buildWhatIfScenarios({
                txns: allAnalyticsTxns,
                goals: allGoals || [],
                wallets: wallets || [],
                upcomingBills: upcomingBills || [],
                obligationSignal,
                categoryIndex: whatIfCategoryIndex,
                currencyCode: mainCurrencyCode,
                locale
            })
            const whatIfScenariosGated = await applyWhatIfScenarioAIGating(whatIfScenariosRaw, allAnalyticsTxns, whatIfCategoryIndex)
            const whatIfScenarios = await applyWhatIfEditorialRanking(whatIfScenariosGated)

            const breakdown: any[] = [
                {
                    name: 'Savings Rate',
                    score: toNumber(existingScore.savings_rate_score),
                    weight: weights.savings,
                    emoji: '💰'
                },
                {
                    name: 'Spending Consistency',
                    score: toNumber(existingScore.consistency_score),
                    weight: weights.consistency,
                    emoji: '📊'
                }
            ]

            if (weights.goals > 0) {
                breakdown.push({
                    name: 'Goals Health',
                    score: Number(goalsResult.score.toFixed(1)),
                    weight: weights.goals,
                    emoji: '🎯'
                })
            }

            if (weights.challenges > 0) {
                breakdown.push({
                    name: 'Challenges',
                    score: Number(challengesResult.score.toFixed(1)),
                    weight: weights.challenges,
                    emoji: '🏆'
                })
            }

            // Cached-path fix: total_wisey_score can be stale (schema/weight changes).
            // Recompute total from the same KPI scores + weights we return.
            const recomputedTotal = breakdown.reduce((sum, k: any) => {
                return sum + (toNumber(k.score) * toNumber(k.weight))
            }, 0)
            const roundedTotal = Number(recomputedTotal.toFixed(1))

            // Best-effort: keep stored monthly score aligned (avoid repeated writes).
            const income = calculateIncome(txns)

            // savings_rate_v2 remains score-only; peer cards now use stored cycle rows.
            const savingsRateV2 = income > 0 ? netSavings / income : 0

            await supabaseAdmin
                .from('user_monthly_scores')
                .update({
                    total_wisey_score: roundedTotal,
                    challenge_score: challengesResult.score,
                    savings_rate_v2: savingsRateV2
                })
                .eq('user_id', userId)
                .eq('month', month)

            return new Response(JSON.stringify({
                wisey_score: {
                    version: 2,
                    total: roundedTotal,
                    breakdown: breakdown
                },
                spending_personality: personality,
                weekly_digest: weeklyDigest,
                what_if_scenarios: whatIfScenarios,
                comparison_cards: comparisonCardsPayload.cards,
                comparison_cards_meta: comparisonCardsPayload.meta,
                quick_stats: computeQuickStats(
                    cycleTxns,
                    digestWindow.cycleStartDate,
                    digestWindow.cycleEndDate
                ),
                daily_calendar: calendar,
                is_cached: true,
                is_new_user: false
            }), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

        // New user still gets full cycle calendar with all days as "none"
        // Lowered threshold from 5 to 2 so comparison cards show sooner
        if (!txns || txns.length < 2) {
            // Fetch XP streak for new users (they may still have a streak!)
            const { data: xpData } = await supabase
                .from('user_xp_progress')
                .select('current_streak_days')
                .eq('user_id', userId)
                .maybeSingle()

            return new Response(JSON.stringify({
                wisey_score: buildNewUserScore(),
                spending_personality: {
                    type: 'explorer',
                    emoji: '🌱',
                    title: 'The Explorer',
                    description: 'Welcome to WiseFlow! You\'re just getting started on your financial journey. Keep tracking to unlock your true personality!',
                    streak_days: xpData?.current_streak_days || 0  // Real XP streak
                },
                weekly_digest: null,
                what_if_scenarios: [],
                comparison_cards: [],
                comparison_cards_meta: useComparisonCardsRebuild
                    ? buildComparisonCardsMeta({
                        state: 'no_completed_cycle',
                        featureEnabled: true,
                        minPeerCount: getWiseyComparisonCardsRebuildMinPeers()
                    })
                    : buildLegacyComparisonCardsMeta(),
                quick_stats: computeQuickStats(
                    cycleTxns,
                    digestWindow.cycleStartDate,
                    digestWindow.cycleEndDate
                ),
                daily_calendar: computeDailyCalendar(
                    cycleTxns,
                    digestWindow.cycleStartDate,
                    digestWindow.cycleEndDate,
                    cycleIncome
                ),
                is_cached: false,
                is_new_user: true
            }), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

        // WISEY SCORE V2: Calculate with dynamic weights
        const income = calculateIncome(txns)
        const spent = calculateSpent(txns)
        // V2: Calculate net savings from savings wallet (used for both score + comparison)
        const netSavings = await calculateSavingsWalletChange(supabase, userId, monthStart, monthEnd)
        const rankings = await getPeerRankings(supabaseAdmin, supabase, userId, month, cycleStartDay)
        const savingsRateScore = await calculateSavingsRateScore(supabase, userId, monthStart, monthEnd, income, rankings.avgSavingsRate)
        const consistencyScore = calculateConsistencyScore(txns)


        // V2: Fetch all goals including challenges
        const [{ data: allGoals }, { data: wallets }, rawUpcomingBills] = await Promise.all([
            supabase
                .from('goals')
                .select('*')
                .eq('user_id', userId),
            supabase
                .from('wallets')
                .select('*')
                .eq('user_id', userId),
            fetchWhatIfUpcomingBills(supabase, userId, monthDateStart, monthDateEndExclusive)
        ])
        const upcomingBills = await normalizeUpcomingBillsToMainCurrency(
            supabase,
            userId,
            mainCurrencyCode,
            rawUpcomingBills || []
        )

        // V2: Calculate Goals Health and Challenges with dynamic detection
        const goalsResult = await calculateGoalsHealthV2(supabase, userId, monthStart, monthEnd)
        const challengesResult = await calculateChallengeScoreV2(supabase, userId, allGoals || [], monthStart, monthEnd)

        // V2: Dynamic weights based on what user has
        const weights = calculateDynamicWeights(goalsResult.hasGoals, challengesResult.hasWiseyChallenges)

        // V2: Calculate total score with dynamic weights
        const wiseyScore = (
            savingsRateScore * weights.savings +
            consistencyScore * weights.consistency +
            goalsResult.score * weights.goals +
            challengesResult.score * weights.challenges
        )

        // Build dynamic breakdown (only include KPIs with weight > 0)
        const breakdown: any[] = [
            {
                name: 'Savings Rate',
                score: Number(savingsRateScore.toFixed(1)),
                weight: weights.savings,
                emoji: '💰'
            },
            {
                name: 'Spending Consistency',
                score: Number(consistencyScore.toFixed(1)),
                weight: weights.consistency,
                emoji: '📊'
            }
        ]

        if (weights.goals > 0) {
            breakdown.push({
                name: 'Goals Health',
                score: Number(goalsResult.score.toFixed(1)),
                weight: weights.goals,
                emoji: '🎯'
            })
        }

        if (weights.challenges > 0) {
            breakdown.push({
                name: 'Challenges',
                score: Number(challengesResult.score.toFixed(1)),
                weight: weights.challenges,
                emoji: '🏆'
            })
        }

        // Store monthly score (service role)
        await supabaseAdmin
            .from('user_monthly_scores')
            .upsert({
                user_id: userId,
                month: month,
                savings_rate_score: savingsRateScore,
                savings_rate_v2: income > 0 ? netSavings / income : 0,
                consistency_score: consistencyScore,
                challenge_score: challengesResult.score,
                streak_score: 0,
                total_wisey_score: wiseyScore
            }, { onConflict: 'user_id,month' })

        // Calculate personality (still uses XP streak for display, not scoring)
        const { data: xpData } = await supabase
            .from('user_xp_progress')
            .select('current_streak_days')
            .eq('user_id', userId)
            .maybeSingle()

        const personality = await calculateSpendingPersonality(
            supabaseAdmin,
            userId,
            month,
            txns,
            income,
            spent,
            xpData?.current_streak_days || 0
        )
        await supabaseAdmin
            .from('spending_personality_history')
            .upsert({
                user_id: userId,
                month: month,
                personality_type: personality.type,
                month_streak_days: personality.streak_days
            }, { onConflict: 'user_id,month' })

        // Check and award badges (pass v2 metrics)
        await checkAndAwardBadges(supabaseAdmin, userId, {
            month,
            monthStart,
            monthEnd,
            txns,
            income,
            spent,
            savingsRate: income > 0 ? netSavings / income : 0,  // V2: wallet-based
            savingsRateScore,
            consistencyScore,
            challengeScore: challengesResult.score,
            streakScore: 0,
            streakDays: xpData?.current_streak_days || 0,
            challenges: []
        })

            const weeklyDigest = await computeWeeklyDigest(supabase, userId, mainCurrencyCode, digestTimeZone, month, locale, {
            cycleStartDay,
            window: digestWindow,
            txns: allAnalyticsTxns
        })
        const obligationSignal = await getWeeklyObligationCoverage(
            supabase,
            userId,
            mainCurrencyCode,
            digestWindow,
            cycleStartDay
        )
            const whatIfScenariosRaw = await buildWhatIfScenarios({
                txns: allAnalyticsTxns,
                goals: allGoals || [],
                wallets: wallets || [],
                upcomingBills: upcomingBills || [],
                obligationSignal,
                categoryIndex: whatIfCategoryIndex,
                currencyCode: mainCurrencyCode,
                locale
            })
        const whatIfScenariosGated = await applyWhatIfScenarioAIGating(whatIfScenariosRaw, allAnalyticsTxns, whatIfCategoryIndex)
        const whatIfScenarios = await applyWhatIfEditorialRanking(whatIfScenariosGated)
        const comparisonCardsPayload = useComparisonCardsRebuild
            ? await buildRebuiltComparisonCardsSection(supabaseAdmin, userId, cycleStartDay)
            : {
                cards: buildComparisonCards(txns, rankings, netSavings),
                meta: buildLegacyComparisonCardsMeta()
            }

        // Build V2 response
        return new Response(JSON.stringify({
            wisey_score: {
                version: 2,
                total: Number(wiseyScore.toFixed(1)),
                breakdown: breakdown
            },
            spending_personality: personality,
            weekly_digest: weeklyDigest,
            what_if_scenarios: whatIfScenarios,
            comparison_cards: comparisonCardsPayload.cards,
            comparison_cards_meta: comparisonCardsPayload.meta,
            quick_stats: computeQuickStats(
                cycleTxns,
                digestWindow.cycleStartDate,
                digestWindow.cycleEndDate
            ),
            daily_calendar: computeDailyCalendar(
                cycleTxns,
                digestWindow.cycleStartDate,
                digestWindow.cycleEndDate,
                cycleIncome
            ),
            is_cached: false,
            is_new_user: false
        }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })


    } catch (error) {
        console.error('❌ Error:', error)
        return new Response(JSON.stringify({ error: (error as Error).message || 'Internal server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })
    }
})
}

// Helper functions

function getCurrentMonth(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getNextMonth(month: string): string {
    const [year, mon] = month.split('-').map(Number)
    const next = new Date(year, mon, 1)
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
}

function getPrevMonth(month: string): string {
    const [year, mon] = month.split('-').map(Number)
    const prev = new Date(year, mon - 2, 1)
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
}

function normalizeTimeZone(raw: string | null): string {
    const candidate = String(raw || '').trim()
    if (!candidate) return 'UTC'
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date())
        return candidate
    } catch {
        return 'UTC'
    }
}

function normalizeWiseyAnalyticsLocale(raw: string | null): string {
    const candidate = String(raw || 'en').trim().toLowerCase().replace('_', '-')
    const language = candidate.split('-')[0] || 'en'
    const supported = new Set([
        'en', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr', 'hu', 'id', 'in',
        'it', 'ja', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'zh'
    ])
    if (!supported.has(language)) return 'en'
    return language === 'in' ? 'id' : language
}

function localeTagForWiseyAnalytics(locale: string): string {
    const normalized = normalizeWiseyAnalyticsLocale(locale)
    const tags: Record<string, string> = {
        en: 'en-US',
        cs: 'cs-CZ',
        da: 'da-DK',
        de: 'de-DE',
        el: 'el-GR',
        es: 'es-ES',
        fi: 'fi-FI',
        fr: 'fr-FR',
        hu: 'hu-HU',
        id: 'id-ID',
        it: 'it-IT',
        ja: 'ja-JP',
        nl: 'nl-NL',
        pl: 'pl-PL',
        pt: 'pt-PT',
        ro: 'ro-RO',
        ru: 'ru-RU',
        sv: 'sv-SE',
        tr: 'tr-TR',
        uk: 'uk-UA',
        zh: 'zh-CN'
    }
    return tags[normalized] || 'en-US'
}

function wiseyAnalyticsLocaleName(locale: string): string {
    const names: Record<string, string> = {
        en: 'English',
        cs: 'Czech',
        da: 'Danish',
        de: 'German',
        el: 'Greek',
        es: 'Spanish',
        fi: 'Finnish',
        fr: 'French',
        hu: 'Hungarian',
        id: 'Indonesian',
        it: 'Italian',
        ja: 'Japanese',
        nl: 'Dutch',
        pl: 'Polish',
        pt: 'Portuguese',
        ro: 'Romanian',
        ru: 'Russian',
        sv: 'Swedish',
        tr: 'Turkish',
        uk: 'Ukrainian',
        zh: 'Chinese'
    }
    return names[normalizeWiseyAnalyticsLocale(locale)] || 'English'
}

function getEarlierIso(a: string, b: string): string {
    return new Date(a).getTime() <= new Date(b).getTime() ? a : b
}

function getLaterIso(a: string, b: string): string {
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b
}

function filterTransactionsByIsoRange(txns: any[], startIso: string, endExclusiveIso: string): any[] {
    const startMs = new Date(startIso).getTime()
    const endMs = new Date(endExclusiveIso).getTime()
    return txns.filter((tx) => {
        const ts = new Date(String(tx?.date || '')).getTime()
        return Number.isFinite(ts) && ts >= startMs && ts < endMs
    })
}

function pad2(value: number): string {
    return String(value).padStart(2, '0')
}

function formatDateOnly(year: number, month: number, day: number): string {
    return `${year}-${pad2(month)}-${pad2(day)}`
}

function parseDateOnly(dateStr: string): { year: number; month: number; day: number } {
    const [year, month, day] = dateStr.split('-').map(Number)
    return { year, month, day }
}

function addDaysToDateOnly(dateStr: string, days: number): string {
    const { year, month, day } = parseDateOnly(dateStr)
    const date = new Date(Date.UTC(year, month - 1, day))
    date.setUTCDate(date.getUTCDate() + days)
    return formatDateOnly(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function dateOnlyToUtcMs(dateStr: string): number {
    const { year, month, day } = parseDateOnly(dateStr)
    return Date.UTC(year, month - 1, day)
}

function diffDaysDateOnly(startDate: string, endDate: string): number {
    return Math.floor((dateOnlyToUtcMs(endDate) - dateOnlyToUtcMs(startDate)) / 86400000)
}

function getDaysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function resolveCycleStartDayForMonth(year: number, month: number, cycleStartDay: number): number {
    const safeCycleDay = Math.max(1, Math.min(31, Math.floor(cycleStartDay || 1)))
    return Math.min(safeCycleDay, getDaysInMonth(year, month))
}

function getCycleStartDateForAnchor(anchorDate: string, cycleStartDay: number): string {
    const anchor = parseDateOnly(anchorDate)
    const currentMonthCycleStartDay = resolveCycleStartDayForMonth(anchor.year, anchor.month, cycleStartDay)
    if (anchor.day >= currentMonthCycleStartDay) {
        return formatDateOnly(anchor.year, anchor.month, currentMonthCycleStartDay)
    }

    const previousMonthDate = addDaysToDateOnly(formatDateOnly(anchor.year, anchor.month, 1), -1)
    const previous = parseDateOnly(previousMonthDate)
    const previousMonthCycleStartDay = resolveCycleStartDayForMonth(previous.year, previous.month, cycleStartDay)
    return formatDateOnly(previous.year, previous.month, previousMonthCycleStartDay)
}

function getNextCycleStartDate(cycleStartDate: string, cycleStartDay: number): string {
    const cycleStart = parseDateOnly(cycleStartDate)
    const nextMonthFirst = addDaysToDateOnly(formatDateOnly(cycleStart.year, cycleStart.month, 1), getDaysInMonth(cycleStart.year, cycleStart.month))
    const nextMonth = parseDateOnly(nextMonthFirst)
    const nextStartDay = resolveCycleStartDayForMonth(nextMonth.year, nextMonth.month, cycleStartDay)
    return formatDateOnly(nextMonth.year, nextMonth.month, nextStartDay)
}

function getTimeZoneDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })

    const partMap = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value
        return acc
    }, {})

    return {
        year: Number(partMap.year || '0'),
        month: Number(partMap.month || '1'),
        day: Number(partMap.day || '1'),
        hour: Number(partMap.hour || '0'),
        minute: Number(partMap.minute || '0'),
        second: Number(partMap.second || '0')
    }
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
    const parts = getTimeZoneDateParts(date, timeZone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    return asUtc - date.getTime()
}

function zonedDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    const offset = getTimeZoneOffsetMs(guess, timeZone)
    return new Date(guess.getTime() - offset)
}

function getWeeklyDigestWindow(timeZone: string, month: string, cycleStartDay: number): {
    timeZone: string
    monthStartDate: string
    monthEndDate: string
    cycleStartDate: string
    cycleEndDate: string
    currentWeekStartDate: string
    currentWeekEndDate: string
    previousWeekStartDate: string
    previousWeekEndDate: string
    currentWeekStartIso: string
    currentWeekEndExclusiveIso: string
    previousWeekStartIso: string
    previousWeekEndExclusiveIso: string
} {
    const now = new Date()
    const nowParts = getTimeZoneDateParts(now, timeZone)
    const currentMonthKey = `${nowParts.year}-${pad2(nowParts.month)}`
    const requestedMonthParts = month.split('-').map(Number)
    if (requestedMonthParts.length !== 2 || !Number.isFinite(requestedMonthParts[0]) || !Number.isFinite(requestedMonthParts[1])) {
        throw new Error(`Invalid digest month: ${month}`)
    }

    const requestedYear = requestedMonthParts[0]
    const requestedMonth = requestedMonthParts[1]
    const requestedMonthLastDay = new Date(Date.UTC(requestedYear, requestedMonth, 0)).getUTCDate()
    const monthStartDate = formatDateOnly(requestedYear, requestedMonth, 1)
    const monthEndDate = formatDateOnly(requestedYear, requestedMonth, requestedMonthLastDay)
    const anchorDate = currentMonthKey === month
        ? formatDateOnly(nowParts.year, nowParts.month, nowParts.day)
        : monthEndDate
    const cycleStartDate = getCycleStartDateForAnchor(anchorDate, cycleStartDay)
    const nextCycleStartDate = getNextCycleStartDate(cycleStartDate, cycleStartDay)
    const cycleEndDate = addDaysToDateOnly(nextCycleStartDate, -1)

    const anchorParts = parseDateOnly(anchorDate)
    const anchorDayOfWeek = new Date(Date.UTC(anchorParts.year, anchorParts.month - 1, anchorParts.day)).getUTCDay()
    const daysSinceMonday = (anchorDayOfWeek + 6) % 7
    const currentWeekStartDate = addDaysToDateOnly(anchorDate, -daysSinceMonday)
    const rawCurrentWeekEndDate = addDaysToDateOnly(currentWeekStartDate, 6)
    const currentWeekEndDate = rawCurrentWeekEndDate > anchorDate ? anchorDate : rawCurrentWeekEndDate
    const previousWeekStartDate = addDaysToDateOnly(currentWeekStartDate, -7)
    const previousWeekEndDate = addDaysToDateOnly(previousWeekStartDate, 6)
    const currentWeekEndNextDate = addDaysToDateOnly(currentWeekEndDate, 1)

    const currentWeekStartParts = parseDateOnly(currentWeekStartDate)
    const currentWeekEndNextParts = parseDateOnly(currentWeekEndNextDate)
    const previousWeekStartParts = parseDateOnly(previousWeekStartDate)

    return {
        timeZone,
        monthStartDate,
        monthEndDate,
        cycleStartDate,
        cycleEndDate,
        currentWeekStartDate,
        currentWeekEndDate,
        previousWeekStartDate,
        previousWeekEndDate,
        currentWeekStartIso: zonedDateTimeToUtc(currentWeekStartParts.year, currentWeekStartParts.month, currentWeekStartParts.day, 0, 0, 0, timeZone).toISOString(),
        currentWeekEndExclusiveIso: zonedDateTimeToUtc(currentWeekEndNextParts.year, currentWeekEndNextParts.month, currentWeekEndNextParts.day, 0, 0, 0, timeZone).toISOString(),
        previousWeekStartIso: zonedDateTimeToUtc(previousWeekStartParts.year, previousWeekStartParts.month, previousWeekStartParts.day, 0, 0, 0, timeZone).toISOString(),
        previousWeekEndExclusiveIso: zonedDateTimeToUtc(currentWeekStartParts.year, currentWeekStartParts.month, currentWeekStartParts.day, 0, 0, 0, timeZone).toISOString()
    }
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
        NZD: 'NZ$',
        SGD: 'S$',
        HKD: 'HK$',
        AED: '\u062F.\u0625',
        SAR: '\uFDFC',
        QAR: '\uFDFC',
        ZAR: 'R'
    }
    return symbolMap[code] ?? code
}

function formatDigestCurrency(amount: number, currencyCode: string = 'USD', locale: string = 'en'): string {
    const roundedWhole = Math.round(Math.max(0, amount))
    const safeCurrency = normalizeCurrencyCode(currencyCode)
    const localeTag = localeTagForWiseyAnalytics(locale)
    if (!safeCurrency) {
        return new Intl.NumberFormat(localeTag, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(roundedWhole)
    }

    const fallbackSymbol = currencySymbolForCode(safeCurrency)
    if (fallbackSymbol !== safeCurrency) {
        return `${fallbackSymbol}${new Intl.NumberFormat(localeTag, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(roundedWhole)}`
    }

    try {
        const formatted = new Intl.NumberFormat(localeTag, {
            style: 'currency',
            currency: safeCurrency,
            currencyDisplay: 'narrowSymbol',
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(roundedWhole)
        if (!formatted.toUpperCase().includes(safeCurrency)) {
            return formatted
        }
    } catch {
        // Fall through to ISO-code fallback below.
    }

    return `${safeCurrency} ${new Intl.NumberFormat(localeTag, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(roundedWhole)}`
}

function formatPct(value: number, locale: string = 'en'): string {
    return new Intl.NumberFormat(localeTagForWiseyAnalytics(locale), {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(value)
}

function roundDigestAmount(amount: number): number {
    return Number(toNumber(amount).toFixed(2))
}

async function resolveWiseyAnalyticsMainCurrency(
    supabase: any,
    userId: string,
    req?: Request
): Promise<string> {
    try {
        const resolution = await resolveMainCurrencyCode(supabase, userId, {
            headerCurrency: req?.headers.get('x-main-currency')
        })
        return normalizeCurrencyCode(resolution.currency) || 'USD'
    } catch (error) {
        console.warn(`[wisey_analytics.currency_resolution_fallback] user_id=${userId} reason=${String((error as Error)?.message || error)}`)
        return 'USD'
    }
}

async function normalizeAnalyticsTransactionsToMainCurrency(
    supabase: any,
    userId: string,
    mainCurrencyCode: string,
    rows: any[]
): Promise<any[]> {
    const normalized = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        normalizeCurrencyCode(mainCurrencyCode) || 'USD',
        Array.isArray(rows) ? rows : []
    )
    console.log(`[wisey_analytics.currency_normalization_metrics] user_id=${userId} normalized_rows_used=${normalized.metrics.normalized_rows_used} temporary_converted_rows_used=${normalized.metrics.temporary_converted_rows_used} raw_same_currency_rows_used=${normalized.metrics.raw_same_currency_rows_used} rows_with_missing_reporting_fields=${normalized.metrics.rows_with_missing_reporting_fields} fx_lookup_failures=${normalized.metrics.fx_lookup_failures}`)
    return normalized.rows as any[]
}

async function normalizeUpcomingBillsToMainCurrency(
    supabase: any,
    userId: string,
    mainCurrencyCode: string,
    bills: any[]
): Promise<any[]> {
    type SyntheticBillRow = {
        id: string
        name: string
        wallet_id: string | null
        source_type: string
        source_currency: string | null
        amount: number
        reporting_amount: null
        reporting_currency: null
        date: string
        due_date: string
    }

    const sourceRows: SyntheticBillRow[] = (Array.isArray(bills) ? bills : [])
        .map((bill) => {
            const rawAmountCents = Math.round(toNumber(bill?.amount_cents || 0))
            const dueDate = String(bill?.due_date || bill?.next_billing_date || '').trim()
            if (rawAmountCents <= 0 || dueDate.length === 0) return null
            const walletIdRaw = String(bill?.wallet_id || '').trim()
            const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
            return {
                id: String(bill?.id || ''),
                name: String(bill?.name || 'a bill').trim() || 'a bill',
                wallet_id: walletId,
                source_type: String(bill?.source_type || 'bill'),
                source_currency: walletId ? null : (normalizeCurrencyCode(bill?.currency_code) || mainCurrencyCode),
                amount: rawAmountCents / 100,
                reporting_amount: null,
                reporting_currency: null,
                date: `${dueDate}T00:00:00.000Z`,
                due_date: dueDate
            }
        })
        .filter((row): row is SyntheticBillRow => Boolean(row))

    if (sourceRows.length === 0) return []

    const normalized = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        normalizeCurrencyCode(mainCurrencyCode) || 'USD',
        sourceRows
    )
    console.log(`[wisey_analytics.upcoming_bills_currency_normalization_metrics] user_id=${userId} normalized_rows_used=${normalized.metrics.normalized_rows_used} temporary_converted_rows_used=${normalized.metrics.temporary_converted_rows_used} raw_same_currency_rows_used=${normalized.metrics.raw_same_currency_rows_used} rows_with_missing_reporting_fields=${normalized.metrics.rows_with_missing_reporting_fields} fx_lookup_failures=${normalized.metrics.fx_lookup_failures}`)

    return (normalized.rows as SyntheticBillRow[])
        .map((row) => ({
            id: row.id,
            name: row.name,
            amount_cents: Math.max(0, Math.round(toNumber(row.amount) * 100)),
            due_date: row.due_date,
            wallet_id: row.wallet_id,
            source_type: String((row as any)?.source_type || 'bill')
        }))
        .filter((row) => row.amount_cents > 0)
}

async function fetchWhatIfUpcomingBills(
    supabase: any,
    userId: string,
    monthDateStart: string,
    monthDateEndExclusive: string
): Promise<any[]> {
    const [{ data: plannedPayments }, { data: bills }, { data: subscriptions }] = await Promise.all([
        supabase
            .from('planned_payments')
            .select('id,name,amount_cents,due_date,wallet_id,currency_code')
            .eq('user_id', userId)
            .eq('is_paid', false)
            .gte('due_date', monthDateStart)
            .lt('due_date', monthDateEndExclusive)
            .order('due_date', { ascending: true }),
        supabase
            .from('bills')
            .select('id,name,amount_cents,due_date,wallet_id,currency_code')
            .eq('user_id', userId)
            .eq('is_paid', false)
            .gte('due_date', monthDateStart)
            .lt('due_date', monthDateEndExclusive)
            .order('due_date', { ascending: true }),
        supabase
            .from('subscriptions')
            .select('id,name,amount_cents,next_billing_date,wallet_id,currency_code')
            .eq('user_id', userId)
            .eq('is_active', true)
            .gte('next_billing_date', monthDateStart)
            .lt('next_billing_date', monthDateEndExclusive)
            .order('next_billing_date', { ascending: true })
    ])

    const plannedRows = Array.isArray(plannedPayments) ? plannedPayments : []
    const billRows = Array.isArray(bills) ? bills : []
    const subscriptionRows = Array.isArray(subscriptions)
        ? subscriptions.map((item: any) => ({
            ...item,
            due_date: item?.next_billing_date || null,
            source_type: 'subscription'
        }))
        : []
    const typedPlannedRows = plannedRows.map((item: any) => ({ ...item, source_type: 'planned_payment' }))
    const typedBillRows = billRows.map((item: any) => ({ ...item, source_type: 'bill' }))

    return [...typedPlannedRows, ...typedBillRows, ...subscriptionRows]
}

function buildDigestStarterPrompt(params: {
    type: 'stability' | 'pressure' | 'recovery'
    scenarioCode: string
}): string {
    // Short, natural one-liners. These are what the user SEES as their chat message.
    // The full digest (numbers, drivers, bullets, best next move) still travels invisibly
    // in the handoff packet, and the DIGEST REPLY CONTRACT tells Wisey to explain + plan,
    // so the visible line does not need to carry instructions.
    switch (params.scenarioCode) {
        case 'overdue_pressure':
            return 'Walk me through why this week is under pressure and what I should do first.'
        case 'weekend_drift':
            return 'Explain what happened on the weekend and how to plan next weekend better.'
        case 'late_week_leak':
            return 'Explain why the back half of this week got heavier and how to fix it.'
        case 'essentials_creep':
            return 'Explain why essentials made this week tighter and how to plan around it.'
        case 'discretionary_leak':
            return 'Explain where my flexible spending drifted and how to tighten it.'
        case 'fixed_bill_compression':
            return 'Explain which obligations compressed this week and what I should do first.'
        case 'income_gap_pressure':
            return 'Explain why this week felt tight against my income and what to prioritize first.'
        case 'planned_large_purchase':
            return 'Explain how one big purchase shaped this week and what to watch next.'
        case 'spend_surge_pressure':
            return 'Explain why this week ran hotter than last week and how to recover.'
        case 'steady_control':
            return 'Explain what I did right this week and how to keep it going.'
        case 'recovery_after_spike':
            return 'Explain what improved this week compared with last week and how to keep that recovery going.'
        case 'mixed_but_contained':
            return 'Explain what Wisey noticed this week and what to watch first.'
        default:
            switch (params.type) {
                case 'stability':
                    return 'Explain what kept this week steady and how to keep it going.'
                case 'recovery':
                    return 'Explain what improved this week and what to keep doing next week.'
                default:
                    return 'Walk me through what happened this week and what I should do first.'
            }
    }
}

function buildWeeklyDigestChatHandoff(params: {
    type: 'stability' | 'pressure' | 'recovery'
    scenarioCode: string
    currencyCode: string
    window: { currentWeekStartDate: string; currentWeekEndDate: string }
    headline: string
    summary: string
    bullets: string[]
    nextMove: string
    confidence: number
    primaryDriver: string | null
    secondaryDriver: string | null
    proofPoints: string[]
    overdueCents: number
    fixedObligationsCents: number
    obligationCount: number
    obligationsAvailable: boolean
    obligationsCovered: boolean
    currentWeekSpend: number
    previousWeekSpend: number
    currentWeekIncome: number
    previousWeekIncome: number
    weekOverWeekSpendDeltaPct: number
    weekendSpendRatio: number
    lateWeekSpendRatio: number
    topCategory: string | null
    largestIncreaseCategory: string | null
    largestIncreaseAmount: number
    largestExpenseAmount: number
    largestExpenseLabel: string | null
    essentialsDelta: number
    discretionaryDelta: number
}) {
    const safeCurrency = normalizeCurrencyCode(params.currencyCode) || 'USD'
    return {
        handoff_version: 'v1',
        source: 'weekly_digest',
        digest_type: params.type,
        scenario_code: params.scenarioCode,
        week_start: params.window.currentWeekStartDate,
        week_end: params.window.currentWeekEndDate,
        headline: params.headline,
        summary: params.summary,
        bullets: params.bullets,
        next_move: params.nextMove,
        confidence: params.confidence,
        primary_driver: params.primaryDriver,
        secondary_driver: params.secondaryDriver,
        proof_points: params.proofPoints,
        starter_prompt: buildDigestStarterPrompt({
            type: params.type,
            scenarioCode: params.scenarioCode
        }),
        obligation_facts: {
            currency: safeCurrency,
            overdue_amount: roundDigestAmount(params.overdueCents / 100),
            fixed_obligations_amount: roundDigestAmount(params.fixedObligationsCents / 100),
            obligation_count: params.obligationCount,
            obligations_available: params.obligationsAvailable,
            obligations_covered: params.obligationsCovered
        },
        spend_facts: {
            currency: safeCurrency,
            current_week_spend: roundDigestAmount(params.currentWeekSpend),
            previous_week_spend: roundDigestAmount(params.previousWeekSpend),
            current_week_income: roundDigestAmount(params.currentWeekIncome),
            previous_week_income: roundDigestAmount(params.previousWeekIncome),
            week_over_week_spend_delta_pct: Number(params.weekOverWeekSpendDeltaPct.toFixed(4)),
            weekend_spend_ratio: Number(params.weekendSpendRatio.toFixed(4)),
            late_week_spend_ratio: Number(params.lateWeekSpendRatio.toFixed(4)),
            top_category: params.topCategory,
            largest_increase_category: params.largestIncreaseCategory,
            largest_increase_amount: roundDigestAmount(params.largestIncreaseAmount),
            largest_expense_amount: roundDigestAmount(params.largestExpenseAmount),
            largest_expense_label: params.largestExpenseLabel,
            essentials_delta: roundDigestAmount(params.essentialsDelta),
            discretionary_delta: roundDigestAmount(params.discretionaryDelta)
        }
    }
}

function humanizeCategory(category: string | null | undefined): string | null {
    const raw = String(category || '').trim()
    if (!raw) return null
    return raw
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

const DIGEST_ESSENTIAL_CATEGORY_KEYS = new Set([
    'rent',
    'mortgage',
    'groceries',
    'gas-fuel',
    'fuel',
    'public-transit',
    'transport',
    'transportation',
    'phone',
    'internet',
    'electricity',
    'water',
    'utilities',
    'health-insurance',
    'insurance',
    'medical',
    'healthcare',
    'car-maintenance',
    'childcare',
    'education',
    'property-tax'
])

const DIGEST_DISCRETIONARY_CATEGORY_KEYS = new Set([
    'restaurants',
    'fast-food',
    'food-delivery',
    'dining-out',
    'entertainment',
    'shopping',
    'clothing',
    'shoes',
    'accessories',
    'beauty-cosmetics',
    'movies-events',
    'games',
    'books-media',
    'coffee-cafes',
    'alcohol-bars',
    'travel',
    'beauty',
    'hobbies',
    'coffee',
    'gifts'
])

const DIGEST_FIXED_BILL_CATEGORY_KEYS = new Set([
    'rent',
    'mortgage',
    'property-tax',
    'home-insurance',
    'electricity',
    'water',
    'gas-heating',
    'internet',
    'phone',
    'hoa-fees',
    'car-payment',
    'car-insurance',
    'health-insurance',
    'insurance',
    'insurance-other',
    'subscriptions',
    'streaming-services',
    'memberships',
    'child-support'
])

const DIGEST_LARGE_PURCHASE_EXCLUDED_CATEGORY_KEYS = new Set([
    ...DIGEST_FIXED_BILL_CATEGORY_KEYS,
    'groceries',
    'restaurants',
    'dining-out',
    'gas-fuel',
    'fuel',
    'public-transit',
    'transport',
    'transportation',
    'parking',
    'tolls',
    'medical',
    'doctor-visits',
    'prescriptions'
])

function normalizeDigestCategoryKey(category: string | null | undefined): string {
    return String(category || '')
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-')
}

function isLegacyTransferCategory(category: string | null | undefined): boolean {
    const key = normalizeDigestCategoryKey(category)
    return key === 'transfer' || key === 'internal-transfer' || key === 'wallet-transfer' || key === 'money-transfer'
}

function isLegacyExcludedSpendingCategory(category: string | null | undefined): boolean {
    const key = normalizeDigestCategoryKey(category)
    return isLegacyTransferCategory(key) || key === 'balance-adjustment'
}

function isDigestExpense(tx: any): boolean {
    const amount = toNumber(tx?.amount)
    const categoryKey = normalizeDigestCategoryKey(tx?.category)
    return amount < 0
        && !isLegacyExcludedSpendingCategory(categoryKey)
}

function getDigestSpendByCategory(txns: any[]): Record<string, number> {
    const byCategory: Record<string, number> = {}
    for (const tx of txns) {
        if (!isDigestExpense(tx)) continue
        const amount = toNumber(tx?.amount)
        const category = String(tx?.category || '')
        const label = humanizeCategory(category) || 'Other'
        byCategory[label] = (byCategory[label] || 0) + Math.abs(amount)
    }
    return byCategory
}

function getTopSpendingCategory(txns: any[]): string | null {
    const byCategory = getDigestSpendByCategory(txns)
    const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]
    return top?.[0] || null
}

function getDigestSpendGroupTotals(txns: any[]): { essentials: number; discretionary: number; other: number } {
    const totals = {
        essentials: 0,
        discretionary: 0,
        other: 0
    }

    for (const tx of txns) {
        if (!isDigestExpense(tx)) continue
        const amount = Math.abs(toNumber(tx?.amount))
        const categoryKey = normalizeDigestCategoryKey(tx?.category)

        if (DIGEST_ESSENTIAL_CATEGORY_KEYS.has(categoryKey)) {
            totals.essentials += amount
        } else if (DIGEST_DISCRETIONARY_CATEGORY_KEYS.has(categoryKey)) {
            totals.discretionary += amount
        } else {
            totals.other += amount
        }
    }

    return totals
}

function getLargestSpendingIncrease(currentWeekTxns: any[], previousWeekTxns: any[]): { category: string | null; deltaAmount: number } {
    const currentByCategory = getDigestSpendByCategory(currentWeekTxns)
    const previousByCategory = getDigestSpendByCategory(previousWeekTxns)
    const allCategories = new Set([
        ...Object.keys(currentByCategory),
        ...Object.keys(previousByCategory)
    ])

    let bestCategory: string | null = null
    let bestDelta = 0

    for (const category of allCategories) {
        const delta = (currentByCategory[category] || 0) - (previousByCategory[category] || 0)
        if (delta > bestDelta) {
            bestDelta = delta
            bestCategory = category
        }
    }

    return {
        category: bestCategory,
        deltaAmount: bestDelta
    }
}

function getLargestExpenseTransaction(txns: any[]): {
    amount: number
    category: string | null
    categoryKey: string | null
    label: string | null
} {
    let winner: any = null
    let winnerAmount = 0

    for (const tx of txns) {
        if (!isDigestExpense(tx)) continue
        const amount = Math.abs(toNumber(tx?.amount))
        if (amount > winnerAmount) {
            winnerAmount = amount
            winner = tx
        }
    }

    if (!winner || winnerAmount <= 0) {
        return {
            amount: 0,
            category: null,
            categoryKey: null,
            label: null
        }
    }

    const title = String(winner?.title || '').trim()
    const note = String(winner?.note || '').trim()
    const category = humanizeCategory(winner?.category) || null
    const label = title.length >= 3 && title.length <= 40
        ? title
        : note.length >= 3 && note.length <= 40
            ? note
            : category

    return {
        amount: winnerAmount,
        category,
        categoryKey: normalizeDigestCategoryKey(winner?.category),
        label
    }
}

function getDateOnlyInTimeZone(value: unknown, timeZone: string): string | null {
    const date = new Date(String(value || ''))
    if (!Number.isFinite(date.getTime())) return null
    const parts = getTimeZoneDateParts(date, timeZone)
    return formatDateOnly(parts.year, parts.month, parts.day)
}

function calculateLateWeekRatio(
    txns: any[],
    timeZone: string,
    weekStartDate: string,
    weekEndDate: string
): number {
    const spending = txns.filter((tx) => isDigestExpense(tx))
    const totalSpending = spending.reduce((sum, tx) => sum + Math.abs(toNumber(tx?.amount)), 0)
    if (totalSpending <= 0) return 0

    const totalDays = Math.max(1, diffDaysDateOnly(weekStartDate, weekEndDate) + 1)
    const lateWindowStartDate = addDaysToDateOnly(weekStartDate, Math.floor(totalDays / 2))

    const lateSpend = spending
        .filter((tx) => {
            const localDate = getDateOnlyInTimeZone(tx?.date, timeZone)
            return Boolean(localDate) && String(localDate) >= lateWindowStartDate
        })
        .reduce((sum, tx) => sum + Math.abs(toNumber(tx?.amount)), 0)

    return lateSpend / totalSpending
}

const WHAT_IF_REJECT_CATEGORY_KEYS = new Set([
    ...DIGEST_FIXED_BILL_CATEGORY_KEYS,
    'transfer',
    'balance-adjustment',
    'credit-card-payment',
    'debt-payment',
    'loan-payment',
    'income',
    'salary',
    'payroll',
    'bank-fees',
    'tax',
    'taxes',
    'medical',
    'doctor-visits',
    'prescriptions',
    'healthcare',
    'insurance',
    'insurance-other',
    'subscriptions',
    'streaming-services',
    'memberships'
])

const WHAT_IF_DISCRETIONARY_CATEGORY_KEYS = new Set([
    'restaurants',
    'fast-food',
    'coffee-cafes',
    'coffee',
    'snacks',
    'alcohol-bars',
    'food-delivery',
    'takeout',
    'dining-out',
    'shopping',
    'clothing',
    'shoes',
    'accessories',
    'beauty-cosmetics',
    'entertainment',
    'movies-events',
    'hobbies',
    'games',
    'books-media'
])

const WHAT_IF_ESSENTIAL_FLEX_CATEGORY_KEYS = new Set([
    'groceries',
    'gas-fuel',
    'fuel',
    'pharmacy',
    'personal-care',
    'beauty',
    'household',
    'household-supplies',
    'cleaning-supplies',
    'utilities'
])

const WHAT_IF_GENERIC_MERCHANT_TOKENS = new Set([
    'debit',
    'card',
    'visa',
    'mastercard',
    'purchase',
    'payment',
    'pos',
    'checkcard',
    'check',
    'ach',
    'online',
    'store',
    'merchant',
    'order'
])

const WHAT_IF_MERCHANT_ALIAS_RULES: Array<{ pattern: RegExp; canonical: string }> = [
    { pattern: /\b(starbucks|sbux)\b/i, canonical: 'Starbucks' },
    { pattern: /\b(amazon|amzn)\b/i, canonical: 'Amazon' },
    { pattern: /\b(uber\s*eats|ubereats)\b/i, canonical: 'Uber Eats' },
    { pattern: /\b(doordash|door\s*dash)\b/i, canonical: 'DoorDash' },
    { pattern: /\b(grubhub)\b/i, canonical: 'Grubhub' },
    { pattern: /\b(instacart)\b/i, canonical: 'Instacart' },
    { pattern: /\b(costco)\b/i, canonical: 'Costco' },
    { pattern: /\b(walmart|wal-?mart)\b/i, canonical: 'Walmart' },
    { pattern: /\b(trader\s*joe'?s)\b/i, canonical: 'Trader Joes' },
    { pattern: /\b(shell|chevron|bp|petrol|opet)\b/i, canonical: 'Fuel Station' },
    { pattern: /\b(cvs|walgreens)\b/i, canonical: 'Pharmacy' }
]

const WHAT_IF_MERCHANT_NOISE_RULES: RegExp[] = [
    /\b(marketplace|mktplace|digital|prime|primevideo|video|music|kindle)\b/gi,
    /\b(payment|purchase|pending|debit|credit|pos|checkcard|online)\b/gi,
    /\b(store|market|merchant|card|visa|mastercard|ach|order)\b/gi
]

function isWhatIfExpense(tx: any, categoryIndex: Map<string, any>, preResolved?: any): boolean {
    if (!isDigestExpense(tx)) return false
    const context = preResolved || resolveWhatIfTxCategoryContext(tx, categoryIndex)
    if (!context) return false
    if (context.isIncome === true) return false
    if (context.categoryType === 'transfer' || context.categoryType === 'goal') return false
    if (context.isFixedObligation === true) return false
    const categoryKey = normalizeDigestCategoryKey(context.key)
    if (isLegacyExcludedSpendingCategory(categoryKey)) return false
    return !WHAT_IF_REJECT_CATEGORY_KEYS.has(categoryKey)
}

function normalizeCategoryNameKey(name: unknown): string {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, ' ')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
}

function buildWhatIfCategoryIndex(rows: any[]): Map<string, any> {
    const index = new Map<string, any>()
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row?.id || '').trim()
        if (!id) continue
        const key = normalizeCategoryNameKey(row?.name)
        index.set(id, {
            id,
            key,
            name: String(row?.name || '').trim(),
            isIncome: row?.is_income === true,
            categoryType: row?.is_income === true ? 'income' : 'expense',
            isFixedObligation: row?.is_fixed_obligation === true
        })
    }
    return index
}

function resolveWhatIfTxCategoryContext(tx: any, categoryIndex: Map<string, any>) {
    const categoryId = String(tx?.category_id || '').trim()
    const fromId = categoryId ? categoryIndex.get(categoryId) : null
    const fallbackKey = normalizeDigestCategoryKey(tx?.category)
    const fallbackName = humanizeCategory(tx?.category) || 'Other'

    if (fromId) {
        return {
            key: fromId.key || fallbackKey,
            name: fromId.name || fallbackName,
            isIncome: fromId.isIncome === true,
            categoryType: fromId.categoryType || null,
            isFixedObligation: fromId.isFixedObligation === true
        }
    }

    return {
        key: fallbackKey,
        name: fallbackName,
        isIncome: false,
        categoryType: null,
        isFixedObligation: false
    }
}

function normalizeWhatIfMerchantLabel(tx: any): string | null {
    const raw = String(tx?.title || tx?.note || '').trim()
    if (!raw) return null

    const lowerRaw = raw.toLowerCase()
    for (const alias of WHAT_IF_MERCHANT_ALIAS_RULES) {
        if (alias.pattern.test(lowerRaw)) return alias.canonical
    }

    let sanitized = lowerRaw
    for (const rule of WHAT_IF_MERCHANT_NOISE_RULES) {
        sanitized = sanitized.replace(rule, ' ')
    }

    const cleaned = sanitized
        .replace(/\d+/g, ' ')
        .replace(/[^a-z\s&'-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => !WHAT_IF_GENERIC_MERCHANT_TOKENS.has(token))
        .slice(0, 2)

    const joined = cleaned.join(' ').trim()
    if (joined.length < 3) return null

    return joined.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function normalizeWhatIfCategoryKey(baseCategoryKey: string, merchantName: string | null, tx: any): string {
    const merchant = String(merchantName || '').toLowerCase()
    const title = String(tx?.title || tx?.note || '').toLowerCase()
    const hint = `${merchant} ${title}`

    if (
        hint.includes('uber eats')
        || hint.includes('doordash')
        || hint.includes('grubhub')
        || hint.includes('takeout')
        || hint.includes('delivery')
    ) return 'takeout'

    if (hint.includes('starbucks') || hint.includes('coffee')) return 'coffee'
    if (hint.includes('amazon')) return 'shopping'
    if (hint.includes('grocery') || hint.includes('supermarket')) return 'groceries'
    if (hint.includes('fuel') || hint.includes('gas station') || hint.includes('petrol')) return 'gas-fuel'
    return baseCategoryKey
}

function resolveWhatIfSlot(
    categoryKey: string,
    merchantName: string | null,
    tx: any
): 'discretionary' | 'essential_flexible' | null {
    const key = normalizeDigestCategoryKey(categoryKey)
    if (!key) return null
    if (WHAT_IF_REJECT_CATEGORY_KEYS.has(key)) return null
    if (WHAT_IF_DISCRETIONARY_CATEGORY_KEYS.has(key)) return 'discretionary'
    if (WHAT_IF_ESSENTIAL_FLEX_CATEGORY_KEYS.has(key)) return 'essential_flexible'

    const hint = `${String(merchantName || '').toLowerCase()} ${String(tx?.title || tx?.note || '').toLowerCase()}`
    if (
        hint.includes('coffee')
        || hint.includes('starbucks')
        || hint.includes('takeout')
        || hint.includes('delivery')
        || hint.includes('amazon')
        || hint.includes('netflix')
        || hint.includes('spotify')
    ) return 'discretionary'

    if (
        hint.includes('grocery')
        || hint.includes('supermarket')
        || hint.includes('fuel')
        || hint.includes('gas station')
        || hint.includes('pharmacy')
        || hint.includes('personal care')
        || hint.includes('household')
    ) return 'essential_flexible'

    return null
}

function getWhatIfLookbackDays(txns: any[]): number {
    const timestamps = txns
        .map((tx) => new Date(String(tx?.date || '')).getTime())
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)

    if (timestamps.length < 2) return 30

    const diffMs = timestamps[timestamps.length - 1] - timestamps[0]
    const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000)) + 1
    return Math.max(30, Math.min(60, diffDays))
}

function getWhatIfActionUnit(categoryKey: string): string {
    const key = String(categoryKey || '')
    if (key === 'restaurants' || key === 'fast-food' || key === 'food-delivery' || key === 'takeout') return 'order'
    if (key === 'coffee-cafes' || key === 'coffee') return 'coffee run'
    if (key === 'alcohol-bars') return 'bar visit'
    if (key === 'movies-events' || key === 'entertainment') return 'outing'
    if (key === 'groceries') return 'grocery trip'
    return 'purchase'
}

function getWhatIfActionPhrase(categoryKey: string, count: number): string {
    const key = String(categoryKey || '')
    const plural = count !== 1
    switch (key) {
        case 'restaurants':
            return plural ? 'restaurant orders' : 'restaurant order'
        case 'fast-food':
            return plural ? 'fast-food meals' : 'fast-food meal'
        case 'food-delivery':
        case 'takeout':
            return plural ? 'delivery orders' : 'delivery order'
        case 'coffee-cafes':
        case 'coffee':
            return plural ? 'coffee runs' : 'coffee run'
        case 'alcohol-bars':
            return plural ? 'bar visits' : 'bar visit'
        case 'groceries':
            return plural ? 'grocery trips' : 'grocery trip'
        case 'movies-events':
            return plural ? 'movie/event tickets' : 'movie/event ticket'
        case 'hobbies':
            return plural ? 'hobby purchases' : 'hobby purchase'
        case 'games':
            return plural ? 'game purchases' : 'game purchase'
        case 'books-media':
            return plural ? 'book/media purchases' : 'book/media purchase'
        default:
            return plural ? 'purchases' : 'purchase'
    }
}

function pluralizeWhatIfUnit(unit: string, count: number): string {
    if (count === 1) return unit
    const parts = unit.split(' ')
    if (parts.length === 0) return unit
    const last = parts[parts.length - 1]
    parts[parts.length - 1] = last.endsWith('s') ? last : `${last}s`
    return parts.join(' ')
}

function roundWhatIfPercent(value: number): number {
    return Math.max(0.05, Math.min(0.35, Number(value.toFixed(2))))
}

function chooseWhatIfReductionForCandidate(
    candidate: any,
    lookbackDays: number,
    currencyCode: string = 'USD',
    locale: string = 'en'
) {
    const count = Math.max(0, Number(candidate?.count || 0))
    const averageAmount = Math.max(0, Number(candidate?.averageAmount || 0))
    const monthlyFrequency = Math.max(1, Math.round((count / Math.max(1, lookbackDays)) * 30))
    const monthlySpend = roundDigestAmount(averageAmount * monthlyFrequency)
    const slot = String(candidate?.slot || '')
    const categoryKey = String(candidate?.categoryKey || '')
    const label = String(candidate?.label || 'spending').trim()
    const lowerLabel = label.toLowerCase()
    const variability = Math.max(0, Number(candidate?.variability || 0))

    if (slot === 'essential_flexible') {
        if (variability >= 0.35 && monthlySpend >= 70) {
            const capAmount = roundDigestAmount(monthlySpend * 0.85)
            const projectedSavingsAmount = Math.max(6, roundDigestAmount(monthlySpend - capAmount))
            return {
                actionShape: 'cap',
                actionVerb: 'Cap',
                reductionLabel: `at ${formatDigestCurrency(capAmount, currencyCode, locale)} this cycle`,
                projectedSavingsAmount,
                suggestedCapAmount: capAmount
            }
        }

        const pctBase = monthlySpend >= 220 || monthlyFrequency >= 8
            ? 0.15
            : monthlySpend >= 120
                ? 0.12
                : 0.10
        const suggestedReductionPct = roundWhatIfPercent(pctBase + Math.min(0.05, variability * 0.1))
        const projectedSavingsAmount = Math.max(6, roundDigestAmount(monthlySpend * suggestedReductionPct))
        return {
            actionShape: 'trim',
            actionVerb: 'Trim',
            reductionLabel: `${lowerLabel} by ${formatDigestCurrency(projectedSavingsAmount, currencyCode, locale)} this cycle`,
            projectedSavingsAmount,
            suggestedReductionPct
        }
    }

    const pauseFriendlyCategoryKeys = new Set([
        'shopping',
        'clothing',
        'shoes',
        'accessories',
        'beauty-cosmetics',
        'books-media'
    ])
    const canPause = pauseFriendlyCategoryKeys.has(categoryKey)
    const highTicket = averageAmount >= 24
    const lowTicket = averageAmount <= 13
    const repeatsPerWeek = (count / Math.max(1, lookbackDays)) * 7

    if (canPause && highTicket && monthlyFrequency <= 3) {
        const suggestedPauseWeeks = monthlyFrequency <= 2 ? 2 : 3
        const skippedCount = Math.max(1, Math.round((monthlyFrequency / 4) * suggestedPauseWeeks))
        return {
            actionShape: 'pause',
            actionVerb: 'Pause',
            reductionLabel: `${label} for ${suggestedPauseWeeks} weeks`,
            projectedSavingsAmount: Math.max(6, roundDigestAmount(skippedCount * averageAmount)),
            suggestedPauseWeeks
        }
    }

    if ((categoryKey === 'takeout' || categoryKey === 'food-delivery' || categoryKey === 'restaurants') && repeatsPerWeek >= 1.2) {
        const suggestedSwapCount = 1
        return {
            actionShape: 'swap',
            actionVerb: 'Swap',
            reductionLabel: `${suggestedSwapCount} ${getWhatIfActionPhrase(categoryKey, suggestedSwapCount)} a week`,
            projectedSavingsAmount: Math.max(6, roundDigestAmount(averageAmount * 4 * 0.6)),
            suggestedSwapCount
        }
    }

    if (repeatsPerWeek >= 1.5 && lowTicket) {
        const suggestedReductionFrequency = Math.max(1, Math.min(3, Math.round(repeatsPerWeek * 0.35)))
        const phrase = getWhatIfActionPhrase(categoryKey, suggestedReductionFrequency)
        return {
            actionShape: 'skip',
            actionVerb: 'Skip',
            reductionLabel: `${suggestedReductionFrequency} ${phrase} a week`,
            projectedSavingsAmount: Math.max(6, roundDigestAmount(averageAmount * suggestedReductionFrequency * 4)),
            suggestedReductionFrequency
        }
    }

    const monthlySkips = Math.max(1, Math.min(4, Math.round(monthlyFrequency * 0.25)))
    const monthlyPhrase = getWhatIfActionPhrase(categoryKey, monthlySkips)
    return {
        actionShape: 'skip',
        actionVerb: 'Skip',
        reductionLabel: `${monthlySkips} ${monthlyPhrase} this month`,
        projectedSavingsAmount: Math.max(6, roundDigestAmount(averageAmount * monthlySkips)),
        suggestedReductionFrequency: monthlySkips
    }
}

function buildWhatIfTitle(candidate: any): string {
    const reduction = candidate?.reduction || {}
    const actionVerb = String(reduction.actionVerb || 'Skip')
    const reductionLabel = String(reduction.reductionLabel || '').trim()
        .replace(/\s+this (cycle|month)\s*$/i, '')  // strip time horizon — payoff line carries it
        .trim()
    if (!reductionLabel) return `${actionVerb} a small spend pattern`
    return `${actionVerb} ${reductionLabel}`.replace(/\s+/g, ' ').trim()
}

function buildWhatIfWhyItMatters(candidate: any): string {
    const count = Number(candidate?.count || 0)
    const label = String(candidate?.label || 'This pattern')
    const slot = String(candidate?.slot || '')

    if (slot === 'essential_flexible') {
        if (count >= 6) return `${label} has been moving enough to create a realistic trim opportunity.`
        return `${label} is essential, but your recent range shows room to trim without overcorrecting.`
    }

    if (count >= 7) return `${label} has become a repeat habit, so a small cut can free meaningful monthly room.`
    if (count >= 4) return `${label} kept recurring recently, which makes this a realistic behavior-level shift.`
    return `${label} showed enough pattern to make one small change worth surfacing.`
}

function scoreWhatIfCandidate(candidate: any, lookbackDays: number): number {
    const count = Math.max(0, Number(candidate?.count || 0))
    const totalAmount = Math.max(0, Number(candidate?.totalAmount || 0))
    const averageAmount = Math.max(0, Number(candidate?.averageAmount || 0))
    const weekendRatio = Math.max(0, Math.min(1, Number(candidate?.weekendRatio || 0)))
    const eveningRatio = Math.max(0, Math.min(1, Number(candidate?.eveningRatio || 0)))
    const variability = Math.max(0, Math.min(1.5, Number(candidate?.variability || 0)))
    const recencyDays = Math.max(0, Number(candidate?.recencyDays ?? 999))

    const monthlySpend = (totalAmount / Math.max(1, lookbackDays)) * 30
    const repeatScore = Math.min(1, count / 10)
    const amountScore = Math.min(1, monthlySpend / 250)
    const recencyScore = Math.max(0, 1 - (recencyDays / 45))
    const behaviorScore = candidate?.slot === 'discretionary'
        ? Math.max(weekendRatio, eveningRatio)
        : Math.min(1, variability)
    const stabilityPenalty = averageAmount > 0
        ? Math.min(0.25, Math.max(0, variability - 0.95) * 0.2)
        : 0

    const score = (
        repeatScore * 0.38 +
        amountScore * 0.26 +
        recencyScore * 0.2 +
        behaviorScore * 0.16
    ) - stabilityPenalty

    return Number(Math.max(0, Math.min(1, score)).toFixed(4))
}

// deno-lint-ignore no-explicit-any
let GOOGLE_SA_WA: any = {};
try {
    GOOGLE_SA_WA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
    console.error("[wisey-analytics] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT_WA = GOOGLE_SA_WA.project_id ?? "";
const VERTEX_REGION_WA = "global";
const GEMINI_KEYS: string[] = VERTEX_PROJECT_WA ? ['vertex_sa'] : [];

let cachedAccessTokenWA: { token: string; expiresAt: number } | null = null;

async function getAccessTokenWA(): Promise<string> {
    if (cachedAccessTokenWA && Date.now() < cachedAccessTokenWA.expiresAt) return cachedAccessTokenWA.token;
    const sa = GOOGLE_SA_WA;
    if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
    const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const b64urlBytes = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri, iat: now, exp: now + 3600 }));
    const pem = sa.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
    const keyData = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claims}`)));
    const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
    const tokenRes = await fetch(sa.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(`Service account token exchange failed: ${JSON.stringify(tokenData)}`);
    cachedAccessTokenWA = { token: tokenData.access_token, expiresAt: Date.now() + 3_300_000 };
    return tokenData.access_token;
}

async function fetchGeminiWithKeyFallback(model: string, body: Record<string, unknown>): Promise<Response | null> {
    if (!VERTEX_PROJECT_WA) return null;
    const accessToken = await getAccessTokenWA();
    const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_WA}/locations/${VERTEX_REGION_WA}/publishers/google/models/${model}:generateContent`;
    const vertexBody = { ...body } as any;
    if (vertexBody.contents && Array.isArray(vertexBody.contents)) {
        vertexBody.contents = vertexBody.contents.map((c: any) => ({ ...c, role: c.role || 'user' }));
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(vertexBody)
        })
        if (res.ok) return res
    } catch (_e) { /* network error */ }
    return null
}

function extractJsonObject(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) return fenced[1].trim()
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return text.slice(firstBrace, lastBrace + 1)
    }
    return null
}

function applyEditorialOrder(
    scenarios: any[],
    orderedIds: string[] | null | undefined,
    whyById: Record<string, string> | null | undefined
): any[] {
    const byId = new Map<string, any>(scenarios.map((item) => [String(item?.id || ''), item]))
    const used = new Set<string>()
    const ordered: any[] = []

    for (const rawId of orderedIds || []) {
        const id = String(rawId || '')
        if (!id || used.has(id)) continue
        const scenario = byId.get(id)
        if (!scenario) continue
        used.add(id)
        const why = String(whyById?.[id] || '').trim()
        if (why) scenario.why_this_matters = why
        ordered.push(scenario)
    }

    for (const scenario of scenarios) {
        const id = String(scenario?.id || '')
        if (!id || used.has(id)) continue
        ordered.push(scenario)
    }

    return ordered.slice(0, 2)
}

async function applyWhatIfEditorialRanking(scenarios: any[]): Promise<any[]> {
    const base = Array.isArray(scenarios) ? scenarios.slice(0, 2) : []
    if (base.length <= 1) return base

    if (GEMINI_KEYS.length === 0) return base

    const prompt = [
        'You are ranking financial what-if scenarios for mobile UI.',
        'Return STRICT JSON only with this schema:',
        '{"ordered_ids":["id1","id2"],"why_by_id":{"id1":"short reason","id2":"short reason"}}',
        'Rules:',
        '- Prefer realism and actionability over hype.',
        '- Preserve one per slot when possible (discretionary + essential_flexible).',
        '- Keep reasons under 100 chars.',
        '- Do not invent new ids.',
        `Input scenarios: ${JSON.stringify(base)}`
    ].join('\n')

    try {
        const response = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 350
            }
        })
        if (!response) return base

        const payload = await response.json()
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) return base
        const jsonText = extractJsonObject(String(text))
        if (!jsonText) return base

        const parsed = JSON.parse(jsonText)
        const orderedIds = Array.isArray(parsed?.ordered_ids)
            ? parsed.ordered_ids.map((id: unknown) => String(id))
            : null
        const whyById = parsed?.why_by_id && typeof parsed.why_by_id === 'object'
            ? parsed.why_by_id as Record<string, string>
            : null

        return applyEditorialOrder(base, orderedIds, whyById)
    } catch (_error) {
        return base
    }
}

async function applyWhatIfScenarioAIGating(
    scenarios: any[],
    txns: any[],
    categoryIndex: Map<string, any>
): Promise<any[]> {
    const base = Array.isArray(scenarios) ? scenarios.slice(0, 2) : []
    if (base.length === 0) return []

    if (GEMINI_KEYS.length === 0) return base

    const candidates = base.map((scenario) => {
        const merchant = String(scenario?.merchant_name || '').toLowerCase()
        const category = normalizeDigestCategoryKey(scenario?.category_key || scenario?.category_name)
        const examples = (Array.isArray(txns) ? txns : [])
            .filter((tx) => isWhatIfExpense(tx, categoryIndex))
            .filter((tx) => {
                const title = String(tx?.title || tx?.note || '').toLowerCase()
                if (merchant && title.includes(merchant)) return true
                const txCategory = resolveWhatIfTxCategoryContext(tx, categoryIndex)
                return normalizeDigestCategoryKey(txCategory.key) === category
            })
            .slice(0, 3)
            .map((tx) => ({
                title: String(tx?.title || tx?.note || ''),
                category: String(tx?.category || ''),
                amount: Math.abs(toNumber(tx?.amount))
            }))

        return {
            id: scenario?.id,
            slot: scenario?.slot,
            title: scenario?.title,
            merchant_name: scenario?.merchant_name,
            category_key: scenario?.category_key,
            transaction_count: scenario?.projection_basis?.transaction_count ?? null,
            avg_amount: scenario?.projection_basis?.avg_amount ?? null,
            projected_savings_amount: scenario?.projected_savings_amount ?? null,
            examples
        }
    })

    const prompt = [
        'You are a multilingual spending habit classifier.',
        'Task: decide if each candidate should be shown as a what-if scenario.',
        'Return STRICT JSON only with schema:',
        '{"decisions":[{"id":"string","allow":true,"confidence":0.0,"reducible":true,"slot_fit":true,"canonical_title":"string","reason":"string"}]}',
        'Rules:',
        '- Accept discretionary habits and essential-flexible habits with clear user control.',
        '- Reject fixed obligations, medical essentials, low-agency spending, and unstable noise.',
        '- Handle any language/scripts and noisy merchant names.',
        '- If uncertain, set allow=false and confidence below 0.55.',
        '- canonical_title is optional, max 8 words.',
        `Candidates: ${JSON.stringify(candidates)}`
    ].join('\n')

    try {
        const response = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 650
            }
        })
        if (!response) return base

        const payload = await response.json()
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) return base
        const jsonText = extractJsonObject(String(text))
        if (!jsonText) return base

        const parsed = JSON.parse(jsonText)
        const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : []
        const byId = new Map<string, any>()
        for (const decision of decisions) {
            const id = String(decision?.id || '')
            if (!id) continue
            byId.set(id, decision)
        }

        const filtered: any[] = []
        for (const scenario of base) {
            const decision = byId.get(String(scenario?.id || ''))
            if (!decision) {
                filtered.push(scenario)
                continue
            }
            const allow = decision?.allow === true
            const reducible = decision?.reducible !== false
            const slotFit = decision?.slot_fit !== false
            const confidence = toNumber(decision?.confidence)

            if (!(allow && reducible && slotFit && confidence >= 0.55)) continue

            const canonicalTitle = String(decision?.canonical_title || '').trim()
            if (canonicalTitle && canonicalTitle.length <= 80) scenario.title = canonicalTitle
            const reason = String(decision?.reason || '').trim()
            if (reason && reason.length <= 140) scenario.why_this_matters = reason
            filtered.push(scenario)
        }

        return filtered
    } catch (_error) {
        return base
    }
}

function getWalletTypeKey(wallet: any): string {
    return String(wallet?.type || '')
        .trim()
        .toLowerCase()
}

function getWalletBalanceCents(wallet: any): number {
    return toNumber(
        wallet?.current_cents
        ?? wallet?.balance_cents
        ?? wallet?.current_amount_cents
        ?? wallet?.amount_cents
        ?? wallet?.balance
        ?? 0
    )
}

function getWalletTargetCents(wallet: any): number {
    return toNumber(
        wallet?.target_cents
        ?? wallet?.target_amount_cents
        ?? wallet?.goal_amount_cents
        ?? wallet?.target_amount
        ?? 0
    )
}

function isEmergencyWalletUnderbuilt(wallet: any): boolean {
    if (!wallet) return false
    const balance = getWalletBalanceCents(wallet)
    const target = getWalletTargetCents(wallet)
    if (target > 0) return balance < (target * 0.8)
    return balance <= 0
}

function formatWishDateHint(targetDateMillis: number, locale: string = 'en'): string | null {
    if (!Number.isFinite(targetDateMillis) || targetDateMillis <= 0) return null
    const date = new Date(targetDateMillis)
    if (!Number.isFinite(date.getTime())) return null
    return new Intl.DateTimeFormat(localeTagForWiseyAnalytics(locale), { month: 'short', year: 'numeric' }).format(date)
}

function findBestMatchingBill(bills: any[], savingsAmount: number): any | null {
    if (!Array.isArray(bills) || bills.length === 0 || savingsAmount <= 0) return null

    let best: any = null
    let bestCloseness = Number.POSITIVE_INFINITY

    for (const bill of bills) {
        const billAmount = toNumber(bill?.amount_cents || 0) / 100
        if (billAmount <= 0) continue
        const ratio = savingsAmount / billAmount
        if (ratio < 0.30) continue
        const closeness = Math.abs(1.0 - ratio)
        if (best === null || closeness < bestCloseness) {
            bestCloseness = closeness
            best = { ...bill, coverageRatio: ratio }
        }
    }

    if (!best) return null

    return {
        kind: 'bill',
        id: String(best.id || ''),
        name: String(best.name || 'a bill'),
        sourceType: String(best.source_type || 'bill'),
        billAmount: toNumber(best.amount_cents || 0) / 100,
        coverageRatio: best.coverageRatio
    }
}

function normalizeWhatIfTargetName(rawName: string): string {
    const cleaned = String(rawName || '')
        .trim()
        .replace(/\s+/g, ' ')
    return cleaned || 'a bill'
}

function ensureWhatIfTargetSuffix(name: string, sourceType: string): string {
    const base = normalizeWhatIfTargetName(name)
    const lower = base.toLowerCase()
    if (sourceType === 'subscription') {
        return /\bsubscription\b/i.test(lower) ? base : `${base} subscription`
    }
    if (sourceType === 'planned_payment') {
        return /\bpayment\b/i.test(lower) ? base : `${base} payment`
    }
    return /\bbill\b/i.test(lower) ? base : `${base} bill`
}

function buildWhatIfDestinationPool(
    goals: any[],
    wallets: any[],
    upcomingBills: any[],
    projectedSavingsAmount: number,
    obligationSignal?: {
        available: boolean
        covered: boolean
        overdueCents: number
        fixedObligationsCents: number
        obligationCount: number
    } | null
) {
    const nowMs = Date.now()
    const activeGoals = [...goals]
        .filter((goal) => !isChallengeGoalRow(goal) && !isWishGoalRow(goal))
        .filter((goal) => getGoalTargetCents(goal) > getGoalCurrentCents(goal))
        .sort((a, b) => {
            const aDate = toNumber(a?.target_date_millis || 0)
            const bDate = toNumber(b?.target_date_millis || 0)
            if (aDate > 0 && bDate > 0 && aDate !== bDate) return aDate - bDate
            return (getGoalTargetCents(a) - getGoalCurrentCents(a)) - (getGoalTargetCents(b) - getGoalCurrentCents(b))
        })
    const datedGoals = activeGoals.filter((goal) => toNumber(goal?.target_date_millis || 0) > nowMs)

    const wishItems = [...goals]
        .filter((goal) => isWishGoalRow(goal))
        .sort((a, b) => {
            const aDate = toNumber(a?.target_date_millis || 0)
            const bDate = toNumber(b?.target_date_millis || 0)
            if (aDate > 0 && bDate > 0 && aDate !== bDate) return aDate - bDate
            return String(a?.name || '').localeCompare(String(b?.name || ''))
        })

    const emergencyWallet = wallets.find((wallet) => getWalletTypeKey(wallet) === 'emergency')
    const savingsWallet = wallets.find((wallet) => getWalletTypeKey(wallet) === 'savings')

    const hasObligationPressure = Boolean(
        obligationSignal?.available && (
            (obligationSignal?.overdueCents || 0) > 0
            || (
                !(obligationSignal?.covered ?? true)
                && (obligationSignal?.fixedObligationsCents || 0) > 0
            )
        )
    )

    const genericObligationTarget = hasObligationPressure
        ? {
            kind: 'obligation_cushion',
            id: 'obligation_cushion',
            name: (obligationSignal?.overdueCents || 0) > 0 ? 'Overdue obligations' : 'Upcoming obligations',
            overdueCents: obligationSignal?.overdueCents || 0,
            fixedObligationsCents: obligationSignal?.fixedObligationsCents || 0,
            obligationCount: obligationSignal?.obligationCount || 0
        }
        : null
    const matchedBill = findBestMatchingBill(upcomingBills, projectedSavingsAmount)
    const obligationTarget = matchedBill ?? genericObligationTarget

    return {
        goalTargets: datedGoals.map((goal) => ({
            kind: 'goal',
            id: String(goal?.id || goal?.client_goal_id || ''),
            data: goal
        })),
        obligationTarget,
        emergencyTarget: emergencyWallet && isEmergencyWalletUnderbuilt(emergencyWallet)
            ? {
                kind: 'emergency_wallet',
                id: String(emergencyWallet?.id || ''),
                name: emergencyWallet?.name || 'Emergency Fund'
            }
            : null,
        savingsTarget: savingsWallet
            ? {
                kind: 'savings_wallet',
                id: String(savingsWallet?.id || ''),
                name: savingsWallet?.name || 'Savings'
            }
            : null,
        wishTargets: wishItems.map((goal) => ({
            kind: 'wish',
            id: String(goal?.id || goal?.client_goal_id || ''),
            data: goal
        })),
        bufferTarget: {
            kind: 'buffer',
            id: 'general_buffer',
            name: 'General buffer'
        }
    }
}

function pickDiscretionaryDestination(
    destinationPool: any,
    usedDestinationKeys: Set<string>
): any {
    const rankedTargets = [
        destinationPool?.obligationTarget || null,
        ...(destinationPool?.goalTargets || []),
        ...(destinationPool?.wishTargets || [])
    ].filter(Boolean)

    for (const target of rankedTargets) {
        const dedupeKey = `${String(target?.kind || 'target')}::${String(target?.id || 'unknown')}`
        if (!usedDestinationKeys.has(dedupeKey)) {
            usedDestinationKeys.add(dedupeKey)
            return target
        }
    }

    return null
}

function pickEssentialFlexibleDestination(
    destinationPool: any,
    usedDestinationKeys: Set<string>
): any {
    const rankedTargets = [
        destinationPool?.emergencyTarget || null,
        destinationPool?.savingsTarget || null
    ].filter(Boolean)

    for (const target of rankedTargets) {
        const dedupeKey = `${String(target?.kind || 'target')}::${String(target?.id || 'unknown')}`
        if (!usedDestinationKeys.has(dedupeKey)) {
            usedDestinationKeys.add(dedupeKey)
            return target
        }
    }

    return null
}

function resolveWhatIfAnthropicKey(): string {
    try {
        const fromEnv = String(Deno.env.get('ANTHROPIC_API_KEY') || '').trim()
        if (fromEnv) return fromEnv
    } catch (_error) {
        // fall through to non-env override
    }
    return String((globalThis as any)?.__WISEY_WHAT_IF_ANTHROPIC_KEY || '').trim()
}

async function buildAnnualFallbackImpactTarget(
    annualAmount: number,
    wishNames: string[],
    currencyCode: string = 'USD',
    locale: string = 'en'
): Promise<any> {
    const amountLabel = formatDigestCurrency(annualAmount, currencyCode, locale)

    if (Array.isArray(wishNames) && wishNames.length > 0) {
        return {
            kind: 'annual_frame',
            annual_amount: annualAmount,
            message: `${amountLabel}/year toward ${wishNames[0]}`
        }
    }

    const aiKey = resolveWhatIfAnthropicKey()
    if (!aiKey) {
        return {
            kind: 'annual_frame',
            annual_amount: annualAmount,
            message: `${amountLabel}/year back into your pocket`
        }
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': aiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 30,
                messages: [{
                    role: 'user',
                    content: `The user would save ${amountLabel} per year with a small spending change. Suggest one short, realistic, specific thing they could do or buy with that amount. Be grounded. Do not always say vacation. Match the suggestion to the actual amount - do not overstate. Return only the label, no explanation, no punctuation at the end. Examples: "a new phone", "a weekend trip with someone", "6 months of gym membership", "a solid laptop upgrade", "a nice dinner out every month".`
                }]
            })
        })
        if (!response.ok) throw new Error('AI call failed')

        const payload = await response.json()
        const label = String(payload?.content?.[0]?.text || '')
            .trim()
            .replace(/^["']|["']$/g, '')

        if (label.length > 0 && label.length < 60) {
            return {
                kind: 'annual_frame',
                annual_amount: annualAmount,
                message: `${amountLabel}/year - ${label}`
            }
        }
    } catch (_error) {
        // fall through to safe fallback
    }

    return {
        kind: 'annual_frame',
        annual_amount: annualAmount,
        message: `${amountLabel}/year back into your pocket`
    }
}

function buildWhatIfImpactTarget(
    target: any,
    projectedSavingsAmount: number,
    currencyCode: string = 'USD',
    locale: string = 'en'
) {
    if (!target) return null

    if (target.kind === 'annual_frame') {
        return {
            kind: 'annual_frame',
            annual_amount: toNumber(target?.annual_amount || 0),
            message: String(target?.message || '').trim() || `${formatDigestCurrency(toNumber(target?.annual_amount || 0), currencyCode, locale)}/year back into your pocket`
        }
    }

    if (target.kind === 'bill') {
        const ratio = toNumber(target?.coverageRatio || 0)
        const sourceType = String(target?.sourceType || target?.source_type || 'bill')
        const billName = ensureWhatIfTargetSuffix(String(target?.name || 'a bill'), sourceType)
        let coverageWord: string
        if (ratio >= 0.90) coverageWord = `covers your ${billName}`
        else if (ratio >= 0.60) coverageWord = `almost covers your ${billName}`
        else coverageWord = `goes a long way toward your ${billName}`

        return {
            kind: 'bill',
            id: target.id || null,
            name: billName,
            amount_applied: projectedSavingsAmount,
            coverage_pct: Number(ratio.toFixed(2)),
            message: coverageWord
        }
    }

    if (target.kind === 'goal') {
        const goal = target.data
        const targetAmount = getGoalTargetCents(goal) / 100
        const currentAmount = getGoalCurrentCents(goal) / 100
        const remainingAmount = Math.max(0, roundDigestAmount(targetAmount - currentAmount))
        const coveragePct = remainingAmount > 0
            ? Number((projectedSavingsAmount / remainingAmount).toFixed(2))
            : 1
        const rawGoalName = String(goal?.name || 'goal').trim()
        // Strip internal prefixes like "SEED:", "DRAFT:", etc.
        const goalName = rawGoalName.includes(':') ? rawGoalName.split(':').slice(1).join(':').trim() || rawGoalName : rawGoalName

        return {
            kind: 'goal',
            id: goal.id || goal.client_goal_id || null,
            name: goalName || 'Goal',
            amount_applied: projectedSavingsAmount,
            coverage_pct: coveragePct,
            message: `hits your ${goalName || 'goal'} goal faster`
        }
    }

    if (target.kind === 'obligation_cushion') {
        const overdueAmount = roundDigestAmount((target.overdueCents || 0) / 100)
        const fixedAmount = roundDigestAmount((target.fixedObligationsCents || 0) / 100)
        const baselineAmount = overdueAmount > 0 ? overdueAmount : fixedAmount
        const coveragePct = baselineAmount > 0
            ? Number((projectedSavingsAmount / baselineAmount).toFixed(2))
            : undefined

        return {
            kind: 'obligation_cushion',
            id: target.id || 'obligation_cushion',
            name: target.name || 'Obligations',
            amount_applied: projectedSavingsAmount,
            coverage_pct: coveragePct,
            message: overdueAmount > 0
                ? 'helps cover overdue obligations'
                : 'helps cover upcoming bills'
        }
    }

    if (target.kind === 'wish') {
        const goal = target.data
        const amountLabel = formatDigestCurrency(projectedSavingsAmount, currencyCode, locale)
        const dateHint = formatWishDateHint(toNumber(goal?.target_date_millis || 0), locale)
        const rawWishName = String(goal?.name || 'Wish').trim() || 'Wish'
        const wishName = rawWishName.includes(':') ? rawWishName.split(':').slice(1).join(':').trim() || rawWishName : rawWishName
        return {
            kind: 'wish',
            id: goal.id || goal.client_goal_id || null,
            name: wishName,
            amount_applied: projectedSavingsAmount,
            message: dateHint
                ? `this gives you ${amountLabel} set aside by ${dateHint}`
                : `this could be your first ${amountLabel} toward ${wishName}`
        }
    }

    if (target.kind === 'emergency_wallet') {
        return {
            kind: 'emergency_wallet',
            id: target.id || null,
            name: target.name || 'Emergency Fund',
            amount_applied: projectedSavingsAmount,
            message: 'adds to your emergency fund'
        }
    }

    if (target.kind === 'savings_wallet') {
        return {
            kind: 'savings_wallet',
            id: target.id || null,
            name: target.name || 'Savings',
            amount_applied: projectedSavingsAmount,
            message: 'adds to your savings wallet'
        }
    }

    return {
        kind: 'buffer',
        id: target.id || 'general_buffer',
        name: target.name || 'General buffer',
        amount_applied: projectedSavingsAmount,
        message: null
    }
}

export async function buildWhatIfScenarios(params: {
    txns: any[]
    goals: any[]
    wallets: any[]
    upcomingBills?: any[]
    currencyCode?: string
    locale?: string
    categoryIndex?: Map<string, any>
    obligationSignal?: {
        available: boolean
        covered: boolean
        overdueCents: number
        fixedObligationsCents: number
        obligationCount: number
    } | null
}): Promise<any[]> {
    const txns = Array.isArray(params.txns) ? params.txns : []
    const goals = Array.isArray(params.goals) ? params.goals : []
    const wallets = Array.isArray(params.wallets) ? params.wallets : []
    const upcomingBills = Array.isArray(params.upcomingBills) ? params.upcomingBills : []
    const currencyCode = normalizeCurrencyCode(params.currencyCode) || 'USD'
    const locale = normalizeWiseyAnalyticsLocale(params.locale || 'en')
    const categoryIndex = params.categoryIndex instanceof Map ? params.categoryIndex : new Map()
    const lookbackDays = getWhatIfLookbackDays(txns)
    const latestTs = txns
        .map((tx) => new Date(String(tx?.date || '')).getTime())
        .filter((value) => Number.isFinite(value))
        .reduce((best, ts) => Math.max(best, ts), 0)
    const anchorTs = latestTs > 0 ? latestTs : Date.now()
    const lookbackStartTs = anchorTs - (lookbackDays * 24 * 60 * 60 * 1000)

    const grouped = new Map<string, any>()

    for (const tx of txns) {
        const categoryContext = resolveWhatIfTxCategoryContext(tx, categoryIndex)
        if (!isWhatIfExpense(tx, categoryIndex, categoryContext)) continue

        const timestamp = new Date(String(tx?.date || '')).getTime()
        if (!Number.isFinite(timestamp) || timestamp < lookbackStartTs) continue

        const amount = Math.abs(toNumber(tx?.amount))
        if (amount < 3) continue

        const merchantName = normalizeWhatIfMerchantLabel(tx)
        const rawCategoryKey = normalizeDigestCategoryKey(categoryContext.key)
        const categoryKey = normalizeWhatIfCategoryKey(rawCategoryKey, merchantName, tx)
        const slot = resolveWhatIfSlot(categoryKey, merchantName, tx)
        if (!slot) continue

        const sourceType: 'merchant_habit' | 'category_habit' = slot === 'discretionary' && merchantName
            ? 'merchant_habit'
            : 'category_habit'
        const label = sourceType === 'merchant_habit'
            ? merchantName
            : String(humanizeCategory(categoryKey) || categoryContext.name || 'Spending')
        const key = sourceType === 'merchant_habit'
            ? `merchant:${slot}:${String(merchantName).toLowerCase()}`
            : `category:${slot}:${categoryKey}`

        const txDate = new Date(timestamp)
        const day = txDate.getUTCDay()
        const hour = txDate.getUTCHours()
        const isWeekend = day === 0 || day === 6
        const isEvening = hour >= 18 || hour <= 4

        const current = grouped.get(key) || {
            key,
            slot,
            sourceType,
            label,
            merchantName: sourceType === 'merchant_habit' ? merchantName : null,
            categoryName: String(categoryContext.name || humanizeCategory(categoryKey) || 'Other'),
            categoryKey,
            count: 0,
            totalAmount: 0,
            lastSeenAt: 0,
            weekendHits: 0,
            eveningHits: 0,
            amounts: [] as number[]
        }

        current.count += 1
        current.totalAmount += amount
        current.lastSeenAt = Math.max(current.lastSeenAt, timestamp)
        current.weekendHits += isWeekend ? 1 : 0
        current.eveningHits += isEvening ? 1 : 0
        current.amounts.push(amount)
        grouped.set(key, current)
    }

    const scoredCandidates = [...grouped.values()]
        .map((candidate) => {
            const avgAmount = candidate.count > 0 ? candidate.totalAmount / candidate.count : 0
            const variance = candidate.count > 1
                ? candidate.amounts.reduce((sum: number, amount: number) => sum + Math.pow(amount - avgAmount, 2), 0) / candidate.count
                : 0
            const stdDev = Math.sqrt(Math.max(0, variance))

            candidate.averageAmount = avgAmount
            candidate.variability = avgAmount > 0 ? stdDev / avgAmount : 0
            candidate.weekendRatio = candidate.count > 0 ? candidate.weekendHits / candidate.count : 0
            candidate.eveningRatio = candidate.count > 0 ? candidate.eveningHits / candidate.count : 0
            candidate.recencyDays = candidate.lastSeenAt > 0
                ? Math.max(0, Math.round((anchorTs - candidate.lastSeenAt) / (24 * 60 * 60 * 1000)))
                : 999
            candidate.reduction = chooseWhatIfReductionForCandidate(candidate, lookbackDays, currencyCode, locale)
            candidate.projectedSavingsAmount = Number(candidate.reduction?.projectedSavingsAmount || 0)
            candidate.score = scoreWhatIfCandidate(candidate, lookbackDays)
            candidate.confidence = Number(Math.max(0.45, Math.min(0.93, (candidate.score * 0.7) + 0.28)).toFixed(2))
            return candidate
        })
    const candidates = scoredCandidates
        .filter((candidate) => candidate.count >= 2)
        .filter((candidate) => candidate.totalAmount >= 18)
        .filter((candidate) => candidate.projectedSavingsAmount >= 6)
        .filter((candidate) => candidate.score >= 0.3)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score
            if (b.projectedSavingsAmount !== a.projectedSavingsAmount) return b.projectedSavingsAmount - a.projectedSavingsAmount
            return b.count - a.count
        })

    if (candidates.length === 0) return []

    const bySlot: Record<'discretionary' | 'essential_flexible', any[]> = {
        discretionary: [],
        essential_flexible: []
    }
    for (const candidate of candidates) {
        if (candidate.slot === 'discretionary') bySlot.discretionary.push(candidate)
        if (candidate.slot === 'essential_flexible') bySlot.essential_flexible.push(candidate)
    }

    const chosenCandidates: any[] = []
    if (bySlot.discretionary.length > 0) chosenCandidates.push(bySlot.discretionary[0])
    if (bySlot.essential_flexible.length > 0) chosenCandidates.push(bySlot.essential_flexible[0])
    if (chosenCandidates.length === 0) return []

    const usedDestinationKeys = new Set<string>()
    const scenarios: any[] = []

    for (const candidate of chosenCandidates) {
        const destinationPool = buildWhatIfDestinationPool(
            goals,
            wallets,
            upcomingBills,
            candidate.projectedSavingsAmount,
            params.obligationSignal
        )
        const destination = candidate.slot === 'discretionary'
            ? pickDiscretionaryDestination(destinationPool, usedDestinationKeys)
            : pickEssentialFlexibleDestination(destinationPool, usedDestinationKeys)
        const impactTarget = destination
            ? buildWhatIfImpactTarget(destination, candidate.projectedSavingsAmount, currencyCode, locale)
            : null

        const projectionBasis: any = {
            lookback_days: lookbackDays,
            transaction_count: candidate.count,
            avg_amount: roundDigestAmount(candidate.averageAmount)
        }
        if (Number.isFinite(candidate.reduction?.suggestedReductionFrequency) && candidate.reduction.suggestedReductionFrequency > 0) {
            projectionBasis.suggested_reduction_frequency = Math.round(candidate.reduction.suggestedReductionFrequency)
        }
        if (Number.isFinite(candidate.reduction?.suggestedReductionPct) && candidate.reduction.suggestedReductionPct > 0) {
            projectionBasis.suggested_reduction_pct = roundWhatIfPercent(candidate.reduction.suggestedReductionPct)
        }
        if (Number.isFinite(candidate.reduction?.suggestedCapAmount) && candidate.reduction.suggestedCapAmount > 0) {
            projectionBasis.suggested_cap_amount = roundDigestAmount(candidate.reduction.suggestedCapAmount)
        }
        if (Number.isFinite(candidate.reduction?.suggestedPauseWeeks) && candidate.reduction.suggestedPauseWeeks > 0) {
            projectionBasis.suggested_pause_weeks = Math.round(candidate.reduction.suggestedPauseWeeks)
        }
        if (Number.isFinite(candidate.reduction?.suggestedSwapCount) && candidate.reduction.suggestedSwapCount > 0) {
            projectionBasis.suggested_swap_count = Math.round(candidate.reduction.suggestedSwapCount)
        }

        scenarios.push({
            id: `${candidate.key.replace(/[^a-z0-9]+/gi, '_')}_${candidate.slot}`.toLowerCase(),
            type: candidate.sourceType,
            title: buildWhatIfTitle(candidate),
            subtitle: null,
            merchant_name: candidate.merchantName || null,
            category_key: candidate.categoryKey,
            category_name: candidate.categoryName || null,
            projected_savings_amount: roundDigestAmount(candidate.projectedSavingsAmount),
            projection_window: 'monthly',
            slot: candidate.slot,
            currency_code: currencyCode,
            projection_basis: projectionBasis,
            impact_target: impactTarget,
            why_this_matters: buildWhatIfWhyItMatters(candidate),
            confidence: candidate.confidence
        })
    }

    const needsAnnualFrame = scenarios.filter((scenario) => scenario.impact_target === null)
    if (needsAnnualFrame.length > 0) {
        const fallbackPool = buildWhatIfDestinationPool(
            goals,
            wallets,
            upcomingBills,
            0,
            params.obligationSignal
        )
        const wishNames = (fallbackPool?.wishTargets || [])
            .map((wish: any) => String(wish?.data?.name || '').trim())
            .filter((name: string) => name.length > 0)

        for (const scenario of needsAnnualFrame) {
            const annualAmount = roundDigestAmount(toNumber(scenario?.projected_savings_amount || 0) * 12)
            scenario.impact_target = await buildAnnualFallbackImpactTarget(annualAmount, wishNames, currencyCode, locale)
        }
    }

    return await localizeWhatIfScenarios(scenarios.slice(0, 2), locale)
}

export function selectWeeklyDigestScenario(params: {
    currentWeekSpend: number
    previousWeekSpend: number
    currentWeekIncome: number
    previousWeekIncome: number
    weekOverWeekSpendDeltaPct: number
    weekendSpendRatio: number
    lateWeekSpendRatio: number
    obligationsAvailable: boolean
    obligationsCovered: boolean
    overdueCents: number
    fixedObligationsCents: number
    obligationCount: number
    essentialsDelta: number
    discretionaryDelta: number
    largestIncreaseCategory: string | null
    largestIncreaseAmount: number
    largestExpenseAmount: number
    largestExpenseCategory: string | null
    largestExpenseCategoryKey: string | null
}): {
    type: 'stability' | 'pressure' | 'recovery'
    scenarioCode: string
    primaryDriver: string | null
    secondaryDriver: string | null
    actionCode: string
    scenarioScore: number
    debugReasons: string[]
} {
    const {
        currentWeekSpend,
        previousWeekSpend,
        currentWeekIncome,
        previousWeekIncome,
        weekOverWeekSpendDeltaPct,
        weekendSpendRatio,
        lateWeekSpendRatio,
        obligationsAvailable,
        obligationsCovered,
        overdueCents,
        fixedObligationsCents,
        obligationCount,
        essentialsDelta,
        discretionaryDelta,
        largestIncreaseCategory,
        largestIncreaseAmount,
        largestExpenseAmount,
        largestExpenseCategory,
        largestExpenseCategoryKey
    } = params

    const risePct = previousWeekSpend > 0
        ? Math.max(0, Math.round(weekOverWeekSpendDeltaPct * 100))
        : 0
    const dropPct = previousWeekSpend > 0
        ? Math.max(0, Math.abs(Math.round(weekOverWeekSpendDeltaPct * 100)))
        : 0
    const fixedObligationsAmount = fixedObligationsCents / 100
    const fixedObligationShare = currentWeekSpend > 0 ? fixedObligationsAmount / currentWeekSpend : 0
    const incomeSupportRatio = fixedObligationsAmount > 0 ? currentWeekIncome / fixedObligationsAmount : 1
    const hasLargePurchaseSignal = (
        largestExpenseAmount >= 180
        && largestExpenseAmount >= Math.max(140, currentWeekSpend * 0.42)
        && !DIGEST_LARGE_PURCHASE_EXCLUDED_CATEGORY_KEYS.has(String(largestExpenseCategoryKey || ''))
    )

    const candidates: Array<{
        type: 'stability' | 'pressure' | 'recovery'
        scenarioCode: string
        primaryDriver: string | null
        actionCode: string
        score: number
        reasons: string[]
    }> = []

    if (obligationsAvailable && !obligationsCovered) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'overdue_pressure',
            primaryDriver: 'overdue_obligations',
            actionCode: 'clear_overdue',
            score: 96 + Math.min(18, Math.round(overdueCents / 5000)),
            reasons: [
                `overdue_cents=${overdueCents}`,
                `weekend_ratio=${weekendSpendRatio.toFixed(2)}`
            ]
        })
    }

    if (weekendSpendRatio >= 0.40 && currentWeekSpend >= 120) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'weekend_drift',
            primaryDriver: 'weekend_spend',
            actionCode: 'protect_weekend',
            score: 78 + Math.round(weekendSpendRatio * 20),
            reasons: [
                `weekend_ratio=${weekendSpendRatio.toFixed(2)}`,
                `current_spend=${currentWeekSpend.toFixed(2)}`
            ]
        })
    }

    if (lateWeekSpendRatio >= 0.62 && currentWeekSpend >= 120) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'late_week_leak',
            primaryDriver: 'late_week_spend',
            actionCode: 'tighten_late_week',
            score: 72 + Math.round(lateWeekSpendRatio * 18),
            reasons: [
                `late_week_ratio=${lateWeekSpendRatio.toFixed(2)}`,
                `current_spend=${currentWeekSpend.toFixed(2)}`
            ]
        })
    }

    if (essentialsDelta >= 40 && essentialsDelta >= discretionaryDelta + 15) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'essentials_creep',
            primaryDriver: 'essentials',
            actionCode: 'absorb_essentials',
            score: 76 + Math.min(16, Math.round(essentialsDelta / 20)),
            reasons: [
                `essentials_delta=${essentialsDelta.toFixed(2)}`,
                `discretionary_delta=${discretionaryDelta.toFixed(2)}`
            ]
        })
    }

    if (discretionaryDelta >= 40 && discretionaryDelta >= essentialsDelta + 15) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'discretionary_leak',
            primaryDriver: 'discretionary',
            actionCode: 'cap_discretionary',
            score: 76 + Math.min(16, Math.round(discretionaryDelta / 20)),
            reasons: [
                `discretionary_delta=${discretionaryDelta.toFixed(2)}`,
                `largest_increase=${largestIncreaseCategory || 'none'}`
            ]
        })
    }

    if (
        obligationsAvailable
        && obligationsCovered
        && fixedObligationsAmount >= 180
        && obligationCount >= 2
        && fixedObligationShare >= 0.55
        && discretionaryDelta < 40
    ) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'fixed_bill_compression',
            primaryDriver: 'fixed_obligations',
            actionCode: 'protect_fixed_commitments',
            score: 80 + Math.min(12, Math.round(fixedObligationShare * 10)) + Math.min(8, obligationCount),
            reasons: [
                `fixed_obligations=${fixedObligationsAmount.toFixed(2)}`,
                `obligation_count=${obligationCount}`,
                `fixed_share=${fixedObligationShare.toFixed(2)}`
            ]
        })
    }

    if (
        obligationsAvailable
        && overdueCents <= 0
        && fixedObligationsAmount >= 180
        && incomeSupportRatio < 0.60
        && (currentWeekIncome === 0 || previousWeekIncome >= currentWeekIncome + 100)
    ) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'income_gap_pressure',
            primaryDriver: 'income_support',
            actionCode: 'stabilize_cash_support',
            score: 82
                + (currentWeekIncome === 0 ? 8 : 0)
                + Math.min(10, Math.round((1 - Math.max(0, incomeSupportRatio)) * 10)),
            reasons: [
                `current_income=${currentWeekIncome.toFixed(2)}`,
                `previous_income=${previousWeekIncome.toFixed(2)}`,
                `fixed_obligations=${fixedObligationsAmount.toFixed(2)}`,
                `income_support_ratio=${incomeSupportRatio.toFixed(2)}`
            ]
        })
    }

    if (hasLargePurchaseSignal && obligationsCovered) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'planned_large_purchase',
            primaryDriver: 'single_large_purchase',
            actionCode: 'absorb_large_purchase',
            score: 84 + Math.min(12, Math.round(largestExpenseAmount / 60)),
            reasons: [
                `largest_expense=${largestExpenseAmount.toFixed(2)}`,
                `largest_expense_category=${largestExpenseCategory || 'none'}`,
                `current_spend=${currentWeekSpend.toFixed(2)}`
            ]
        })
    }

    if (previousWeekSpend > 0 && risePct >= 20) {
        candidates.push({
            type: 'pressure',
            scenarioCode: 'spend_surge_pressure',
            primaryDriver: 'overall_spend',
            actionCode: 'cool_overall_spend',
            score: 70 + Math.min(18, Math.round(risePct / 4)),
            reasons: [
                `rise_pct=${risePct}`,
                `largest_increase_amount=${largestIncreaseAmount.toFixed(2)}`
            ]
        })
    }

    if (
        previousWeekSpend > 0
        && weekOverWeekSpendDeltaPct <= -0.18
        && obligationsAvailable
        && obligationsCovered
        && weekendSpendRatio < 0.38
    ) {
        candidates.push({
            type: 'stability',
            scenarioCode: 'steady_control',
            primaryDriver: 'steady_control',
            actionCode: 'keep_rhythm',
            score: 80 + Math.min(14, Math.round(dropPct / 4)),
            reasons: [
                `drop_pct=${dropPct}`,
                `obligations_covered=${obligationsCovered}`
            ]
        })
    }

    if (previousWeekSpend > 0 && weekOverWeekSpendDeltaPct <= -0.15) {
        candidates.push({
            type: 'recovery',
            scenarioCode: 'recovery_after_spike',
            primaryDriver: 'recovery',
            actionCode: 'repeat_reset',
            score: 68 + Math.min(12, Math.round(dropPct / 5)),
            reasons: [
                `drop_pct=${dropPct}`,
                `weekend_ratio=${weekendSpendRatio.toFixed(2)}`
            ]
        })
    }

    candidates.push({
        type: 'pressure',
        scenarioCode: 'mixed_but_contained',
        primaryDriver: largestIncreaseCategory ? 'mixed_category_pressure' : 'mixed_signals',
        actionCode: 'tighten_one_category',
        score: 32 + (weekendSpendRatio >= 0.35 ? 6 : 0) + (lateWeekSpendRatio >= 0.55 ? 4 : 0),
        reasons: [
            `weekend_ratio=${weekendSpendRatio.toFixed(2)}`,
            `late_week_ratio=${lateWeekSpendRatio.toFixed(2)}`
        ]
    })

    candidates.sort((a, b) => b.score - a.score)
    const winner = candidates[0]
    const runnerUp = candidates[1]
    const secondaryDriver = runnerUp && (winner.score - runnerUp.score) <= 10
        ? runnerUp.primaryDriver
        : null

    return {
        type: winner.type,
        scenarioCode: winner.scenarioCode,
        primaryDriver: winner.primaryDriver,
        secondaryDriver,
        actionCode: winner.actionCode,
        scenarioScore: winner.score,
        debugReasons: secondaryDriver
            ? [...winner.reasons, `secondary_driver=${secondaryDriver}`]
            : winner.reasons
    }
}

function normalizeObligationSourceKey(rawSource: unknown): string {
    const source = String(rawSource || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')

    if (!source) return ''
    if (source === 'bill' || source === 'bills') return 'bill'
    if (source === 'subscription' || source === 'subscriptions') return 'subscription'
    if (
        source === 'planned_payment'
        || source === 'planned_payments'
        || source === 'plannedpayment'
        || source === 'plannedpayments'
    ) return 'planned_payment'
    if (
        source === 'goal_auto_save'
        || source === 'goalautosave'
        || source === 'goal_auto_savings'
    ) return 'goal_auto_save'
    return source
}

async function normalizeObligationLinesToMainCurrency(
    supabase: any,
    userId: string,
    mainCurrencyCode: string,
    lines: any[]
): Promise<Array<{ source: string; occurrenceDate: string; amountCents: number }>> {
    type SyntheticObligationRow = {
        wallet_id: string | null
        source_currency: string | null
        amount: number
        reporting_amount: null
        reporting_currency: null
        date: string
        source: string
        occurrenceDate: string
    }

    const sourceRows: SyntheticObligationRow[] = (Array.isArray(lines) ? lines : [])
        .map((line) => {
            const amountCents = Math.max(0, Math.round(toNumber(line?.amountCents ?? line?.amount_cents ?? 0)))
            if (amountCents <= 0) return null

            const occurrenceDate = String(line?.occurrenceDate ?? line?.occurrence_date ?? '').trim()
            if (!occurrenceDate) return null

            const source = normalizeObligationSourceKey(line?.source)
            if (!source) return null

            const walletIdRaw = String(line?.walletId ?? line?.wallet_id ?? '').trim()
            const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
            const sourceCurrency = normalizeCurrencyCode(line?.currencyCode ?? line?.currency_code)

            return {
                wallet_id: walletId,
                source_currency: walletId ? null : (sourceCurrency || mainCurrencyCode),
                amount: amountCents / 100,
                reporting_amount: null,
                reporting_currency: null,
                date: `${occurrenceDate}T00:00:00.000Z`,
                source,
                occurrenceDate
            }
        })
        .filter((row): row is SyntheticObligationRow => Boolean(row))

    if (sourceRows.length === 0) return []

    const normalized = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        normalizeCurrencyCode(mainCurrencyCode) || 'USD',
        sourceRows
    )
    console.log(`[wisey_analytics.obligations_currency_normalization_metrics] user_id=${userId} normalized_rows_used=${normalized.metrics.normalized_rows_used} temporary_converted_rows_used=${normalized.metrics.temporary_converted_rows_used} raw_same_currency_rows_used=${normalized.metrics.raw_same_currency_rows_used} rows_with_missing_reporting_fields=${normalized.metrics.rows_with_missing_reporting_fields} fx_lookup_failures=${normalized.metrics.fx_lookup_failures}`)

    return (normalized.rows as SyntheticObligationRow[])
        .map((row) => ({
            source: normalizeObligationSourceKey(row.source),
            occurrenceDate: String(row.occurrenceDate || '').trim(),
            amountCents: Math.max(0, Math.round(toNumber(row.amount) * 100))
        }))
        .filter((row) => row.occurrenceDate.length > 0 && row.amountCents > 0)
}

async function getWeeklyObligationCoverage(
    supabase: any,
    userId: string,
    mainCurrencyCode: string,
    window: { currentWeekStartDate: string; currentWeekEndDate: string },
    cycleStartDay: number
): Promise<{
    covered: boolean
    available: boolean
    overdueCents: number
    billsCents: number
    plannedPaymentsCents: number
    subscriptionsCents: number
    goalAutoSaveCents: number
    fixedObligationsCents: number
    obligationCount: number
}> {
    try {
        const { data, error } = await supabase.rpc('get_obligations_v1', {
            p_mode: 'custom',
            p_anchor_date: null,
            p_cycle_start_day: cycleStartDay,
            p_window_start: window.currentWeekStartDate,
            p_window_end: window.currentWeekEndDate,
            p_wallet_ids: null,
            p_include_overdue: true,
            p_include_lines: true
        })

        if (error) {
            console.error(`[weekly_digest_null_reason] reason=obligations_fetch_failed error=${error.message}`)
            return {
                covered: false,
                available: false,
                overdueCents: 0,
                billsCents: 0,
                plannedPaymentsCents: 0,
                subscriptionsCents: 0,
                goalAutoSaveCents: 0,
                fixedObligationsCents: 0,
                obligationCount: 0
            }
        }

        const rawLines = Array.isArray(data?.lines) ? data.lines : []
        const normalizedLines = await normalizeObligationLinesToMainCurrency(
            supabase,
            userId,
            mainCurrencyCode,
            rawLines
        )

        let billsCents = 0
        let plannedPaymentsCents = 0
        let subscriptionsCents = 0
        let goalAutoSaveCents = 0

        const linesForMetrics = normalizedLines.length > 0
            ? normalizedLines
            : rawLines.map((line: any) => ({
                source: normalizeObligationSourceKey(line?.source),
                occurrenceDate: String(line?.occurrenceDate ?? line?.occurrence_date ?? '').trim(),
                amountCents: Math.max(0, Math.round(toNumber(line?.amountCents ?? line?.amount_cents ?? 0)))
            }))

        if (normalizedLines.length > 0) {
            for (const line of normalizedLines) {
                const source = normalizeObligationSourceKey(line.source)
                if (source === 'bill') billsCents += line.amountCents
                else if (source === 'planned_payment') plannedPaymentsCents += line.amountCents
                else if (source === 'subscription') subscriptionsCents += line.amountCents
                else if (source === 'goal_auto_save') goalAutoSaveCents += line.amountCents
            }
        } else {
            billsCents = Math.max(0, Math.round(toNumber(data?.totals?.billsCents || 0)))
            plannedPaymentsCents = Math.max(0, Math.round(toNumber(data?.totals?.plannedPaymentsCents || 0)))
            subscriptionsCents = Math.max(0, Math.round(toNumber(data?.totals?.subscriptionsCents || 0)))
            goalAutoSaveCents = Math.max(0, Math.round(toNumber(data?.totals?.goalAutoSaveCents || 0)))
        }

        const obligationMetrics = deriveDigestObligationMetrics({
            lines: linesForMetrics,
            anchorDate: window.currentWeekEndDate
        })
        const overdueCents = obligationMetrics.overdueCents
        const fixedObligationsCents = Math.max(0, billsCents + plannedPaymentsCents + subscriptionsCents)
        const obligationCount = Math.max(
            0,
            Math.round(toNumber(data?.counts?.bills || 0))
            + Math.round(toNumber(data?.counts?.plannedPayments || 0))
            + Math.round(toNumber(data?.counts?.subscriptions || 0))
        )
        return {
            covered: overdueCents <= 0,
            available: true,
            overdueCents,
            billsCents,
            plannedPaymentsCents,
            subscriptionsCents,
            goalAutoSaveCents,
            fixedObligationsCents,
            obligationCount
        }
    } catch (error) {
        console.error(`[weekly_digest_null_reason] reason=obligations_exception error=${String((error as Error)?.message || error)}`)
        return {
            covered: false,
            available: false,
            overdueCents: 0,
            billsCents: 0,
            plannedPaymentsCents: 0,
            subscriptionsCents: 0,
            goalAutoSaveCents: 0,
            fixedObligationsCents: 0,
            obligationCount: 0
        }
    }
}

export function deriveDigestObligationMetrics(params: {
    lines: Array<any>
    anchorDate: string
}): {
    overdueCents: number
} {
    const safeLines = Array.isArray(params.lines) ? params.lines : []
    let overdueCents = 0

    for (const rawLine of safeLines) {
        const source = normalizeObligationSourceKey(rawLine?.source)
        if (source === 'goal_auto_save') continue

        const occurrenceDate = typeof rawLine?.occurrenceDate === 'string' ? rawLine.occurrenceDate : ''
        if (!occurrenceDate) continue
        if (occurrenceDate < params.anchorDate) {
            overdueCents += Math.max(0, Math.round(toNumber(rawLine?.amountCents || 0)))
        }
    }

    return {
        overdueCents: Math.max(0, overdueCents)
    }
}

async function getUserCycleStartDay(supabase: any, userId: string): Promise<number> {
    try {
        const { data, error } = await supabase
            .from('user_preferences')
            .select('cycle_start_day')
            .eq('user_id', userId)
            .maybeSingle()

        if (error) return 1
        const raw = Math.floor(toNumber(data?.cycle_start_day))
        return raw >= 1 && raw <= 31 ? raw : 1
    } catch {
        return 1
    }
}

function pickDigestVariant(seed: string, variants: string[]): string {
    if (!variants.length) return ''
    const index = Math.abs(stableDigestHash(seed)) % variants.length
    return variants[index]
}

function stableDigestHash(value: string): number {
    let hash = 0
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(i)
        hash |= 0
    }
    return hash
}

function pickDigestFamily<T extends { id: string }>(
    scenarioCode: string,
    weekStartDate: string,
    families: T[]
): T {
    if (!families.length) {
        throw new Error(`No digest families configured for scenario ${scenarioCode}`)
    }
    const weekSlot = Math.floor(dateOnlyToUtcMs(weekStartDate) / 604800000)
    const base = Math.abs(stableDigestHash(scenarioCode)) % families.length
    const index = (base + Math.abs(weekSlot)) % families.length
    return families[index]
}

function buildDigestConfidence(params: {
    scenarioScore: number
    hasSecondaryDriver: boolean
    obligationsAvailable: boolean
}): number {
    const { scenarioScore, hasSecondaryDriver, obligationsAvailable } = params
    let confidence = 0.58 + Math.min(0.31, scenarioScore * 0.003)
    if (hasSecondaryDriver) confidence -= 0.03
    if (!obligationsAvailable) confidence -= 0.02
    return Number(Math.max(0.61, Math.min(0.93, confidence)).toFixed(2))
}

export function hasWeeklyDigestSignal(params: {
    transactionCount: number
    currentWeekSpend: number
    previousWeekSpend: number
    overdueCents: number
    fixedObligationsCents?: number
    currentWeekIncome?: number
}): boolean {
    return params.transactionCount >= 2
        || params.currentWeekSpend > 0
        || params.previousWeekSpend > 0
        || params.overdueCents > 0
        || toNumber(params.fixedObligationsCents) > 0
        || toNumber(params.currentWeekIncome) > 0
}

export function buildWeeklyDigestPayload(params: {
    scenario: {
        type: 'stability' | 'pressure' | 'recovery'
        scenarioCode: string
        primaryDriver: string | null
        secondaryDriver: string | null
        actionCode: string
        scenarioScore: number
        debugReasons: string[]
    }
    currencyCode?: string
    locale?: string
    window: { currentWeekStartDate: string; currentWeekEndDate: string }
    currentWeekSpend: number
    previousWeekSpend: number
    currentWeekIncome: number
    previousWeekIncome: number
    weekOverWeekSpendDeltaPct: number
    weekendSpendRatio: number
    lateWeekSpendRatio: number
    obligationsCovered: boolean
    obligationsAvailable: boolean
    overdueCents: number
    fixedObligationsCents: number
    obligationCount: number
    topCategory: string | null
    largestIncreaseCategory: string | null
    largestIncreaseAmount: number
    largestExpenseAmount: number
    largestExpenseLabel: string | null
    essentialsDelta: number
    discretionaryDelta: number
}): any {
    const {
        scenario,
        currencyCode,
        locale = 'en',
        window,
        currentWeekSpend,
        previousWeekSpend,
        currentWeekIncome,
        previousWeekIncome,
        weekOverWeekSpendDeltaPct,
        weekendSpendRatio,
        lateWeekSpendRatio,
        obligationsCovered,
        obligationsAvailable,
        overdueCents,
        fixedObligationsCents,
        obligationCount,
        topCategory,
        largestIncreaseCategory,
        largestIncreaseAmount,
        largestExpenseAmount,
        largestExpenseLabel,
        essentialsDelta,
        discretionaryDelta
    } = params
    const digestCurrencyCode = normalizeCurrencyCode(currencyCode) || 'USD'
    const formatDigestCurrencyScoped = (amount: number) => formatDigestCurrency(amount, digestCurrencyCode, locale)
    const formatDigestPctScoped = (value: number) => formatPct(value, locale)

    const { type, scenarioCode, primaryDriver, secondaryDriver, actionCode, scenarioScore, debugReasons } = scenario
    const seed = [
        scenarioCode,
        window.currentWeekStartDate,
        Math.round(currentWeekSpend),
        Math.round(previousWeekSpend)
    ].join(':')
    const risePct = previousWeekSpend > 0
        ? Math.max(0, Math.round(weekOverWeekSpendDeltaPct * 100))
        : 0
    const dropPct = previousWeekSpend > 0
        ? Math.max(0, Math.abs(Math.round(weekOverWeekSpendDeltaPct * 100)))
        : 0
    const lowerTopCategory = topCategory ? topCategory.toLowerCase() : null
    const lowerLargestIncreaseCategory = largestIncreaseCategory ? largestIncreaseCategory.toLowerCase() : null
    const spendBullet = previousWeekSpend > 0
        ? `Spent ${formatDigestCurrencyScoped(currentWeekSpend)} vs ${formatDigestCurrencyScoped(previousWeekSpend)} last week.`
        : `Spent ${formatDigestCurrencyScoped(currentWeekSpend)} this week.`
    const weekendBullet = `Weekend spending reached ${formatDigestPctScoped(weekendSpendRatio)} of your weekly total.`
    const lateWeekBullet = `${formatDigestPctScoped(lateWeekSpendRatio)} of spending landed in the back half of the week.`
    const overdueBullet = overdueCents > 0
        ? `${formatDigestCurrencyScoped(overdueCents / 100)} in overdue obligations is still open.`
        : null
    const coveredBullet = obligationsAvailable && obligationsCovered ? 'Bills stayed covered.' : null
    const increaseBullet = largestIncreaseCategory && largestIncreaseAmount >= 15
        ? `${largestIncreaseCategory} added ${formatDigestCurrencyScoped(largestIncreaseAmount)} more than last week.`
        : null
    const essentialsBullet = essentialsDelta >= 15
        ? `Essentials rose by ${formatDigestCurrencyScoped(essentialsDelta)} versus last week.`
        : null
    const discretionaryBullet = discretionaryDelta >= 15
        ? `Flexible spending rose by ${formatDigestCurrencyScoped(discretionaryDelta)} versus last week.`
        : null
    const topCategoryBullet = topCategory ? `${topCategory} was your biggest spending area this week.` : null
    const fixedObligationsAmount = fixedObligationsCents / 100
    const fixedBillsBullet = fixedObligationsAmount >= 1
        ? `${formatDigestCurrencyScoped(fixedObligationsAmount)} of obligations came due during this week${obligationCount > 0 ? ` across ${obligationCount} commitments` : ''}.`
        : null
    const incomeSupportBullet = currentWeekIncome > 0
        ? `Incoming cash this week was ${formatDigestCurrencyScoped(currentWeekIncome)}.`
        : 'No income landed this week.'
    const purchaseLabel = String(largestExpenseLabel || '').trim() || 'One purchase'
    const largePurchaseBullet = largestExpenseAmount >= 1
        ? `${purchaseLabel} accounted for ${formatDigestCurrencyScoped(largestExpenseAmount)} this week.`
        : null

    let headline = ''
    let summary = ''
    let nextMove = ''
    let headlineFamily = 'default'
    const proofPoints: string[] = []
    const pushProof = (value: string | null | undefined) => {
        if (!value) return
        if (!proofPoints.includes(value)) proofPoints.push(value)
    }
    const chooseHeadline = (families: Array<{ id: string; headlines: string[] }>): string => {
        const family = pickDigestFamily(scenarioCode, window.currentWeekStartDate, families)
        headlineFamily = family.id
        return pickDigestVariant(`${seed}:${family.id}:headline`, family.headlines)
    }

    switch (scenarioCode) {
        case 'overdue_pressure':
            headline = chooseHeadline([
                {
                    id: 'overdue_backlog',
                    headlines: [
                        'Overdue bills are still squeezing this week.',
                        'This week is being dragged by overdue obligations.'
                    ]
                },
                {
                    id: 'overdue_weight',
                    headlines: [
                        'The pressure this week is coming from what is already behind.',
                        'Old obligations are still controlling the shape of this week.'
                    ]
                },
                {
                    id: 'overdue_drag',
                    headlines: [
                        'This week feels heavier because past-due items are still open.',
                        'What is overdue is still pulling this week down.'
                    ]
                }
            ])
            summary = overdueCents > 0
                ? pickDigestVariant(seed + ':summary', previousWeekSpend > 0 && currentWeekSpend < previousWeekSpend
                    ? [
                        `Spending cooled off, but ${formatDigestCurrencyScoped(overdueCents / 100)} in overdue obligations is still creating pressure.${fixedBillsBullet ? ` ${fixedBillsBullet}` : ''} This week is being weighed down more by what is behind than by what is new.`,
                        `You spent less than last week, but ${formatDigestCurrencyScoped(overdueCents / 100)} is still overdue.${fixedBillsBullet ? ` ${fixedBillsBullet}` : ''} The main issue is unfinished obligations, not runaway day-to-day spending.`
                    ]
                    : [
                        `${formatDigestCurrencyScoped(overdueCents / 100)} in overdue obligations is still open, and that is what makes this week heavy.${fixedBillsBullet ? ` ${fixedBillsBullet}` : ''} ${risePct > 0 ? `Spending also rose ${risePct}% versus last week.` : 'The pressure is less about one category and more about clearing what is behind.'}`,
                        `This week is under real pressure because ${formatDigestCurrencyScoped(overdueCents / 100)} is overdue.${fixedBillsBullet ? ` ${fixedBillsBullet}` : ''} ${risePct > 0 ? `On top of that, total spending also rose ${risePct}% versus last week.` : 'That backlog matters more than any one new purchase.'}`
                    ])
                : 'Some obligations slipped behind, and that is the main reason this week feels tighter.'
            pushProof(spendBullet)
            pushProof(overdueBullet)
            pushProof(increaseBullet || topCategoryBullet || weekendBullet || fixedBillsBullet)
            nextMove = 'Clear overdue obligations before adding new spending.'
            break
        case 'weekend_drift':
            headline = chooseHeadline([
                {
                    id: 'weekend_cluster',
                    headlines: [
                        'Your weekend spend is steering the week.',
                        'Most of the pressure is clustering around the weekend.'
                    ]
                },
                {
                    id: 'weekend_slip',
                    headlines: [
                        'The weekend is where this week starts to slip.',
                        'The week is loosest once the weekend starts.'
                    ]
                },
                {
                    id: 'weekend_window',
                    headlines: [
                        'The weak spot this week is a short weekend window.',
                        'This week is not leaking everywhere, it is leaking on the weekend.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Almost ${formatDigestPctScoped(weekendSpendRatio)} of your spending landed on the weekend. That means the pressure is concentrated into a short window you can actually control.`,
                `${formatDigestPctScoped(weekendSpendRatio)} of spending happened on the weekend, so the issue is not the whole week. It is a specific window that is carrying too much of the load.`
            ])
            pushProof(spendBullet)
            pushProof(weekendBullet)
            pushProof(increaseBullet || discretionaryBullet || topCategoryBullet)
            nextMove = 'Set one Friday-to-Sunday cap before the weekend starts.'
            break
        case 'late_week_leak':
            headline = chooseHeadline([
                {
                    id: 'late_week_back_half',
                    headlines: [
                        'The back half of the week is where control slips.',
                        'The pressure built in the second half of the week.'
                    ]
                },
                {
                    id: 'late_week_drift',
                    headlines: [
                        'This week leaked late, not all at once.',
                        'The week stayed fine at first, then loosened late.'
                    ]
                },
                {
                    id: 'late_week_finish',
                    headlines: [
                        'The finish of the week is costing more than the start.',
                        'This week gets heavier as it goes on.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `${formatDigestPctScoped(lateWeekSpendRatio)} of spending landed in the back half of the week. This looks more like late-week drift than a full-week spending problem.`,
                `The week did not break all at once. ${formatDigestPctScoped(lateWeekSpendRatio)} of spending arrived late, which points to back-half drift more than all-week pressure.`
            ])
            pushProof(spendBullet)
            pushProof(lateWeekBullet)
            pushProof(increaseBullet || discretionaryBullet || weekendBullet)
            nextMove = 'Treat the back half of the week like a mini budget window.'
            break
        case 'essentials_creep':
            headline = chooseHeadline([
                {
                    id: 'essentials_core',
                    headlines: [
                        'Core costs rose more than usual this week.',
                        'This week got heavier because essentials moved up.'
                    ]
                },
                {
                    id: 'essentials_real_life',
                    headlines: [
                        'The pressure came from everyday costs, not noise.',
                        'This week tightened because real-life costs stepped up.'
                    ]
                },
                {
                    id: 'essentials_baseline',
                    headlines: [
                        'The baseline cost of the week moved up.',
                        'This week got heavier before optional spending even started.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Essentials rose by ${formatDigestCurrencyScoped(essentialsDelta)} versus last week. This looks more like real-life cost pressure than careless spending.`,
                `Your core costs ran ${formatDigestCurrencyScoped(essentialsDelta)} higher than last week. That matters because essentials need breathing room, not just restraint.`
            ])
            pushProof(spendBullet)
            pushProof(essentialsBullet)
            pushProof(overdueBullet || weekendBullet || topCategoryBullet)
            nextMove = 'Leave room for essentials first, then decide what flexible spend still fits.'
            break
        case 'discretionary_leak':
            headline = chooseHeadline([
                {
                    id: 'discretionary_lead',
                    headlines: [
                        'Flexible spending is quietly taking the lead.',
                        'The leak is coming from optional spend, not fixed pressure.'
                    ]
                },
                {
                    id: 'discretionary_control',
                    headlines: [
                        'This week got looser in the categories you can control.',
                        'The part of the week you can control is where it slipped.'
                    ]
                },
                {
                    id: 'discretionary_drift',
                    headlines: [
                        'Optional spending started steering the week.',
                        'This week loosened in the flexible categories.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Flexible spending climbed by ${formatDigestCurrencyScoped(discretionaryDelta)} versus last week. That is useful to know because it is the easiest kind of pressure to reverse quickly.`,
                `Optional spending did most of the damage this week, rising ${formatDigestCurrencyScoped(discretionaryDelta)} from the prior one. The upside is that this is the most fixable type of pressure.`
            ])
            pushProof(spendBullet)
            pushProof(discretionaryBullet)
            pushProof(increaseBullet || weekendBullet || topCategoryBullet)
            nextMove = lowerLargestIncreaseCategory
                ? `Put ${lowerLargestIncreaseCategory} on a short cap for the next few days.`
                : 'Put one flexible category on a short cap this week.'
            break
        case 'fixed_bill_compression':
            headline = chooseHeadline([
                {
                    id: 'fixed_bill_cluster',
                    headlines: [
                        'This week got crowded by fixed commitments.',
                        'Recurring obligations stacked into the same window.'
                    ]
                },
                {
                    id: 'fixed_bill_timing',
                    headlines: [
                        'The tightness this week came from fixed bills landing together.',
                        'This week tightened because several fixed commitments landed at once.'
                    ]
                },
                {
                    id: 'fixed_bill_compression',
                    headlines: [
                        'Fixed commitments compressed the week.',
                        'The schedule of recurring bills made this week tighter.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `${formatDigestCurrencyScoped(fixedObligationsAmount)} of obligations came due during this week${obligationCount > 0 ? ` across ${obligationCount} commitments` : ''}. This looks more like timing pressure than a discretionary leak.`,
                `Fixed commitments took up ${formatDigestCurrencyScoped(fixedObligationsAmount)} this week${obligationCount > 0 ? ` across ${obligationCount} items` : ''}. The story here is compression from recurring obligations, not loose optional spending.`
            ])
            pushProof(fixedBillsBullet)
            pushProof(spendBullet)
            pushProof(coveredBullet || incomeSupportBullet)
            nextMove = 'Keep flexible spend quiet until this fixed-bill cluster passes.'
            break
        case 'income_gap_pressure':
            headline = chooseHeadline([
                {
                    id: 'income_gap_support',
                    headlines: [
                        'This week was light on incoming cash support.',
                        'Income support came in weaker than the obligations load.'
                    ]
                },
                {
                    id: 'income_gap_inflow',
                    headlines: [
                        'The week tightened because cash in was light against what was due.',
                        'Incoming cash support was too thin for the week\'s obligations.'
                    ]
                },
                {
                    id: 'income_gap_cover',
                    headlines: [
                        'What came in this week did not cover what landed.',
                        'The week tightened because inflow support lagged behind commitments.'
                    ]
                }
            ])
            summary = currentWeekIncome <= 0
                ? pickDigestVariant(seed + ':summary', [
                    `No income landed this week while ${formatDigestCurrencyScoped(fixedObligationsAmount)} of obligations still had to be carried. The pressure is coming from weak cash support, not just spending behavior.`,
                    `${formatDigestCurrencyScoped(fixedObligationsAmount)} of obligations came due this week, but no income landed alongside them. That makes this a cash-support problem before it becomes a spending one.`
                ])
                : pickDigestVariant(seed + ':summary', [
                    `Only ${formatDigestCurrencyScoped(currentWeekIncome)} came in this week against ${formatDigestCurrencyScoped(fixedObligationsAmount)} of fixed obligations. The pressure is coming from light income support more than broad spending drift.`,
                    `This week had ${formatDigestCurrencyScoped(currentWeekIncome)} of incoming cash against ${formatDigestCurrencyScoped(fixedObligationsAmount)} of fixed obligations. The squeeze is coming from weak inflow support, not just category leakage.`
                ])
            pushProof(incomeSupportBullet)
            pushProof(fixedBillsBullet)
            pushProof(previousWeekIncome > 0 ? `Last week brought in ${formatDigestCurrencyScoped(previousWeekIncome)}.` : spendBullet)
            nextMove = 'Hold off on new flexible spending until cash support catches up.'
            break
        case 'planned_large_purchase':
            headline = chooseHeadline([
                {
                    id: 'large_purchase_single',
                    headlines: [
                        'One large purchase shaped the whole week.',
                        'This week was defined by a single big purchase.'
                    ]
                },
                {
                    id: 'large_purchase_dominated',
                    headlines: [
                        'A single purchase dominated this week\'s picture.',
                        'One decision carried most of the week\'s weight.'
                    ]
                },
                {
                    id: 'large_purchase_concentrated',
                    headlines: [
                        'This week looks heavier because of one concentrated purchase.',
                        'The week changed shape because one purchase landed.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `${purchaseLabel} accounted for ${formatDigestCurrencyScoped(largestExpenseAmount)} and changed the shape of the week by itself. This looks more like one concentrated purchase than broad category drift.`,
                `A ${formatDigestCurrencyScoped(largestExpenseAmount)} purchase did most of the work this week. The week looks heavier because of one big decision, not because spending leaked everywhere.`
            ])
            pushProof(largePurchaseBullet)
            pushProof(spendBullet)
            pushProof(coveredBullet || weekendBullet)
            nextMove = 'Let this be the big purchase for the week and keep the rest quiet.'
            break
        case 'spend_surge_pressure':
            headline = chooseHeadline([
                {
                    id: 'spend_surge_pace',
                    headlines: [
                        'This week expanded faster than the last one.',
                        'The overall pace of spending picked up this week.'
                    ]
                },
                {
                    id: 'spend_surge_weight',
                    headlines: [
                        'This week got materially heavier than the one before it.',
                        'The full pace of the week stepped up.'
                    ]
                },
                {
                    id: 'spend_surge_broader',
                    headlines: [
                        'The week widened beyond its usual pace.',
                        'This week ran broader than the previous one.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Total spending rose ${risePct}% versus last week. The issue is the overall pace of the week, not just one isolated charge.`,
                `You spent ${risePct}% more than last week. That points to a broader pace problem, even if one category helped push it up.`
            ])
            pushProof(spendBullet)
            pushProof(increaseBullet || topCategoryBullet)
            pushProof(weekendSpendRatio >= 0.35 ? weekendBullet : lateWeekBullet)
            nextMove = lowerLargestIncreaseCategory
                ? `Cool ${lowerLargestIncreaseCategory} down before adding anything else this week.`
                : 'Keep the next few purchases deliberate until the weekly pace cools.'
            break
        case 'steady_control':
            headline = chooseHeadline([
                {
                    id: 'steady_control_rhythm',
                    headlines: [
                        'You held the week together with more control.',
                        'The system held better this week than before.'
                    ]
                },
                {
                    id: 'steady_control_steadier',
                    headlines: [
                        'This week looked steadier than the last one.',
                        'This week held a cleaner rhythm than the one before it.'
                    ]
                },
                {
                    id: 'steady_control_calmer',
                    headlines: [
                        'The week stayed calmer and more controlled.',
                        'This week looked more managed than reactive.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Spending fell ${dropPct}% and your core commitments stayed covered. That points to real control, not just a quiet week by luck.`,
                `You spent ${dropPct}% less than last week and kept obligations clean. This looks like steadier behavior, not random variance.`
            ])
            pushProof(spendBullet)
            pushProof(coveredBullet || weekendBullet)
            pushProof(weekendSpendRatio >= 0.35 ? weekendBullet : topCategoryBullet)
            nextMove = weekendSpendRatio >= 0.35
                ? 'Keep weekends controlled through Friday.'
                : 'Keep the same rhythm through the rest of the cycle.'
            break
        case 'recovery_after_spike':
            headline = chooseHeadline([
                {
                    id: 'recovery_cooldown',
                    headlines: [
                        'This week looks calmer than the last one.',
                        'You cooled the week down after a hotter stretch.'
                    ]
                },
                {
                    id: 'recovery_direction',
                    headlines: [
                        'The trend this week is recovery, not escalation.',
                        'The week moved back toward control.'
                    ]
                },
                {
                    id: 'recovery_reset',
                    headlines: [
                        'This week looks like a reset after a hotter one.',
                        'The week stabilized instead of escalating.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                `Spending cooled ${dropPct}% from the previous week. The week still had pressure points, but the direction is recovery rather than escalation.`,
                `You pulled spending down by ${dropPct}% versus last week. It was not perfect, but the week stabilized instead of getting hotter.`
            ])
            pushProof(spendBullet)
            pushProof(coveredBullet || weekendBullet)
            pushProof(topCategoryBullet || lateWeekBullet)
            nextMove = 'Repeat the same reset before Friday.'
            break
        default:
            headline = chooseHeadline([
                {
                    id: 'mixed_contained',
                    headlines: [
                        'The week was mixed, but still contained.',
                        'This week needs attention, not alarm.'
                    ]
                },
                {
                    id: 'mixed_signals',
                    headlines: [
                        'A few pressure signals showed up, but none took over.',
                        'There were signals to watch, but no full slide.'
                    ]
                },
                {
                    id: 'mixed_tighten',
                    headlines: [
                        'The week needs an early tighten, not a major reset.',
                        'This week was messy in places, but still controllable.'
                    ]
                }
            ])
            summary = pickDigestVariant(seed + ':summary', [
                'There were a few pressure signals, but none of them dominated the week. This looks more like something to tighten early than a week that fully slipped.',
                'The week was not perfectly clean, but no single signal was strong enough to call it a real slide. Wisey sees a contained week that still needs tightening.'
            ])
            pushProof(spendBullet)
            pushProof(weekendSpendRatio >= 0.35 ? weekendBullet : lateWeekBullet)
            pushProof(increaseBullet || topCategoryBullet || coveredBullet)
            nextMove = lowerLargestIncreaseCategory
                ? `Protect ${lowerLargestIncreaseCategory} before it grows into a pattern.`
                : 'Tighten one flexible area before the week gets away from you.'
            break
    }

    switch (actionCode) {
        case 'protect_weekend':
            nextMove = 'Set one Friday-to-Sunday cap before the weekend starts.'
            break
        case 'tighten_late_week':
            nextMove = 'Treat the back half of the week like a mini budget window.'
            break
        case 'absorb_essentials':
            nextMove = 'Leave room for essentials first, then decide what flexible spend still fits.'
            break
        case 'clear_overdue':
            nextMove = 'Clear overdue obligations before adding new spending.'
            break
        case 'cap_discretionary':
            nextMove = lowerLargestIncreaseCategory
                ? `Put ${lowerLargestIncreaseCategory} on a short cap for the next few days.`
                : 'Put one flexible category on a short cap this week.'
            break
        case 'protect_fixed_commitments':
            nextMove = 'Keep flexible spend quiet until this fixed-bill cluster passes.'
            break
        case 'stabilize_cash_support':
            nextMove = 'Hold off on new flexible spending until cash support catches up.'
            break
        case 'absorb_large_purchase':
            nextMove = 'Let this be the big purchase for the week and keep the rest quiet.'
            break
        case 'cool_overall_spend':
            nextMove = lowerLargestIncreaseCategory
                ? `Cool ${lowerLargestIncreaseCategory} down before adding anything else this week.`
                : 'Keep the next few purchases deliberate until the weekly pace cools.'
            break
        case 'keep_rhythm':
            nextMove = weekendSpendRatio >= 0.35
                ? 'Keep weekends controlled through Friday.'
                : 'Keep the same rhythm through the rest of the cycle.'
            break
        case 'repeat_reset':
            nextMove = 'Repeat the same reset before Friday.'
            break
        case 'tighten_one_category':
            nextMove = lowerLargestIncreaseCategory
                ? `Protect ${lowerLargestIncreaseCategory} before it grows into a pattern.`
                : 'Tighten one flexible area before the week gets away from you.'
            break
    }

    const bullets = proofPoints.filter((item) => Boolean(item)).slice(0, 3)
    const confidence = buildDigestConfidence({
        scenarioScore,
        hasSecondaryDriver: Boolean(secondaryDriver),
        obligationsAvailable
    })
    const chatHandoff = buildWeeklyDigestChatHandoff({
        type,
        scenarioCode,
        currencyCode: digestCurrencyCode,
        window,
        headline,
        summary,
        bullets,
        nextMove,
        confidence,
        primaryDriver,
        secondaryDriver,
        proofPoints: proofPoints.slice(0, 4),
        overdueCents,
        fixedObligationsCents,
        obligationCount,
        obligationsAvailable,
        obligationsCovered,
        currentWeekSpend,
        previousWeekSpend,
        currentWeekIncome,
        previousWeekIncome,
        weekOverWeekSpendDeltaPct,
        weekendSpendRatio,
        lateWeekSpendRatio,
        topCategory,
        largestIncreaseCategory,
        largestIncreaseAmount,
        largestExpenseAmount,
        largestExpenseLabel,
        essentialsDelta,
        discretionaryDelta
    })

    return {
        week_start: window.currentWeekStartDate,
        week_end: window.currentWeekEndDate,
        type,
        headline,
        summary,
        bullets,
        next_move: nextMove,
        confidence,
        scenario_code: scenarioCode,
        headline_family: headlineFamily,
        primary_driver: primaryDriver,
        secondary_driver: secondaryDriver,
        proof_points: proofPoints.slice(0, 4),
        chat_handoff: chatHandoff,
        action_code: actionCode,
        debug_reasons: debugReasons,
        computed_at: new Date().toISOString()
    }
}

async function localizeWeeklyDigestContent(digest: any, locale: string = 'en'): Promise<any> {
    const normalizedLocale = normalizeWiseyAnalyticsLocale(locale)
    if (!digest || normalizedLocale === 'en') return digest

    if (GEMINI_KEYS.length === 0) return digest

    const starterPrompt = String(digest?.chat_handoff?.starter_prompt || '')
    const source = {
        headline: String(digest?.headline || ''),
        summary: String(digest?.summary || ''),
        bullets: Array.isArray(digest?.bullets) ? digest.bullets.map((item: unknown) => String(item || '')) : [],
        next_move: String(digest?.next_move || ''),
        starter_prompt: starterPrompt
    }
    const prompt = [
        'Translate this weekly financial digest UI copy.',
        `Target language: ${wiseyAnalyticsLocaleName(normalizedLocale)}.`,
        'Return STRICT JSON only with this schema:',
        '{"headline":"...","summary":"...","bullets":["..."],"next_move":"...","starter_prompt":"..."}',
        'Rules:',
        '- Preserve all money amounts, currency symbols/codes, percentages, dates, merchant names, and category names exactly as written.',
        '- Keep the tone friendly, clear, and concise for a mobile finance app.',
        '- Do not add new facts, numbers, advice, bullets, or warnings.',
        '- Translate only the surrounding words.',
        `Source JSON: ${JSON.stringify(source)}`
    ].join('\n')

    try {
        const response = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 900
            }
        })
        if (!response) return digest

        const payload = await response.json()
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) return digest
        const jsonText = extractJsonObject(String(text))
        if (!jsonText) return digest

        const parsed = JSON.parse(jsonText)
        const headline = String(parsed?.headline || '').trim() || source.headline
        const summary = String(parsed?.summary || '').trim() || source.summary
        const bullets = Array.isArray(parsed?.bullets)
            ? parsed.bullets.map((item: unknown) => String(item || '').trim()).filter(Boolean).slice(0, source.bullets.length)
            : source.bullets
        const nextMove = String(parsed?.next_move || '').trim() || source.next_move
        const localizedStarterPrompt = String(parsed?.starter_prompt || '').trim() || starterPrompt
        const localizedChatHandoff = digest.chat_handoff
            ? {
                ...digest.chat_handoff,
                headline,
                summary,
                bullets,
                next_move: nextMove,
                starter_prompt: localizedStarterPrompt
            }
            : digest.chat_handoff

        return {
            ...digest,
            headline,
            summary,
            bullets,
            next_move: nextMove,
            chat_handoff: localizedChatHandoff
        }
    } catch (error) {
        console.warn(`[weekly_digest_localize_failed] locale=${normalizedLocale} error=${String((error as Error)?.message || error)}`)
        return digest
    }
}

async function localizeWhatIfScenarios(scenarios: any[], locale: string = 'en'): Promise<any[]> {
    const normalizedLocale = normalizeWiseyAnalyticsLocale(locale)
    if (!Array.isArray(scenarios) || scenarios.length === 0 || normalizedLocale === 'en') return scenarios

    if (GEMINI_KEYS.length === 0) return scenarios

    const source = scenarios.map((scenario: any) => ({
        id: String(scenario?.id || ''),
        title: String(scenario?.title || ''),
        impact_message: String(scenario?.impact_target?.message || ''),
        why_this_matters: String(scenario?.why_this_matters || '')
    }))
    const prompt = [
        'Translate this mobile finance app What-If scenario copy.',
        `Target language: ${wiseyAnalyticsLocaleName(normalizedLocale)}.`,
        'Return STRICT JSON only with this schema:',
        '{"items":[{"id":"...","title":"...","impact_message":"...","why_this_matters":"..."}]}',
        'Rules:',
        '- Preserve all money amounts, currency symbols/codes, percentages, dates, merchant names, goal names, wallet names, bill names, and category names exactly as written.',
        '- Translate only the surrounding UI copy.',
        '- Keep the title concise and natural for a mobile card.',
        '- Do not add or remove items.',
        `Source JSON: ${JSON.stringify(source)}`
    ].join('\n')

    try {
        const response = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 900
            }
        })
        if (!response) return scenarios

        const payload = await response.json()
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) return scenarios
        const jsonText = extractJsonObject(String(text))
        if (!jsonText) return scenarios

        const parsed = JSON.parse(jsonText)
        const items = Array.isArray(parsed?.items) ? parsed.items : []
        const localizedById = new Map<string, {
            title: string
            impact_message: string
            why_this_matters: string
        }>(
            items.map((item: any) => [
                String(item?.id || ''),
                {
                    title: String(item?.title || '').trim(),
                    impact_message: String(item?.impact_message || '').trim(),
                    why_this_matters: String(item?.why_this_matters || '').trim()
                }
            ])
        )

        return scenarios.map((scenario: any) => {
            const localized = localizedById.get(String(scenario?.id || ''))
            if (!localized) return scenario

            const currentImpact = scenario?.impact_target
            return {
                ...scenario,
                title: localized.title || String(scenario?.title || ''),
                impact_target: currentImpact
                    ? {
                        ...currentImpact,
                        message: localized.impact_message || String(currentImpact?.message || '')
                    }
                    : currentImpact,
                why_this_matters: localized.why_this_matters || String(scenario?.why_this_matters || '')
            }
        })
    } catch (error) {
        console.warn(`[what_if_localize_failed] locale=${normalizedLocale} error=${String((error as Error)?.message || error)}`)
        return scenarios
    }
}

async function computeWeeklyDigest(
    supabase: any,
    userId: string,
    currencyCode: string,
    timeZone: string,
    month: string,
    locale: string = 'en',
    options?: {
        cycleStartDay?: number
        window?: ReturnType<typeof getWeeklyDigestWindow>
        txns?: any[]
    }
): Promise<any | null> {
    try {
        const digestCurrencyCode = normalizeCurrencyCode(currencyCode) || 'USD'
        const cycleStartDay = options?.cycleStartDay ?? await getUserCycleStartDay(supabase, userId)
        const window = options?.window ?? getWeeklyDigestWindow(timeZone, month, cycleStartDay)
        // Weekly digest always analyzes the last fully completed week (Mon-Sun).
        const digestWeekStartDate = window.previousWeekStartDate
        const digestWeekEndDate = window.previousWeekEndDate
        const priorWeekStartDate = addDaysToDateOnly(digestWeekStartDate, -7)
        const priorWeekEndDate = addDaysToDateOnly(digestWeekStartDate, -1)

        const digestWeekStartParts = parseDateOnly(digestWeekStartDate)
        const digestWeekEndExclusiveParts = parseDateOnly(addDaysToDateOnly(digestWeekEndDate, 1))
        const priorWeekStartParts = parseDateOnly(priorWeekStartDate)

        const digestWeekStartIso = zonedDateTimeToUtc(
            digestWeekStartParts.year,
            digestWeekStartParts.month,
            digestWeekStartParts.day,
            0,
            0,
            0,
            window.timeZone
        ).toISOString()
        const digestWeekEndExclusiveIso = zonedDateTimeToUtc(
            digestWeekEndExclusiveParts.year,
            digestWeekEndExclusiveParts.month,
            digestWeekEndExclusiveParts.day,
            0,
            0,
            0,
            window.timeZone
        ).toISOString()
        const priorWeekStartIso = zonedDateTimeToUtc(
            priorWeekStartParts.year,
            priorWeekStartParts.month,
            priorWeekStartParts.day,
            0,
            0,
            0,
            window.timeZone
        ).toISOString()

        const digestWindow = {
            ...window,
            currentWeekStartDate: digestWeekStartDate,
            currentWeekEndDate: digestWeekEndDate,
            previousWeekStartDate: priorWeekStartDate,
            previousWeekEndDate: priorWeekEndDate,
            currentWeekStartIso: digestWeekStartIso,
            currentWeekEndExclusiveIso: digestWeekEndExclusiveIso,
            previousWeekStartIso: priorWeekStartIso,
            previousWeekEndExclusiveIso: digestWeekStartIso
        }

        const weekKey = buildWeeklyDigestCacheKey(digestWindow, digestCurrencyCode, locale)
        const cachedDigest = await readCachedWeeklyDigest(supabase, userId, weekKey)
        if (cachedDigest.hit) {
            return cachedDigest.digest
        }
        let allTxns = Array.isArray(options?.txns)
            ? filterTransactionsByIsoRange(options?.txns || [], digestWindow.previousWeekStartIso, digestWindow.currentWeekEndExclusiveIso)
            : []

        if (!options?.txns) {
            const { data: txns, error } = await supabase
                .from('wallet_transactions')
                .select('amount, date, category, title, note')
                .eq('user_id', userId)
                .gte('date', digestWindow.previousWeekStartIso)
                .lt('date', digestWindow.currentWeekEndExclusiveIso)

            if (error) {
                console.error(`[weekly_digest_null_reason] reason=query_failed error=${error.message}`)
                return null
            }

            allTxns = await normalizeAnalyticsTransactionsToMainCurrency(
                supabase,
                userId,
                digestCurrencyCode,
                Array.isArray(txns) ? txns : []
            )
        }

        const currentWeekTxns = filterTransactionsByIsoRange(
            allTxns,
            digestWindow.currentWeekStartIso,
            digestWindow.currentWeekEndExclusiveIso
        )
        const elapsedDays = Math.max(1, diffDaysDateOnly(digestWindow.currentWeekStartDate, digestWindow.currentWeekEndDate) + 1)
        const previousComparisonTxns = filterTransactionsByIsoRange(
            allTxns,
            digestWindow.previousWeekStartIso,
            digestWindow.previousWeekEndExclusiveIso
        )

        const currentWeekSpend = calculateSpent(currentWeekTxns)
        const previousWeekSpend = calculateSpent(previousComparisonTxns)
        const obligationSignal = await getWeeklyObligationCoverage(
            supabase,
            userId,
            digestCurrencyCode,
            digestWindow,
            cycleStartDay
        )
        if (!hasWeeklyDigestSignal({
            transactionCount: allTxns.length,
            currentWeekSpend,
            previousWeekSpend,
            overdueCents: obligationSignal.overdueCents,
            fixedObligationsCents: obligationSignal.fixedObligationsCents,
            currentWeekIncome: calculateIncome(currentWeekTxns)
        })) {
            console.log(`[weekly_digest_null_reason] reason=low_signal count=${allTxns.length} overdue_cents=${obligationSignal.overdueCents}`)
            await writeCachedWeeklyDigest(supabase, userId, weekKey, digestWindow, null)
            return null
        }

        const weekOverWeekSpendDelta = currentWeekSpend - previousWeekSpend
        const weekOverWeekSpendDeltaPct = previousWeekSpend > 0 ? weekOverWeekSpendDelta / previousWeekSpend : 0
        const currentWeekIncome = calculateIncome(currentWeekTxns)
        const previousWeekIncome = calculateIncome(previousComparisonTxns)
        const weekendSpendRatio = calculateWeekendRatio(currentWeekTxns, timeZone)
        const lateWeekSpendRatio = elapsedDays >= 3
            ? calculateLateWeekRatio(
                currentWeekTxns,
                timeZone,
                digestWindow.currentWeekStartDate,
                digestWindow.currentWeekEndDate
            )
            : 0
        const topCategory = getTopSpendingCategory(currentWeekTxns)
        const largestIncrease = getLargestSpendingIncrease(currentWeekTxns, previousComparisonTxns)
        const largestExpense = getLargestExpenseTransaction(currentWeekTxns)
        const currentGroupTotals = getDigestSpendGroupTotals(currentWeekTxns)
        const previousGroupTotals = getDigestSpendGroupTotals(previousComparisonTxns)
        const essentialsDelta = currentGroupTotals.essentials - previousGroupTotals.essentials
        const discretionaryDelta = currentGroupTotals.discretionary - previousGroupTotals.discretionary
        const scenario = selectWeeklyDigestScenario({
            currentWeekSpend,
            previousWeekSpend,
            currentWeekIncome,
            previousWeekIncome,
            weekOverWeekSpendDeltaPct,
            weekendSpendRatio,
            lateWeekSpendRatio,
            obligationsAvailable: obligationSignal.available,
            obligationsCovered: obligationSignal.covered,
            overdueCents: obligationSignal.overdueCents,
            fixedObligationsCents: obligationSignal.fixedObligationsCents,
            obligationCount: obligationSignal.obligationCount,
            essentialsDelta,
            discretionaryDelta,
            largestIncreaseCategory: largestIncrease.category,
            largestIncreaseAmount: largestIncrease.deltaAmount,
            largestExpenseAmount: largestExpense.amount,
            largestExpenseCategory: largestExpense.category,
            largestExpenseCategoryKey: largestExpense.categoryKey
        })

        const digest = buildWeeklyDigestPayload({
            scenario,
            currencyCode: digestCurrencyCode,
            locale,
            window: digestWindow,
            currentWeekSpend,
            previousWeekSpend,
            currentWeekIncome,
            previousWeekIncome,
            weekOverWeekSpendDeltaPct,
            weekendSpendRatio,
            lateWeekSpendRatio,
            obligationsCovered: obligationSignal.covered,
            obligationsAvailable: obligationSignal.available,
            overdueCents: obligationSignal.overdueCents,
            fixedObligationsCents: obligationSignal.fixedObligationsCents,
            obligationCount: obligationSignal.obligationCount,
            topCategory,
            largestIncreaseCategory: largestIncrease.category,
            largestIncreaseAmount: largestIncrease.deltaAmount,
            largestExpenseAmount: largestExpense.amount,
            largestExpenseLabel: largestExpense.label,
            essentialsDelta,
            discretionaryDelta
        })
        const localizedDigest = await localizeWeeklyDigestContent(digest, locale)

        console.log(
            `[weekly_digest_generated] type=${localizedDigest.type} scenario=${localizedDigest.scenario_code} primary_driver=${localizedDigest.primary_driver || 'none'} secondary_driver=${localizedDigest.secondary_driver || 'none'} locale=${locale} tz=${digestWindow.timeZone} current_spend=${currentWeekSpend.toFixed(2)} previous_spend=${previousWeekSpend.toFixed(2)} current_income=${currentWeekIncome.toFixed(2)} fixed_obligations=${(obligationSignal.fixedObligationsCents / 100).toFixed(2)} weekend_ratio=${weekendSpendRatio.toFixed(2)} late_week_ratio=${lateWeekSpendRatio.toFixed(2)} obligations_covered=${obligationSignal.covered} confidence=${localizedDigest.confidence}`
        )

        await writeCachedWeeklyDigest(supabase, userId, weekKey, digestWindow, localizedDigest)
        return localizedDigest
    } catch (error) {
        console.error(`[weekly_digest_null_reason] reason=exception error=${String((error as Error)?.message || error)}`)
        return null
    }
}

function buildWeeklyDigestCacheKey(window: {
    currentWeekStartDate: string
    currentWeekEndDate: string
    timeZone: string
}, currencyCode: string = 'USD', locale: string = 'en'): string {
    // Weekly lock key rotates by week, timezone, main currency, and locale.
    // Without currency/locale, switching settings can return stale digest copy.
    const safeCurrency = normalizeCurrencyCode(currencyCode) || 'USD'
    const safeLocale = normalizeWiseyAnalyticsLocale(locale)
    return `wisey_analytics:${window.currentWeekStartDate}:${window.timeZone}:${safeCurrency}:${safeLocale}`
}

async function readCachedWeeklyDigest(
    supabase: any,
    userId: string,
    weekKey: string
): Promise<{ hit: boolean; digest: any | null }> {
    try {
        const { data, error } = await supabase
            .from('digests')
            .select('sections_json')
            .eq('user_id', userId)
            .eq('week_key', weekKey)
            .maybeSingle()

        if (error || !data) return { hit: false, digest: null }
        const sections = data.sections_json
        if (!sections || typeof sections !== 'object') return { hit: false, digest: null }
        if (!Object.prototype.hasOwnProperty.call(sections, 'weekly_digest')) return { hit: false, digest: null }
        return { hit: true, digest: sections.weekly_digest ?? null }
    } catch {
        return { hit: false, digest: null }
    }
}

async function writeCachedWeeklyDigest(
    supabase: any,
    userId: string,
    weekKey: string,
    window: {
        currentWeekStartDate: string
        currentWeekEndDate: string
        timeZone: string
    },
    digest: any | null
): Promise<void> {
    try {
        const sectionsJson = {
            source: 'wisey_analytics_weekly_digest_v1',
            week_start: window.currentWeekStartDate,
            week_end: window.currentWeekEndDate,
            timezone: window.timeZone,
            cached_at: new Date().toISOString(),
            weekly_digest: digest
        }

        const { error } = await supabase
            .from('digests')
            .upsert(
                {
                    user_id: userId,
                    week_key: weekKey,
                    sections_json: sectionsJson
                },
                { onConflict: 'user_id,week_key' }
            )

        if (error) {
            console.warn(`[weekly_digest_cache_write_failed] week_key=${weekKey} error=${error.message}`)
        }
    } catch (error) {
        console.warn(`[weekly_digest_cache_write_exception] week_key=${weekKey} error=${String((error as Error)?.message || error)}`)
    }
}

// FIX #4: Filter challenges to the requested month
function filterChallengesForMonth(challenges: any[], monthStart: string, monthEnd: string): any[] {
    const startMs = new Date(monthStart).getTime()
    const endMs = new Date(monthEnd).getTime()

    return challenges.filter(c => {
        const cStartMs = c.start_at ? new Date(c.start_at).getTime() : 0
        const cEndMs = c.end_at ? new Date(c.end_at).getTime() : endMs

        // Include if challenge overlaps with month window
        return (cStartMs >= startMs && cStartMs < endMs) ||  // starts in month
            (cEndMs >= startMs && cEndMs < endMs) ||      // ends in month
            (cStartMs <= startMs && cEndMs >= endMs)      // spans month
    })
}

// FIX #2: Updated to use toNumber() for all amount parsing
// FIX: Exclude balance-adjustment from income (these are wallet edits, not real income)
function calculateIncome(txns: any[]): number {
    return txns
        .filter(t => toNumber(t.amount) > 0)
        .filter(t => !isLegacyTransferCategory(t.category) && normalizeDigestCategoryKey(t.category) !== 'balance-adjustment')
        .reduce((sum, t) => sum + toNumber(t.amount), 0)
}

// FIX: Exclude Transfer and balance-adjustment from spending (these are not real expenses)
function calculateSpent(txns: any[]): number {
    return Math.abs(
        txns
            .filter(t => toNumber(t.amount) < 0)
            .filter(t => !isLegacyExcludedSpendingCategory(t.category))
            .reduce((sum, t) => sum + toNumber(t.amount), 0)
    )
}

// Calculate what % of spending happens on weekends (Sat/Sun)
// Uses same filters as calculateSpent for consistency
function calculateWeekendRatio(txns: any[], timeZone?: string): number {
    const spending = txns
        .filter(t => toNumber(t.amount) < 0)
        .filter(t => !isLegacyExcludedSpendingCategory(t.category))

    const weekendSpending = spending
        .filter(t => {
            let day = new Date(t.date).getDay()
            if (timeZone) {
                const rawDate = new Date(String(t.date))
                if (!Number.isFinite(rawDate.getTime())) return false
                const parts = getTimeZoneDateParts(rawDate, timeZone)
                day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
            }
            return day === 0 || day === 6  // Sun=0, Sat=6
        })
        .reduce((sum, t) => sum + Math.abs(toNumber(t.amount)), 0)

    const totalSpending = spending.reduce((sum, t) => sum + Math.abs(toNumber(t.amount)), 0)
    return totalSpending > 0 ? weekendSpending / totalSpending : 0
}

/**
 * Calculate net change in SAVINGS wallets for the month (Savings Rate v2)
 * 
 * Returns the sum of ALL transactions (deposits + withdrawals + transfers) 
 * to wallets with type='savings' during the month.
 * 
 * Example:
 * - Savings wallet: +$800, +$200, -$100 = +$900 net
 */
async function calculateSavingsWalletChange(
    supabase: any,
    userId: string,
    monthStart: string,
    monthEnd: string
): Promise<number> {
    // Get all savings-type wallets for this user
    const { data: savingsWallets, error: walletError } = await supabase
        .from('wallets')
        .select('id')
        .eq('user_id', userId)
        .eq('type', 'savings')

    if (walletError) {
        console.error(`[SavingsCalc] Failed to fetch wallets: ${walletError.message}`)
        throw new Error(`Failed to fetch savings wallets: ${walletError.message}`)
    }

    if (!savingsWallets || savingsWallets.length === 0) {
        console.log(`[SavingsCalc] user=${userId.substring(0, 8)} month=${monthStart.substring(0, 7)} wallets=0 txns=0 net=0`)
        return 0
    }

    // Sum ALL transactions to savings wallets in this month
    const walletIds = savingsWallets.map((w: any) => w.id)

    const { data: txns, error: txnError } = await supabase
        .from('wallet_transactions')
        .select('amount')
        .eq('user_id', userId)
        .in('wallet_id', walletIds)
        .gte('date', monthStart)
        .lt('date', monthEnd)

    if (txnError) {
        console.error(`[SavingsCalc] Failed to fetch transactions: ${txnError.message}`)
        throw new Error(`Failed to fetch savings transactions: ${txnError.message}`)
    }

    const netSavings = txns?.reduce((sum: number, t: any) => sum + toNumber(t.amount), 0) || 0

    // Single summary log line
    console.log(`[SavingsCalc] user=${userId.substring(0, 8)} month=${monthStart.substring(0, 7)} wallets=${savingsWallets.length} txns=${txns?.length || 0} net=${netSavings}`)

    return netSavings
}

/**
 * Calculate Savings Rate Score (0-10)
 * 
 * V2 CHANGE (Dec 2025):
 * Now uses net change in SAVINGS wallet instead of (income - spent)
 * to measure intentional saving behavior.
 */
async function calculateSavingsRateScore(
    supabase: any,
    userId: string,
    monthStart: string,
    monthEnd: string,
    income: number,
    peerAvgRate: number
): Promise<number> {
    // Edge case: no income (prevents divide-by-zero)
    if (income <= 0) {
        return 5.0  // Neutral score for no-income scenarios
    }

    // V2: Calculate savings as net change in SAVINGS wallet
    const netSavings = await calculateSavingsWalletChange(supabase, userId, monthStart, monthEnd)
    const savingsRate = netSavings / income

    let baseScore = 0

    // Tiered scoring based on savings rate
    // Note: savingsRate can be negative if user withdrew more than deposited
    if (savingsRate >= 0.30) baseScore = 10.0      // Excellent: 30%+ savings
    else if (savingsRate >= 0.20) baseScore = 8.0  // Great: 20-30%
    else if (savingsRate >= 0.15) baseScore = 6.5  // Good: 15-20%
    else if (savingsRate >= 0.10) baseScore = 5.0  // Average: 10-15%
    else if (savingsRate >= 0.05) baseScore = 3.0  // Below average: 5-10%
    else if (savingsRate > 0) baseScore = 2.0     // Low: 0-5%
    else baseScore = 1.0                           // Deficit: negative or zero savings

    // Bonus for beating peer average (capped in final return)
    if (peerAvgRate > 0 && savingsRate > peerAvgRate) {
        baseScore += 2.0
    }

    // Clamp to 0-10 range
    return Math.max(0, Math.min(baseScore, 10))
}


// Spending Consistency Score - measures daily spending stability
// Uses Coefficient of Variation (CV) = stdDev / mean
function calculateConsistencyScore(txns: any[]): number {
    if (txns.length < 7) return 5.0  // Not enough data

    // Group spending by day
    const dailySpend: Record<string, number> = {}
    txns.filter(t => toNumber(t.amount) < 0).forEach(t => {
        const day = String(t.date).substring(0, 10)
        dailySpend[day] = (dailySpend[day] || 0) + Math.abs(toNumber(t.amount))
    })

    const values = Object.values(dailySpend)
    if (values.length < 7) return 5.0  // Need at least 7 days

    const mean = values.reduce((a, b) => a + b, 0) / values.length

    // Edge case: very low mean spending (prevent CV explosion)
    // Use epsilon to ensure stability
    const EPSILON = 1.0  // $1 minimum for meaningful CV
    if (mean < EPSILON) {
        // Low/no spending = highly consistent (by definition)
        return 9.0
    }

    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
    const stdDev = Math.sqrt(variance)
    const cv = stdDev / mean  // Safe: mean >= EPSILON

    // Score based on CV (lower = more consistent)
    if (cv <= 0.30) return 10.0  // Very stable
    if (cv <= 0.50) return 8.0   // Stable
    if (cv <= 0.75) return 6.0   // Moderate
    if (cv <= 1.00) return 4.0   // Variable
    return 2.0                    // Erratic
}


// Challenge Engagement Score - measures challenge participation and success
function calculateChallengeScore(challenges: any[]): number {
    const active = challenges.filter(c => c.status === 'active').length
    const completed = challenges.filter(c => c.status === 'completed').length
    const failed = challenges.filter(c => c.status === 'failed').length

    const totalAttempted = completed + failed

    // New user with no challenges = neutral score
    if (totalAttempted === 0 && active === 0) {
        return 5.0
    }

    // Calculate completion rate (0 to 1)
    const completionRate = totalAttempted > 0 ? completed / totalAttempted : 0

    // Base score from completion rate (0-8 range, changed from 0-6 to allow reaching 10)
    let baseScore = completionRate * 8.0

    // Active challenge bonus (+2)
    const activeBonus = active > 0 ? 2.0 : 0

    // If no attempts but has active challenge, give base credit
    if (totalAttempted === 0 && active > 0) {
        baseScore = 4.0  // Starting = good effort
    }

    // Clamp to 0-10 range
    return Math.max(0, Math.min(baseScore + activeBonus, 10))
}


// Streak Momentum Score - measures daily activity consistency
function calculateStreakScore(currentStreak: number, bestStreak: number): number {
    let baseScore = 0

    // Tiered scoring based on streak length
    if (currentStreak >= 30) baseScore = 10.0      // Master: 30+ days
    else if (currentStreak >= 21) baseScore = 8.5  // Strong: 3 weeks
    else if (currentStreak >= 14) baseScore = 7.0  // Good: 2 weeks
    else if (currentStreak >= 7) baseScore = 5.5   // Building: 1 week
    else if (currentStreak >= 3) baseScore = 4.0   // Starting: 3 days
    else if (currentStreak >= 1) baseScore = 2.0   // Just started
    else baseScore = 0.0                           // No streak

    // Bonus for approaching personal best (+1.5 if within 80% of best)
    if (bestStreak > 0 && currentStreak >= bestStreak * 0.8) {
        baseScore += 1.5
    }

    // Clamp to 0-10 range
    return Math.max(0, Math.min(baseScore, 10))
}


// ============================================================
// WISEY SCORE V2 FUNCTIONS
// ============================================================

function dateFromIsoOrMillis(value: any): Date | null {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value
    if (typeof value === 'number') {
        const d = new Date(value)
        return isNaN(d.getTime()) ? null : d
    }
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (/^\d+$/.test(trimmed)) {
            const d = new Date(Number(trimmed))
            return isNaN(d.getTime()) ? null : d
        }
        const d = new Date(trimmed)
        return isNaN(d.getTime()) ? null : d
    }
    return null
}

function isChallengeGoalRow(g: any): boolean {
    return g?.goal_type === 'CHALLENGE' || g?.is_challenge === true || (typeof g?.challenge_type === 'string' && g.challenge_type.trim().length > 0)
}

function isWishGoalRow(g: any): boolean {
    if (isChallengeGoalRow(g)) return false
    if (g?.is_wish === true) return true
    if (g?.is_wish === false) return false
    return getGoalTargetCents(g) <= 0
}

function getGoalTargetCents(g: any): number {
    return toNumber(g?.target_cents ?? g?.target_amount_cents ?? g?.target_amount ?? 0)
}

function getGoalCurrentCents(g: any): number {
    return toNumber(g?.current_cents ?? g?.current_amount_cents ?? g?.current_amount ?? 0)
}

async function calculateGoalsHealthV2(
    supabase: any,
    userId: string,
    monthStart: string,
    monthEnd: string
): Promise<{ score: number, hasGoals: boolean }> {
    // V2 FIX: Include ALL goal types except CHALLENGE (don't over-restrict)
    const { data: allGoals } = await supabase
        .from('goals')
        .select('*')
        .eq('user_id', userId)

    // Wishes live in the same table today, but they are not goal-progress rows for scoring.
    const goals = (allGoals || []).filter((g: any) =>
        !isChallengeGoalRow(g) && !isWishGoalRow(g)
    )

    const activeGoals = goals.filter((g: any) => {
        const target = getGoalTargetCents(g)
        const current = getGoalCurrentCents(g)
        const progress = target > 0 ? (current / target) : 0
        return progress < 1.0
    })

    if (activeGoals.length === 0) {
        return { score: 0, hasGoals: false }
    }

    let totalScore = 0

    for (const goal of activeGoals) {
        // V2 FIX: Match wallet_transactions.goal_id against both goal.id and goal.client_goal_id
        // (older data stored client UUID in goal_id field directly)
        const goalIds = [goal.id, goal.client_goal_id].filter(Boolean)
        const { data: lastDeposit } = await supabase
            .from('wallet_transactions')
            .select('date')
            .eq('user_id', userId)
            .in('goal_id', goalIds)
            .lt('amount', 0)
            .order('date', { ascending: false })
            .limit(1)
            .maybeSingle()

        let activityScore = 0
        if (lastDeposit) {
            const lastDate = new Date(lastDeposit.date)
            const now = new Date()
            const daysSince = Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24))

            if (daysSince <= 7) activityScore = 5
            else if (daysSince <= 14) activityScore = 3
            else if (daysSince <= 30) activityScore = 1
            else activityScore = 0
        }

        const target = getGoalTargetCents(goal)
        const current = getGoalCurrentCents(goal)
        const progress = target > 0 ? (current / target) : 0
        let progressScore = 0

        const startDate = dateFromIsoOrMillis(goal.start_date) || dateFromIsoOrMillis(goal.created_at_millis) || dateFromIsoOrMillis(goal.created_at) || new Date()
        const deadlineDate = dateFromIsoOrMillis(goal.deadline) || dateFromIsoOrMillis(goal.target_date_millis)

        if (deadlineDate) {
            const deadline = deadlineDate
            const now = new Date()
            const totalDays = Math.max(1, (deadline.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
            const daysPassed = Math.max(0, (now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
            const expectedProgress = Math.min(1, daysPassed / totalDays)
            const progressDiff = progress - expectedProgress

            if (progressDiff >= 0.10) progressScore = 5
            else if (progressDiff >= 0) progressScore = 4
            else if (progressDiff >= -0.20) progressScore = 3
            else if (progressDiff >= -0.40) progressScore = 2
            else progressScore = 1
        } else {
            if (progress >= 0.75) progressScore = 5
            else if (progress >= 0.50) progressScore = 4
            else if (progress >= 0.25) progressScore = 3
            else if (progress >= 0.10) progressScore = 2
            else progressScore = 1
        }

        const goalScore = (activityScore + progressScore) / 2
        totalScore += goalScore
    }

    const finalScore = Math.min(10, totalScore / activeGoals.length)
    return { score: finalScore, hasGoals: true }
}

async function calculateChallengeScoreV2(
    supabase: any,
    userId: string,
    goals: any[],
    monthStart: string,
    monthEnd: string
): Promise<{ score: number, hasWiseyChallenges: boolean }> {
    const wiseyChallenges = goals.filter((g: any) =>
        isChallengeGoalRow(g) &&
        g.note &&
        String(g.note).includes('baseline8d_cents=')
    )

    if (wiseyChallenges.length === 0) {
        return { score: 0, hasWiseyChallenges: false }
    }

    let totalPoints = 0

    for (const challenge of wiseyChallenges) {
        const startDate = dateFromIsoOrMillis(challenge.start_date) || dateFromIsoOrMillis(challenge.created_at_millis) || dateFromIsoOrMillis(challenge.created_at) || new Date()
        const endDate: Date | null = dateFromIsoOrMillis(challenge.deadline) || dateFromIsoOrMillis(challenge.target_date_millis)

        const { data: allExpenses } = await supabase
            .from('wallet_transactions')
            .select('date, amount')
            .eq('user_id', userId)
            .lt('amount', 0)
            .gte('date', startDate.toISOString())
            .lt('date', endDate ? endDate.toISOString() : monthEnd)

        const expensesByDay: Record<string, number> = {}
        for (const txn of allExpenses || []) {
            const day = String(txn.date).substring(0, 10)
            expensesByDay[day] = (expensesByDay[day] || 0) + Math.abs(toNumber(txn.amount))
        }

        let successfulDays = 0
        const today = new Date()
        const checkEnd = endDate && endDate < today ? endDate : today

        // V2 FIX: Use UTC day iteration to prevent timezone off-by-one
        const startUTC = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate())
        const endUTC = Date.UTC(checkEnd.getUTCFullYear(), checkEnd.getUTCMonth(), checkEnd.getUTCDate())

        for (let time = startUTC; time <= endUTC; time += 86400000) {
            const d = new Date(time)
            const dayStr = d.toISOString().substring(0, 10)
            const dailySpend = expensesByDay[dayStr] || 0
            if (dailySpend === 0) {
                successfulDays++
            }
        }

        totalPoints += successfulDays

        const status = String(challenge.status || '').toLowerCase()
        if (status === 'completed') {
            totalPoints += 5
        }
        if (status === 'failed') {
            totalPoints -= 3
        }
    }

    const score = Math.max(0, Math.min(totalPoints / 2, 10))
    return { score, hasWiseyChallenges: true }
}


function calculateDynamicWeights(hasGoals: boolean, hasWiseyChallenges: boolean): {
    savings: number,
    consistency: number,
    goals: number,
    challenges: number
} {
    if (hasGoals && hasWiseyChallenges) {
        return { savings: 0.40, consistency: 0.30, goals: 0.15, challenges: 0.15 }
    } else if (hasGoals) {
        return { savings: 0.45, consistency: 0.40, goals: 0.15, challenges: 0 }
    } else if (hasWiseyChallenges) {
        return { savings: 0.45, consistency: 0.40, goals: 0, challenges: 0.15 }
    } else {
        return { savings: 0.50, consistency: 0.50, goals: 0, challenges: 0 }
    }
}


// FIX #2: Updated to use toNumber()
/**
 * Calculate Spending Personality (MVP: 4 types)
 * Types: steady_saver, balanced_spender, growth_focused, explorer
 * Streak: Always use real XP streak (current_streak_days)
 */
async function calculateSpendingPersonality(
    supabaseAdmin: any,
    userId: string,
    month: string,
    txns: any[],
    income: number,
    spent: number,
    xpStreakDays: number
): Promise<any> {
    const txnCount = txns.filter(t => toNumber(t.amount) < 0).length

    // Fallback for new/low-data users
    if (txnCount < 5) {
        return {
            type: 'explorer',
            emoji: '🌱',
            title: 'Financial Explorer',
            description: 'Just getting started! Add more transactions to discover your spending personality.',
            streak_days: xpStreakDays  // Real XP streak
        }
    }

    // Calculate metrics for personality assignment
    const savingsRate = income > 0 ? (income - spent) / income : 0
    const variance = calculateVariance(txns)

    // Steady Saver: High savings rate (>20%) + Low variance (<30%)
    if (savingsRate >= 0.20 && variance < 0.30) {
        return {
            type: 'steady_saver',
            emoji: '🐢',
            title: 'The Steady Saver',
            description: `You're consistent and disciplined with your spending. ${getSavingsComparison(savingsRate)} Keep it up! 💪`,
            streak_days: xpStreakDays  // Real XP streak
        }
    }

    // Growth Focused: Check if savings improved vs previous month
    const prevMonth = getPrevMonth(month)
    const prevMonthStart = `${prevMonth}-01T00:00:00Z`
    const prevMonthEnd = getNextMonth(prevMonth) + '-01T00:00:00Z'

    const { data: prevTxns } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount')
        .eq('user_id', userId)
        .gte('date', prevMonthStart)
        .lt('date', prevMonthEnd)

    // Check expense count for consistency with main txnCount logic
    const prevExpenseCount = prevTxns ? prevTxns.filter((t: any) => toNumber(t.amount) < 0).length : 0

    if (prevExpenseCount >= 5) {
        const prevIncome = calculateIncome(prevTxns || [])
        const prevSpent = calculateSpent(prevTxns || [])
        const prevSavingsRate = prevIncome > 0 ? (prevIncome - prevSpent) / prevIncome : 0

        // Growth Focused: Savings rate improved by at least 5% vs last month
        if (savingsRate > prevSavingsRate && (savingsRate - prevSavingsRate) >= 0.05) {
            const improvement = Math.round((savingsRate - prevSavingsRate) * 100)
            return {
                type: 'growth_focused',
                emoji: '🌱',
                title: 'The Growth Seeker',
                description: `You're building great habits! Your savings improved by ${improvement}% this month. Keep growing! 📈`,
                streak_days: xpStreakDays  // Real XP streak
            }
        }
    }

    // Default: Balanced Spender
    return {
        type: 'balanced_spender',
        emoji: '🌊',
        title: 'The Balanced Spender',
        description: 'You know when to save and when to treat yourself. Your flexible approach works well for your lifestyle. 💙',
        streak_days: xpStreakDays  // Real XP streak
    }
}

/**
 * Calculate spending variance (coefficient of variation)
 */
function calculateVariance(txns: any[]): number {
    const dailySpend: Record<string, number> = {}

    txns.filter(t => toNumber(t.amount) < 0).forEach(t => {
        const day = String(t.date).substring(0, 10)
        dailySpend[day] = (dailySpend[day] || 0) + Math.abs(toNumber(t.amount))
    })

    const values = Object.values(dailySpend)
    if (values.length < 3) return 0.5  // Default medium variance

    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length
    const stdDev = Math.sqrt(variance)

    return mean > 0 ? stdDev / mean : 0.5
}

/**
 * Get savings comparison text
 */
function getSavingsComparison(savingsRate: number): string {
    if (savingsRate >= 0.30) return "Your 30%+ savings rate is exceptional!"
    if (savingsRate >= 0.25) return "Saving 25%+ puts you ahead of most people."
    return "Your savings discipline is impressive."
}


// Compute the cycle-income bucket_month for the given month + cycleStartDay.
// Mirrors the SQL formula: DATE_TRUNC('month', midpoint_of_cycle).
function computePeerBucketMonth(month: string, cycleStartDay: number): string {
    const anchorDate = `${month}-15` // mid-month anchor to find the right cycle
    const cycleStartDate = getCycleStartDateForAnchor(anchorDate, cycleStartDay)
    const nextCycleStart = getNextCycleStartDate(cycleStartDate, cycleStartDay)
    const cycleEndDate = addDaysToDateOnly(nextCycleStart, -1)

    const startMs = new Date(cycleStartDate + 'T00:00:00Z').getTime()
    const endMs   = new Date(cycleEndDate   + 'T00:00:00Z').getTime()
    const midMs   = Math.round((startMs + endMs) / 2)
    const mid     = new Date(midMs)

    const y = mid.getUTCFullYear()
    const m = String(mid.getUTCMonth() + 1).padStart(2, '0')
    return `${y}-${m}-01`
}

// Peer rankings - tries cycle-income RPC first, then returns static fallback.
export async function getPeerRankings(
    supabaseAdmin: any,
    supabaseUser: any,
    userId: string,
    month: string,
    cycleStartDay: number = 1
): Promise<any> {
    const legacyFallback = { avgSavingsRate: 0.15, avgSpendingRatio: 0.65, avgWeekendRatio: 0.30, avgScore: 5.0, peerCount: 0 }
    void supabaseUser

    // Attempt new cycle-income RPC.
    try {
        // 1. Get user's stored income anchor + bucket_month from most recent completed cycle
        const { data: cycleRow } = await supabaseAdmin
            .from('user_cycle_scores')
            .select('income_anchor_normalized, bucket_month')
            .eq('user_id', userId)
            .order('cycle_end_date', { ascending: false })
            .limit(1)
            .maybeSingle()

        const incomeAnchorUsd: number | null = cycleRow?.income_anchor_normalized ?? null

        // 2. Use the stored bucket_month from the last completed cycle.
        //    (The current in-progress cycle has no peers yet — backfill only runs on closed cycles.)
        const bucketMonth: string = cycleRow?.bucket_month
            ? cycleRow.bucket_month.slice(0, 7) + '-01'   // normalize DATE → YYYY-MM-01
            : computePeerBucketMonth(month, cycleStartDay) // fallback if no row yet

        console.log(`[PeerRankings] userId=${userId} month=${month} cycleStartDay=${cycleStartDay} bucketMonth=${bucketMonth} incomeAnchorUsd=${incomeAnchorUsd}`)

        // 3. Call new RPC - only if we have a stored anchor (backfill has run for this user)
        if (incomeAnchorUsd !== null && incomeAnchorUsd > 0) {
            const { data: peerData, error: peerError } = await supabaseAdmin
                .rpc('get_peer_averages_by_cycle_income', {
                    p_user_id:           userId,
                    p_bucket_month:      bucketMonth,
                    p_income_anchor_usd: incomeAnchorUsd,
                    p_min_peer_count:    2
                })
                .single()

            if (!peerError && peerData) {
                const hasSufficient = peerData.has_sufficient_peers === true
                console.log(`[PeerRankings] cycle-income RPC: peerCount=${peerData.peer_count} band=${peerData.peer_band_label} hasSufficient=${hasSufficient}`)

                if (!hasSufficient) {
                    // Not enough peers in band - hide the section (peerCount=0 signals UI to hide)
                    return legacyFallback
                }

                return {
                    avgSavingsRate:   valueOrFallback(peerData.avg_savings_rate,   0.15),
                    avgSpendingRatio: valueOrFallback(peerData.avg_spending_ratio,  0.65),
                    avgWeekendRatio:  valueOrFallback(peerData.avg_weekend_ratio,   0.30),
                    avgScore:         valueOrFallback(peerData.avg_score,            5.0),
                    peerCount:        peerData.peer_count ?? 0,
                    peerBandLabel:    peerData.peer_band_label ?? null
                }
            }

            console.warn(`[PeerRankings] cycle-income RPC failed: ${peerError?.message} - falling back to static baseline`)
        } else {
            console.log(`[PeerRankings] No stored income anchor for user ${userId} - falling back to static baseline`)
        }
    } catch (err: any) {
        console.warn(`[PeerRankings] cycle-income path threw: ${err?.message} - falling back to static baseline`)
    }

    return legacyFallback
}

async function getPersonalityFromHistory(
    supabase: any,
    userId: string,
    month: string,
    xpStreakDays: number  // Real XP streak (always)
): Promise<any> {
    const { data } = await supabase
        .from('spending_personality_history')
        .select('*')
        .eq('user_id', userId)
        .eq('month', month)
        .maybeSingle()

    if (!data) {
        return {
            type: 'explorer',
            emoji: '🌱',
            title: 'Financial Explorer',
            description: 'Getting started!',
            streak_days: xpStreakDays  // Real XP streak
        }
    }

    const types: Record<string, { emoji: string; title: string; description: string }> = {
        steady_saver: { emoji: '🐢', title: 'The Steady Saver', description: "You're consistent and disciplined with your spending. Keep it up! 💪" },
        balanced_spender: { emoji: '🌊', title: 'The Balanced Spender', description: 'You know when to save and when to treat yourself. Your flexible approach works well for your lifestyle. 💙' },
        growth_focused: { emoji: '🌱', title: 'The Growth Seeker', description: "You're building great habits! Keep growing! 📈" },
        explorer: { emoji: '🌱', title: 'Financial Explorer', description: 'Just getting started! Add more transactions to discover your spending personality.' }
    }

    const typeInfo = types[data.personality_type] || types.explorer

    return {
        type: data.personality_type,
        emoji: typeInfo.emoji,
        title: typeInfo.title,
        description: typeInfo.description,
        streak_days: xpStreakDays  // ALWAYS use real XP streak (not cached month_streak_days)
    }
}

async function checkAndAwardBadges(supabaseAdmin: any, userId: string, metrics: any) {
    const eligibleBadges: string[] = []

    const month: string | undefined = metrics.month
    const monthStart: string | undefined = metrics.monthStart
    const monthEnd: string | undefined = metrics.monthEnd
    const currentTxns: any[] | undefined = metrics.txns

    const monthTxnsCache = new Map<string, Promise<any[]>>()

    async function fetchMonthTxns(targetMonth: string): Promise<any[]> {
        const cached = monthTxnsCache.get(targetMonth)
        if (cached) return await cached

        const p = (async () => {
            const start = `${targetMonth}-01T00:00:00Z`
            const end = getNextMonth(targetMonth) + '-01T00:00:00Z'

            const { data, error } = await supabaseAdmin
                .from('wallet_transactions')
                .select('amount, category, date')
                .eq('user_id', userId)
                .gte('date', start)
                .lt('date', end)

            if (error) return []
            return data || []
        })()

        monthTxnsCache.set(targetMonth, p)
        return await p
    }

    function computeSaved(txns: any[]): number {
        const income = calculateIncome(txns)
        const spent = calculateSpent(txns)
        return income - spent
    }

    function computeSpent(txns: any[]): number {
        return calculateSpent(txns)
    }

    function computeSpendByCategory(txns: any[]): Record<string, number> {
        const byCat: Record<string, number> = {}
        for (const t of txns) {
            const amt = toNumber(t.amount)
            if (amt >= 0) continue
            const cat = String(t.category || 'Other')
            byCat[cat] = (byCat[cat] || 0) + Math.abs(amt)
        }
        return byCat
    }

    function hasUnderAverageStreak(monthStr: string, txns: any[], streakDays: number): boolean {
        const [year, mon] = monthStr.split('-').map(Number)
        const daysInMonth = new Date(year, mon, 0).getDate()
        if (daysInMonth <= 0) return false

        const dailySpend: Record<string, number> = {}
        for (const t of txns) {
            const amt = toNumber(t.amount)
            if (amt >= 0) continue
            const day = String(t.date).substring(0, 10)
            dailySpend[day] = (dailySpend[day] || 0) + Math.abs(amt)
        }

        const totalSpent = Object.values(dailySpend).reduce((a, b) => a + b, 0)
        const dailyAvg = totalSpent / daysInMonth

        let current = 0
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`
            const spent = dailySpend[dateStr] || 0
            if (spent <= dailyAvg) {
                current += 1
                if (current >= streakDays) return true
            } else {
                current = 0
            }
        }

        return false
    }

    function getMaxNoSpendStreak(daysSpent: Record<string, number>, startIso: string, endIso: string): number {
        let current = 0
        let max = 0

        const start = new Date(startIso)
        const end = new Date(endIso)
        for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
            const yyyy = d.getUTCFullYear()
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
            const dd = String(d.getUTCDate()).padStart(2, '0')
            const key = `${yyyy}-${mm}-${dd}`
            const spent = daysSpent[key] || 0

            if (spent <= 0) {
                current += 1
                if (current > max) max = current
            } else {
                current = 0
            }
        }

        return max
    }

    // ========== A. SAVINGS BADGES (3) ==========

    // 1. First Save: Save >$50 in first month
    if (monthStart && metrics.income > 0 && (metrics.income - metrics.spent) >= 50) {
        const { data: olderTxn } = await supabaseAdmin
            .from('wallet_transactions')
            .select('id')
            .eq('user_id', userId)
            .lt('date', monthStart)
            .limit(1)
            .maybeSingle()

        // Only award if this is the user's first month of tracked transactions
        if (!olderTxn) {
            eligibleBadges.push('first_save')
        }
    }

    // 2. Savings Champion: Save >30% of income in a month
    if (metrics.savingsRate >= 0.30) {
        eligibleBadges.push('savings_champion')
    }

    // 3. Growth Streak: Increase savings 3 months in a row (requires history - skip for now)
    if (month && currentTxns && currentTxns.length > 0) {
        const prev1Month = getPrevMonth(month)
        const prev2Month = getPrevMonth(prev1Month)

        const [prev1Txns, prev2Txns] = await Promise.all([
            fetchMonthTxns(prev1Month),
            fetchMonthTxns(prev2Month)
        ])

        if (prev1Txns.length > 0 && prev2Txns.length > 0) {
            const savedPrev2 = computeSaved(prev2Txns)
            const savedPrev1 = computeSaved(prev1Txns)
            const savedCurr = (metrics.income || 0) - (metrics.spent || 0)

            if (savedPrev2 < savedPrev1 && savedPrev1 < savedCurr) {
                eligibleBadges.push('growth_streak')
            }
        }
    }

    // ========== B. SPENDING CONTROL BADGES (3) ==========

    // 4. Budget Master: Stay under monthly average for 14 consecutive days
    if (month && currentTxns && hasUnderAverageStreak(month, currentTxns, 14)) {
        eligibleBadges.push('budget_master')
    }

    // 5. Category Champion: Reduce spending in any category by >25% vs last month
    if (month && currentTxns && currentTxns.length > 0) {
        const prevMonth = getPrevMonth(month)
        const prevTxns = await fetchMonthTxns(prevMonth)

        if (prevTxns.length > 0) {
            const prevByCat = computeSpendByCategory(prevTxns)
            const currByCat = computeSpendByCategory(currentTxns)

            for (const [cat, prevSpend] of Object.entries(prevByCat)) {
                const currSpend = currByCat[cat] || 0
                if (prevSpend > 0 && currSpend <= prevSpend * 0.75) {
                    eligibleBadges.push('category_champion')
                    break
                }
            }
        }
    }

    // 6. Downtrend Legend: Spend less than previous month for 3 months straight
    if (month && currentTxns && currentTxns.length > 0) {
        const prev1Month = getPrevMonth(month)
        const prev2Month = getPrevMonth(prev1Month)

        const [prev1Txns, prev2Txns] = await Promise.all([
            fetchMonthTxns(prev1Month),
            fetchMonthTxns(prev2Month)
        ])

        if (prev1Txns.length > 0 && prev2Txns.length > 0) {
            const spentPrev2 = computeSpent(prev2Txns)
            const spentPrev1 = computeSpent(prev1Txns)
            const spentCurr = metrics.spent || 0

            if (spentPrev2 > spentPrev1 && spentPrev1 > spentCurr) {
                eligibleBadges.push('downtrend_legend')
            }
        }
    }

    // ========== C. CHALLENGE BADGES (3) ==========

    // 7. Challenge Starter: Complete first challenge (any type)
    const completedChallenges = metrics.challenges?.filter((c: any) => c.status === 'completed') || []
    if (completedChallenges.length >= 1) {
        eligibleBadges.push('challenge_starter')
    }

    // 8. Streak Master: Maintain 14-day streak
    if (metrics.streakDays >= 14) {
        eligibleBadges.push('streak_master')
    }

    // 9. Triple Threat: Have 3 active challenges running simultaneously
    const activeChallenges = metrics.challenges?.filter((c: any) => c.status === 'active') || []
    if (activeChallenges.length >= 3) {
        eligibleBadges.push('triple_threat')
    }

    // ========== D. CONSISTENCY BADGES (3) ==========

    // 10. No-Spend Week: 7 consecutive no-spend days
    if (month && monthStart && monthEnd && currentTxns) {
        const start = new Date(monthStart)
        start.setUTCDate(start.getUTCDate() - 6)
        const streakStartIso = start.toISOString()

        const prevMonth = getPrevMonth(month)
        const prevTxns = await fetchMonthTxns(prevMonth)

        const daySpent: Record<string, number> = {}
        for (const t of prevTxns) {
            const amt = toNumber(t.amount)
            if (amt >= 0) continue
            const day = String(t.date).substring(0, 10)
            if (day < String(monthStart).substring(0, 10)) {
                daySpent[day] = (daySpent[day] || 0) + Math.abs(amt)
            }
        }

        for (const t of currentTxns) {
            const amt = toNumber(t.amount)
            if (amt >= 0) continue
            const day = String(t.date).substring(0, 10)
            daySpent[day] = (daySpent[day] || 0) + Math.abs(amt)
        }

        const maxStreak = getMaxNoSpendStreak(daySpent, streakStartIso, monthEnd)
        if (maxStreak >= 7) {
            eligibleBadges.push('no_spend_week')
        }
    }

    // 11. Steady Eddie: Spending variance <30% (CV) for entire month (consistencyScore = 10)
    if (metrics.consistencyScore && metrics.consistencyScore >= 10.0) {
        eligibleBadges.push('steady_eddie')
    }

    // 12. Month Mastery: Hit all 4 Wisey Score components above 7.0 in one month
    if (metrics.savingsRateScore >= 7.0 &&
        metrics.consistencyScore >= 7.0 &&
        metrics.challengeScore >= 7.0 &&
        metrics.streakScore >= 7.0) {
        eligibleBadges.push('month_mastery')
    }

    // Award each eligible badge (idempotent via UNIQUE constraint)
    for (const badgeId of eligibleBadges) {
        try {
            const { data: badge, error } = await supabaseAdmin
                .from('user_badges')
                .insert({
                    user_id: userId,
                    badge_id: badgeId,
                    xp_awarded: BADGE_XP_MAP[badgeId] || 100
                })
                .select()
                .single()

            // If badge was actually inserted (not duplicate)
            if (badge && !error) {
                await awardXpIdempotent(supabaseAdmin, userId, BADGE_XP_MAP[badgeId] || 100, 'badge_earned', badgeId)
            }
        } catch (e) {
            // Ignore duplicate key errors
        }
    }
}

async function awardXpIdempotent(supabaseAdmin: any, userId: string, xpAmount: number, reason: string, refId: string) {
    try {
        const { data, error } = await supabaseAdmin
            .from('xp_transactions')
            .insert({
                user_id: userId,
                xp_amount: xpAmount,
                reason: reason,
                reference_id: refId
            })
            .select()
            .single()

        if (data && !error) {
            await supabaseAdmin.rpc('increment_user_xp', {
                p_user_id: userId,
                p_xp_amount: xpAmount
            })
        }
    } catch (e) {
        // Ignore duplicate key errors
    }
}


function buildNewUserScore(): any {
    return {
        version: 2,
        total: 5.0,
        breakdown: [
            {
                name: 'Savings Rate',
                score: 5.0,
                weight: 0.50,
                emoji: '💰'
            },
            {
                name: 'Spending Consistency',
                score: 5.0,
                weight: 0.50,
                emoji: '📊'
            }
        ]
    }
}


// Comparison cards - only uses real peer data from RPC
// V2: Uses wallet-based savings rate
// V3: Added Spending Control card
function buildComparisonCards(txns: any[], rankings: any, netSavings: number): any[] {
    const spent = calculateSpent(txns)
    const income = calculateIncome(txns)
    const savingsRate = income > 0 ? netSavings / income : 0
    const spendingRatio = income > 0 ? spent / income : 0

    console.log(`[ComparisonCards] txns=${txns.length}, spent=${spent}, income=${income}, netSavings=${netSavings}, savingsRate=${(savingsRate * 100).toFixed(1)}%, spendingRatio=${(spendingRatio * 100).toFixed(1)}%`)

    const cards: any[] = []

    // Card 1: Savings Rate (uses real peer average from RPC)
    const peerSavingsRate = toNumber(rankings.avgSavingsRate)  // Already has 0.15 fallback
    const hasPeerData = rankings.peerCount > 0

    if (income > 0) {
        cards.push({
            id: 'savings_rate',
            emoji: '💰',
            title: 'Savings Rate',
            your_value: Number((savingsRate * 100).toFixed(1)),
            peer_average: Number((peerSavingsRate * 100).toFixed(1)),
            percentile: savingsRate > peerSavingsRate ? 75 : 45,
            result_text: hasPeerData
                ? (savingsRate > peerSavingsRate
                    ? `Saving ${((savingsRate - peerSavingsRate) * 100).toFixed(0)}% more than peers!`
                    : `${((peerSavingsRate - savingsRate) * 100).toFixed(0)}% below peer average`)
                : `You're saving ${(savingsRate * 100).toFixed(0)}% of income`,
            is_positive: savingsRate > peerSavingsRate,
            has_peer_data: hasPeerData
        })
    }

    // Card 2: Spending Control (spending-to-income ratio)
    // Lower is better - spending less of income on expenses
    const peerSpendingRatio = toNumber(rankings.avgSpendingRatio)  // Has 0.65 fallback like savings_rate
    const hasSpendingPeerData = rankings.peerCount > 0  // Match savings_rate pattern

    console.log(`[SpendingControl] peerCount=${rankings.peerCount}, avgSpendingRatio=${rankings.avgSpendingRatio}, hasPeerData=${hasSpendingPeerData}, peerSpendingRatio=${peerSpendingRatio}`)

    if (income > 0) {
        // For spending ratio, LOWER is better (more controlled spending)
        const isPositive = spendingRatio < peerSpendingRatio
        const diffPercent = Math.abs(spendingRatio - peerSpendingRatio) * 100

        cards.push({
            id: 'spending_control',
            emoji: '📊',
            title: 'Spending Control',
            your_value: Number((spendingRatio * 100).toFixed(1)),
            peer_average: Number((peerSpendingRatio * 100).toFixed(1)),
            percentile: isPositive ? 70 : 40,
            result_text: hasSpendingPeerData
                ? (isPositive
                    ? `Spending ${diffPercent.toFixed(0)}% less than peers!`
                    : `Spending ${diffPercent.toFixed(0)}% more than peers`)
                : `Spending ${(spendingRatio * 100).toFixed(0)}% of income`,
            is_positive: isPositive,
            has_peer_data: hasSpendingPeerData
        })
    }

    // Card 3: Weekend Spend Share (what % of spending happens on weekends)
    // Lower is better - less weekend spending = better control
    const weekendRatio = calculateWeekendRatio(txns)
    const peerWeekendRatio = toNumber(rankings.avgWeekendRatio)  // Has fallback in getPeerRankings
    const hasWeekendPeerData = rankings.peerCount > 0  // Match other cards

    console.log(`[WeekendSpendShare] weekendRatio=${(weekendRatio * 100).toFixed(1)}%, peerRatio=${(peerWeekendRatio * 100).toFixed(1)}%, hasPeerData=${hasWeekendPeerData}`)

    if (spent > 0) {  // Only show if user has spending data
        const isWeekendPositive = weekendRatio < peerWeekendRatio
        const weekendDiffPercent = Math.abs(weekendRatio - peerWeekendRatio) * 100

        cards.push({
            id: 'weekend_spend_share',
            emoji: '🗓️',
            title: 'Weekend Spend Share',
            your_value: Number((weekendRatio * 100).toFixed(1)),
            peer_average: Number((peerWeekendRatio * 100).toFixed(1)),
            percentile: isWeekendPositive ? 70 : 40,
            result_text: hasWeekendPeerData
                ? (isWeekendPositive
                    ? `${weekendDiffPercent.toFixed(0)}% less on weekends!`
                    : `${weekendDiffPercent.toFixed(0)}% more on weekends`)
                : `${(weekendRatio * 100).toFixed(0)}% spent on weekends`,
            is_positive: isWeekendPositive,
            has_peer_data: hasWeekendPeerData
        })
    }

    return cards
}

function computeQuickStats(txns: any[], cycleStartDate: string, cycleEndDate: string): any {
    const income = calculateIncome(txns)
    const spent = calculateSpent(txns)
    return {
        income: Number(income.toFixed(2)),
        spent: Number(spent.toFixed(2)),
        saved: Number((income - spent).toFixed(2)),
        cycle_start: cycleStartDate,
        cycle_end: cycleEndDate
    }
}

// Calendar intensity based on cycle income pace (income / cycleDays = daily budget).
// Falls back to spending-average method when income = 0.
function computeDailyCalendar(
    txns: any[],
    cycleStartDate: string,
    cycleEndDate: string,
    totalIncome: number = 0
): any[] {
    const daysInWindow = diffDaysDateOnly(cycleStartDate, cycleEndDate) + 1
    if (!Number.isFinite(daysInWindow) || daysInWindow <= 0) return []

    const dailyMap: Record<string, number> = {}
    txns.filter(t => toNumber(t.amount) < 0).forEach(t => {
        const day = String(t.date).substring(0, 10)
        dailyMap[day] = (dailyMap[day] || 0) + Math.abs(toNumber(t.amount))
    })

    // Primary baseline: daily income share
    // Fallback: average daily spending (for zero-income months)
    const dailyBudget = (totalIncome > 0)
        ? totalIncome / daysInWindow
        : (() => {
            const totalSpent = Object.values(dailyMap).reduce((a, b) => a + b, 0)
            return daysInWindow > 0 ? totalSpent / daysInWindow : 0
        })()

    const calendar: any[] = []
    for (let day = 0; day < daysInWindow; day++) {
        const dateStr = addDaysToDateOnly(cycleStartDate, day)
        const daySpent = dailyMap[dateStr] || 0

        let intensity = 'none'
        if (daySpent > 0 && dailyBudget > 0) {
            if (daySpent <= dailyBudget * 0.5)      intensity = 'low'    // well under pace
            else if (daySpent <= dailyBudget * 1.2) intensity = 'medium' // normal range
            else                                     intensity = 'high'   // over pace
        }

        calendar.push({
            date: dateStr,
            intensity,
            amount: Number(daySpent.toFixed(2))
        })
    }

    return calendar
}

function buildSavingsExplanation(income: number, spent: number, rankings: any): string {
    const rate = income > 0 ? ((income - spent) / income * 100).toFixed(0) : '0'
    if (Number(rate) > toNumber(rankings.avgSavingsRate) * 100) {
        return `Saving ${rate}% - above your peers!`
    }
    return `Saving ${rate}% - keep it up!`
}

function buildConsistencyExplanation(score: number): string {
    if (score >= 8) return 'Very consistent spending pattern!'
    if (score >= 6) return 'Good spending control'
    return 'Some spending variance detected'
}

function buildChallengeExplanation(challenges: any[]): string {
    const active = challenges.filter(c => c.status === 'active').length
    if (active > 0) return `${active} active challenge${active > 1 ? 's' : ''}`
    return 'Start a challenge to earn points!'
}

function buildStreakExplanation(streakDays: number): string {
    if (streakDays >= 14) return `${streakDays}-day streak - amazing!`
    if (streakDays >= 7) return `${streakDays}-day streak - keep going!`
    if (streakDays > 0) return `${streakDays}-day streak`
    return 'Start tracking to build your streak!'
}
