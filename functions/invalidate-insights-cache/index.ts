/**
 * Manual Cache Invalidation Endpoint
 * 
 * Allows admins to manually invalidate spending insights cache for debugging
 * and support purposes. Service role authentication required.
 * 
 * POST /functions/v1/invalidate-insights-cache
 * 
 * Body:
 * {
 *   "userId": "uuid",
 *   "monthKey": "2025-01", // Optional: specific month or omit for all months
 *   "scope": "aggregates" | "insights" | "both"
 * }
 * 
 * Response:
 * {
 *   "ok": true,
 *   "invalidated": {
 *     "userId": "uuid",
 *     "monthKey": "2025-01" | "all",
 *     "scope": "both",
 *     "aggregatesDeleted": 1,
 *     "insightsDeleted": 3
 *   }
 * }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface InvalidateCacheRequest {
  userId: string
  monthKey?: string // Optional: specific month or all months
  currencyCode?: string // Optional: specific currency or all currencies
  scope: 'aggregates' | 'insights' | 'both'
}

interface InvalidateCacheResponse {
  ok: boolean
  invalidated?: {
    userId: string
    monthKey: string
    currencyCode: string
    scope: string
    aggregatesDeleted: number
    insightsDeleted: number
  }
  error?: string
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Verify service role authentication
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get service role key from environment
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!serviceRoleKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY environment variable not set')
      return new Response(
        JSON.stringify({ ok: false, error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse Bearer token and compare exact match
    const token = authHeader.replace('Bearer ', '').trim()
    const isServiceRole = token === serviceRoleKey
    
    if (!isServiceRole) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Service role authentication required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Parse and validate request body
    const body: InvalidateCacheRequest = await req.json()
    
    if (!body.userId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'userId is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!['aggregates', 'insights', 'both'].includes(body.scope)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'scope must be aggregates, insights, or both' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate monthKey format if provided (YYYY-MM)
    if (body.monthKey && !/^\d{4}-\d{2}$/.test(body.monthKey)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'monthKey must be in YYYY-MM format' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Create Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabase = createClient(supabaseUrl, serviceRoleKey!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    let aggregatesDeleted = 0
    let insightsDeleted = 0

    // 4. Invalidate based on scope (currency-aware)
    if (body.scope === 'aggregates' || body.scope === 'both') {
      let query = supabase
        .from('user_monthly_spending_aggregates')
        .delete({ count: 'exact' })
        .eq('user_id', body.userId)
      
      if (body.monthKey) {
        query = query.eq('month_key', body.monthKey)
      }
      
      if (body.currencyCode) {
        query = query.eq('currency_code', body.currencyCode)
      }
      
      const { error, count } = await query
      
      if (error) {
        console.error('Error deleting aggregates:', error)
        throw error
      }
      
      aggregatesDeleted = count || 0
    }

    if (body.scope === 'insights' || body.scope === 'both') {
      let query = supabase
        .from('user_monthly_insights_cache')
        .delete({ count: 'exact' })
        .eq('user_id', body.userId)
      
      if (body.monthKey) {
        query = query.eq('month_key', body.monthKey)
      }
      
      if (body.currencyCode) {
        query = query.eq('currency_code', body.currencyCode)
      }
      
      const { error, count } = await query
      
      if (error) {
        console.error('Error deleting insights:', error)
        throw error
      }
      
      insightsDeleted = count || 0
    }

    // 5. Log invalidation to audit log
    const { error: auditError } = await supabase
      .from('aggregation_audit_log')
      .insert({
        user_id: body.userId,
        month_key: body.monthKey || null,
        operation: 'manual_invalidate',
        triggered_by: 'admin',
        metadata: {
          scope: body.scope,
          aggregates_deleted: aggregatesDeleted,
          insights_deleted: insightsDeleted,
          request_origin: req.headers.get('origin') || 'unknown'
        }
      })

    if (auditError) {
      console.error('Error logging to audit:', auditError)
      // Don't fail the request if audit logging fails
    }

    // 6. Return success response
    const response: InvalidateCacheResponse = {
      ok: true,
      invalidated: {
        userId: body.userId,
        monthKey: body.monthKey || 'all',
        currencyCode: body.currencyCode || 'all',
        scope: body.scope,
        aggregatesDeleted,
        insightsDeleted
      }
    }

    console.log('Cache invalidated successfully:', response.invalidated)

    return new Response(
      JSON.stringify(response),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )

  } catch (error) {
    console.error('Error in invalidate-insights-cache:', error)
    
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: error.message || 'Internal server error' 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})
