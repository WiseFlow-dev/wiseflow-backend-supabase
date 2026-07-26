import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AmountOutOfRangeError, calculateReportingAmount, parseTransactionAmount } from './transactionAmount.ts'

Deno.test('transaction amount parsing keeps ordinary two-decimal values', () => {
  assertEquals(parseTransactionAmount(123.456), 123.46)
  assertEquals(parseTransactionAmount(-123.456), -123.46)
  assertEquals(parseTransactionAmount(0), 0)
})

Deno.test('transaction amount parsing preserves the existing large PEN amount', () => {
  assertEquals(parseTransactionAmount(9_999_999_999), 9_999_999_999)
})

Deno.test('transaction amount parsing accepts the widened database boundary', () => {
  assertEquals(
    parseTransactionAmount(9_999_999_999_999_998),
    9_999_999_999_999_998,
  )
})

Deno.test('transaction amount parsing rejects values outside numeric 18,2', () => {
  const error = assertThrows(
    () => parseTransactionAmount(10_000_000_000_000_000),
    AmountOutOfRangeError,
  )
  assertEquals(error.failureCategory, 'transaction_amount_out_of_range')
})

Deno.test('transaction amount parsing rejects invalid numeric input', () => {
  assertThrows(() => parseTransactionAmount('not-a-number'), Error, 'Invalid amount')
  assertThrows(() => parseTransactionAmount(Number.POSITIVE_INFINITY), Error, 'Invalid amount')
})

Deno.test('reporting amount calculation enforces numeric 24,6', () => {
  assertEquals(calculateReportingAmount(10_000_000_000, 0.28898), 2_889_800_000)

  const error = assertThrows(
    () => calculateReportingAmount(9_999_999_999_999_998, 101),
    AmountOutOfRangeError,
  )
  assertEquals(error.failureCategory, 'reporting_amount_out_of_range')
})
