// ============================================================================
// LLM Rewrite Worker - Background job processor
// ============================================================================
// Polls the llm_rewrite_queue table and processes pending jobs by calling
// the spending-insights-llm function to enhance raw insights with LLM.
//
// Features:
//   - Postgres advisory locks for idempotency
//   - Automatic retry on failure (max 3 attempts)
//   - Skip logic for old months (>2 months old if already rewritten)
//   - Updates insights cache with rewritten text
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

interface LLMJob {
  job_id: number
  user_id: string
  month_key: string
  currency_code: string
  insights: any[]
  locale: string
  attempts: number
}

interface RawInsight {
  id: string
  type: string
  title: string
  short: string
  recommendation: string
  detailStats?: Array<{ label: string; value: string; valueColor?: string }>
}

// Hash string to int64 for advisory lock
function hashToInt64(str: string): bigint {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  
  // Simple hash function (FNV-1a)
  let hash = 2166136261n
  for (const byte of data) {
    hash ^= BigInt(byte)
    hash = (hash * 16777619n) & 0xFFFFFFFFFFFFFFFFn
  }
  
  // Convert to signed int64
  if (hash > 0x7FFFFFFFFFFFFFFFn) {
    hash = hash - 0x10000000000000000n
  }
  
  return hash
}

// Check if we should run LLM for this month
function shouldRunLLM(monthKey: string, cachedInsights: any[] | null): boolean {
  const monthDate = new Date(monthKey + '-01')
  const now = new Date()
  const monthsOld = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12 
    + (now.getUTCMonth() - monthDate.getUTCMonth())
  
  // Always run for current/recent months (0-2 months old)
  if (monthsOld <= 2) return true
  
  // For old months (>2 months), skip only if already rewritten
  if (!cachedInsights || cachedInsights.length === 0) return true
  
  const allRewritten = cachedInsights.every(i => i.llm_rewritten_at != null)
  return !allRewritten // Run if any missing rewrite
}

// Process a single LLM job
async function processLLMJob(job: LLMJob, supabase: any): Promise<void> {
  const lockKey = hashToInt64(`llm-rewrite:${job.user_id}:${job.month_key}:${job.currency_code}`)
  
  console.log('Processing LLM job', {
    jobId: job.job_id,
    userId: job.user_id,
    monthKey: job.month_key,
    currencyCode: job.currency_code,
    locale: job.locale,
    insightCount: job.insights.length,
    attempt: job.attempts + 1
  })
  
  // Try to acquire advisory lock BEFORE marking as processing
  const { data: lockAcquired, error: lockError } = await supabase.rpc('pg_try_advisory_lock', {
    key: Number(lockKey) // Send as number, not string
  })
  
  if (lockError || !lockAcquired) {
    console.log('Another worker is processing this job, skipping', { jobId: job.job_id })
    return
  }
  
  try {
    // Mark job as processing AFTER lock acquired (prevents stuck jobs if worker crashes)
    await supabase.rpc('mark_llm_job_processing', { p_job_id: job.job_id })
    
    // Check if we should skip LLM for this month (currency-aware)
    const { data: cachedInsights } = await supabase
      .from('user_monthly_insights_cache')
      .select('llm_rewritten_at')
      .eq('user_id', job.user_id)
      .eq('month_key', job.month_key)
      .eq('currency_code', job.currency_code)
    
    if (!shouldRunLLM(job.month_key, cachedInsights)) {
      console.log('Skipping LLM for old month with existing rewrites', {
        monthKey: job.month_key,
        monthsOld: Math.floor((Date.now() - new Date(job.month_key + '-01').getTime()) / (30 * 24 * 60 * 60 * 1000))
      })
      
      await supabase.rpc('mark_llm_job_completed', { p_job_id: job.job_id })
      return
    }
    
    // Call spending-insights-llm function
    console.log('Calling LLM to rewrite insights...')
    const llmResponse = await fetch(`${SUPABASE_URL}/functions/v1/spending-insights-llm`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        insights: job.insights,
        locale: job.locale
      })
    })
    
    if (!llmResponse.ok) {
      const errorText = await llmResponse.text()
      throw new Error(`LLM function failed: ${llmResponse.status} ${errorText}`)
    }
    
    const { rewrittenInsights } = await llmResponse.json()
    
    if (!rewrittenInsights || rewrittenInsights.length === 0) {
      throw new Error('LLM returned no rewritten insights')
    }
    
    console.log('LLM rewrite successful', { count: rewrittenInsights.length })
    
    // Update insights cache with rewritten text (currency-scoped)
    const now = new Date().toISOString()
    
    for (const insight of rewrittenInsights) {
      await supabase
        .from('user_monthly_insights_cache')
        .upsert({
          user_id: job.user_id,
          month_key: job.month_key,
          currency_code: job.currency_code,
          insight_type: insight.type,
          insight_data: insight,
          raw_computed_at: now,
          llm_rewritten_at: now
        }, {
          onConflict: 'user_id,month_key,currency_code,insight_type'
        })
    }
    
    console.log('Insights cache updated with LLM rewrites')
    
    // Mark job as completed
    await supabase.rpc('mark_llm_job_completed', { p_job_id: job.job_id })
    
    console.log('LLM job completed successfully', { jobId: job.job_id })
    
  } catch (error) {
    console.error('LLM job failed', {
      jobId: job.job_id,
      error: error.message,
      attempt: job.attempts + 1
    })
    
    // Mark job as failed (will retry if attempts < max_attempts)
    await supabase.rpc('mark_llm_job_failed', {
      p_job_id: job.job_id,
      p_error_message: error.message
    })
    
  } finally {
    // Always release advisory lock
    await supabase.rpc('pg_advisory_unlock', { key: Number(lockKey) }) // Send as number, not string
  }
}

// Main worker loop
Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    
    // Get next pending job
    const { data: jobs, error: jobError } = await supabase.rpc('get_next_llm_job')
    
    if (jobError) {
      console.error('Failed to get next job', jobError)
      return new Response(JSON.stringify({ error: 'Failed to get next job' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({ message: 'No pending jobs' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    const job = jobs[0] as LLMJob
    
    // Process the job (lock acquired inside processLLMJob before marking processing)
    await processLLMJob(job, supabase)
    
    return new Response(JSON.stringify({ 
      success: true,
      jobId: job.job_id,
      userId: job.user_id,
      monthKey: job.month_key,
      currencyCode: job.currency_code
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
    
  } catch (error) {
    console.error('Worker error', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
