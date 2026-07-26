import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { getServiceSupabaseClient, getUserFromAuthHeader } from './_shared/supabaseClient.ts'
import { log, logError } from './_shared/logger.ts'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } })
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asPositiveCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

function asPositiveInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n))
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asText(item))
    .filter((item): item is string => Boolean(item))
}

function getClientTransferCompletion(payload: Record<string, unknown>) {
  const mode = asText(payload?.client_transfer_mode)
  const explicitCompleted = payload?.client_completed === true || payload?.client_flow_completed === true
  if (mode !== 'multi_wallet_transfer' && !explicitCompleted) return null

  const statusRaw = asText(payload?.client_transfer_status)?.toLowerCase()
  const transfer_status = statusRaw === 'canceled_partial' ? 'canceled_partial' : 'completed'
  const source_wallet_ids = asStringArray(payload?.source_wallet_ids)
  const transferred_total_cents = asPositiveCents(
    payload?.client_transfer_total_cents ?? payload?.transferred_total_cents
  )
  const transfer_count = Math.max(
    asPositiveInt(payload?.client_transfer_count ?? payload?.transfer_count),
    source_wallet_ids.length,
  )
  const completed = transfer_count > 0 || transferred_total_cents > 0

  return {
    transfer_mode: 'multi_wallet_transfer',
    transfer_status,
    source_wallet_ids,
    transferred_total_cents,
    transfer_count,
    completed,
  }
}

