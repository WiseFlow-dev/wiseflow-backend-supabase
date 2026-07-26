import { assert, assertEquals, assertMatch, assertNotEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
    buildRebuiltComparisonCards,
    buildWhatIfScenarios,
    buildWeeklyDigestPayload,
    computeLatestCompletedCycleWindowForDate,
    deriveDigestObligationMetrics,
    getPeerRankings,
    hasWeeklyDigestSignal,
    READ_THROUGH_RECOMPUTE_BACKOFF_MS,
    shouldAttemptReadThroughRecompute,
    selectWeeklyDigestScenario
} from './index.ts'

const baseWindow = {
    currentWeekStartDate: '2026-03-05',
    currentWeekEndDate: '2026-03-10'
}

const rebuiltComparisonFixture = {
    selfRow: {
        savings_ratio: 0.24,
        spending_ratio: 1.2,
        weekend_ratio: 0.33
    },
    peerStats: {
        median_savings_ratio: 0.18,
        median_spending_ratio: 1.05,
        median_weekend_ratio: 0.27
    }
}

function scenarioInput(overrides: Record<string, number | string | boolean | null> = {}) {
    return {
        currentWeekSpend: 429,
        previousWeekSpend: 1132,
        currentWeekIncome: 0,
        previousWeekIncome: 1200,
        weekOverWeekSpendDeltaPct: (429 - 1132) / 1132,
        weekendSpendRatio: 0.38,
        lateWeekSpendRatio: 0.41,
        obligationsAvailable: true,
        obligationsCovered: false,
        overdueCents: 8000,
        fixedObligationsCents: 32000,
        obligationCount: 3,
        essentialsDelta: -69,
        discretionaryDelta: 65,
        largestIncreaseCategory: 'Shopping',
        largestIncreaseAmount: 65,
        largestExpenseAmount: 220,
        largestExpenseCategory: 'Shopping',
        largestExpenseCategoryKey: 'shopping',
        ...overrides
    }
}

Deno.test('overdue pressure wording stays obligation-specific when spend is down', () => {
    const currentWeekSpend = 429
    const previousWeekSpend = 1132
    const scenario = selectWeeklyDigestScenario(scenarioInput())

    assertEquals(scenario.scenarioCode, 'overdue_pressure')

    const digest = buildWeeklyDigestPayload({
        scenario,
        window: baseWindow,
        currentWeekSpend,
        previousWeekSpend,
        currentWeekIncome: 0,
        previousWeekIncome: 1200,
        weekOverWeekSpendDeltaPct: (currentWeekSpend - previousWeekSpend) / previousWeekSpend,
        weekendSpendRatio: 0.38,
        lateWeekSpendRatio: 0.41,
        obligationsCovered: false,
        obligationsAvailable: true,
        overdueCents: 8000,
        fixedObligationsCents: 32000,
        obligationCount: 3,
        topCategory: 'Shopping',
        largestIncreaseCategory: 'Shopping',
        largestIncreaseAmount: 65,
        largestExpenseAmount: 220,
        largestExpenseLabel: 'Laptop',
        essentialsDelta: -69,
        discretionaryDelta: 65
    })

    assertEquals(digest.type, 'pressure')
    assertMatch(digest.summary, /overdue/i)
    assertMatch(digest.summary, /came due during this week/i)
    assert(!/hotter than/i.test(digest.summary))
    assertEquals(digest.chat_handoff.handoff_version, 'v1')
    assertEquals(digest.chat_handoff.source, 'weekly_digest')
    assertEquals(digest.chat_handoff.digest_type, 'pressure')
    assertEquals(digest.chat_handoff.scenario_code, 'overdue_pressure')
    assertEquals(digest.chat_handoff.week_start, '2026-03-05')
    assertEquals(digest.chat_handoff.week_end, '2026-03-10')
    assertEquals(digest.chat_handoff.starter_prompt, 'Walk me through why this week is under pressure and what I should do first.')
    assertEquals(digest.chat_handoff.bullets, digest.bullets)
    assertEquals(digest.chat_handoff.proof_points, digest.proof_points)
    assertEquals(digest.chat_handoff.obligation_facts.overdue_amount, 80)
    assertEquals(digest.chat_handoff.obligation_facts.fixed_obligations_amount, 320)
    assertEquals(digest.chat_handoff.spend_facts.current_week_spend, 429)
    assertEquals(digest.chat_handoff.spend_facts.previous_week_spend, 1132)
    assertEquals(digest.chat_handoff.spend_facts.largest_increase_category, 'Shopping')
})

