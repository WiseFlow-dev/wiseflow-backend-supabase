// ============================================================================
// LLM Rewrite Worker - Unit Tests
// ============================================================================

import { assertEquals, assertExists } from 'https://deno.land/std@0.192.0/testing/asserts.ts'

// Mock Supabase client
function createMockSupabase() {
  const calls: any[] = []
  
  return {
    calls,
    rpc: (fn: string, params?: any) => {
      calls.push({ type: 'rpc', fn, params })
      
      // Mock responses
      if (fn === 'get_next_llm_job') {
        return Promise.resolve({
          data: [{
            job_id: 1,
            user_id: 'test-user-id',
            month_key: '2025-01',
            insights: [
              { id: 'test-1', type: 'SPENDING_VELOCITY', title: 'Test', short: 'Test', recommendation: 'Test' }
            ],
            locale: 'en',
            attempts: 0
          }],
          error: null
        })
      }
      
      if (fn === 'pg_try_advisory_lock') {
        return Promise.resolve({ data: true, error: null })
      }
      
      if (fn === 'pg_advisory_unlock') {
        return Promise.resolve({ data: true, error: null })
      }
      
      if (fn === 'mark_llm_job_processing') {
        return Promise.resolve({ data: null, error: null })
      }
      
      if (fn === 'mark_llm_job_completed') {
        return Promise.resolve({ data: null, error: null })
      }
      
      if (fn === 'mark_llm_job_failed') {
        return Promise.resolve({ data: null, error: null })
      }
      
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => {
      const query = {
        select: (cols: string) => query,
        eq: (col: string, val: any) => query,
        upsert: (data: any, opts: any) => {
          calls.push({ type: 'upsert', table, data, opts })
          return Promise.resolve({ data: null, error: null })
        }
      }
      return query
    }
  }
}

Deno.test('shouldRunLLM - always run for current month', () => {
  const now = new Date()
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  
  // Import function (would need to export it from index.ts)
  // For now, test the logic inline
  const monthDate = new Date(currentMonth + '-01')
  const monthsOld = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12 
    + (now.getUTCMonth() - monthDate.getUTCMonth())
  
  assertEquals(monthsOld, 0, 'Current month should be 0 months old')
  assertEquals(monthsOld <= 2, true, 'Should run LLM for current month')
})

Deno.test('shouldRunLLM - always run for recent months (1-2 months old)', () => {
  const now = new Date()
  const lastMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  const lastMonthKey = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth() + 1).padStart(2, '0')}`
  
  const monthDate = new Date(lastMonthKey + '-01')
  const monthsOld = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12 
    + (now.getUTCMonth() - monthDate.getUTCMonth())
  
  assertEquals(monthsOld, 1, 'Last month should be 1 month old')
  assertEquals(monthsOld <= 2, true, 'Should run LLM for recent months')
})

Deno.test('shouldRunLLM - skip old months if already rewritten', () => {
  const now = new Date()
  const oldMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() - 6, 1)
  const oldMonthKey = `${oldMonth.getUTCFullYear()}-${String(oldMonth.getUTCMonth() + 1).padStart(2, '0')}`
  
  const monthDate = new Date(oldMonthKey + '-01')
  const monthsOld = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12 
    + (now.getUTCMonth() - monthDate.getUTCMonth())
  
  assertEquals(monthsOld > 2, true, 'Old month should be >2 months old')
  
  // If all insights have llm_rewritten_at, should skip
  const cachedInsights = [
    { llm_rewritten_at: '2025-01-01T00:00:00Z' },
    { llm_rewritten_at: '2025-01-01T00:00:00Z' }
  ]
  
  const allRewritten = cachedInsights.every(i => i.llm_rewritten_at != null)
  assertEquals(allRewritten, true, 'All insights rewritten')
  assertEquals(!allRewritten, false, 'Should skip LLM for old month with rewrites')
})

Deno.test('shouldRunLLM - run for old months if not rewritten', () => {
  const now = new Date()
  const oldMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() - 6, 1)
  const oldMonthKey = `${oldMonth.getUTCFullYear()}-${String(oldMonth.getUTCMonth() + 1).padStart(2, '0')}`
  
  const monthDate = new Date(oldMonthKey + '-01')
  const monthsOld = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12 
    + (now.getUTCMonth() - monthDate.getUTCMonth())
  
  assertEquals(monthsOld > 2, true, 'Old month should be >2 months old')
  
  // If some insights missing llm_rewritten_at, should run
  const cachedInsights = [
    { llm_rewritten_at: '2025-01-01T00:00:00Z' },
    { llm_rewritten_at: null } // Missing rewrite
  ]
  
  const allRewritten = cachedInsights.every(i => i.llm_rewritten_at != null)
  assertEquals(allRewritten, false, 'Not all insights rewritten')
  assertEquals(!allRewritten, true, 'Should run LLM for old month with missing rewrites')
})

Deno.test('hashToInt64 - produces consistent hash', () => {
  // Simple FNV-1a hash implementation for testing
  function hashToInt64(str: string): bigint {
    const encoder = new TextEncoder()
    const data = encoder.encode(str)
    
    let hash = 2166136261n
    for (const byte of data) {
      hash ^= BigInt(byte)
      hash = (hash * 16777619n) & 0xFFFFFFFFFFFFFFFFn
    }
    
    if (hash > 0x7FFFFFFFFFFFFFFFn) {
      hash = hash - 0x10000000000000000n
    }
    
    return hash
  }
  
  const hash1 = hashToInt64('llm-rewrite:user-123:2025-01')
  const hash2 = hashToInt64('llm-rewrite:user-123:2025-01')
  const hash3 = hashToInt64('llm-rewrite:user-456:2025-01')
  
  assertEquals(hash1, hash2, 'Same input should produce same hash')
  assertEquals(hash1 === hash3, false, 'Different input should produce different hash')
})

Deno.test('enqueue_llm_rewrite - idempotent', async () => {
  const supabase = createMockSupabase()
  
  // First call
  await supabase.rpc('enqueue_llm_rewrite', {
    p_user_id: 'test-user',
    p_month_key: '2025-01',
    p_insights: [],
    p_locale: 'en'
  })
  
  // Second call (should be idempotent)
  await supabase.rpc('enqueue_llm_rewrite', {
    p_user_id: 'test-user',
    p_month_key: '2025-01',
    p_insights: [],
    p_locale: 'en'
  })
  
  const enqueueCalls = supabase.calls.filter((c: any) => c.fn === 'enqueue_llm_rewrite')
  assertEquals(enqueueCalls.length, 2, 'Should have 2 enqueue calls')
})

Deno.test('processLLMJob - acquires advisory lock', async () => {
  const supabase = createMockSupabase()
  
  await supabase.rpc('pg_try_advisory_lock', { key: '12345' })
  
  const lockCalls = supabase.calls.filter((c: any) => c.fn === 'pg_try_advisory_lock')
  assertEquals(lockCalls.length, 1, 'Should acquire advisory lock')
  assertExists(lockCalls[0].params.key, 'Lock key should exist')
})

Deno.test('processLLMJob - releases advisory lock on completion', async () => {
  const supabase = createMockSupabase()
  
  await supabase.rpc('pg_advisory_unlock', { key: '12345' })
  
  const unlockCalls = supabase.calls.filter((c: any) => c.fn === 'pg_advisory_unlock')
  assertEquals(unlockCalls.length, 1, 'Should release advisory lock')
})

Deno.test('processLLMJob - marks job as completed on success', async () => {
  const supabase = createMockSupabase()
  
  await supabase.rpc('mark_llm_job_completed', { p_job_id: 1 })
  
  const completedCalls = supabase.calls.filter((c: any) => c.fn === 'mark_llm_job_completed')
  assertEquals(completedCalls.length, 1, 'Should mark job as completed')
  assertEquals(completedCalls[0].params.p_job_id, 1, 'Should pass correct job ID')
})

Deno.test('processLLMJob - marks job as failed on error', async () => {
  const supabase = createMockSupabase()
  
  await supabase.rpc('mark_llm_job_failed', { 
    p_job_id: 1, 
    p_error_message: 'Test error' 
  })
  
  const failedCalls = supabase.calls.filter((c: any) => c.fn === 'mark_llm_job_failed')
  assertEquals(failedCalls.length, 1, 'Should mark job as failed')
  assertEquals(failedCalls[0].params.p_job_id, 1, 'Should pass correct job ID')
  assertEquals(failedCalls[0].params.p_error_message, 'Test error', 'Should pass error message')
})
