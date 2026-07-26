import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getUserFromAuthHeader(supabaseClient: any, req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Error('Missing Authorization header')
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabaseClient.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired token')
  return user
}

function log(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), event, ...meta }
  console.log(JSON.stringify(payload))
}

serve(async (req) => {
  try {
    const supabaseClient = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabaseClient, req)
    const url = new URL(req.url)
    const method = req.method

    log('baseline_metrics.request', { 
      user_id: user.id, 
      method, 
      path: url.pathname 
    })

    // GET /baseline-metrics - Get current baseline metrics
    if (method === 'GET' && url.pathname === '/baseline-metrics') {
      const startDate = url.searchParams.get('start_date') || 
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const endDate = url.searchParams.get('end_date') || 
        new Date().toISOString().split('T')[0]

      const { data: metrics, error } = await supabaseClient
        .rpc('get_baseline_metrics', { 
          start_date: startDate, 
          end_date: endDate 
        })

      if (error) {
        log('baseline_metrics.error', { error: error.message })
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Format metrics for dashboard
      const formattedMetrics = {
        period: { start_date: startDate, end_date: endDate },
        metrics: metrics.reduce((acc: any, row: any) => {
          acc[row.metric_name] = {
            value: parseFloat(row.metric_value),
            user_count: parseInt(row.user_count),
            description: row.description
          }
          return acc
        }, {}),
        summary: {
          total_users: Math.max(...metrics.map((m: any) => parseInt(m.user_count))),
          data_quality: metrics.length === 6 ? 'complete' : 'partial',
          generated_at: new Date().toISOString()
        }
      }

      log('baseline_metrics.success', { 
        user_id: user.id,
        metrics_count: metrics.length,
        period: { startDate, endDate }
      })

      return new Response(JSON.stringify(formattedMetrics), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // POST /baseline-metrics/track - Track insight interaction
    if (method === 'POST' && url.pathname === '/baseline-metrics/track') {
      const body = await req.json()
      const { 
        insight_id, 
        insight_type, 
        action_type, 
        view_duration_seconds = 0,
        insight_content = '',
        month_key 
      } = body

      // Validate required fields
      if (!insight_id || !insight_type || !action_type || !month_key) {
        return new Response(JSON.stringify({ 
          error: 'Missing required fields: insight_id, insight_type, action_type, month_key' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Insert interaction record (will trigger metrics update via trigger)
      const { error: insertError } = await supabaseClient
        .from('insight_interactions')
        .insert({
          user_id: user.id,
          insight_id,
          insight_type,
          action_type,
          view_duration_seconds,
          insight_content,
          month_key
        })

      if (insertError) {
        log('baseline_metrics.track_error', { 
          error: insertError.message,
          user_id: user.id,
          insight_id,
          action_type
        })
        return new Response(JSON.stringify({ error: insertError.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      log('baseline_metrics.tracked', { 
        user_id: user.id,
        insight_id,
        insight_type,
        action_type,
        month_key
      })

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // POST /baseline-metrics/feedback - Submit user feedback
    if (method === 'POST' && url.pathname === '/baseline-metrics/feedback') {
      const body = await req.json()
      const { 
        insight_id, 
        insight_type, 
        feedback_type,
        is_misleading = false,
        is_helpful = null,
        satisfaction_rating = null,
        insight_content = '',
        user_comment = ''
      } = body

      // Validate required fields
      if (!insight_id || !insight_type || !feedback_type) {
        return new Response(JSON.stringify({ 
          error: 'Missing required fields: insight_id, insight_type, feedback_type' 
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Insert feedback record
      const { error: insertError } = await supabaseClient
        .from('insight_feedback')
        .insert({
          user_id: user.id,
          insight_id,
          insight_type,
          feedback_type,
          is_misleading,
          is_helpful,
          satisfaction_rating,
          insight_content,
          user_comment
        })

      if (insertError) {
        log('baseline_metrics.feedback_error', { 
          error: insertError.message,
          user_id: user.id,
          insight_id,
          feedback_type
        })
        return new Response(JSON.stringify({ error: insertError.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // If this is a complaint about misleading insight, update metrics
      if (feedback_type === 'complaint' && is_misleading) {
        const currentMonth = new Date().toISOString().slice(0, 7) // "2025-02"
        
        await supabaseClient
          .from('insight_metrics')
          .upsert({
            user_id: user.id,
            month_key: currentMonth,
            user_complaints: 1
          }, {
            onConflict: 'user_id,month_key',
            ignoreDuplicates: false
          })
      }

      log('baseline_metrics.feedback_submitted', { 
        user_id: user.id,
        insight_id,
        insight_type,
        feedback_type,
        is_misleading
      })

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // GET /baseline-metrics/dashboard - Get formatted dashboard data
    if (method === 'GET' && url.pathname === '/baseline-metrics/dashboard') {
      const { data: metrics, error } = await supabaseClient
        .from('baseline_metrics_dashboard')
        .select('*')

      if (error) {
        log('baseline_metrics.dashboard_error', { error: error.message })
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      // Create dashboard-friendly format
      const dashboard = {
        title: 'Insights System Baseline Metrics',
        generated_at: new Date().toISOString(),
        period: 'Last 30 days',
        status: metrics.length > 0 ? 'active' : 'no_data',
        metrics: metrics.map((m: any) => ({
          name: m.metric_name,
          value: parseFloat(m.metric_value),
          user_count: parseInt(m.user_count),
          description: m.description,
          status: getMetricStatus(m.metric_name, parseFloat(m.metric_value))
        })),
        recommendations: generateRecommendations(metrics)
      }

      return new Response(JSON.stringify(dashboard), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    log('baseline_metrics.error', { error: error.message })
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

function getMetricStatus(metricName: string, value: number): string {
  switch (metricName) {
    case 'complaint_rate':
      return value > 20 ? 'critical' : value > 10 ? 'warning' : 'good'
    case 'engagement_time':
      return value < 5 ? 'critical' : value < 15 ? 'warning' : 'good'
    case 'false_positive_rate':
      return value > 30 ? 'critical' : value > 15 ? 'warning' : 'good'
    case 'satisfaction_score':
      return value < 2.5 ? 'critical' : value < 3.5 ? 'warning' : 'good'
    case 'action_rate':
      return value < 5 ? 'critical' : value < 15 ? 'warning' : 'good'
    case 'unfair_comparison_rate':
      return value > 10 ? 'critical' : value > 5 ? 'warning' : 'good'
    default:
      return 'unknown'
  }
}

function generateRecommendations(metrics: any[]): string[] {
  const recommendations: string[] = []
  
  metrics.forEach((metric: any) => {
    const value = parseFloat(metric.metric_value)
    const status = getMetricStatus(metric.metric_name, value)
    
    if (status === 'critical') {
      switch (metric.metric_name) {
        case 'complaint_rate':
          recommendations.push('🚨 High complaint rate detected - implement fair comparisons immediately')
          break
        case 'unfair_comparison_rate':
          recommendations.push('🚨 Unfair comparisons detected - Phase 1A implementation critical')
          break
        case 'false_positive_rate':
          recommendations.push('🚨 High false positive rate - quality filtering needed')
          break
        case 'engagement_time':
          recommendations.push('🚨 Low engagement - insights may not be valuable to users')
          break
      }
    }
  })
  
  if (recommendations.length === 0) {
    recommendations.push('✅ Baseline metrics established - ready to proceed with implementation')
  }
  
  return recommendations
}