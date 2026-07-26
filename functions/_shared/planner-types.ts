/**
 * WiseFlow Planner - Core Types
 * Phase 0: Shared types for vacation and savings planners
 */

export interface EligibleCategory {
  name: string
  spendCents: number
  categoryId?: string
  categoryKey?: string
  expenseTier?: 'discretionary' | 'flexible_essential'
}

export interface TrimCategory {
  categoryId: string
  categoryKey: string
  name: string
  currentAmountCents: number
  recommendedCapCents: number
}

export interface CutAllocationResult {
  trimCategories: TrimCategory[]
  totalTrimmableCents: number
  selectedCutCents: number
  maxOptionalCutCapacityCents: number
}

export interface CoverageResult {
  baseCoveragePct: number
  comfortCoveragePct: number
  maxCoveragePct: number
}

export type Verdict = 'yes' | 'close' | 'no'

export interface SavingsProjectionFields {
  realisticAmountCents: number
  recurringMonthlyCapacityCents: number
  recurringSavingsRatePct: number
  isOneTimeAchievable: boolean
  savingsRatePct: number
  dailyDeductionCents: number
  projections: {
    month3Cents: number
    month6Cents: number
    month12Cents: number
  }
}

export interface NormalizationResult {
  normalizationFactor: number
  warnings: string[]
}
