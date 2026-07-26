/**
 * WiseFlow Planner - Core Functions
 * Phase 0: Pure, deterministic calculation functions
 * 
 * All functions are side-effect free and handle edge cases with math guards.
 */

import type {
  EligibleCategory,
  TrimCategory,
  CutAllocationResult,
  CoverageResult,
  Verdict,
  SavingsProjectionFields,
  NormalizationResult,
} from './planner-types.ts'

// Constants
const MIN_CYCLE_ELAPSED_DAYS = 7
const MAX_NORMALIZATION_FACTOR = 2.0
const PLANNER_CATEGORY_CUT_CAP_RATIO = 0.40
const CLOSE_COVERAGE_THRESHOLD = 0.75
const ACHIEVABLE_REQUIRED_CUT_PCT_MAX = 30
const CLOSE_REQUIRED_CUT_PCT_MAX = 40

/**
 * Compute normalization factor for partial-cycle data
 * 
 * Early-cycle behavior:
 * - If rawElapsedDays < minElapsedDays, use conservative denominator
 * - Cap factor at maxNormalizationFactor to prevent extreme extrapolation
 * 
 * @param cycleTotalDays - Total days in billing cycle
 * @param rawElapsedDays - Days elapsed so far (can be 0)
 * @param minElapsedDays - Minimum days before standard normalization (default 7)
 * @param maxNormalizationFactor - Hard cap for early-cycle extrapolation (default 2.0)
 * @returns Normalization result with factor and warnings
 */
export function computeNormalizationFactor(
  cycleTotalDays: number,
  rawElapsedDays: number,
  minElapsedDays: number = MIN_CYCLE_ELAPSED_DAYS,
  maxNormalizationFactor: number = MAX_NORMALIZATION_FACTOR
): NormalizationResult {
  const warnings: string[] = []
  
  // Guard: Ensure positive values
  const safeCycleTotalDays = Math.max(1, cycleTotalDays)
  const safeRawElapsedDays = Math.max(0, rawElapsedDays)
  
  // Guard: Prevent divide-by-zero
  const denominatorDays = Math.max(1, safeRawElapsedDays)
  
  let normalizationFactor = safeCycleTotalDays / denominatorDays
  
  // Early-cycle conservative normalization
  if (safeRawElapsedDays < minElapsedDays) {
    warnings.push(`Only ${safeRawElapsedDays} days into cycle. Using conservative normalization.`)
    const flooredDenominator = Math.max(minElapsedDays, denominatorDays)
    normalizationFactor = Math.min(
      safeCycleTotalDays / flooredDenominator,
      maxNormalizationFactor
    )
  }
  
  return {
    normalizationFactor,
    warnings
  }
}

/**
 * Compute adjusted required amount for vacation (avoiding double-counting)
 * 
 * If existing vacation goal is already counted in fixed obligations,
 * don't subtract it again from the requirement.
 * 
 * @param requiredMonthlyCents - Base monthly requirement
 * @param existingVacationGoalMonthlyCents - Existing goal contribution
 * @param fixedGoalAutoSaveCents - Goal auto-save already in fixed obligations
 * @returns Adjusted requirement (never negative)
 */
export function computeAdjustedRequiredCentsVacation(
  requiredMonthlyCents: number,
  existingVacationGoalMonthlyCents: number,
  fixedGoalAutoSaveCents: number
): number {
  // Guard: Ensure non-negative inputs
  const safeRequired = Math.max(0, requiredMonthlyCents)
  const safeExisting = Math.max(0, existingVacationGoalMonthlyCents)
  const safeFixed = Math.max(0, fixedGoalAutoSaveCents)
  
  // Check if existing goal is already counted in fixed obligations
  const existingGoalAlreadyCountedInFixed =
    safeExisting > 0 && safeFixed >= safeExisting
  
  if (existingGoalAlreadyCountedInFixed) {
    // Don't subtract - already accounted for
    return safeRequired
  } else {
    // Subtract existing goal, but never go negative
    return Math.max(0, safeRequired - safeExisting)
  }
}

/**
 * Compute gap between requirement and capacity
 * 
 * @param adjustedRequiredCents - Adjusted monthly requirement
 * @param baseCapacityCents - Base monthly capacity (can be negative)
 * @returns Gap amount (never negative)
 */
export function computeGapCents(
  adjustedRequiredCents: number,
  baseCapacityCents: number
): number {
  return Math.max(0, adjustedRequiredCents - baseCapacityCents)
}

type CutEligibleTier = 'discretionary' | 'flexible_essential'

