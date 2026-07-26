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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function getClientFlowRequirement(type: string, payload: Record<string, unknown>) {
  switch (type) {
    case 'cycle_leftover_to_savings_wallet_v1': {
      const amount_cents = asPositiveCents(payload?.amount_cents)
      const target_wallet_id = asText(payload?.target_wallet_id)
      const target_wallet_name = asText(payload?.target_wallet_name) ?? 'Savings Wallet'
      const clientTransfer = getClientTransferCompletion(payload)
      if (target_wallet_id && payload?.create_wallet_if_missing !== true) {
        if (clientTransfer?.completed) return null
        return {
          action: 'savings_transfer_required',
          completed: false,
          requires_client_flow: true,
          target_wallet_id,
          target_wallet_type: 'savings',
          target_wallet_name,
          amount_cents,
          ...clientTransfer,
        }
      }
      return {
        action: 'savings_wallet_required',
        completed: false,
        requires_client_flow: true,
        target_wallet_type: 'savings',
        target_wallet_name,
        amount_cents,
      }
    }
    case 'emergency_wallet_booster_v1': {
      const amount_cents = asPositiveCents(payload?.amount_cents)
      const target_wallet_id = asText(payload?.target_wallet_id)
      const target_wallet_name = asText(payload?.target_wallet_name) ?? 'Emergency Wallet'
      const clientTransfer = getClientTransferCompletion(payload)
      if (target_wallet_id && payload?.create_wallet_if_missing !== true) {
        if (clientTransfer?.completed) return null
        return {
          action: 'emergency_transfer_required',
          completed: false,
          requires_client_flow: true,
          target_wallet_id,
          target_wallet_type: 'emergency',
          target_wallet_name,
          amount_cents,
          ...clientTransfer,
        }
      }
      return {
        action: 'emergency_wallet_required',
        completed: false,
        requires_client_flow: true,
        target_wallet_type: 'emergency',
        target_wallet_name,
        amount_cents,
      }
    }
    default:
      return null
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const body = await req.json().catch(() => ({})) as any
    let proposalId: string | null = (body?.proposal_id as string) ?? null
    const ruleId: string | null = (body?.rule_id as string) ?? null
    const periodKey: string | null = (body?.period_key as string) ?? null
    const payloadOverride = asObject(body?.payload_override)

    // Resolve target proposal
    if (!proposalId) {
      if (!ruleId || !periodKey) return json({ ok: false, error: 'Missing proposal_id or (rule_id + period_key)' }, 400)
      const { data: p, error: pErr } = await supabase
        .from('action_proposals')
        .select('id')
        .eq('user_id', userId)
        .eq('rule_id', ruleId)
        .eq('period_key', periodKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (pErr || !p) return json({ ok: false, error: 'Proposal not found' }, 404)
      proposalId = p.id
    }

    // Load proposal details
    const { data: proposal, error: gErr } = await supabase
      .from('action_proposals')
      .select('id, user_id, rule_id, status, cta_json, metadata')
      .eq('id', proposalId)
      .eq('user_id', userId)
      .maybeSingle()
    if (gErr || !proposal) return json({ ok: false, error: 'Proposal not found for user' }, 404)

    const payload = {
      ...asObject((proposal.cta_json as Record<string, unknown> | null)?.payload),
      ...payloadOverride,
    }
    const clientFlowRequirement = getClientFlowRequirement(proposal.rule_id as string, payload)
    if (clientFlowRequirement) {
      return json({
        ok: true,
        accepted: proposal.status === 'accepted',
        processed: {
          status: 'client_flow_required',
          outcome: clientFlowRequirement,
        }
      }, 200)
    }

    // Accept if not already accepted (fires enqueue trigger)
    if (proposal.status !== 'accepted') {
      const acceptedAt = new Date().toISOString()
      const proposalMetadata = asObject(proposal.metadata)
      const { error: uErr } = await supabase
        .from('action_proposals')
        .update({
          status: 'accepted',
          metadata: {
            ...proposalMetadata,
            accepted_at: acceptedAt,
          },
        })
        .eq('id', proposal.id)
        .eq('user_id', userId)
      if (uErr) return json({ ok: false, error: `Update failed: ${uErr.message}` }, 500)
    }

    // Ensure a queue item exists for this proposal
	    const { data: existing, error: qGetErr } = await supabase
	      .from('actions_queue')
	      .select('id, status, action_type, payload, attempts')
	      .eq('proposal_id', proposal.id)
	      .maybeSingle()
    if (qGetErr) return json({ ok: false, error: qGetErr.message }, 500)

    let queueId = existing?.id as string | undefined
    let queueStatus = existing?.status as string | undefined

    if (!queueId) {
      const { data: inserted, error: insErr } = await supabase
        .from('actions_queue')
        .insert([{ user_id: userId, proposal_id: proposal.id, rule_id: proposal.rule_id, action_type: proposal.rule_id, payload }])
        .select('id, status')
        .maybeSingle()
      if (insErr) return json({ ok: false, error: `Enqueue failed: ${insErr.message}` }, 500)
      queueId = inserted?.id
      queueStatus = inserted?.status
    }
    
    // If a queue item already exists and caller passed payload overrides,
    // refresh queued payload so execution uses the latest client flow fields.
    if (queueId && queueStatus !== 'completed' && Object.keys(payloadOverride).length > 0) {
      const nextStatus = queueStatus === 'failed' ? 'queued' : queueStatus
      const { error: payloadErr } = await supabase
        .from('actions_queue')
        .update({ payload, ...(nextStatus ? { status: nextStatus } : {}) })
        .eq('id', queueId)
        .eq('user_id', userId)
      if (payloadErr) {
        logError('accept_proposal.payload_update_failed', { queueId, error: payloadErr.message })
      } else if (queueStatus === 'failed') {
        queueStatus = 'queued'
      }
    }

    // If queue is in failed state and no new payload was supplied, do not churn it here.
    if (queueId && queueStatus === 'failed' && Object.keys(payloadOverride).length === 0) {
      return json({
        ok: true,
        accepted: true,
        processed: {
          queue_id: queueId,
          status: 'client_flow_required',
          outcome: { action: 'client_flow_required', completed: false },
        }
      }, 200)
    }

    // If already completed, return
    if (queueStatus === 'completed') {
      return json({ ok: true, accepted: true, processed: { queue_id: queueId, status: queueStatus } }, 200)
    }

    // Process this queue item inline (single-item version of actions-exec)
    // Try to lock
    const { error: lockErr } = await supabase
      .from('actions_queue')
      .update({ status: 'in_progress', attempts: (existing?.attempts ?? 0) + 1, locked_at: new Date().toISOString() })
      .eq('id', queueId)
      .eq('status', 'queued')
    if (lockErr) logError('accept_proposal.lock_failed', { queueId, error: lockErr.message })

    // Handle action
    try {
      // Compute outcome based on action_type
      const { data: qRow, error: qRowErr } = await supabase
        .from('actions_queue')
        .select('id, action_type, payload, status')
        .eq('id', queueId)
        .maybeSingle()
      if (qRowErr || !qRow) return json({ ok: false, error: 'Queue row missing' }, 500)
      if (qRow.status === 'completed') {
        return json({ ok: true, accepted: true, processed: { queue_id: queueId, status: 'completed' } }, 200)
      }

      const outcome = await handleAction(
        qRow.action_type as string,
        qRow.payload as Record<string, unknown>,
        userId,
        supabase
      )

      await supabase.from('action_outcomes').insert([{ queue_id: qRow.id, success: true, detail: outcome }])

	      const recordExecution = shouldRecordExecution(outcome)
	      if (recordExecution) {
	        try {
	          const payload_json = { ...(qRow.payload ?? {}), outcome }
	          await supabase
	            .from('executed_actions')
	            .insert([{ 
	              user_id: userId, 
	              proposal_id: proposal.id, 
	              rule_id: proposal.rule_id, 
	              payload_json, 
	              status: 'success', 
	              meta: { queue_id: qRow.id, accepted_at: new Date().toISOString() } 
	            }])
	            .select('id')
	            .maybeSingle()
	        } catch (e) {
	          logError('accept_proposal.exec_insert_error', { error: String(e) })
	        }
	      }

	      const nextQueueStatus = recordExecution ? 'completed' : 'failed'
	      await supabase.from('actions_queue').update({ status: nextQueueStatus }).eq('id', qRow.id)

	      log('accept_proposal.completed', { userId, proposal_id: proposal.id, queue_id: qRow.id })
	      return json({
	        ok: true,
	        accepted: true,
	        processed: {
	          queue_id: qRow.id,
	          status: recordExecution ? 'completed' : 'client_flow_required',
	          outcome,
	        }
	      }, 200)
    } catch (err) {
      await supabase.from('action_outcomes').insert([{ queue_id: queueId, success: false, detail: { error: String(err) } }])
      await supabase.from('actions_queue').update({ status: 'failed' }).eq('id', queueId)
      return json({ ok: false, error: String(err) }, 500)
    }
  } catch (e) {
    logError('accept_proposal.error', { error: String(e) })
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
