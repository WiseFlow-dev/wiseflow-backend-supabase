export const TRANSACTION_AMOUNT_ABS_EXCLUSIVE = 10_000_000_000_000_000
export const REPORTING_AMOUNT_ABS_EXCLUSIVE = 1_000_000_000_000_000_000

export class AmountOutOfRangeError extends Error {
  readonly failureCategory: 'transaction_amount_out_of_range' | 'reporting_amount_out_of_range'

  constructor(failureCategory: 'transaction_amount_out_of_range' | 'reporting_amount_out_of_range') {
    super('Transaction amount is outside the supported range.')
    this.name = 'AmountOutOfRangeError'
    this.failureCategory = failureCategory
  }
}

export function parseTransactionAmount(value: unknown): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) {
    throw new Error('Invalid amount. Expected numeric value.')
  }
  if (Math.abs(amount) >= TRANSACTION_AMOUNT_ABS_EXCLUSIVE) {
    throw new AmountOutOfRangeError('transaction_amount_out_of_range')
  }
  return Number(amount.toFixed(2))
}

export function calculateReportingAmount(amount: number, rate: number): number {
  const reportingAmount = amount * rate
  if (
    !Number.isFinite(reportingAmount) ||
    Math.abs(reportingAmount) >= REPORTING_AMOUNT_ABS_EXCLUSIVE
  ) {
    throw new AmountOutOfRangeError('reporting_amount_out_of_range')
  }
  return Number(reportingAmount.toFixed(6))
}