Deno.test('mixed but contained no longer presents as recovery', () => {
    const currentWeekSpend = 120
    const previousWeekSpend = 130
    const scenario = selectWeeklyDigestScenario(scenarioInput({
        currentWeekSpend,
        previousWeekSpend,
        currentWeekIncome: 0,
        previousWeekIncome: 0,
        weekOverWeekSpendDeltaPct: (currentWeekSpend - previousWeekSpend) / previousWeekSpend,
        weekendSpendRatio: 0.32,
        lateWeekSpendRatio: 0.5,
        obligationsCovered: true,
        overdueCents: 0,
        fixedObligationsCents: 0,
        obligationCount: 0,
        essentialsDelta: 5,
        discretionaryDelta: 10,
        largestIncreaseAmount: 12,
        largestExpenseAmount: 70
    }))

    assertEquals(scenario.scenarioCode, 'mixed_but_contained')
    assertEquals(scenario.type, 'pressure')
})

Deno.test('what-if scenarios build a discretionary scenario for repeated merchant spend', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -7.5, date: '2026-03-02T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -8.25, date: '2026-03-05T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -7.75, date: '2026-03-09T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' }
        ],
        goals: [
            {
                id: 'goal-1',
                name: 'Vacation',
                is_challenge: false,
                is_wish: false,
                current_amount_cents: 25000,
                target_amount_cents: 100000,
                target_date_millis: Date.now() + (60 * 24 * 60 * 60 * 1000)
            }
        ],
        wallets: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].slot, 'discretionary')
    assertEquals(scenarios[0].type, 'merchant_habit')
    assertMatch(scenarios[0].title, /Skip|Pause|Swap|Trim|Cap/i)
    assertEquals(scenarios[0].merchant_name, 'Starbucks')
    assertEquals(scenarios[0].impact_target.kind, 'goal')
    assertEquals(scenarios[0].impact_target.name, 'Vacation')
})

Deno.test('what-if scenarios use wish fallback without fake goal-speed math', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -24, date: '2026-03-03T12:00:00Z', category: 'shopping', title: 'AMAZON' },
            { amount: -32, date: '2026-03-10T12:00:00Z', category: 'shopping', title: 'AMAZON' }
        ],
        goals: [
            {
                id: 'wish-1',
                name: 'New Headphones',
                is_challenge: false,
                is_wish: true,
                current_amount_cents: 0,
                target_amount_cents: 0,
                target_date_millis: 0
            }
        ],
        wallets: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'wish')
    assertEquals(scenarios[0].impact_target.name, 'New Headphones')
    assertEquals(scenarios[0].impact_target.days_faster, undefined)
    assertMatch(scenarios[0].impact_target.message, /toward/i)
})

Deno.test('what-if scenarios return empty when only rejected fixed spend exists', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -950, date: '2026-03-04T09:00:00Z', category: 'rent', title: 'Monthly Rent' },
            { amount: -210, date: '2026-03-11T09:00:00Z', category: 'insurance', title: 'Car Insurance' }
        ],
        goals: [],
        wallets: []
    })

    assertEquals(scenarios, [])
})

Deno.test('what-if scenarios prefer obligation protection when pressure is active', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -11.5, date: '2026-03-02T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -10.75, date: '2026-03-05T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -9.5, date: '2026-03-09T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' }
        ],
        goals: [],
        wallets: [
            { id: 'wallet-emergency', type: 'emergency', name: 'Emergency Fund' }
        ],
        obligationSignal: {
            available: true,
            covered: false,
            overdueCents: 8500,
            fixedObligationsCents: 24000,
            obligationCount: 2
        }
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].slot, 'discretionary')
    assertEquals(scenarios[0].impact_target.kind, 'obligation_cushion')
    assertMatch(scenarios[0].impact_target.message, /overdue|obligations/i)
})

Deno.test('what-if scenarios fill discretionary and essential slots with distinct destinations', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -8.5, date: '2026-03-02T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -9.25, date: '2026-03-05T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -8.75, date: '2026-03-09T10:00:00Z', category: 'coffee', title: 'STARBUCKS 1234' },
            { amount: -22, date: '2026-03-03T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-10T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -26, date: '2026-03-14T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -83, date: '2026-03-04T18:00:00Z', category: 'groceries', title: 'Trader Joes' },
            { amount: -95, date: '2026-03-11T18:00:00Z', category: 'groceries', title: 'Trader Joes' }
        ],
        goals: [
            {
                id: 'goal-1',
                name: 'Vacation',
                is_challenge: false,
                is_wish: false,
                current_amount_cents: 25000,
                target_amount_cents: 100000,
                target_date_millis: Date.now() + (90 * 24 * 60 * 60 * 1000)
            }
        ],
        wallets: [
            { id: 'wallet-emergency', type: 'emergency', name: 'Emergency Fund' },
            { id: 'wallet-savings', type: 'savings', name: 'Savings' }
        ],
        obligationSignal: {
            available: true,
            covered: false,
            overdueCents: 6500,
            fixedObligationsCents: 18000,
            obligationCount: 2
        }
    })

    assertEquals(scenarios.length, 2)
    assertEquals(scenarios.map((it) => it.slot), ['discretionary', 'essential_flexible'])
    assertEquals(scenarios[0].impact_target.kind, 'obligation_cushion')
    assertEquals(scenarios[1].impact_target.kind, 'emergency_wallet')
})

