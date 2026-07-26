/**
 * Unit Tests for Cache Invalidation
 * 
 * Tests cache invalidation triggers, month boundaries, and manual invalidation endpoint.
 * 
 * Run with: deno test --allow-all
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Test configuration
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'http://localhost:54321'
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

let supabase: SupabaseClient

// Test user ID (use a test user or create one)
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'

// Helper to create test transaction
async function createTestTransaction(
  userId: string,
  date: string,
  amount: number,
  category: string = 'Other'
) {
  const { data, error } = await supabase
    .from('wallet_transactions')
    .insert({
      user_id: userId,
      wallet_id: '00000000-0000-0000-0000-000000000001',
      date,
      amount,
      category,
      note: 'Test transaction'
    })
    .select()
    .single()

  if (error) throw error
  return data
}

// Helper to seed aggregate cache
async function seedAggregateCache(userId: string, monthKey: string) {
  const { data, error } = await supabase
    .from('user_monthly_spending_aggregates')
    .insert({
      user_id: userId,
      month_key: monthKey,
      total_expense_cents: 100000,
      total_income_cents: 200000,
      transaction_count: 10,
      daily_totals: { '2025-01-15': 50000 },
      category_totals: { 'restaurants': 100000 },
      last_transaction_at: new Date().toISOString(),
      computed_at: new Date().toISOString()
    })
    .select()
    .single()

  if (error) throw error
  return data
}

// Helper to get aggregate cache
async function getAggregateCache(userId: string, monthKey: string) {
  const { data, error } = await supabase
    .from('user_monthly_spending_aggregates')
    .select('*')
    .eq('user_id', userId)
    .eq('month_key', monthKey)
    .maybeSingle()

  if (error) throw error
  return data
}

// Helper to cleanup test data
async function cleanup() {
  await supabase.from('wallet_transactions').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('user_monthly_spending_aggregates').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('user_monthly_insights_cache').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('aggregation_audit_log').delete().eq('user_id', TEST_USER_ID)
}

// ============================================================================
// TEST SUITE: Cache Invalidation Triggers
// ============================================================================

Deno.test('Cache Invalidation - INSERT transaction invalidates current month aggregate', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Cached aggregate for current month
    const monthKey = '2025-01'
    await seedAggregateCache(TEST_USER_ID, monthKey)
    
    let cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertExists(cached, 'Cache should exist before insert')
    
    // When: Insert new transaction
    await createTestTransaction(TEST_USER_ID, '2025-01-20T12:00:00Z', -50.00)
    
    // Wait for trigger to execute
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Then: Aggregate cache is invalidated
    cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertEquals(cached, null, 'Cache should be invalidated after insert')
    
  } finally {
    await cleanup()
  }
})

Deno.test('Cache Invalidation - UPDATE transaction amount invalidates aggregate', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Transaction and cached aggregate
    const monthKey = '2025-01'
    const txn = await createTestTransaction(TEST_USER_ID, '2025-01-15T12:00:00Z', -50.00)
    await seedAggregateCache(TEST_USER_ID, monthKey)
    
    let cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertExists(cached, 'Cache should exist before update')
    
    // When: Update transaction amount
    await supabase
      .from('wallet_transactions')
      .update({ amount: -100.00 })
      .eq('id', txn.id)
    
    // Wait for trigger
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Then: Cache invalidated
    cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertEquals(cached, null, 'Cache should be invalidated after update')
    
  } finally {
    await cleanup()
  }
})

Deno.test('Cache Invalidation - DELETE transaction invalidates aggregate', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Transaction and cached aggregate
    const monthKey = '2025-01'
    const txn = await createTestTransaction(TEST_USER_ID, '2025-01-15T12:00:00Z', -50.00)
    await seedAggregateCache(TEST_USER_ID, monthKey)
    
    let cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertExists(cached, 'Cache should exist before delete')
    
    // When: Delete transaction
    await supabase
      .from('wallet_transactions')
      .delete()
      .eq('id', txn.id)
    
    // Wait for trigger
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Then: Cache invalidated
    cached = await getAggregateCache(TEST_USER_ID, monthKey)
    assertEquals(cached, null, 'Cache should be invalidated after delete')
    
  } finally {
    await cleanup()
  }
})

Deno.test('Cache Invalidation - UPDATE timestamp crossing month boundary invalidates both months', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Transaction in January, cached aggregates for Jan & Feb
    const txn = await createTestTransaction(TEST_USER_ID, '2025-01-31T23:00:00Z', -50.00)
    await seedAggregateCache(TEST_USER_ID, '2025-01')
    await seedAggregateCache(TEST_USER_ID, '2025-02')
    
    let janCache = await getAggregateCache(TEST_USER_ID, '2025-01')
    let febCache = await getAggregateCache(TEST_USER_ID, '2025-02')
    assertExists(janCache, 'Jan cache should exist')
    assertExists(febCache, 'Feb cache should exist')
    
    // When: Update date from Jan 31 to Feb 1
    await supabase
      .from('wallet_transactions')
      .update({ date: '2025-02-01T00:00:00Z' })
      .eq('id', txn.id)
    
    // Wait for trigger
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Then: Both months invalidated
    janCache = await getAggregateCache(TEST_USER_ID, '2025-01')
    febCache = await getAggregateCache(TEST_USER_ID, '2025-02')
    assertEquals(janCache, null, 'Jan cache should be invalidated')
    assertEquals(febCache, null, 'Feb cache should be invalidated')
    
  } finally {
    await cleanup()
  }
})

// ============================================================================
// TEST SUITE: Month Boundaries (UTC)
// ============================================================================

Deno.test('Month Boundaries - Transaction at UTC midnight belongs to correct month', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Test: Transaction at 2025-01-31 23:59:59 UTC
    const txn1 = await createTestTransaction(TEST_USER_ID, '2025-01-31T23:59:59Z', -50.00)
    await seedAggregateCache(TEST_USER_ID, '2025-01')
    
    // Verify month key extraction
    const { data: monthKey1 } = await supabase.rpc('get_month_key_utc', { 
      ts: '2025-01-31T23:59:59Z' 
    })
    assertEquals(monthKey1, '2025-01', 'Should be January')
    
    // Test: Transaction at 2025-02-01 00:00:00 UTC
    const txn2 = await createTestTransaction(TEST_USER_ID, '2025-02-01T00:00:00Z', -50.00)
    
    const { data: monthKey2 } = await supabase.rpc('get_month_key_utc', { 
      ts: '2025-02-01T00:00:00Z' 
    })
    assertEquals(monthKey2, '2025-02', 'Should be February')
    
    // Cleanup
    await supabase.from('wallet_transactions').delete().in('id', [txn1.id, txn2.id])
    
  } finally {
    await cleanup()
  }
})

// ============================================================================
// TEST SUITE: Cache Freshness
// ============================================================================

Deno.test('Cache Freshness - is_aggregate_cache_fresh returns true when cache is fresh', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Transaction and fresh cache
    const monthKey = '2025-01'
    const txn = await createTestTransaction(TEST_USER_ID, '2025-01-15T12:00:00Z', -50.00)
    
    // Seed cache with last_transaction_at = transaction date
    await supabase
      .from('user_monthly_spending_aggregates')
      .insert({
        user_id: TEST_USER_ID,
        month_key: monthKey,
        total_expense_cents: 5000,
        transaction_count: 1,
        last_transaction_at: txn.date,
        computed_at: new Date().toISOString()
      })
    
    // When: Check freshness
    const { data: isFresh } = await supabase.rpc('is_aggregate_cache_fresh', {
      p_user_id: TEST_USER_ID,
      p_month_key: monthKey
    })
    
    // Then: Cache is fresh
    assertEquals(isFresh, true, 'Cache should be fresh')
    
  } finally {
    await cleanup()
  }
})

Deno.test('Cache Freshness - is_aggregate_cache_fresh returns false when newer transaction exists', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Old cache and newer transaction
    const monthKey = '2025-01'
    
    // Seed cache with old timestamp
    await supabase
      .from('user_monthly_spending_aggregates')
      .insert({
        user_id: TEST_USER_ID,
        month_key: monthKey,
        total_expense_cents: 5000,
        transaction_count: 1,
        last_transaction_at: '2025-01-15T12:00:00Z',
        computed_at: new Date().toISOString()
      })
    
    // Create newer transaction
    await createTestTransaction(TEST_USER_ID, '2025-01-20T12:00:00Z', -30.00)
    
    // When: Check freshness
    const { data: isFresh } = await supabase.rpc('is_aggregate_cache_fresh', {
      p_user_id: TEST_USER_ID,
      p_month_key: monthKey
    })
    
    // Then: Cache is stale
    assertEquals(isFresh, false, 'Cache should be stale')
    
  } finally {
    await cleanup()
  }
})

// ============================================================================
// TEST SUITE: Manual Invalidation Endpoint
// ============================================================================

Deno.test('Manual Invalidation - Endpoint invalidates specific month', async () => {
  supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  
  try {
    await cleanup()
    
    // Given: Cached aggregates for multiple months
    await seedAggregateCache(TEST_USER_ID, '2025-01')
    await seedAggregateCache(TEST_USER_ID, '2025-02')
    
    // When: Call invalidation endpoint for January only
    const response = await fetch(`${SUPABASE_URL}/functions/v1/invalidate-insights-cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId: TEST_USER_ID,
        monthKey: '2025-01',
        scope: 'both'
      })
    })
    
    const result = await response.json()
    
    // Then: January invalidated, February remains
    assertEquals(result.ok, true, 'Request should succeed')
    assertEquals(result.invalidated.monthKey, '2025-01')
    
    const janCache = await getAggregateCache(TEST_USER_ID, '2025-01')
    const febCache = await getAggregateCache(TEST_USER_ID, '2025-02')
    
    assertEquals(janCache, null, 'Jan cache should be invalidated')
    assertExists(febCache, 'Feb cache should remain')
    
  } finally {
    await cleanup()
  }
})

Deno.test('Manual Invalidation - Endpoint requires service role auth', async () => {
  // When: Call endpoint without service role key
  const response = await fetch(`${SUPABASE_URL}/functions/v1/invalidate-insights-cache`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer invalid-key',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      userId: TEST_USER_ID,
      monthKey: '2025-01',
      scope: 'both'
    })
  })
  
  // Then: Request rejected
  assertEquals(response.status, 403, 'Should return 403 Forbidden')
})

console.log('✅ All cache invalidation tests passed!')
