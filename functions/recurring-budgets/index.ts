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

function computeServerKey(params: {
  user_id: string
  category_id: string | null
  period: string
  start_date: string
  end_date: string
  name: string | null
}): string {
  // Match app's GLOBAL budget format: user_id:GLOBAL:uuid:category_id:period:start_date:end_date:name_lower
  const u = params.user_id ?? ''
  const cat = params.category_id ?? ''
  const p = params.period ?? ''
  const s = params.start_date ?? ''
  const e = params.end_date ?? ''
  const n = (params.name ?? '').toLowerCase()
  return `${u}:GLOBAL:uuid:${cat}:${p}:${s}:${e}:${n}`
}

function calculateNextDates(
  startDate: string | null, 
  endDate: string | null, 
  frequency: string | null
): { startDate: string; endDate: string; path: string } {
  // Priority 1: If both start_date and end_date exist, check for full-month or custom range
  if (startDate && endDate) {
    const start = new Date(startDate + 'T00:00:00Z') // Parse as UTC
    const end = new Date(endDate + 'T00:00:00Z')
    
    // Check if this is a full calendar month
    const isFirstDayOfMonth = start.getUTCDate() === 1
    
    // Get last day of the start month
    const lastDayOfStartMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))
    const isLastDayOfMonth = end.getUTCDate() === lastDayOfStartMonth.getUTCDate() &&
                             end.getUTCMonth() === start.getUTCMonth() &&
                             end.getUTCFullYear() === start.getUTCFullYear()
    
    if (isFirstDayOfMonth && isLastDayOfMonth) {
      // Full month: advance to next calendar month
      const nextMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
      const lastDayOfNextMonth = new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0))
      
      return {
        startDate: nextMonth.toISOString().split('T')[0],
        endDate: lastDayOfNextMonth.toISOString().split('T')[0],
        path: 'full_month'
      }
    } else {
      // Custom range: use date range duration
      const durationMs = end.getTime() - start.getTime()
      const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24)) + 1
      
      // New start date = old end date + 1 day
      const newStart = new Date(end.getTime() + (1000 * 60 * 60 * 24))
      
      // New end date = new start date + (duration - 1) days
      const newEnd = new Date(newStart.getTime() + ((durationDays - 1) * 1000 * 60 * 60 * 24))
      
      return {
        startDate: newStart.toISOString().split('T')[0],
        endDate: newEnd.toISOString().split('T')[0],
        path: 'custom_range'
      }
    }
  }
  
  // Priority 2: Fallback to frequency-based calculation
  const end = new Date((endDate || new Date().toISOString().split('T')[0]) + 'T00:00:00Z')
  
  // Start date is end date + 1 day
  const start = new Date(end.getTime() + (1000 * 60 * 60 * 24))
  
  // Calculate new end date based on frequency
  const newEnd = new Date(start)
  switch (frequency) {
    case 'WEEKLY':
      newEnd.setUTCDate(newEnd.getUTCDate() + 7)
      break
    case 'MONTHLY':
      newEnd.setUTCMonth(newEnd.getUTCMonth() + 1)
      break
    case 'QUARTERLY':
      newEnd.setUTCMonth(newEnd.getUTCMonth() + 3)
      break
    case 'YEARLY':
      newEnd.setUTCFullYear(newEnd.getUTCFullYear() + 1)
      break
    default:
      // Default to monthly if frequency is invalid
      newEnd.setUTCMonth(newEnd.getUTCMonth() + 1)
  }
  
  // Subtract 1 day from end date to get the last day of the period
  newEnd.setUTCDate(newEnd.getUTCDate() - 1)
  
  return {
    startDate: start.toISOString().split('T')[0],
    endDate: newEnd.toISOString().split('T')[0],
    path: 'frequency_fallback'
  }
}