Deno.test('what-if scenarios use richer action shapes for impulse and takeout patterns', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -21, date: '2026-03-02T12:00:00Z', category: 'takeout', title: 'UBER EATS' },
            { amount: -22, date: '2026-03-05T12:00:00Z', category: 'takeout', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-09T12:00:00Z', category: 'takeout', title: 'UBER EATS' },
            { amount: -26, date: '2026-03-12T12:00:00Z', category: 'takeout', title: 'UBER EATS' },
            { amount: -31, date: '2026-03-03T18:00:00Z', category: 'shopping', title: 'AMAZON' },
            { amount: -33, date: '2026-03-10T18:00:00Z', category: 'shopping', title: 'AMAZON' }
        ],
        goals: [],
        wallets: []
    })

    assertEquals(scenarios.length, 1)
    assertMatch(scenarios[0].title, /Swap|Pause/i)
})

Deno.test('what-if merchant normalization collapses brand aliases into one candidate', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -9.5, date: '2026-03-02T10:00:00Z', category: 'coffee', title: 'SBUX #1288' },
            { amount: -8.75, date: '2026-03-05T10:00:00Z', category: 'coffee', title: 'STARBUCKS STORE 44' },
            { amount: -9.25, date: '2026-03-09T10:00:00Z', category: 'coffee', title: 'Starbucks Coffee' }
        ],
        goals: [],
        wallets: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].merchant_name, 'Starbucks')
    assertEquals(scenarios[0].projection_basis.transaction_count, 3)
})

Deno.test('what-if category normalization infers takeout from merchant hint', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -23, date: '2026-03-02T12:00:00Z', category: 'other', title: 'UBER EATS ORDER' },
            { amount: -24, date: '2026-03-05T12:00:00Z', category: 'other', title: 'UberEats 5521' },
            { amount: -22, date: '2026-03-09T12:00:00Z', category: 'other', title: 'DOORDASH' },
            { amount: -25, date: '2026-03-12T12:00:00Z', category: 'other', title: 'Door Dash' }
        ],
        goals: [],
        wallets: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].slot, 'discretionary')
    assertEquals(scenarios[0].category_key, 'takeout')
    assertMatch(scenarios[0].title, /Skip|Swap|delivery|takeout/i)
})

Deno.test('what-if scenarios match bill with high coverage wording', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -25, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -25, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -25, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -25, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            { id: 'bill-1', name: 'internet bill', amount_cents: 2500, due_date: '2026-03-18', wallet_id: 'w1' }
        ]
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'bill')
    assertMatch(String(scenarios[0].impact_target.message || ''), /covers your internet bill/i)
})

Deno.test('what-if scenarios match bill with mid and low coverage wording', async () => {
    const midCoverage = await buildWhatIfScenarios({
        txns: [
            { amount: -30, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -30, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -30, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -30, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            { id: 'bill-2', name: 'phone bill', amount_cents: 4200, due_date: '2026-03-17', wallet_id: 'w1' }
        ]
    })

    assertEquals(midCoverage.length, 1)
    assertEquals(midCoverage[0].impact_target.kind, 'bill')
    assertMatch(String(midCoverage[0].impact_target.message || ''), /almost covers your phone bill/i)

    const lowCoverage = await buildWhatIfScenarios({
        txns: [
            { amount: -24, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            { id: 'bill-3', name: 'Spotify', amount_cents: 5800, due_date: '2026-03-19', wallet_id: 'w1' }
        ]
    })

    assertEquals(lowCoverage.length, 1)
    assertEquals(lowCoverage[0].impact_target.kind, 'bill')
    assertMatch(String(lowCoverage[0].impact_target.message || ''), /goes a long way toward your spotify/i)
})

Deno.test('what-if bill matching skips bills below 30% coverage and falls back', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -12, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -12, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -12, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -12, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            { id: 'bill-4', name: 'Big Bill', amount_cents: 50000, due_date: '2026-03-21', wallet_id: 'w1' }
        ],
        obligationSignal: {
            available: true,
            covered: false,
            overdueCents: 4500,
            fixedObligationsCents: 20000,
            obligationCount: 2
        }
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'obligation_cushion')
})

Deno.test('what-if bill matching falls back to generic obligation when no bills exist', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -16, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -16, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -16, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -16, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [],
        obligationSignal: {
            available: true,
            covered: false,
            overdueCents: 3200,
            fixedObligationsCents: 18000,
            obligationCount: 2
        }
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'obligation_cushion')
})

Deno.test('what-if bill matching prefers closest amount over smaller high-ratio bill', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -52, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -52, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -52, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -52, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            { id: 'bill-small', name: 'Netflix', amount_cents: 1000, due_date: '2026-03-15', wallet_id: 'w1' },
            { id: 'bill-close', name: 'phone bill', amount_cents: 5500, due_date: '2026-03-16', wallet_id: 'w1' }
        ]
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'bill')
    assertEquals(scenarios[0].impact_target.name, 'phone bill')
    assertMatch(String(scenarios[0].impact_target.message || ''), /covers your phone bill/i)
})