function isCutEligibleTier(value: unknown): value is CutEligibleTier {
  return value === 'discretionary' || value === 'flexible_essential'
}

function clampRatio(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function computeTierCutCapRatio(
  tier: CutEligibleTier,
  spendCents: number,
  tierTotalCents: number,
  tierRank: number
): number {
  const share = tierTotalCents > 0 ? Math.max(0, spendCents) / tierTotalCents : 0

  if (tier === 'discretionary') {
    return clampRatio(0.30 + share * 0.30 - tierRank * 0.05, 0.22, 0.55)
  }

  return clampRatio(0.08 + share * 0.14 - tierRank * 0.03, 0.05, 0.25)
}

/**
 * Allocate cuts across eligible categories.
 *
 * Legacy callers without `expenseTier` keep the old proportional 40% cap behavior.
 * Tier-aware callers use the Wisey strategy:
 * discretionary first, flexible essentials second, and lower caps on flexible essentials.
 *
 * @param eligibleCategories - Categories eligible for cuts
 * @param gapCents - Amount needed to cover
 * @param capRatio - Legacy maximum cut ratio when no expense tiers are provided
 * @returns Cut allocation result
 */
export function allocateCappedCuts(
  eligibleCategories: EligibleCategory[],
  gapCents: number,
  capRatio: number = PLANNER_CATEGORY_CUT_CAP_RATIO
): CutAllocationResult {
  // CRITICAL: Enforce 40% cap at API boundary (spec policy)
  const safeCapRatio = Math.min(PLANNER_CATEGORY_CUT_CAP_RATIO, Math.max(0, capRatio))
  // Guard: Empty categories
  if (eligibleCategories.length === 0) {
    return {
      trimCategories: [],
      totalTrimmableCents: 0,
      selectedCutCents: 0,
      maxOptionalCutCapacityCents: 0
    }
  }
  
  // Guard: Ensure non-negative gap
  const safeGapCents = Math.max(0, gapCents)
  
  // Calculate total eligible spend
  const totalEligibleSpendCents = eligibleCategories.reduce(
    (sum, cat) => sum + Math.max(0, cat.spendCents),
    0
  )
  
  // Guard: Zero spend
  if (totalEligibleSpendCents === 0) {
    return {
      trimCategories: [],
      totalTrimmableCents: 0,
      selectedCutCents: 0,
      maxOptionalCutCapacityCents: 0
    }
  }
  
  const hasTierAwareCategories = eligibleCategories.some((cat) => isCutEligibleTier(cat.expenseTier))

  // Calculate max cut capacity per category
  interface CategoryWithCuts extends EligibleCategory {
    expenseTier?: CutEligibleTier
    maxCutForCategoryCents: number
    selectedCutCents: number
    proportionalRemainder: number
  }

  const categoriesWithCuts: CategoryWithCuts[] = eligibleCategories
    .map(cat => {
      const safeSpend = Math.max(0, cat.spendCents)
      return {
        ...cat,
        expenseTier: isCutEligibleTier(cat.expenseTier) ? cat.expenseTier : undefined,
        spendCents: safeSpend,
        maxCutForCategoryCents: Math.floor(safeSpend * safeCapRatio),
        selectedCutCents: 0,
        proportionalRemainder: 0
      }
    })
    .filter((cat) => {
      if (!hasTierAwareCategories) return true
      return isCutEligibleTier(cat.expenseTier)
    })

  if (hasTierAwareCategories) {
    const tierOrder: CutEligibleTier[] = ['discretionary', 'flexible_essential']

    for (const tier of tierOrder) {
      const tierCategories = categoriesWithCuts
        .filter((cat) => cat.expenseTier === tier)
        .sort((a, b) => b.spendCents - a.spendCents)
      const tierTotalCents = tierCategories.reduce((sum, cat) => sum + cat.spendCents, 0)

      tierCategories.forEach((cat, index) => {
        cat.maxCutForCategoryCents = Math.floor(
          cat.spendCents * computeTierCutCapRatio(tier, cat.spendCents, tierTotalCents, index)
        )
      })
    }
  }

  // Calculate total cut capacity
  const totalCutCapacityCents = categoriesWithCuts.reduce(
    (sum, cat) => sum + cat.maxCutForCategoryCents,
    0
  )
  
  // Target cut (capped by total capacity)
  const targetCutCents = Math.min(safeGapCents, totalCutCapacityCents)
  
  const allocateWithinGroup = (group: CategoryWithCuts[], groupTargetCents: number) => {
    const groupSpendCents = group.reduce((sum, cat) => sum + cat.spendCents, 0)
    if (groupSpendCents <= 0 || groupTargetCents <= 0) return 0

    const groupCapacityCents = group.reduce((sum, cat) => sum + cat.maxCutForCategoryCents, 0)
    const targetForGroup = Math.min(groupTargetCents, groupCapacityCents)

    for (const cat of group) {
      const proportionalRaw = (targetForGroup * cat.spendCents) / groupSpendCents
      const proportionalFloor = Math.floor(proportionalRaw)
      cat.proportionalRemainder = proportionalRaw - proportionalFloor
      cat.selectedCutCents = Math.min(cat.maxCutForCategoryCents, proportionalFloor)
    }

    const allocatedCents = group.reduce((sum, cat) => sum + cat.selectedCutCents, 0)
    let remainderCents = targetForGroup - allocatedCents

    const sortedByRemainder = [...group].sort(
      (a, b) => b.proportionalRemainder - a.proportionalRemainder
    )

    while (remainderCents > 0) {
      let progressed = false

      for (const cat of sortedByRemainder) {
        if (remainderCents <= 0) break

        const spareCents = cat.maxCutForCategoryCents - cat.selectedCutCents
        if (spareCents <= 0) continue

        cat.selectedCutCents += 1
        remainderCents -= 1
        progressed = true

        if (remainderCents === 0) break
      }

      if (!progressed) break
    }

    return group.reduce((sum, cat) => sum + cat.selectedCutCents, 0)
  }

  if (hasTierAwareCategories) {
    let remainingTargetCents = targetCutCents
    for (const tier of ['discretionary', 'flexible_essential'] as CutEligibleTier[]) {
      if (remainingTargetCents <= 0) break
      const group = categoriesWithCuts
        .filter((cat) => cat.expenseTier === tier)
        .sort((a, b) => b.spendCents - a.spendCents)
      const allocated = allocateWithinGroup(group, remainingTargetCents)
      remainingTargetCents -= allocated
    }
  } else {
    allocateWithinGroup(categoriesWithCuts, targetCutCents)
  }
  
  // Build trim categories
  const trimCategories: TrimCategory[] = categoriesWithCuts
    .filter(cat => cat.selectedCutCents > 0)
    .sort((a, b) => {
      if (hasTierAwareCategories) {
        const tierPriority: Record<CutEligibleTier, number> = {
          discretionary: 0,
          flexible_essential: 1,
        }
        const aPriority = isCutEligibleTier(a.expenseTier) ? tierPriority[a.expenseTier] : 99
        const bPriority = isCutEligibleTier(b.expenseTier) ? tierPriority[b.expenseTier] : 99
        if (aPriority !== bPriority) return aPriority - bPriority
      }
      return b.selectedCutCents - a.selectedCutCents
    })
    .map(cat => ({
      categoryId: cat.categoryId || '',
      categoryKey: cat.categoryKey || cat.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: cat.name,
      currentAmountCents: cat.spendCents,
      recommendedCapCents: cat.spendCents - cat.selectedCutCents
    }))
  
  const selectedCutCents = categoriesWithCuts.reduce(
    (sum, cat) => sum + cat.selectedCutCents,
    0
  )
  
  return {
    trimCategories,
    totalTrimmableCents: totalCutCapacityCents,
    selectedCutCents,
    maxOptionalCutCapacityCents: totalCutCapacityCents
  }
}

/**
 * Compute coverage percentages
 * 
 * @param baseCapacityCents - Base monthly capacity (can be negative)
 * @param adjustedRequiredCents - Adjusted monthly requirement
 * @param totalTrimmableCents - Total amount that can be cut
 * @returns Coverage percentages (clamped to 0 minimum)
 */
export function computeCoverage(
  baseCapacityCents: number,
  adjustedRequiredCents: number,
  totalTrimmableCents: number
): CoverageResult {
  const safeTrimmable = Math.max(0, totalTrimmableCents)
  
  // Guard: Divide-by-zero
  if (adjustedRequiredCents <= 0) {
    return {
      baseCoveragePct: 100,
      comfortCoveragePct: 100,
      maxCoveragePct: 100
    }
  }
  
  // Calculate raw coverage (can be negative)
  const baseCoverageRaw = (baseCapacityCents / adjustedRequiredCents) * 100
  const maxCoverageRaw = ((baseCapacityCents + safeTrimmable) / adjustedRequiredCents) * 100
  const comfortCoverageRaw = ((baseCapacityCents + (safeTrimmable * 0.80)) / adjustedRequiredCents) * 100
  
  // Clamp to 0 minimum for display
  return {
    baseCoveragePct: Math.max(0, baseCoverageRaw),
    comfortCoveragePct: Math.max(0, comfortCoverageRaw),
    maxCoveragePct: Math.max(0, maxCoverageRaw)
  }
}

/**
 * Compute verdict based on capacity and coverage
 * 
 * Logic:
 * - "yes" if base capacity meets requirement OR max coverage meets requirement
 * - "close" if max coverage >= 75%
 * - "no" otherwise
 * 
 * @param baseCapacityCents - Base monthly capacity
 * @param adjustedRequiredCents - Adjusted monthly requirement
 * @param maxCoveragePct - Maximum coverage percentage with cuts
 * @returns Verdict
 */
export function computeVerdict(
  baseCapacityCents: number,
  adjustedRequiredCents: number,
  maxCoveragePct: number
): Verdict {
  // Guard: Zero or negative requirement is always "yes"
  if (adjustedRequiredCents <= 0) {
    return 'yes'
  }
  
  // Check if achievable without cuts
  if (baseCapacityCents >= adjustedRequiredCents) {
    return 'yes'
  }
  
  // Check if achievable with cuts (100% coverage)
  if (maxCoveragePct >= 100) {
    return 'yes'
  }
  
  // Check if close (75%+ coverage)
  if (maxCoveragePct >= CLOSE_COVERAGE_THRESHOLD * 100) {
    return 'close'
  }
  
  return 'no'
}

/**
 * Compute vacation verdict from required cut percentage of eligible spend.
 *
 * Rules:
 * - "yes" when required cut is 0-30% of eligible categories spend
 * - "close" when required cut is >30-40%
 * - "no" when required cut is >40% or there is no eligible spend to cut from
 *
 * @param requiredMonthlyCents - Required monthly saving amount to evaluate
 * @param totalEligibleSpendCents - Total monthly spend in eligible categories (pre-cap)
 * @returns Verdict compatible with existing UI contract
 */
export function computeVacationVerdictByRequiredCut(
  requiredMonthlyCents: number,
  totalEligibleSpendCents: number
): Verdict {
  const safeRequired = Math.max(0, requiredMonthlyCents)
  if (safeRequired <= 0) return 'yes'

  const safeEligibleSpend = Math.max(0, totalEligibleSpendCents)
  if (safeEligibleSpend <= 0) return 'no'

  const requiredCutPct = (safeRequired / safeEligibleSpend) * 100

  if (requiredCutPct <= ACHIEVABLE_REQUIRED_CUT_PCT_MAX) return 'yes'
  if (requiredCutPct <= CLOSE_REQUIRED_CUT_PCT_MAX) return 'close'
  return 'no'
}

/**
 * Compute savings projection fields
 * 
 * All projections use recurring capacity only (never one-time cash buffer).
 * 
 * @param targetSavingsCents - Target savings amount
 * @param baseCapacityCents - Base monthly capacity
 * @param selectedCutCents - Selected cuts amount
 * @returns Savings projection fields
 */
export function computeSavingsProjectionFields(
  targetSavingsCents: number,
  baseCapacityCents: number,
  selectedCutCents: number
): SavingsProjectionFields {
  const safeTarget = Math.max(0, targetSavingsCents)
  const safeCuts = Math.max(0, selectedCutCents)
  
  // Recurring capacity (can't save negative amounts)
  const recurringCapacity = Math.max(0, baseCapacityCents + safeCuts)
  
  // Realistic amount (capped by target)
  const realisticAmountCents = Math.min(safeTarget, recurringCapacity)
  
  // Savings rate
  const savingsRatePct = safeTarget > 0
    ? Math.round((realisticAmountCents / safeTarget) * 100)
    : 0
  
  // Daily deduction for auto-save
  const dailyDeductionCents = realisticAmountCents > 0
    ? Math.max(1, Math.floor(realisticAmountCents / 30))
    : 0
  
  // One-time achievable flag
  const isOneTimeAchievable = realisticAmountCents >= safeTarget
  
  // Projections (recurring capacity)
  const projections = {
    month3Cents: realisticAmountCents * 3,
    month6Cents: realisticAmountCents * 6,
    month12Cents: realisticAmountCents * 12
  }
  
  return {
    realisticAmountCents,
    recurringMonthlyCapacityCents: realisticAmountCents,
    recurringSavingsRatePct: savingsRatePct,
    isOneTimeAchievable,
    savingsRatePct,
    dailyDeductionCents,
    projections
  }
}
