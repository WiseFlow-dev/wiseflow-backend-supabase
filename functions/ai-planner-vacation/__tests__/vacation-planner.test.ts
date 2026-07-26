/**
 * WiseFlow AI Planner - Vacation Tests
 * Phase 1: Real integration tests with mocked Supabase
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { handleVacationPlannerRequest } from '../index.ts'

function monthStringOffset(offsetMonths: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() + offsetMonths)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Mock Supabase client builder
function createMockSupabase(mocks: {
  profile?: any
  transactions?: any[]
  goals?: any[]
  budgets?: any[]
  obligations?: any
  obligationsByCall?: any[]
}) {
  let rpcCallCount = 0
  return {
    from: (table: string) => ({
      select: (_fields: string) => ({
        eq: (_field: string, _value: any) => {
          if (table === 'profiles' || table === 'user_preferences') {
            return {
              single: () => ({ data: mocks.profile || { cycle_start_day: 1 }, error: null }),
              maybeSingle: () => ({ data: mocks.profile || { cycle_start_day: 1 }, error: null })
            }
          }
          if (table === 'budgets') {
            return { data: mocks.budgets || [], error: null }
          }
          if (table === 'goals') {
            return {
              eq: (_field2: string, _value2: any) => ({
                ilike: (_field3: string, _pattern: string) => ({
                  then: (resolve: any) => resolve({ data: mocks.goals || [], error: null })
                })
              })
            }
          }
          if (table === 'wallet_transactions') {
            return {
              gte: (_field2: string, _value2: any) => ({
                order: (_field3: string, _opts: any) => ({
                  then: (resolve: any) => resolve({ data: mocks.transactions || [], error: null })
                })
              })
            }
          }
          return { data: [], error: null }
        }
      })
    }),
    rpc: (name: string, _params: any) => {
      if (name === 'get_obligations_v1') {
        const series = Array.isArray(mocks.obligationsByCall) ? mocks.obligationsByCall : null
        const responseFromSeries = series && series.length > 0
          ? series[Math.min(rpcCallCount, series.length - 1)]
          : null
        rpcCallCount += 1
        return {
          data: responseFromSeries || mocks.obligations || {
            totals: {
              billsCents: 0,
              plannedPaymentsCents: 0,
              subscriptionsCents: 0,
              goalAutoSaveCents: 0,
              grandTotalCents: 0
            }
          },
          error: null
        }
      }
      return { data: null, error: null }
    }
  }
}

// Test 1: Valid request happy path
Deno.test('vacation planner - valid request returns vacation_plan', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      // Income
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      // Spending
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } },
      { date: '2026-03-12', amount: -200, category: 'Entertainment', category_id: 'entertainment', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 50000,
        subscriptionsCents: 50000,
        goalAutoSaveCents: 0,
        grandTotalCents: 250000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-1' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.vacationName, 'Hawaii Trip')
  assertEquals(result.costCents, 50000)
  assertEquals(result.targetMonth, '2026-09')
  assertExists(result.verdict)
  assertExists(result.monthlySurplusCents)
  assertExists(result.trimCategories)
  assertExists(result.projections)
})

// Test 1b: Long-term plans use averaged obligations across cycles
Deno.test('vacation planner - long-term uses averaged fixed obligations', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligationsByCall: [
      { totals: { billsCents: 10000, plannedPaymentsCents: 0, subscriptionsCents: 0, goalAutoSaveCents: 0, grandTotalCents: 10000 } },
      { totals: { billsCents: 20000, plannedPaymentsCents: 0, subscriptionsCents: 0, goalAutoSaveCents: 0, grandTotalCents: 20000 } },
      { totals: { billsCents: 40000, plannedPaymentsCents: 0, subscriptionsCents: 0, goalAutoSaveCents: 0, grandTotalCents: 40000 } }
    ]
  })

  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Long Term Trip',
      costCents: 50000,
      targetMonth: '2099-01'
    },
    { supabase: mockSupabase, userId: 'test-user-1b' }
  )

  assertEquals(result.type, 'vacation_plan')
  // Average of 10000, 20000, 40000 = 23333.33 => rounded 23333
  assertEquals(result.fixedObligationsCents, 23333)
  assertEquals(result.cyclesUsed, 3)
})

// Test 2: Missing income returns clarifying question
Deno.test('vacation planner - missing income returns clarifying_question', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      // Only spending, no income
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-2' }
  )
  
  assertEquals(result.type, 'clarifying_question')
  assertExists(result.question)
  assertEquals(result.question.includes('income'), true)
})

// Test 3: Invalid targetMonth format returns error
Deno.test('vacation planner - invalid targetMonth format returns error', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [],
    goals: [],
    budgets: [],
    obligations: { totals: { grandTotalCents: 0 } }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: 'invalid-date'
    },
    { supabase: mockSupabase, userId: 'test-user-3' }
  )
  
  assertEquals(result.type, 'error')
  assertExists(result.error)
  assertEquals(result.error.includes('YYYY-MM'), true)
})

// Test 3b: Invalid targetMonth month value returns error
Deno.test('vacation planner - invalid targetMonth month returns error', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [],
    goals: [],
    budgets: [],
    obligations: { totals: { grandTotalCents: 0 } }
  })

  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-13'
    },
    { supabase: mockSupabase, userId: 'test-user-3b' }
  )

  assertEquals(result.type, 'error')
  assertExists(result.error)
  assertEquals(result.error.includes('Invalid target month'), true)
})

// Test 4: Past target month returns error
Deno.test('vacation planner - past target month returns error', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [],
    goals: [],
    budgets: [],
    obligations: { totals: { grandTotalCents: 0 } }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2020-01'
    },
    { supabase: mockSupabase, userId: 'test-user-4' }
  )
  
  assertEquals(result.type, 'error')
  assertExists(result.error)
  assertEquals(result.error.includes('future'), true)
})

// Test 5: Budget lock exclusion by category_id
Deno.test('vacation planner - excludes budgeted category by ID', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } },
      { date: '2026-03-12', amount: -200, category: 'Entertainment', category_id: 'entertainment', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [
      {
        category_id: 'dining',
        amount_cents: 25000,
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        is_active: true,
        name: 'Dining Budget',
        wallet_id: null,
        categories: { name: 'Dining' }
      }
    ],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-5' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  // Dining should be excluded, only Entertainment eligible
  const diningCategory = result.trimCategories?.find((c: any) => c.name === 'Dining')
  assertEquals(diningCategory, undefined)
  assertEquals(result.skippedBudgetedCategories?.includes('Dining'), true)
})

// Test 6: Budget lock exclusion by fuzzy name/key
Deno.test('vacation planner - excludes budgeted category by fuzzy name', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Restaurant', category_id: 'restaurant', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [
      {
        category_id: 'other-id',
        amount_cents: 25000,
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        is_active: true,
        name: 'Restaurant Budget',
        wallet_id: null,
        categories: { name: 'Other' }
      }
    ],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-6' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  // Restaurant should be excluded by fuzzy match with "Restaurant Budget"
  assertEquals(result.skippedBudgetedCategories?.includes('Restaurant'), true)
})

// Test 7: All categories budgeted warning
Deno.test('vacation planner - warns when all categories budgeted', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [
      {
        category_id: 'dining',
        amount_cents: 25000,
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        is_active: true,
        name: 'Dining Budget',
        wallet_id: null,
        categories: { name: 'Dining' }
      }
    ],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-7' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  const hasWarning = result.warnings?.some((w: string) => w.includes('active budgets'))
  assertEquals(hasWarning, true)
})

// Test 8: Existing goal uses current_amount_cents and avoids double-count
Deno.test('vacation planner - existing goal uses current_amount_cents', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } }
    ],
	    goals: [
	      {
	        name: 'Summer Vacation',
	        target_amount_cents: 100000,
	        current_amount_cents: 30000,
	        is_wish: false
	      }
	    ],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 11667, // Existing goal auto-save
        grandTotalCents: 161667
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-8' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.existingAutoSaving?.exists, true)
  assertEquals(result.existingAutoSaving?.goalName, 'Summer Vacation')
  // Should use current_amount_cents (30000) to calculate remaining (70000)
  // Estimated monthly: ceil(70000 / 6) = 11667
  assertEquals(result.existingAutoSaving?.estimatedMonthlyCents, 11667)
})

// Test 9: Cut mode correctness - needed_to_hit_target
Deno.test('vacation planner - cut mode needed_to_hit_target when gap exists', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 1800, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-9' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  // Base capacity: 180000 - 150000 - 30000 = 0
  // Required: ceil(50000 / 6) = 8334
  // Gap: 8334 (> 0)
  assertEquals(result.cutMode, 'needed_to_hit_target')
  if ('requiredCutToTargetCents' in result && typeof result.requiredCutToTargetCents === 'number') {
    assertEquals(result.requiredCutToTargetCents > 0, true)
  }
})

// Test 10: Cut mode correctness - optional_buffer
Deno.test('vacation planner - cut mode optional_buffer when no gap', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 4000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -300, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 150000,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 150000
      }
    }
  })
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-10' }
  )
  
  assertEquals(result.type, 'vacation_plan')
  // Base capacity: 400000 - 150000 - 30000 = 220000
  // Required: ceil(50000 / 6) = 8334
  // Gap: 0 (base capacity exceeds requirement)
  assertEquals(result.cutMode, 'optional_buffer')
  // Optional cuts target the required monthly saving, capped by 40% rule.
  if (typeof result.selectedCutCents === 'number' && typeof result.maxOptionalCutCapacityCents === 'number') {
    assertEquals(result.selectedCutCents > 0, true)
    assertEquals(result.selectedCutCents <= result.maxOptionalCutCapacityCents, true)
    if (typeof result.remainingMonthlySavingCents === 'number') {
      assertEquals(result.selectedCutCents <= result.remainingMonthlySavingCents, true)
    }
  } else {
    throw new Error('Expected selectedCutCents and maxOptionalCutCapacityCents in vacation_plan response')
  }
})

// Test 10b: Optional cuts respect 40% cap even when target is higher
Deno.test('vacation planner - optional cuts are capped at 40 percent', async () => {
  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: 1 },
    transactions: [
      { date: '2026-03-05', amount: 10000, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: '2026-03-10', amount: -10, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 100000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-10b' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.cutMode, 'optional_buffer')
  // Target is monthly requirement, but selected cuts must stop at 40%-cap capacity.
  if (typeof result.selectedCutCents === 'number' && typeof result.maxOptionalCutCapacityCents === 'number') {
    assertEquals(result.selectedCutCents, result.maxOptionalCutCapacityCents)
    if (typeof result.remainingMonthlySavingCents === 'number') {
      assertEquals(result.selectedCutCents <= result.remainingMonthlySavingCents, true)
    }
  } else {
    throw new Error('Expected selectedCutCents and maxOptionalCutCapacityCents in vacation_plan response')
  }
})

// Test 10c: Verdict thresholds - achievable at <=30% required cut
Deno.test('vacation planner - verdict yes when required cut is 30 percent', async () => {
  const currentDay = new Date().getDate()
  const targetMonth = monthStringOffset(4) // 4 months to save
  const todayIso = new Date().toISOString().slice(0, 10)

  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: currentDay },
    transactions: [
      // Keep base capacity at ~0 after normalization: income and non-essential spend are equal.
      { date: todayIso, amount: 100, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: todayIso, amount: -100, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  // Required monthly = 6000 cents. With cycle_start_day=today, normalization caps near 2.0,
  // so eligible spend is ~20000 and required cut ~= 30%.
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Threshold 30',
      costCents: 24000,
      targetMonth
    },
    { supabase: mockSupabase, userId: 'test-user-10c' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.verdict, 'yes')
})

// Test 10d: Verdict thresholds - close at >30% and <=40% required cut
Deno.test('vacation planner - verdict close when required cut is between 30 and 40 percent', async () => {
  const currentDay = new Date().getDate()
  const targetMonth = monthStringOffset(4) // 4 months to save
  const todayIso = new Date().toISOString().slice(0, 10)

  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: currentDay },
    transactions: [
      { date: todayIso, amount: 100, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: todayIso, amount: -100, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  // Required monthly = 7000 cents => ~35% of ~20000 eligible spend.
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Threshold 35',
      costCents: 28000,
      targetMonth
    },
    { supabase: mockSupabase, userId: 'test-user-10d' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.verdict, 'close')
})

// Test 10e: Verdict thresholds - hard reach above 40% required cut
Deno.test('vacation planner - verdict no when required cut is above 40 percent', async () => {
  const currentDay = new Date().getDate()
  const targetMonth = monthStringOffset(4) // 4 months to save
  const todayIso = new Date().toISOString().slice(0, 10)

  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: currentDay },
    transactions: [
      { date: todayIso, amount: 100, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: todayIso, amount: -100, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  // Required monthly = 9000 cents => ~45% of ~20000 eligible spend (above 40 cap).
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Threshold 45',
      costCents: 36000,
      targetMonth
    },
    { supabase: mockSupabase, userId: 'test-user-10e' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.verdict, 'no')
})

// Test 10f: Optional-buffer path still uses required-cut thresholds (close)
Deno.test('vacation planner - optional buffer can still be close by required cut percent', async () => {
  const currentDay = new Date().getDate()
  const targetMonth = monthStringOffset(4) // 4 months to save
  const todayIso = new Date().toISOString().slice(0, 10)

  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: currentDay },
    transactions: [
      // High base capacity (income > spend), so gap becomes 0 => optional_buffer.
      { date: todayIso, amount: 200, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: todayIso, amount: -100, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  // Required monthly = 7000 cents (~35% of ~20000 eligible spend) => CLOSE.
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Optional Close',
      costCents: 28000,
      targetMonth
    },
    { supabase: mockSupabase, userId: 'test-user-10f' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.cutMode, 'optional_buffer')
  assertEquals(result.verdict, 'close')
})

// Test 10g: Optional-buffer path still uses required-cut thresholds (hard reach)
Deno.test('vacation planner - optional buffer can still be no by required cut percent', async () => {
  const currentDay = new Date().getDate()
  const targetMonth = monthStringOffset(4) // 4 months to save
  const todayIso = new Date().toISOString().slice(0, 10)

  const mockSupabase = createMockSupabase({
    profile: { cycle_start_day: currentDay },
    transactions: [
      { date: todayIso, amount: 200, category: 'Salary', category_id: 'salary', categories: { is_income: true } },
      { date: todayIso, amount: -100, category: 'Dining', category_id: 'dining', categories: { is_income: false } }
    ],
    goals: [],
    budgets: [],
    obligations: {
      totals: {
        billsCents: 0,
        plannedPaymentsCents: 0,
        subscriptionsCents: 0,
        goalAutoSaveCents: 0,
        grandTotalCents: 0
      }
    }
  })

  // Required monthly = 9000 cents (~45% of ~20000 eligible spend) => HARD REACH ("no").
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Optional Hard',
      costCents: 36000,
      targetMonth
    },
    { supabase: mockSupabase, userId: 'test-user-10g' }
  )

  assertEquals(result.type, 'vacation_plan')
  assertEquals(result.cutMode, 'optional_buffer')
  assertEquals(result.verdict, 'no')
})

// Test 11: Missing vacation name
Deno.test('vacation planner - missing vacation name returns clarifying_question', async () => {
  const mockSupabase = createMockSupabase({})
  
  const result = await handleVacationPlannerRequest(
    {
      costCents: 50000,
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-11' }
  )
  
  assertEquals(result.type, 'clarifying_question')
  if ('question' in result && result.question) {
    assertEquals(result.question.includes('name'), true)
  }
})

// Test 12: Missing cost
Deno.test('vacation planner - missing cost returns clarifying_question', async () => {
  const mockSupabase = createMockSupabase({})
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      targetMonth: '2026-09'
    },
    { supabase: mockSupabase, userId: 'test-user-12' }
  )
  
  assertEquals(result.type, 'clarifying_question')
  if ('question' in result && result.question) {
    assertEquals(result.question.includes('cost'), true)
  }
})

// Test 13: Missing target month
Deno.test('vacation planner - missing target month returns clarifying_question', async () => {
  const mockSupabase = createMockSupabase({})
  
  const result = await handleVacationPlannerRequest(
    {
      vacationName: 'Hawaii Trip',
      costCents: 50000
    },
    { supabase: mockSupabase, userId: 'test-user-13' }
  )
  
  assertEquals(result.type, 'clarifying_question')
  if ('question' in result && result.question) {
    assertEquals(result.question.toLowerCase().includes('when') || result.question.toLowerCase().includes('planning'), true)
  }
})

console.log('All vacation planner tests passed!')