Deno.test('what-if bill messaging appends subscription label when source is subscription', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -24, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -24, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            {
                id: 'sub-1',
                name: 'Spotify',
                amount_cents: 5800,
                due_date: '2026-03-19',
                wallet_id: 'w1',
                source_type: 'subscription'
            }
        ]
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'bill')
    assertMatch(String(scenarios[0].impact_target.message || ''), /spotify subscription/i)
})

Deno.test('what-if bill messaging appends payment label when source is planned payment', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -22, date: '2026-03-02T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -22, date: '2026-03-05T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -22, date: '2026-03-09T12:00:00Z', category: 'restaurants', title: 'UBER EATS' },
            { amount: -22, date: '2026-03-12T12:00:00Z', category: 'restaurants', title: 'UBER EATS' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: [
            {
                id: 'pp-1',
                name: 'rent',
                amount_cents: 4800,
                due_date: '2026-03-19',
                wallet_id: 'w1',
                source_type: 'planned_payment'
            }
        ]
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'bill')
    assertMatch(String(scenarios[0].impact_target.message || ''), /rent payment/i)
})

Deno.test('what-if annual fallback uses first wish item name when destination is null', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -80, date: '2026-03-02T12:00:00Z', category: 'groceries', title: 'Trader Joes' },
            { amount: -120, date: '2026-03-09T12:00:00Z', category: 'groceries', title: 'Trader Joes' }
        ],
        goals: [
            {
                id: 'wish-annual-1',
                name: 'Car',
                is_challenge: false,
                is_wish: true,
                current_amount_cents: 0,
                target_amount_cents: 0,
                target_date_millis: 0
            }
        ],
        wallets: [],
        upcomingBills: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].slot, 'essential_flexible')
    assertEquals(scenarios[0].impact_target.kind, 'annual_frame')
    assertMatch(String(scenarios[0].impact_target.message || ''), /year toward Car/i)
})

Deno.test('what-if scenarios carry currency code and annual fallback uses it', async () => {
    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -80, date: '2026-03-02T12:00:00Z', category: 'groceries', title: 'Trader Joes' },
            { amount: -120, date: '2026-03-09T12:00:00Z', category: 'groceries', title: 'Trader Joes' }
        ],
        goals: [
            {
                id: 'wish-annual-currency-1',
                name: 'Car',
                is_challenge: false,
                is_wish: true,
                current_amount_cents: 0,
                target_amount_cents: 0,
                target_date_millis: 0
            }
        ],
        wallets: [],
        upcomingBills: [],
        currencyCode: 'TRY'
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].currency_code, 'TRY')
    assertMatch(String(scenarios[0].impact_target?.message || ''), /year toward Car/i)
    assertMatch(String(scenarios[0].impact_target?.message || ''), /₺|TRY/i)
})

Deno.test('what-if annual fallback AI path returns a non-null message', async () => {
    const originalFetch = globalThis.fetch
    ;(globalThis as any).__WISEY_WHAT_IF_ANTHROPIC_KEY = 'test-anthropic-key'
    ;(globalThis as any).fetch = async () => {
        return new Response(
            JSON.stringify({ content: [{ text: 'a new phone' }] }),
            {
                status: 200,
                headers: { 'content-type': 'application/json' }
            }
        )
    }

    try {
        const scenarios = await buildWhatIfScenarios({
            txns: [
                { amount: -80, date: '2026-03-02T12:00:00Z', category: 'groceries', title: 'Trader Joes' },
                { amount: -120, date: '2026-03-09T12:00:00Z', category: 'groceries', title: 'Trader Joes' }
            ],
            goals: [],
            wallets: [],
            upcomingBills: []
        })

        assertEquals(scenarios.length, 1)
        assertEquals(scenarios[0].impact_target.kind, 'annual_frame')
        assertMatch(String(scenarios[0].impact_target.message || ''), /year - a new phone/i)
    } finally {
        ;(globalThis as any).fetch = originalFetch
        delete (globalThis as any).__WISEY_WHAT_IF_ANTHROPIC_KEY
    }
})

Deno.test('what-if annual fallback does not crash when AI key is missing', async () => {
    delete (globalThis as any).__WISEY_WHAT_IF_ANTHROPIC_KEY

    const scenarios = await buildWhatIfScenarios({
        txns: [
            { amount: -80, date: '2026-03-02T12:00:00Z', category: 'groceries', title: 'Trader Joes' },
            { amount: -120, date: '2026-03-09T12:00:00Z', category: 'groceries', title: 'Trader Joes' }
        ],
        goals: [],
        wallets: [],
        upcomingBills: []
    })

    assertEquals(scenarios.length, 1)
    assertEquals(scenarios[0].impact_target.kind, 'annual_frame')
    assert(String(scenarios[0].impact_target.message || '').trim().length > 0)
})

