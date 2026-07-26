import { assertEquals, assertThrows } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { parseNullableTransferGroupIdFromPatch } from './index.ts'

Deno.test('update-transaction: parseNullableTransferGroupIdFromPatch accepts valid Android-shaped group IDs', () => {
  const result = parseNullableTransferGroupIdFromPatch(
    { internal_transfer_group_id: 'itf_0123456789abcdef' },
    'internal_transfer_group_id',
    'existing-group',
  )
  assertEquals(result, 'itf_0123456789abcdef')
})

Deno.test('update-transaction: parseNullableTransferGroupIdFromPatch preserves existing value when key is absent', () => {
  const result = parseNullableTransferGroupIdFromPatch(
    {},
    'internal_transfer_group_id',
    'existing-group',
  )
  assertEquals(result, 'existing-group')
})

Deno.test('update-transaction: parseNullableTransferGroupIdFromPatch clears to null when explicit null is passed', () => {
  const result = parseNullableTransferGroupIdFromPatch(
    { internal_transfer_group_id: null },
    'internal_transfer_group_id',
    'existing-group',
  )
  assertEquals(result, null)
})

Deno.test('update-transaction: parseNullableTransferGroupIdFromPatch throws error for invalid supplied values', () => {
  assertThrows(
    () => parseNullableTransferGroupIdFromPatch(
      { internal_transfer_group_id: 12345 },
      'internal_transfer_group_id',
      'existing-group',
    ),
    Error,
    'Invalid internal_transfer_group_id. Expected string or null.',
  )
  assertThrows(
    () => parseNullableTransferGroupIdFromPatch(
      { internal_transfer_group_id: '' },
      'internal_transfer_group_id',
      'existing-group',
    ),
    Error,
    'Invalid internal_transfer_group_id. Expected non-empty string or null.',
  )
  assertThrows(
    () => parseNullableTransferGroupIdFromPatch(
      { internal_transfer_group_id: 'a'.repeat(129) },
      'internal_transfer_group_id',
      'existing-group',
    ),
    Error,
    'Invalid internal_transfer_group_id. Value too long (max 128 chars).',
  )
})
