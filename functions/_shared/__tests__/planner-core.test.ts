/**
 * WiseFlow Planner - Core Functions Tests
 * Phase 0: Comprehensive test coverage
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  computeNormalizationFactor,
  computeAdjustedRequiredCentsVacation,
  computeGapCents,
  allocateCappedCuts,
  computeCoverage,
  computeVerdict,
  computeVacationVerdictByRequiredCut,
  computeSavingsProjectionFields,
} from '../planner-core.ts'
import type { EligibleCategory } from '../planner-types.ts'

// Test: Normalization - Standard case
Deno.test('computeNormalizationFactor - standard mid-cycle', () => {
  const result = computeNormalizationFactor(30, 15)
  assertEquals(result.normalizationFactor, 2.0)
  assertEquals(result.warnings.length, 0)
})

// Test: Normalization - Early cycle with cap
Deno.test('computeNormalizationFactor - early cycle conservative', () => {
  const result = computeNormalizationFactor(30, 3, 7, 2.0)
  // Should use floored denominator (7) and cap at 2.0
  // 30 / 7 = 4.28, but capped at 2.0
  assertEquals(result.normalizationFactor, 2.0)
  assertEquals(result.warnings.length, 1)
  assertEquals(result.warnings[0].includes('Only 3 days'), true)
})

// Test: Normalization - Day 1 extreme case
Deno.test('computeNormalizationFactor - day 1 extreme cap', () => {
  const result = computeNormalizationFactor(30, 1, 7, 2.0)
  // Should cap at 2.0 to prevent 30x multiplier
  assertEquals(result.normalizationFactor, 2.0)
  assertEquals(result.warnings.length, 1)
})

// Test: Normalization - Zero elapsed days guard
Deno.test('computeNormalizationFactor - zero elapsed days guard', () => {
  const result = computeNormalizationFactor(30, 0, 7, 2.0)
  // Should use denominator of 1, then cap
  assertEquals(result.normalizationFactor, 2.0)
  assertEquals(result.warnings.length, 1)
})

// Test: Adjusted requirement - No existing goal
Deno.test('computeAdjustedRequiredCentsVacation - no existing goal', () => {
  const adjusted = computeAdjustedRequiredCentsVacation(50000, 0, 0)
  assertEquals(adjusted, 50000)
})

// Test: Adjusted requirement - Existing goal NOT in fixed
Deno.test('computeAdjustedRequiredCentsVacation - existing goal not in fixed', () => {
  const adjusted = computeAdjustedRequiredCentsVacation(50000, 10000, 0)
  // Should subtract existing goal
  assertEquals(adjusted, 40000)
})

// Test: Adjusted requirement - Existing goal ALREADY in fixed (double-count guard)
Deno.test('computeAdjustedRequiredCentsVacation - existing goal in fixed (no double-count)', () => {
  const adjusted = computeAdjustedRequiredCentsVacation(50000, 10000, 15000)
  // fixedGoalAutoSave (15000) >= existingGoal (10000), so don't subtract
  assertEquals(adjusted, 50000)
})

// Test: Adjusted requirement - Never negative
Deno.test('computeAdjustedRequiredCentsVacation - never negative', () => {
  const adjusted = computeAdjustedRequiredCentsVacation(10000, 20000, 0)
  assertEquals(adjusted, 0)
})

// Test: Gap - Positive gap
Deno.test('computeGapCents - positive gap', () => {
  const gap = computeGapCents(50000, 30000)
  assertEquals(gap, 20000)
})

// Test: Gap - No gap (capacity exceeds requirement)
Deno.test('computeGapCents - no gap', () => {
  const gap = computeGapCents(30000, 50000)
  assertEquals(gap, 0)
})

// Test: Gap - Negative capacity
Deno.test('computeGapCents - negative capacity', () => {
  const gap = computeGapCents(50000, -10000)
  assertEquals(gap, 60000)
})

// Test: Cut allocation - Empty categories
Deno.test('allocateCappedCuts - empty categories', () => {
  const result = allocateCappedCuts([], 10000)
  assertEquals(result.trimCategories.length, 0)
  assertEquals(result.totalTrimmableCents, 0)
  assertEquals(result.selectedCutCents, 0)
})

// Test: Cut allocation - Zero spend
Deno.test('allocateCappedCuts - zero spend', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 0 },
    { name: 'Entertainment', spendCents: 0 }
  ]
  const result = allocateCappedCuts(categories, 10000)
  assertEquals(result.trimCategories.length, 0)
  assertEquals(result.totalTrimmableCents, 0)
})

// Test: Cut allocation - 40% cap enforced
Deno.test('allocateCappedCuts - 40% cap enforced', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 50000, categoryId: 'dining-1' }
  ]
  // Request 30000 cut, but max is 40% of 50000 = 20000
  const result = allocateCappedCuts(categories, 30000)
  
  assertEquals(result.trimCategories.length, 1)
  assertEquals(result.trimCategories[0].currentAmountCents, 50000)
  assertEquals(result.trimCategories[0].recommendedCapCents, 30000) // 50000 - 20000
  assertEquals(result.selectedCutCents, 20000) // Capped at 40%
  assertEquals(result.totalTrimmableCents, 20000)
})

// Test: Cut allocation - Proportional distribution
Deno.test('allocateCappedCuts - proportional distribution', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 40000, categoryId: 'dining-1' },
    { name: 'Entertainment', spendCents: 30000, categoryId: 'ent-1' },
    { name: 'Shopping', spendCents: 30000, categoryId: 'shop-1' }
  ]
  // Total spend: 100000, gap: 20000
  // Proportional: Dining 8000, Entertainment 6000, Shopping 6000
  const result = allocateCappedCuts(categories, 20000)
  
  assertEquals(result.trimCategories.length, 3)
  assertEquals(result.selectedCutCents, 20000)
  
  // Check proportional allocation
  const diningCut = result.trimCategories.find(c => c.name === 'Dining')
  assertExists(diningCut)
  assertEquals(diningCut.currentAmountCents - diningCut.recommendedCapCents, 8000)
})

// Test: Cut allocation - Remainder distribution
Deno.test('allocateCappedCuts - remainder distribution', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 33333, categoryId: 'dining-1' },
    { name: 'Entertainment', spendCents: 33333, categoryId: 'ent-1' },
    { name: 'Shopping', spendCents: 33334, categoryId: 'shop-1' }
  ]
  // Total: 100000, gap: 10000
  // Proportional floor: 3333 + 3333 + 3333 = 9999
  // Remainder: 1 cent should be distributed
  const result = allocateCappedCuts(categories, 10000)
  
  assertEquals(result.selectedCutCents, 10000) // Should hit exactly 10000
})

// Test: Cut allocation - Cap-safe remainder (no infinite loop)
Deno.test('allocateCappedCuts - cap-safe remainder no stall', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 10000, categoryId: 'dining-1' }
  ]
  // Max cut: 4000 (40%), but request 5000
  // Should allocate 4000 and stop (not infinite loop)
  const result = allocateCappedCuts(categories, 5000)
  
  assertEquals(result.selectedCutCents, 4000)
  assertEquals(result.totalTrimmableCents, 4000)
})

// Test: Cut allocation - API boundary 40% cap enforcement
Deno.test('allocateCappedCuts - API boundary enforces 40% cap', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 10000, categoryId: 'dining-1' }
  ]
  // Try to pass 0.60 (60%) cap - should be clamped to 0.40
  const result = allocateCappedCuts(categories, 10000, 0.60)
  
  // Should still respect 40% cap (4000), not 60% (6000)
  assertEquals(result.totalTrimmableCents, 4000)
  assertEquals(result.selectedCutCents, 4000)
})

// Test: Cut allocation - Cent-by-cent remainder distribution (fairness)
Deno.test('allocateCappedCuts - cent-by-cent remainder distribution fairness', () => {
  const categories: EligibleCategory[] = [
    { name: 'Dining', spendCents: 10000, categoryId: 'dining-1' },
    { name: 'Entertainment', spendCents: 10000, categoryId: 'ent-1' }
  ]
  // Total: 20000, gap: 5 cents
  // With equal spend, both should get proportional floor of 2 cents each
  // Remainder of 1 cent should go to one category
  // Result: one gets 3 cents, other gets 2 cents (fair distribution)
  const result = allocateCappedCuts(categories, 5)
  
  assertEquals(result.selectedCutCents, 5)
  
  const diningCut = result.trimCategories.find(c => c.name === 'Dining')
  const entCut = result.trimCategories.find(c => c.name === 'Entertainment')
  
  assertExists(diningCut)
  assertExists(entCut)
  
  const diningCutAmount = diningCut.currentAmountCents - diningCut.recommendedCapCents
  const entCutAmount = entCut.currentAmountCents - entCut.recommendedCapCents
  
  // CRITICAL: Both categories must receive cuts (fairness assertion)
  assertEquals(diningCutAmount > 0, true, 'Dining should receive cuts')
  assertEquals(entCutAmount > 0, true, 'Entertainment should receive cuts')
  
  // Total should be 5
  assertEquals(diningCutAmount + entCutAmount, 5)
  
  // With equal spend, cuts should be nearly equal (differ by at most 1 cent)
  const diff = Math.abs(diningCutAmount - entCutAmount)
  assertEquals(diff <= 1, true, 'Cuts should differ by at most 1 cent for equal spend')
})

Deno.test('allocateCappedCuts - tier-aware discretionary before flexible essentials', () => {
  const categories: EligibleCategory[] = [
    { name: 'Groceries', spendCents: 100000, categoryId: 'groceries-1', expenseTier: 'flexible_essential' },
    { name: 'Entertainment', spendCents: 100000, categoryId: 'ent-1', expenseTier: 'discretionary' },
  ]

  const result = allocateCappedCuts(categories, 50000)

  const entertainmentCut = result.trimCategories.find(c => c.name === 'Entertainment')
  const groceriesCut = result.trimCategories.find(c => c.name === 'Groceries')

  assertExists(entertainmentCut)
  assertEquals(entertainmentCut.currentAmountCents - entertainmentCut.recommendedCapCents, 50000)
  assertEquals(groceriesCut, undefined)
})

Deno.test('allocateCappedCuts - tier-aware flexible essentials use lower dynamic cap', () => {
  const flexibleOnly = allocateCappedCuts([
    { name: 'Groceries', spendCents: 100000, categoryId: 'groceries-1', expenseTier: 'flexible_essential' },
  ], 50000)
  const discretionaryOnly = allocateCappedCuts([
    { name: 'Entertainment', spendCents: 100000, categoryId: 'ent-1', expenseTier: 'discretionary' },
  ], 50000)

  assertEquals(flexibleOnly.selectedCutCents, 22000)
  assertEquals(discretionaryOnly.selectedCutCents, 50000)
})

// Test: Coverage - Standard case
Deno.test('computeCoverage - standard case', () => {
  const coverage = computeCoverage(30000, 50000, 20000)
  
  assertEquals(coverage.baseCoveragePct, 60) // 30000 / 50000 * 100
  assertEquals(coverage.maxCoveragePct, 100) // (30000 + 20000) / 50000 * 100
  assertEquals(coverage.comfortCoveragePct, 92) // (30000 + 16000) / 50000 * 100
})

// Test: Coverage - Divide-by-zero guard
Deno.test('computeCoverage - divide by zero guard', () => {
  const coverage = computeCoverage(30000, 0, 20000)
  
  assertEquals(coverage.baseCoveragePct, 100)
  assertEquals(coverage.maxCoveragePct, 100)
  assertEquals(coverage.comfortCoveragePct, 100)
})

// Test: Coverage - Negative capacity clamped to 0
Deno.test('computeCoverage - negative capacity clamped', () => {
  const coverage = computeCoverage(-10000, 50000, 20000)
  
  assertEquals(coverage.baseCoveragePct, 0) // Clamped from negative
  assertEquals(coverage.maxCoveragePct, 20) // (-10000 + 20000) / 50000 * 100
})

// Test: Verdict - Yes without cuts
Deno.test('computeVerdict - yes without cuts', () => {
  const verdict = computeVerdict(50000, 40000, 100)
  assertEquals(verdict, 'yes')
})

// Test: Verdict - Yes with cuts
Deno.test('computeVerdict - yes with cuts', () => {
  const verdict = computeVerdict(30000, 50000, 100)
  assertEquals(verdict, 'yes')
})

// Test: Verdict - Close (75%+ coverage)
Deno.test('computeVerdict - close at 75%', () => {
  const verdict = computeVerdict(30000, 50000, 75)
  assertEquals(verdict, 'close')
})

// Test: Verdict - Close (80% coverage)
Deno.test('computeVerdict - close at 80%', () => {
  const verdict = computeVerdict(30000, 50000, 80)
  assertEquals(verdict, 'close')
})

// Test: Verdict - No (below 75%)
Deno.test('computeVerdict - no below 75%', () => {
  const verdict = computeVerdict(30000, 50000, 74)
  assertEquals(verdict, 'no')
})

// Test: Verdict - Zero requirement is always yes
Deno.test('computeVerdict - zero requirement always yes', () => {
  const verdict = computeVerdict(-10000, 0, 0)
  assertEquals(verdict, 'yes')
})

// Test: Vacation verdict - achievable at 30%
Deno.test('computeVacationVerdictByRequiredCut - yes at 30 percent', () => {
  const verdict = computeVacationVerdictByRequiredCut(3000, 10000)
  assertEquals(verdict, 'yes')
})

// Test: Vacation verdict - close between 30 and 40%
Deno.test('computeVacationVerdictByRequiredCut - close at 35 percent', () => {
  const verdict = computeVacationVerdictByRequiredCut(3500, 10000)
  assertEquals(verdict, 'close')
})

// Test: Vacation verdict - hard reach above 40%
Deno.test('computeVacationVerdictByRequiredCut - no above 40 percent', () => {
  const verdict = computeVacationVerdictByRequiredCut(4100, 10000)
  assertEquals(verdict, 'no')
})

// Test: Vacation verdict - no when no eligible spend and positive gap
Deno.test('computeVacationVerdictByRequiredCut - no with positive gap and zero eligible spend', () => {
  const verdict = computeVacationVerdictByRequiredCut(1000, 0)
  assertEquals(verdict, 'no')
})

// Test: Savings projection - Standard case
Deno.test('computeSavingsProjectionFields - standard case', () => {
  const result = computeSavingsProjectionFields(60000, 40000, 10000)
  
  assertEquals(result.realisticAmountCents, 50000) // min(60000, 40000 + 10000)
  assertEquals(result.recurringMonthlyCapacityCents, 50000)
  assertEquals(result.savingsRatePct, 83) // round(50000 / 60000 * 100)
  assertEquals(result.recurringSavingsRatePct, 83)
  assertEquals(result.isOneTimeAchievable, false)
  assertEquals(result.dailyDeductionCents, 1666) // floor(50000 / 30)
  assertEquals(result.projections.month3Cents, 150000)
  assertEquals(result.projections.month6Cents, 300000)
  assertEquals(result.projections.month12Cents, 600000)
})

// Test: Savings projection - Fully achievable
Deno.test('computeSavingsProjectionFields - fully achievable', () => {
  const result = computeSavingsProjectionFields(40000, 30000, 15000)
  
  assertEquals(result.realisticAmountCents, 40000) // Capped at target
  assertEquals(result.savingsRatePct, 100)
  assertEquals(result.isOneTimeAchievable, true)
})

// Test: Savings projection - Negative capacity
Deno.test('computeSavingsProjectionFields - negative capacity', () => {
  const result = computeSavingsProjectionFields(50000, -10000, 5000)
  
  assertEquals(result.realisticAmountCents, 0) // Can't save negative
  assertEquals(result.recurringMonthlyCapacityCents, 0)
  assertEquals(result.savingsRatePct, 0)
  assertEquals(result.dailyDeductionCents, 0)
  assertEquals(result.projections.month3Cents, 0)
})

// Test: Savings projection - Zero target guard
Deno.test('computeSavingsProjectionFields - zero target guard', () => {
  const result = computeSavingsProjectionFields(0, 30000, 10000)
  
  assertEquals(result.savingsRatePct, 0) // Guard against divide-by-zero
  assertEquals(result.realisticAmountCents, 0)
})

// Test: Savings projection - Daily deduction minimum
Deno.test('computeSavingsProjectionFields - daily deduction minimum', () => {
  const result = computeSavingsProjectionFields(100, 20, 5)
  
  assertEquals(result.realisticAmountCents, 25)
  assertEquals(result.dailyDeductionCents, 1) // max(1, floor(25 / 30))
})

console.log('All planner-core tests passed! (33 tests)')