Deno.test('low-volume overdue weeks still count as digest-worthy signal', () => {
    assertEquals(hasWeeklyDigestSignal({
        transactionCount: 0,
        currentWeekSpend: 0,
        previousWeekSpend: 0,
        overdueCents: 5000,
        fixedObligationsCents: 0,
        currentWeekIncome: 0
    }), true)

    assertEquals(hasWeeklyDigestSignal({
        transactionCount: 0,
        currentWeekSpend: 0,
        previousWeekSpend: 0,
        overdueCents: 0,
        fixedObligationsCents: 15000,
        currentWeekIncome: 0
    }), true)

    assertEquals(hasWeeklyDigestSignal({
        transactionCount: 0,
        currentWeekSpend: 0,
        previousWeekSpend: 0,
        overdueCents: 0,
        fixedObligationsCents: 0,
        currentWeekIncome: 200
    }), true)

    assertEquals(hasWeeklyDigestSignal({
        transactionCount: 0,
        currentWeekSpend: 0,
        previousWeekSpend: 0,
        overdueCents: 0,
        fixedObligationsCents: 0,
        currentWeekIncome: 0
    }), false)
})

Deno.test('fixed bill compression wins when obligations crowd the week', () => {
    const scenario = selectWeeklyDigestScenario(scenarioInput({
        currentWeekSpend: 410,
        previousWeekSpend: 390,
        currentWeekIncome: 450,
        previousWeekIncome: 500,
        weekOverWeekSpendDeltaPct: (410 - 390) / 390,
        weekendSpendRatio: 0.18,
        lateWeekSpendRatio: 0.29,
        obligationsCovered: true,
        overdueCents: 0,
        fixedObligationsCents: 29000,
        obligationCount: 3,
        essentialsDelta: 8,
        discretionaryDelta: 12,
        largestIncreaseAmount: 10,
        largestExpenseAmount: 95
    }))

    assertEquals(scenario.scenarioCode, 'fixed_bill_compression')
})

Deno.test('fixed bill compression chat handoff keeps the obligation-cluster facts explicit', () => {
    const digest = buildWeeklyDigestPayload({
        scenario: {
            type: 'pressure',
            scenarioCode: 'fixed_bill_compression',
            primaryDriver: 'fixed_obligations_cluster',
            secondaryDriver: null,
            actionCode: 'protect_fixed_commitments',
            scenarioScore: 77,
            debugReasons: ['fixed_obligations_crowded']
        },
        window: baseWindow,
        currentWeekSpend: 410,
        previousWeekSpend: 390,
        currentWeekIncome: 450,
        previousWeekIncome: 500,
        weekOverWeekSpendDeltaPct: (410 - 390) / 390,
        weekendSpendRatio: 0.18,
        lateWeekSpendRatio: 0.29,
        obligationsCovered: true,
        obligationsAvailable: true,
        overdueCents: 0,
        fixedObligationsCents: 29000,
        obligationCount: 3,
        topCategory: 'Rent',
        largestIncreaseCategory: 'Utilities',
        largestIncreaseAmount: 10,
        largestExpenseAmount: 95,
        largestExpenseLabel: 'Rent',
        essentialsDelta: 8,
        discretionaryDelta: 12
    })

    assertEquals(digest.chat_handoff.scenario_code, 'fixed_bill_compression')
    assertEquals(digest.chat_handoff.starter_prompt, 'Explain which obligations compressed this week and what I should do first.')
    assertEquals(digest.chat_handoff.obligation_facts.fixed_obligations_amount, 290)
    assertEquals(digest.chat_handoff.obligation_facts.obligation_count, 3)
    assertEquals(digest.chat_handoff.obligation_facts.obligations_covered, true)
    assertEquals(digest.chat_handoff.spend_facts.current_week_income, 450)
})

Deno.test('income gap pressure wins when fixed obligations outrun current income support', () => {
    const scenario = selectWeeklyDigestScenario(scenarioInput({
        currentWeekSpend: 180,
        previousWeekSpend: 260,
        currentWeekIncome: 0,
        previousWeekIncome: 1100,
        weekendSpendRatio: 0.14,
        lateWeekSpendRatio: 0.21,
        obligationsCovered: true,
        overdueCents: 0,
        fixedObligationsCents: 36000,
        obligationCount: 3,
        essentialsDelta: 5,
        discretionaryDelta: 10,
        largestIncreaseAmount: 0,
        largestExpenseAmount: 85
    }))

    assertEquals(scenario.scenarioCode, 'income_gap_pressure')
})

