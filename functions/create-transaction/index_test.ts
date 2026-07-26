import { assertEquals, assertThrows } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { asOptionalTransferGroupId } from './index.ts'

Deno.test('create-transaction: asOptionalTransferGroupId accepts valid Android-shaped group IDs', () => {
  assertEquals(asOptionalTransferGroupId('itf_0123456789abcdef'), 'itf_0123456789abcdef')
  assertEquals(asOptionalTransferGroupId('  itf_0123456789abcdef  '), 'itf_0123456789abcdef')
})

Deno.test('create-transaction: asOptionalTransferGroupId returns null for absent or explicit null', () => {
  assertEquals(asOptionalTransferGroupId(undefined), null)
  assertEquals(asOptionalTransferGroupId(null), null)
  assertEquals(asOptionalTransferGroupId(''), null)
  assertEquals(asOptionalTransferGroupId('   '), null)
})

Deno.test('create-transaction: asOptionalTransferGroupId throws validation error for invalid supplied values', () => {
  assertThrows(
    () => asOptionalTransferGroupId(12345),
    Error,
    'Invalid internal_transfer_group_id. Expected string or null.',
  )
  assertThrows(
    () => asOptionalTransferGroupId(true),
    Error,
    'Invalid internal_transfer_group_id. Expected string or null.',
  )
  assertThrows(
    () => asOptionalTransferGroupId({ id: '123' }),
    Error,
    'Invalid internal_transfer_group_id. Expected string or null.',
  )
  assertThrows(
    () => asOptionalTransferGroupId('a'.repeat(129)),
    Error,
    'Invalid internal_transfer_group_id. Value too long (max 128 chars).',
  )
})