serve(async (req) => {
  try {
    const supabaseClient = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabaseClient, req)

    log('recurring_budgets.request', { user_id: user.id })

    // Query expired recurring budgets
    const { data: expiredBudgets, error: queryError } = await supabaseClient
      .from('budgets')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_recurring', true)
      .eq('is_active', true)
      .lt('end_date', new Date().toISOString().split('T')[0])

    if (queryError) {
      log('recurring_budgets.query_error', { error: queryError.message })
      throw queryError
    }

    if (!expiredBudgets || expiredBudgets.length === 0) {
      log('recurring_budgets.no_expired', { user_id: user.id })
      return new Response(
        JSON.stringify({ created: 0, message: 'No expired recurring budgets found' }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    log('recurring_budgets.found_expired', { count: expiredBudgets.length })

    let createdCount = 0
    const errors: string[] = []

    for (const budget of expiredBudgets) {
      try {
        // Calculate next period dates
        const { startDate, endDate, path } = calculateNextDates(
          budget.start_date,
          budget.end_date,
          budget.recurring_frequency
        )
        
        // For recurring budgets, reset tracking_start_date to the new period start
        // This ensures each renewed period starts fresh
        const trackingStartDate = startDate + 'T00:00:00Z'
        
        // Compute server_key for idempotency (match app's GLOBAL:uuid format)
        const period = budget.period || 'MONTHLY'
        const serverKey = computeServerKey({
          user_id: user.id,
          category_id: budget.category_id,
          period,
          start_date: startDate,
          end_date: endDate,
          name: budget.name,
        })

        // Check if budget with this server_key already exists (idempotency)
        const { data: existing, error: existingErr } = await supabaseClient
          .from('budgets')
          .select('id')
          .eq('user_id', user.id)
          .eq('server_key', serverKey)
          .maybeSingle()

        if (existingErr) {
          log('recurring_budgets.existing_check_error', { 
            budget_id: budget.id, 
            server_key: serverKey,
            error: existingErr.message 
          })
          errors.push(`Failed to check existing budget for ${budget.name}: ${existingErr.message}`)
          continue
        }

        if (existing) {
          // Duplicate already exists - skip insert but still deactivate old budget
          log('recurring_budgets.skip_duplicate', { 
            server_key: serverKey, 
            old_budget_id: budget.id,
            existing_budget_id: existing.id
          })
          
          // Mark old budget as inactive
          const { error: updateError } = await supabaseClient
            .from('budgets')
            .update({ is_active: false })
            .eq('id', budget.id)

          if (updateError) {
            log('recurring_budgets.update_error', { 
              budget_id: budget.id, 
              error: updateError.message 
            })
            errors.push(`Failed to deactivate old budget ${budget.name}: ${updateError.message}`)
          }
          
          continue
        }

        // Create new budget with server_key
        const newBudget = {
          user_id: user.id,
          wallet_id: budget.wallet_id,
          name: budget.name,
          amount_cents: budget.amount_cents,
          icon_key: budget.icon_key,
          start_date: startDate,
          end_date: endDate,
          category_id: budget.category_id,
          leftover_destination_wallet_id: budget.leftover_destination_wallet_id,
          is_recurring: budget.is_recurring,
          recurring_frequency: budget.recurring_frequency,
          tracking_start_date: trackingStartDate,
          period: period,
          spent_cents: 0,
          is_active: true,
          server_key: serverKey
        }

        const { error: insertError } = await supabaseClient
          .from('budgets')
          .insert(newBudget)

        if (insertError) {
          log('recurring_budgets.insert_error', { 
            budget_id: budget.id, 
            server_key: serverKey,
            error: insertError.message 
          })
          errors.push(`Failed to create budget for ${budget.name}: ${insertError.message}`)
          continue
        }

        // Mark old budget as inactive
        const { error: updateError } = await supabaseClient
          .from('budgets')
          .update({ is_active: false })
          .eq('id', budget.id)

        if (updateError) {
          log('recurring_budgets.update_error', { 
            budget_id: budget.id, 
            error: updateError.message 
          })
          errors.push(`Failed to deactivate old budget ${budget.name}: ${updateError.message}`)
          continue
        }

        createdCount++
        log('recurring_budgets.created', { 
          old_budget_id: budget.id,
          name: budget.name,
          start_date: startDate,
          end_date: endDate,
          path: path
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        log('recurring_budgets.process_error', { 
          budget_id: budget.id, 
          error: errorMsg 
        })
        errors.push(`Error processing budget ${budget.name}: ${errorMsg}`)
      }
    }

    log('recurring_budgets.complete', { 
      created: createdCount, 
      errors: errors.length 
    })

    return new Response(
      JSON.stringify({ 
        created: createdCount,
        processed: expiredBudgets.length,
        errors: errors.length > 0 ? errors : undefined
      }),
      { headers: { 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    log('recurring_budgets.error', { error: errorMsg })
    
    return new Response(
      JSON.stringify({ error: errorMsg }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})