Deno.test('large purchase scenario wins when one purchase dominates the week', () => {
    const scenario = selectWeeklyDigestScenario(scenarioInput({
        currentWeekSpend: 420,
        previousWeekSpend: 300,
        currentWeekIncome: 600,
        previousWeekIncome: 550,
        weekOverWeekSpendDeltaPct: (420 - 300) / 300,
        weekendSpendRatio: 0.12,
        lateWeekSpendRatio: 0.24,
        obligationsCovered: true,
        overdueCents: 0,
        fixedObligationsCents: 8000,
        obligationCount: 1,
        essentialsDelta: 0,
        discretionaryDelta: 0,
        largestIncreaseCategory: 'Electronics',
        largestIncreaseAmount: 210,
        largestExpenseAmount: 260,
        largestExpenseCategory: 'Electronics',
        largestExpenseCategoryKey: 'electronics'
    }))

    assertEquals(scenario.scenarioCode, 'planned_large_purchase')
})

Deno.test('headline family rotates across adjacent weeks for repeated scenarios', () => {
    const scenario = selectWeeklyDigestScenario(scenarioInput({
        currentWeekSpend: 410,
        previousWeekSpend: 390,
        currentWeekIncome: 450,
        previousWeekIncome: 500,
        weekOverWeekSpendDeltaPct: (410 - 390) / 390,
        weekendSpendRatio: 0.18,
        lateWeekSpendRatio: 0.29,
        obligationsCovered: true,
        overdueCents: 0,
        fixedObligationsCents: 29000,
        obligationCount: 3,
        essentialsDelta: 8,
        discretionaryDelta: 12,
        largestIncreaseAmount: 10,
        largestExpenseAmount: 95
    }))

    const digestWeekOne = buildWeeklyDigestPayload({
        scenario,
        window: {
            currentWeekStartDate: '2026-03-05',
            currentWeekEndDate: '2026-03-10'
        },
        currentWeekSpend: 410,
        previousWeekSpend: 390,
        currentWeekIncome: 450,
        previousWeekIncome: 500,
        weekOverWeekSpendDeltaPct: (410 - 390) / 390,
        weekendSpendRatio: 0.18,
        lateWeekSpendRatio: 0.29,
        obligationsCovered: true,
        obligationsAvailable: true,
        overdueCents: 0,
        fixedObligationsCents: 29000,
        obligationCount: 3,
        topCategory: 'Rent',
        largestIncreaseCategory: 'Utilities',
        largestIncreaseAmount: 10,
        largestExpenseAmount: 95,
        largestExpenseLabel: 'Rent',
        essentialsDelta: 8,
        discretionaryDelta: 12
    })

    const digestWeekTwo = buildWeeklyDigestPayload({
        scenario,
        window: {
            currentWeekStartDate: '2026-03-12',
            currentWeekEndDate: '2026-03-17'
        },
        currentWeekSpend: 410,
        previousWeekSpend: 390,
        currentWeekIncome: 450,
        previousWeekIncome: 500,
        weekOverWeekSpendDeltaPct: (410 - 390) / 390,
        weekendSpendRatio: 0.18,
        lateWeekSpendRatio: 0.29,
        obligationsCovered: true,
        obligationsAvailable: true,
        overdueCents: 0,
        fixedObligationsCents: 29000,
        obligationCount: 3,
        topCategory: 'Rent',
        largestIncreaseCategory: 'Utilities',
        largestIncreaseAmount: 10,
        largestExpenseAmount: 95,
        largestExpenseLabel: 'Rent',
        essentialsDelta: 8,
        discretionaryDelta: 12
    })

    assertEquals(digestWeekOne.scenario_code, 'fixed_bill_compression')
    assertEquals(digestWeekTwo.scenario_code, 'fixed_bill_compression')
    assertNotEquals(digestWeekOne.headline_family, digestWeekTwo.headline_family)
})

