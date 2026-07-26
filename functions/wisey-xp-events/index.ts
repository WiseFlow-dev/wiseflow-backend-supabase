import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// XP Award Amounts
const XP_AMOUNTS = {
    daily_active: 50,
    transaction_logged: 5,
    weekly_active_5: 250,
    weekly_active_7: 400,
    goal_milestone_10: 100,
    goal_milestone_25: 200,
    goal_milestone_50: 400,
    goal_milestone_75: 600,
    goal_milestone_100: 800,
    debt_milestone_10: 100,
    debt_milestone_25: 200,
    debt_milestone_50: 400,
    debt_milestone_75: 600,
    debt_milestone_100: 800,
    budget_rollover_win: 500
}

// Security Thresholds
const MIN_TRANSACTION_AMOUNT = 1.0 // $1.00 minimum
const MIN_GOAL_TARGET = 50000 // $500 in cents
const MIN_DEBT_AMOUNT = 50000 // $500 in cents
const MIN_BUDGET_AMOUNT = 5000 // $50 in cents
const MAX_DAILY_TRANSACTION_XP = 10

// Defensive numeric parsing
function toNumber(v: unknown): number {
    const n = Number.parseFloat(String(v))
    return Number.isFinite(n) ? n : 0
}

// Convert wallet_transactions.amount (DECIMAL dollars) to cents
// wallet_transactions.amount is DECIMAL(12,2) representing dollars (e.g., -12.50)
// goals/debts/budgets use *_cents (BIGINT representing cents)
function dollarsToCents(v: unknown): number {
    return Math.round(Math.abs(toNumber(v)) * 100)
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
        // JWT Auth - derive userId from token only
        const authHeader = req.headers.get('Authorization')
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            })
        }

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

        const userId = user.id

        // Service role client for writes
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        )

        // Parse request body
        const { event, data } = await req.json()

        // Route to appropriate handler
        let result
        switch (event) {
            case 'transaction_logged':
                result = await handleTransactionXP(supabaseAdmin, userId, data.transaction_id)
                break
            case 'goal_progress':
                result = await handleGoalMilestoneXP(supabaseAdmin, userId, data.goal_id)
                break
            case 'debt_payment':
                result = await handleDebtMilestoneXP(supabaseAdmin, userId, data.debt_id)
                break
            case 'budget_rollover':
                result = await handleBudgetRolloverXP(supabaseAdmin, userId, data.budget_id)
                break
            case 'daily_active':
                result = await handleDailyActiveXP(supabaseAdmin, userId)
                break
            case 'weekly_consistency':
                result = await handleWeeklyConsistencyXP(supabaseAdmin, userId)
                break
            case 'challenge_completed':
                result = await handleChallengeCompletedXP(supabaseAdmin, userId, data.goal_id)
                break
            default:
                return new Response(JSON.stringify({ error: 'Unknown event type' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                })

        }

        return new Response(JSON.stringify(result), {
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

// ========== HANDLER: Transaction Logged XP ==========
async function handleTransactionXP(
    supabaseAdmin: any,
    userId: string,
    transactionId: string
): Promise<any> {
    // 1. Verify transaction exists and belongs to user
    const { data: txn } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount, date, user_id')
        .eq('id', transactionId)
        .single()

    if (!txn || txn.user_id !== userId) {
        return { success: false, error: 'Transaction not found or unauthorized' }
    }

    // 2. Security checks
    const amount = Math.abs(toNumber(txn.amount))

    if (amount < MIN_TRANSACTION_AMOUNT) {
        return { success: false, error: `Transaction amount too small (min $${MIN_TRANSACTION_AMOUNT})` }
    }

    // Only expense transactions earn XP (negative amount)
    if (toNumber(txn.amount) >= 0) {
        return { success: false, error: 'Only expense transactions earn XP' }
    }

    // No future transactions
    if (new Date(txn.date) > new Date()) {
        return { success: false, error: 'Future transactions not allowed' }
    }

    // 3. Check daily cap (max 10 transactions/day)
    const today = new Date().toISOString().substring(0, 10)
    const { count } = await supabaseAdmin
        .from('xp_transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('reason', 'txn_logged')
        .gte('created_at', `${today}T00:00:00Z`)

    if (count >= MAX_DAILY_TRANSACTION_XP) {
        return { success: false, error: `Daily transaction XP cap reached (${MAX_DAILY_TRANSACTION_XP}/day)` }
    }

    // 4. Award XP (idempotent via UNIQUE constraint)
    const xpResult = await awardXP(supabaseAdmin, userId, {
        amount: XP_AMOUNTS.transaction_logged,
        reason: 'txn_logged',
        reference_id: transactionId
    })

    if (!xpResult.success) {
        return { success: false, error: 'XP already awarded for this transaction' }
    }

    // 5. Check for daily active bonus (first action of day)
    await checkAndAwardDailyActive(supabaseAdmin, userId)

    return {
        success: true,
        xp_awarded: XP_AMOUNTS.transaction_logged,
        event: 'transaction_logged',
        old_level: xpResult.old_level,
        new_level: xpResult.new_level,
        level_up_occurred: (xpResult.new_level || 0) > (xpResult.old_level || 0)
    }
}

// ========== HANDLER: Goal Milestone XP ==========
async function handleGoalMilestoneXP(
    supabaseAdmin: any,
    userId: string,
    clientGoalId: string  // Android's local goal.id (stored as client_goal_id in Supabase)
): Promise<any> {
    // 1. Verify goal exists and belongs to user
    // NOTE: Android sends the local goal.id which is stored as client_goal_id in Supabase
    const { data: goal } = await supabaseAdmin
        .from('goals')
        .select('*')
        .eq('client_goal_id', clientGoalId)  // Lookup by Android's local ID
        .eq('user_id', userId)
        .single()

    if (!goal) {
        return { success: false, error: 'Goal not found or unauthorized' }
    }

    const isWishGoal = goal.is_wish === true || (!goal.is_challenge && toNumber(goal.target_amount_cents) <= 0)
    if (isWishGoal) {
        return { success: false, error: 'Wish items do not earn goal milestone XP' }
    }

    if (goal.is_challenge) {
        return { success: false, error: 'Challenges do not earn goal milestone XP' }
    }

    // 2. Security: minimum target amount ($500)
    const targetCents = toNumber(goal.target_amount_cents)
    if (targetCents < MIN_GOAL_TARGET) {
        return { success: false, error: `Goal target too small (min $${MIN_GOAL_TARGET / 100})` }
    }

    // 3. **FIX LOOPHOLE**: Compute current amount from TRANSACTION SUMS (not goal.current_amount_cents)
    // This prevents users from manually editing goals.current_amount_cents and claiming milestones
    // NOTE: Transactions use the Android local ID (client_goal_id), same as what was passed in
    const { data: goalTxns } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount')
        .in('goal_id', [goal.id, clientGoalId])
        .eq('user_id', userId)
        .lt('amount', 0) // Only expense transactions (contributions to goal)

    if (!goalTxns || goalTxns.length === 0) {
        return { success: false, error: 'No wallet transactions linked to this goal' }
    }

    // Sum of all contribution transactions (convert dollars to cents)
    const currentCents = goalTxns.reduce((sum: number, txn: any) => sum + dollarsToCents(txn.amount), 0)

    // 4. Calculate current progress % based on transaction sums
    const progressPct = (currentCents / targetCents) * 100

    // 5. Determine ALL milestones to award (not just the next one)
    const milestones = [
        { threshold: 10, xp: XP_AMOUNTS.goal_milestone_10 },
        { threshold: 25, xp: XP_AMOUNTS.goal_milestone_25 },
        { threshold: 50, xp: XP_AMOUNTS.goal_milestone_50 },
        { threshold: 75, xp: XP_AMOUNTS.goal_milestone_75 },
        { threshold: 100, xp: XP_AMOUNTS.goal_milestone_100 }
    ]

    const lastAwarded = goal.last_milestone_awarded || 0

    // Find ALL milestones that should be awarded (not just the next one)
    const milestonesToAward = milestones.filter(m =>
        m.threshold > lastAwarded && progressPct >= m.threshold
    )

    if (milestonesToAward.length === 0) {
        return { success: false, error: 'No new milestone reached' }
    }

    // 6. Award XP for each milestone (each is idempotent via reference_id)
    let totalXpAwarded = 0
    let highestMilestone = lastAwarded

    // Track level progression across multiple milestone awards
    let firstXpResult: any = null
    let lastXpResult: any = null
    const awardedMilestones: number[] = []

    for (const milestone of milestonesToAward) {
        const xpResult = await awardXP(supabaseAdmin, userId, {
            amount: milestone.xp,
            reason: 'goal_milestone',
            reference_id: `${clientGoalId}:${milestone.threshold}`
        })

        if (xpResult.success) {
            if (!firstXpResult) firstXpResult = xpResult
            lastXpResult = xpResult
            totalXpAwarded += milestone.xp
            highestMilestone = Math.max(highestMilestone, milestone.threshold)
            awardedMilestones.push(milestone.threshold)
        }
    }

    if (totalXpAwarded === 0) {
        return { success: false, error: 'All milestones already awarded' }
    }

    // 7. Update last_milestone_awarded to highest reached
    await supabaseAdmin
        .from('goals')
        .update({ last_milestone_awarded: highestMilestone })
        .eq('id', goal.id)

    return {
        success: true,
        xp_awarded: totalXpAwarded,
        milestones_awarded: awardedMilestones,
        highest_milestone: highestMilestone,
        current_cents: currentCents,
        target_cents: targetCents,
        event: 'goal_milestone',
        old_level: firstXpResult?.old_level,
        new_level: lastXpResult?.new_level,
        level_up_occurred: (lastXpResult?.new_level || 0) > (firstXpResult?.old_level || 0)
    }
}


// ========== HANDLER: Debt Payment Milestone XP ==========
async function handleDebtMilestoneXP(
    supabaseAdmin: any,
    userId: string,
    clientDebtId: string  // Android's local debt.id (stored as client_debt_id in Supabase)
): Promise<any> {
    // 1. Verify debt exists and belongs to user
    // NOTE: Android sends the local debt.id which is stored as client_debt_id in Supabase
    const { data: debt } = await supabaseAdmin
        .from('debts')
        .select('*')
        .eq('client_debt_id', clientDebtId)  // Lookup by Android's local ID
        .eq('user_id', userId)
        .single()

    if (!debt) {
        return { success: false, error: 'Debt not found or unauthorized' }
    }

    // 2. Security: minimum debt amount ($500)
    // Fix: Use correct schema (total_amount_cents, not amount_cents)
    const totalDebtCents = toNumber(debt.total_amount_cents)
    if (totalDebtCents < MIN_DEBT_AMOUNT) {
        return { success: false, error: `Debt amount too small (min $${MIN_DEBT_AMOUNT / 100})` }
    }

    // 3. **FIX LOOPHOLE**: Compute paid amount from TRANSACTION SUMS (not remaining_amount_cents)
    // This prevents users from manually editing debt.remaining_amount_cents
    // NOTE: Transactions use the Android local ID (client_debt_id), same as what was passed in
    const { data: debtTxns } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount')
        .in('debt_id', [debt.id, clientDebtId])
        .eq('user_id', userId)
        .lt('amount', 0) // Only expense transactions (payments)

    if (!debtTxns || debtTxns.length === 0) {
        return { success: false, error: 'No wallet transactions linked to this debt' }
    }

    // Sum of all payment transactions (convert dollars to cents)
    const paidCents = debtTxns.reduce((sum: number, txn: any) => sum + dollarsToCents(txn.amount), 0)

    // 4. Calculate payment progress % based on transaction sums
    const progressPct = (paidCents / totalDebtCents) * 100

    // 5. Determine ALL milestones to award (not just the next one)
    const milestones = [
        { threshold: 10, xp: XP_AMOUNTS.debt_milestone_10 },
        { threshold: 25, xp: XP_AMOUNTS.debt_milestone_25 },
        { threshold: 50, xp: XP_AMOUNTS.debt_milestone_50 },
        { threshold: 75, xp: XP_AMOUNTS.debt_milestone_75 },
        { threshold: 100, xp: XP_AMOUNTS.debt_milestone_100 }
    ]

    const lastAwarded = debt.last_milestone_awarded || 0

    // Find ALL milestones that should be awarded (not just the next one)
    const milestonesToAward = milestones.filter(m =>
        m.threshold > lastAwarded && progressPct >= m.threshold
    )

    if (milestonesToAward.length === 0) {
        return { success: false, error: 'No new milestone reached' }
    }

    // 6. Award XP for each milestone (each is idempotent via reference_id)
    let totalXpAwarded = 0
    let highestMilestone = lastAwarded

    // Track level progression across multiple milestone awards
    let firstXpResult: any = null
    let lastXpResult: any = null
    const awardedMilestones: number[] = []

    for (const milestone of milestonesToAward) {
        const xpResult = await awardXP(supabaseAdmin, userId, {
            amount: milestone.xp,
            reason: 'debt_milestone',
            reference_id: `${clientDebtId}:${milestone.threshold}`
        })

        if (xpResult.success) {
            if (!firstXpResult) firstXpResult = xpResult
            lastXpResult = xpResult
            totalXpAwarded += milestone.xp
            highestMilestone = Math.max(highestMilestone, milestone.threshold)
            awardedMilestones.push(milestone.threshold)
        }
    }

    if (totalXpAwarded === 0) {
        return { success: false, error: 'All milestones already awarded' }
    }

    // 7. Update last_milestone_awarded to highest reached
    await supabaseAdmin
        .from('debts')
        .update({ last_milestone_awarded: highestMilestone })
        .eq('id', debt.id)

    return {
        success: true,
        xp_awarded: totalXpAwarded,
        milestones_awarded: awardedMilestones,
        highest_milestone: highestMilestone,
        paid_cents: paidCents,
        total_cents: totalDebtCents,
        event: 'debt_milestone',
        old_level: firstXpResult?.old_level,
        new_level: lastXpResult?.new_level,
        level_up_occurred: (lastXpResult?.new_level || 0) > (firstXpResult?.old_level || 0)
    }
}



// ========== HANDLER: Challenge Completed XP (Wisey-suggested only) ==========
// Awards 100 XP per day of the challenge duration
// Only for Wisey-suggested challenges (identified by baseline8d_cents in note)
async function handleChallengeCompletedXP(
    supabaseAdmin: any,
    userId: string,
    clientGoalId: string  // Android's local goal.id (stored as client_goal_id in Supabase)
): Promise<any> {
    // 1. Verify goal/challenge exists and belongs to user
    const { data: goal } = await supabaseAdmin
        .from('goals')
        .select('*')
        .eq('client_goal_id', clientGoalId)
        .eq('user_id', userId)
        .single()

    if (!goal) {
        return { success: false, error: 'Challenge not found or unauthorized' }
    }

    // 2. Verify it's actually a challenge
    if (!goal.is_challenge) {
        return { success: false, error: 'Not a challenge' }
    }

    // 3. Security: Only Wisey-suggested challenges qualify
    // Wisey-suggested challenges have "baseline8d_cents=" in their note
    const note = goal.note || ''
    if (!note.includes('baseline8d_cents=')) {
        return { success: false, error: 'Not a Wisey-suggested challenge - no XP award' }
    }

    // 4. Calculate challenge duration in days
    const createdAt = goal.created_at_millis || goal.created_at
    const targetDate = goal.target_date_millis

    if (!createdAt || !targetDate) {
        return { success: false, error: 'Cannot determine challenge duration' }
    }

    // Convert to milliseconds if needed (handle both millis and ISO strings)
    const startMs = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime()
    const endMs = typeof targetDate === 'number' ? targetDate : new Date(targetDate).getTime()

    const durationDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)))

    // Cap at 365 days to prevent abuse
    const cappedDays = Math.min(durationDays, 365)
    const xpAmount = cappedDays * 100  // 100 XP per day

    // 5. Award XP (idempotent via reference_id)
    const xpResult = await awardXP(supabaseAdmin, userId, {
        amount: xpAmount,
        reason: 'challenge_completed',
        reference_id: `challenge:${clientGoalId}`  // One-time per challenge
    })

    if (!xpResult.success) {
        return { success: false, error: 'Challenge completion XP already awarded' }
    }

    return {
        success: true,
        xp_awarded: xpAmount,
        challenge_days: cappedDays,
        event: 'challenge_completed',
        old_level: xpResult.old_level,
        new_level: xpResult.new_level,
        level_up_occurred: (xpResult.new_level || 0) > (xpResult.old_level || 0)
    }
}

// ========== HANDLER: Budget Rollover Win XP ==========

async function handleBudgetRolloverXP(
    supabaseAdmin: any,
    userId: string,
    budgetId: string
): Promise<any> {
    // 1. Verify budget exists and belongs to user
    const { data: budget } = await supabaseAdmin
        .from('budgets')
        .select('*')
        .eq('id', budgetId)
        .eq('user_id', userId)
        .single()

    if (!budget) {
        return { success: false, error: 'Budget not found or unauthorized' }
    }

    // 2. Security checks
    const budgetAmount = toNumber(budget.amount_cents)
    if (budgetAmount < MIN_BUDGET_AMOUNT) {
        return { success: false, error: `Budget amount too small (min $${MIN_BUDGET_AMOUNT / 100})` }
    }

    if (!budget.end_date) {
        return { success: false, error: 'Budget has no end_date (no rollover period)' }
    }

    // Budget period must have ended
    const today = new Date().toISOString().substring(0, 10)
    if (String(budget.end_date) >= today) {
        return { success: false, error: 'Budget period has not ended yet' }
    }

    // 3. **FIX LOOPHOLE**: Compute spent from TRANSACTION SUMS (not budget.spent_cents)
    // This prevents users from manually editing budgets.spent_cents
    const budgetStart = budget.start_date
    const budgetEnd = budget.end_date

    const budgetStartIso = `${budgetStart}T00:00:00.000Z`
    const budgetEndExclusive = new Date(`${budgetEnd}T00:00:00.000Z`)
    budgetEndExclusive.setUTCDate(budgetEndExclusive.getUTCDate() + 1)
    const budgetEndExclusiveIso = budgetEndExclusive.toISOString()

    const { data: budgetTxns } = await supabaseAdmin
        .from('wallet_transactions')
        .select('amount')
        .eq('budget_id', budgetId)
        .eq('user_id', userId)
        .gte('date', budgetStartIso)
        .lt('date', budgetEndExclusiveIso)
        .lt('amount', 0) // Only expense transactions
        .neq('is_budget_rollover', true) // Exclude rollover transaction itself

    // Sum of budget transactions (convert dollars to cents)
    const spentCents = budgetTxns
        ? budgetTxns.reduce((sum: number, txn: any) => sum + dollarsToCents(txn.amount), 0)
        : 0

    // User must have stayed under budget (computed from transactions)
    if (spentCents >= budgetAmount) {
        return { success: false, error: 'Budget was exceeded (no rollover)' }
    }

    const leftoverCents = budgetAmount - spentCents

    // 4. **FIX LOOPHOLE**: Verify rollover transaction exists AND matches leftover amount
    const { data: rolloverTxn } = await supabaseAdmin
        .from('wallet_transactions')
        .select('*')
        .eq('budget_id', budgetId)
        .eq('is_budget_rollover', true)
        .eq('user_id', userId)
        .maybeSingle()

    if (!rolloverTxn) {
        return { success: false, error: 'No rollover transaction found for this budget' }
    }

    // Verify rollover transaction amount matches leftover (allow small rounding)
    // rolloverTxn.amount is in dollars (DECIMAL), convert to cents for comparison
    const rolloverAmountCents = dollarsToCents(rolloverTxn.amount)
    const amountDiff = Math.abs(rolloverAmountCents - leftoverCents)

    // Allow 1 cent rounding difference (not 100 cents!)
    if (amountDiff > 1) {
        return {
            success: false,
            error: `Rollover amount mismatch (expected ${leftoverCents}¢, got ${rolloverAmountCents}¢, diff ${amountDiff}¢)`
        }
    }

    // 5. Award XP (idempotent via budget_id + end_date)
    const referenceId = `${budgetId}:${budgetEnd}`
    const xpResult = await awardXP(supabaseAdmin, userId, {
        amount: XP_AMOUNTS.budget_rollover_win,
        reason: 'budget_rollover_win',
        reference_id: referenceId
    })

    if (!xpResult.success) {
        return { success: false, error: 'Rollover XP already awarded for this budget period' }
    }

    return {
        success: true,
        xp_awarded: XP_AMOUNTS.budget_rollover_win,
        leftover_cents: leftoverCents,
        spent_cents: spentCents,
        budget_cents: budgetAmount,
        event: 'budget_rollover',
        old_level: xpResult.old_level,
        new_level: xpResult.new_level,
        level_up_occurred: (xpResult.new_level || 0) > (xpResult.old_level || 0)
    }
}

// ========== HANDLER: Daily Active Bonus ==========
async function handleDailyActiveXP(
    supabaseAdmin: any,
    userId: string
): Promise<any> {
    return await checkAndAwardDailyActive(supabaseAdmin, userId)
}

async function checkAndAwardDailyActive(
    supabaseAdmin: any,
    userId: string
): Promise<any> {
    const today = new Date().toISOString().substring(0, 10)

    const xpResult = await awardXP(supabaseAdmin, userId, {
        amount: XP_AMOUNTS.daily_active,
        reason: 'daily_active',
        reference_id: today
    })

    if (!xpResult.success) {
        return { success: false, error: 'Daily active bonus already claimed today' }
    }

    return {
        success: true,
        xp_awarded: XP_AMOUNTS.daily_active,
        event: 'daily_active',
        old_level: xpResult.old_level,
        new_level: xpResult.new_level,
        level_up_occurred: (xpResult.new_level || 0) > (xpResult.old_level || 0)
    }
}

// ========== HANDLER: Weekly Consistency Bonus ==========
async function handleWeeklyConsistencyXP(
    supabaseAdmin: any,
    userId: string
): Promise<any> {
    // Calculate current week (YYYY-WW format)
    const now = new Date()
    const startOfYear = new Date(now.getFullYear(), 0, 1)
    const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7)
    const weekId = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`

    // Get start of week (Monday)
    const dayOfWeek = now.getDay()
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)
    const monday = new Date(now.setDate(diff))
    monday.setHours(0, 0, 0, 0)

    // Count unique days with 'daily_active' bonus this week
    const { data: activeDays } = await supabaseAdmin
        .from('xp_transactions')
        .select('reference_id')
        .eq('user_id', userId)
        .eq('reason', 'daily_active')
        .gte('created_at', monday.toISOString())

    const uniqueDays = new Set(activeDays?.map((d: any) => d.reference_id) || [])
    const activeCount = uniqueDays.size

    // Determine which weekly bonus to award
    let bonusType = null
    let bonusXP = 0

    if (activeCount >= 7) {
        bonusType = 'weekly_active_7'
        bonusXP = XP_AMOUNTS.weekly_active_7
    } else if (activeCount >= 5) {
        bonusType = 'weekly_active_5'
        bonusXP = XP_AMOUNTS.weekly_active_5
    } else {
        return { success: false, error: `Insufficient active days this week (${activeCount}/5)` }
    }

    // Award XP (idempotent via week ID)
    const xpResult = await awardXP(supabaseAdmin, userId, {
        amount: bonusXP,
        reason: bonusType,
        reference_id: weekId
    })

    if (!xpResult.success) {
        return { success: false, error: 'Weekly consistency bonus already claimed' }
    }

    return {
        success: true,
        xp_awarded: bonusXP,
        active_days: activeCount,
        event: bonusType,
        old_level: xpResult.old_level,
        new_level: xpResult.new_level,
        level_up_occurred: (xpResult.new_level || 0) > (xpResult.old_level || 0)
    }
}

// ========== HELPER: Award XP with Idempotency ==========
async function awardXP(
    supabaseAdmin: any,
    userId: string,
    params: { amount: number; reason: string; reference_id: string }
): Promise<{ success: boolean; old_level?: number; new_level?: number; old_xp?: number; new_xp?: number }> {
    try {
        // Try to insert XP transaction (UNIQUE constraint prevents duplicates)
        const { data, error } = await supabaseAdmin
            .from('xp_transactions')
            .insert({
                user_id: userId,
                xp_amount: params.amount,
                reason: params.reason,
                reference_id: params.reference_id
            })
            .select()
            .single()

        // If insert failed (duplicate), return false
        if (error) {
            console.log(`XP already awarded: ${params.reason}:${params.reference_id}`)
            return { success: false }
        }

        // If successful, call increment_user_xp_v2 RPC to get level progression
        if (data) {
            const { data: xpResult } = await supabaseAdmin.rpc('increment_user_xp_v2', {
                p_user_id: userId,
                p_xp_amount: params.amount
            })

            return {
                success: true,
                old_level: xpResult?.[0]?.old_level,
                new_level: xpResult?.[0]?.new_level,
                old_xp: xpResult?.[0]?.old_xp,
                new_xp: xpResult?.[0]?.new_xp
            }
        }

        return { success: false }
    } catch (e) {
        console.error('Error awarding XP:', e)
        return { success: false }
    }
}