function shouldRecordExecution(outcome: Record<string, unknown>) {
  return outcome?.requires_client_flow !== true && outcome?.completed !== false
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()

    // Require authenticated user; actions are processed per-user
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const { limit } = await req.json().catch(() => ({ limit: 10 })) as { limit?: number }
    const batchSize = Math.min(Math.max(1, limit ?? 10), 25)

    // Pull oldest queued items for this user
    const { data: items, error: qErr } = await supabase
      .from('actions_queue')
      .select('id, proposal_id, rule_id, action_type, payload, attempts')
      .eq('user_id', userId)
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(batchSize)

    if (qErr) throw new Error(qErr.message)

    const processed: Array<{ id: string; status: string }> = []

    for (const item of items ?? []) {
      // Try to lock the item (best-effort optimistic lock)
      const { error: lockErr } = await supabase
        .from('actions_queue')
        .update({ status: 'in_progress', attempts: (item.attempts ?? 0) + 1, locked_at: new Date().toISOString() })
        .eq('id', item.id)
        .eq('status', 'queued')

      if (lockErr) {
        logError('actions_exec.lock_failed', { id: item.id, error: lockErr.message })
        continue
      }

      // Handle action
      try {
        const outcome = await handleAction(
          item.action_type as string,
          item.payload as Record<string, unknown>,
          userId,
          supabase
        )

        await supabase.from('action_outcomes').insert([{
          queue_id: item.id,
          success: true,
          detail: outcome,
        }])

        if (shouldRecordExecution(outcome) && item.proposal_id && item.rule_id) {
          try {
            const payload_json = { ...(item.payload ?? {}), outcome }
            await supabase
              .from('executed_actions')
              .insert([{
                user_id: userId,
                proposal_id: item.proposal_id,
                rule_id: item.rule_id,
                payload_json,
                status: 'success',
                meta: { queue_id: item.id, executed_by: 'actions-exec', accepted_at: new Date().toISOString() }
              }])
              .select('id')
              .maybeSingle()
          } catch (e) {
            logError('actions_exec.exec_insert_error', { id: item.id, error: String(e) })
          }
        }

        const nextQueueStatus = shouldRecordExecution(outcome) ? 'completed' : 'failed'
        await supabase
          .from('actions_queue')
          .update({ status: nextQueueStatus })
          .eq('id', item.id)

        processed.push({ id: item.id, status: 'completed' })
      } catch (err) {
        await supabase.from('action_outcomes').insert([{
          queue_id: item.id,
          success: false,
          detail: { error: String(err) },
        }])
        await supabase
          .from('actions_queue')
          .update({ status: 'failed' })
          .eq('id', item.id)
        processed.push({ id: item.id, status: 'failed' })
      }
    }

    log('actions_exec.completed', { userId, processed_count: processed.length })
    return json({ ok: true, processed })
  } catch (e) {
    logError('actions_exec.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})

async function handleAction(
  type: string,
  payload: Record<string, unknown>,
  userId: string,
  supabase: any
) {
  const retiredRules = new Set([
    'surplus_auto_shift_v1',
    'budget_underspend_to_savings_v1',
    'budget_coaching_v1',
    'dining_overspend_clamp_v1',
    'shopping_overspend_clamp_v1',
    'entertainment_overspend_clamp_v1',
  ])
  if (retiredRules.has(type)) {
    return { action: 'retired_rule_noop', completed: true, retired_rule: type }
  }

	switch (type) {
	    case 'cycle_leftover_to_savings_wallet_v1': {
		      const amount_cents = asPositiveCents(payload?.amount_cents)
	      const target_wallet_id = asText(payload?.target_wallet_id)
	      const target_wallet_name = asText(payload?.target_wallet_name) ?? 'Savings Wallet'
	      const clientTransfer = getClientTransferCompletion(payload)
	      if (clientTransfer?.completed && target_wallet_id && payload?.create_wallet_if_missing !== true) {
	        return {
	          action: 'client_transfer_recorded',
	          ...clientTransfer,
	          amount_cents,
	          target_wallet_id,
	          target_wallet_name,
	          target_wallet_type: 'savings',
	        }
	      }
	      if (!target_wallet_id || payload?.create_wallet_if_missing === true) {
	        return {
	          action: 'savings_wallet_required',
	          completed: false,
	          requires_client_flow: true,
	          target_wallet_type: 'savings',
	          target_wallet_name,
	          amount_cents,
	        }
	      }
	      return {
	        action: 'savings_transfer_required',
	        completed: false,
	        requires_client_flow: true,
	        amount_cents,
	        target_wallet_id,
	        target_wallet_name,
	        target_wallet_type: 'savings',
	        ...clientTransfer,
	      }
	    }
	    case 'emergency_wallet_booster_v1': {
	      const amount_cents = asPositiveCents(payload?.amount_cents)
	      const target_wallet_id = asText(payload?.target_wallet_id)
	      const target_wallet_name = asText(payload?.target_wallet_name) ?? 'Emergency Wallet'
	      const clientTransfer = getClientTransferCompletion(payload)
	      if (clientTransfer?.completed && target_wallet_id && payload?.create_wallet_if_missing !== true) {
	        return {
	          action: 'client_transfer_recorded',
	          ...clientTransfer,
	          amount_cents,
	          target_wallet_id,
	          target_wallet_name,
	          target_wallet_type: 'emergency',
	        }
	      }
	      if (!target_wallet_id || payload?.create_wallet_if_missing === true) {
	        return {
	          action: 'emergency_wallet_required',
	          completed: false,
	          requires_client_flow: true,
	          target_wallet_type: 'emergency',
	          target_wallet_name,
	          amount_cents,
	        }
	      }
	      return {
	        action: 'emergency_transfer_required',
	        completed: false,
	        requires_client_flow: true,
	        amount_cents,
	        target_wallet_id,
	        target_wallet_name,
	        target_wallet_type: 'emergency',
	        ...clientTransfer,
	      }
	    }
	    case 'budget_suggestion_v1': {
	      return {
	        action: 'budget_suggestion_recorded',
	        completed: true,
	        category_id: asText(payload?.category_id),
	        category_key: asText(payload?.category_key),
	        display_name: asText(payload?.display_name),
	        budget_name: asText(payload?.budget_name),
	        wallet_id: asText(payload?.wallet_id),
	      }
	    }
		    case 'challenge_suggestion_v1': {
		      return {
		        action: 'challenge_suggestion_recorded',
	        completed: true,
	        challenge_type: asText(payload?.challenge_type) ?? 'NO_SPEND',
	        category_key: asText(payload?.category_key),
	        display_name: asText(payload?.display_name),
	        wallet_id: asText(payload?.wallet_id),
	        duration_days: asPositiveInt(payload?.duration_days),
		        strict_mode: payload?.strict_mode === true,
		      }
		    }
	    case 'subscription_hike_unused_v1': {
	      const subscription_id = (payload?.subscription_id as string) ?? null
	      const { data: inserted, error } = await supabase
        .from('subscription_reviews')
        .insert([{ user_id: userId, subscription_id, status: 'open' }])
        .select('id')
        .maybeSingle()
      if (error) throw new Error(error.message)
      return { action: 'subscription_review_task', subscription_id, review_id: inserted?.id }
    }
    default:
      throw new Error(`Unknown action_type: ${type}`)
  }
}