Deno.test('chat handoff starter prompts stay scenario-specific for stability and recovery', () => {
    const stabilityDigest = buildWeeklyDigestPayload({
        scenario: {
            type: 'stability',
            scenarioCode: 'steady_control',
            primaryDriver: 'controlled_weekly_spend',
            secondaryDriver: null,
            actionCode: 'keep_rhythm',
            scenarioScore: 74,
            debugReasons: ['spend_down_and_obligations_clean']
        },
        window: {
            currentWeekStartDate: '2026-03-12',
            currentWeekEndDate: '2026-03-18'
        },
        currentWeekSpend: 842,
        previousWeekSpend: 1028,
        currentWeekIncome: 1100,
        previousWeekIncome: 980,
        weekOverWeekSpendDeltaPct: (842 - 1028) / 1028,
        weekendSpendRatio: 0.28,
        lateWeekSpendRatio: 0.31,
        obligationsCovered: true,
        obligationsAvailable: true,
        overdueCents: 0,
        fixedObligationsCents: 18000,
        obligationCount: 2,
        topCategory: 'Groceries',
        largestIncreaseCategory: null,
        largestIncreaseAmount: 0,
        largestExpenseAmount: 180,
        largestExpenseLabel: 'Groceries',
        essentialsDelta: -22,
        discretionaryDelta: -41
    })

    const recoveryDigest = buildWeeklyDigestPayload({
        scenario: {
            type: 'recovery',
            scenarioCode: 'recovery_after_spike',
            primaryDriver: 'spend_cooling',
            secondaryDriver: 'lower_weekend_drift',
            actionCode: 'repeat_reset',
            scenarioScore: 69,
            debugReasons: ['spend_down_after_hotter_week']
        },
        window: {
            currentWeekStartDate: '2026-03-19',
            currentWeekEndDate: '2026-03-25'
        },
        currentWeekSpend: 610,
        previousWeekSpend: 960,
        currentWeekIncome: 900,
        previousWeekIncome: 760,
        weekOverWeekSpendDeltaPct: (610 - 960) / 960,
        weekendSpendRatio: 0.24,
        lateWeekSpendRatio: 0.33,
        obligationsCovered: true,
        obligationsAvailable: true,
        overdueCents: 0,
        fixedObligationsCents: 14000,
        obligationCount: 2,
        topCategory: 'Dining',
        largestIncreaseCategory: null,
        largestIncreaseAmount: 0,
        largestExpenseAmount: 120,
        largestExpenseLabel: 'Dining',
        essentialsDelta: -18,
        discretionaryDelta: -55
    })

    assertEquals(stabilityDigest.chat_handoff.digest_type, 'stability')
    assertEquals(recoveryDigest.chat_handoff.digest_type, 'recovery')
    assertEquals(stabilityDigest.chat_handoff.starter_prompt, 'Explain what I did right this week and how to keep it going.')
    assertEquals(recoveryDigest.chat_handoff.starter_prompt, 'Explain what improved this week compared with last week and how to keep that recovery going.')
    assertNotEquals(stabilityDigest.chat_handoff.starter_prompt, recoveryDigest.chat_handoff.starter_prompt)
})

Deno.test('weekly digest uses requested currency in chat handoff and copy', () => {
    const digest = buildWeeklyDigestPayload({
        scenario: {
            type: 'pressure',
            scenarioCode: 'overdue_pressure',
            primaryDriver: 'overdue_obligations',
            secondaryDriver: null,
            actionCode: 'clear_overdue',
            scenarioScore: 88,
            debugReasons: []
        },
        currencyCode: 'TRY',
        window: baseWindow,
        currentWeekSpend: 429,
        previousWeekSpend: 1132,
        currentWeekIncome: 0,
        previousWeekIncome: 1200,
        weekOverWeekSpendDeltaPct: (429 - 1132) / 1132,
        weekendSpendRatio: 0.38,
        lateWeekSpendRatio: 0.41,
        obligationsCovered: false,
        obligationsAvailable: true,
        overdueCents: 8000,
        fixedObligationsCents: 32000,
        obligationCount: 3,
        topCategory: 'Shopping',
        largestIncreaseCategory: 'Shopping',
        largestIncreaseAmount: 65,
        largestExpenseAmount: 220,
        largestExpenseLabel: 'Laptop',
        essentialsDelta: -69,
        discretionaryDelta: 65
    })

    assertEquals(digest.chat_handoff.obligation_facts.currency, 'TRY')
    assertEquals(digest.chat_handoff.spend_facts.currency, 'TRY')
    assertMatch(String(digest.summary || ''), /₺|TRY/i)
})

Deno.test('derived overdue counts obligations that became overdue inside the current digest week', () => {
    const metrics = deriveDigestObligationMetrics({
        anchorDate: '2026-03-10',
        lines: [
            {
                source: 'bill',
                amountCents: 5000,
                occurrenceDate: '2026-02-27'
            },
            {
                source: 'planned_payment',
                amountCents: 3000,
                occurrenceDate: '2026-03-09'
            },
            {
                source: 'bill',
                amountCents: 12000,
                occurrenceDate: '2026-03-12'
            },
            {
                source: 'goal_auto_save',
                amountCents: 2000,
                occurrenceDate: '2026-03-08'
            }
        ]
    })

    assertEquals(metrics.overdueCents, 8000)
})

Deno.test('rebuilt comparison cards use stored completed-cycle ratios and remove percentile', () => {
    const result = buildRebuiltComparisonCards(rebuiltComparisonFixture)

    assertEquals(result.cards.map((card) => card.id), [
        'savings_rate',
        'spending_control',
        'weekend_spend_share'
    ])

    const savingsCard = result.cards[0]
    assertEquals(savingsCard.your_value, 24.0)
    assertEquals(savingsCard.peer_average, 18.0)
    assertEquals(savingsCard.percentile, null)
    assertEquals(savingsCard.has_peer_data, true)
})

Deno.test('rebuilt comparison cards allow spending control above one hundred percent', () => {
    const result = buildRebuiltComparisonCards(rebuiltComparisonFixture)
    const spendingCard = result.cards.find((card) => card.id === 'spending_control')

    assertEquals(spendingCard?.your_value, 120.0)
    assertEquals(spendingCard?.peer_average, 105.0)
    assertEquals(spendingCard?.is_positive, false)
    assertMatch(String(spendingCard?.result_text || ''), /higher than peers/i)
})

Deno.test('rebuilt comparison cards respect metric availability flags instead of synthetic fallback values', () => {
    const result = buildRebuiltComparisonCards({
        ...rebuiltComparisonFixture,
        peerStats: {
            ...rebuiltComparisonFixture.peerStats,
            median_weekend_ratio: null
        },
        metricAvailability: {
            weekend_spend_share: false
        }
    })

    assertEquals(result.metricAvailability.weekend_spend_share, false)
    assertEquals(result.cards.some((card) => card.id === 'weekend_spend_share'), false)
})

Deno.test('latest completed cycle window respects non-first cycle start days', () => {
    const result = computeLatestCompletedCycleWindowForDate('2026-05-12', 10)

    assertEquals(result.cycleStartDate, '2026-04-10')
    assertEquals(result.cycleEndDate, '2026-05-09')
    assertEquals(result.bucketMonth, '2026-04-01')
})

Deno.test('read-through recompute throttles recent dirty queue attempts', () => {
    const nowMs = Date.parse('2026-05-25T12:00:00Z')
    const recentAttemptAt = new Date(nowMs - (READ_THROUGH_RECOMPUTE_BACKOFF_MS - 60_000)).toISOString()

    const shouldAttempt = shouldAttemptReadThroughRecompute({
        hasStoredRow: false,
        dirtyRows: [{ last_attempt_at: recentAttemptAt }],
        nowMs
    })

    assertEquals(shouldAttempt, false)
})

Deno.test('read-through recompute retries when the backoff window has expired or a row was never attempted', () => {
    const nowMs = Date.parse('2026-05-25T12:00:00Z')
    const oldAttemptAt = new Date(nowMs - (READ_THROUGH_RECOMPUTE_BACKOFF_MS + 60_000)).toISOString()

    assertEquals(
        shouldAttemptReadThroughRecompute({
            hasStoredRow: true,
            dirtyRows: [{ last_attempt_at: oldAttemptAt }],
            nowMs
        }),
        true
    )

    assertEquals(
        shouldAttemptReadThroughRecompute({
            hasStoredRow: true,
            dirtyRows: [{ last_attempt_at: null }],
            nowMs
        }),
        true
    )
})

Deno.test('getPeerRankings preserves real zero peer averages (no fallback override)', async () => {
    const supabaseAdmin = {
        from: () => ({
            select: () => ({
                eq: () => ({
                    order: () => ({
                        limit: () => ({
                            maybeSingle: async () => ({
                                data: {
                                    income_anchor_normalized: 4200,
                                    bucket_month: '2026-04-01'
                                },
                                error: null
                            })
                        })
                    })
                })
            })
        }),
        rpc: () => ({
            single: async () => ({
                data: {
                    avg_savings_rate: 0,
                    avg_spending_ratio: 0,
                    avg_weekend_ratio: 0,
                    avg_score: 0,
                    peer_count: 2,
                    peer_band_label: '$3000-$5000',
                    has_sufficient_peers: true
                },
                error: null
            })
        })
    }

    const rankings = await getPeerRankings(supabaseAdmin, {}, 'user-1', '2026-04')
    assertEquals(rankings.avgSavingsRate, 0)
    assertEquals(rankings.avgSpendingRatio, 0)
    assertEquals(rankings.avgWeekendRatio, 0)
    assertEquals(rankings.avgScore, 0)
    assertEquals(rankings.peerCount, 2)
})

Deno.test('getPeerRankings uses fallback values only when peer averages are null', async () => {
    const supabaseAdmin = {
        from: () => ({
            select: () => ({
                eq: () => ({
                    order: () => ({
                        limit: () => ({
                            maybeSingle: async () => ({
                                data: {
                                    income_anchor_normalized: 4200,
                                    bucket_month: '2026-04-01'
                                },
                                error: null
                            })
                        })
                    })
                })
            })
        }),
        rpc: () => ({
            single: async () => ({
                data: {
                    avg_savings_rate: null,
                    avg_spending_ratio: null,
                    avg_weekend_ratio: null,
                    avg_score: null,
                    peer_count: 25,
                    peer_band_label: '$3000-$5000',
                    has_sufficient_peers: true
                },
                error: null
            })
        })
    }

    const rankings = await getPeerRankings(supabaseAdmin, {}, 'user-1', '2026-04')
    assertEquals(rankings.avgSavingsRate, 0.15)
    assertEquals(rankings.avgSpendingRatio, 0.65)
    assertEquals(rankings.avgWeekendRatio, 0.30)
    assertEquals(rankings.avgScore, 5.0)
    assertEquals(rankings.peerCount, 25)
})
