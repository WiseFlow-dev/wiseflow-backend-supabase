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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }
  try {
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const { action, proposal_id, executed_action_id } = await req.json()
    if (!action) return json({ error: 'Missing action' }, 400)

    if (action === 'accept') {
      return json({
        error: 'Deprecated accept path. Use /functions/v1/accept-proposal.',
      }, 410)
    }

    if (action === 'decline') {
      if (!proposal_id) return json({ error: 'Missing proposal_id' }, 400)

      const { data: proposal, error: pErr } = await supabase
        .from('action_proposals')
        .select('id, rule_id, status')
        .eq('id', proposal_id)
        .eq('user_id', userId)
        .single()
      if (pErr || !proposal) return json({ error: 'Proposal not found' }, 404)
      if (proposal.status !== 'pending') return json({ error: 'Proposal is not pending' }, 409)

      const { error: upErr } = await supabase
        .from('action_proposals')
        .update({ status: 'declined' })
        .eq('id', proposal_id)
      if (upErr) return json({ error: 'Failed to decline proposal' }, 500)

      await supabase.from('action_audit_logs').insert([{
        user_id: userId,
        event: 'action_declined',
        entity_type: 'action',
        entity_id: proposal_id,
        metadata: { rule_id: proposal.rule_id }
      }])

      log('actions.decline', { userId, proposal_id, rule_id: proposal.rule_id })
      return json({ ok: true })
    }

    if (action === 'undo') {
      if (!executed_action_id) return json({ error: 'Missing executed_action_id' }, 400)

      const { data: exec, error: eErr } = await supabase
        .from('executed_actions')
        .select('id, user_id, created_at, status, proposal_id')
        .eq('id', executed_action_id)
        .eq('user_id', userId)
        .single()
      if (eErr || !exec) return json({ error: 'Executed action not found' }, 404)
      if (exec.status !== 'success') return json({ error: 'Only successful actions can be undone' }, 409)

      // Check risk & time window from proposal
      const { data: prop } = await supabase
        .from('action_proposals')
        .select('risk_level')
        .eq('id', exec.proposal_id)
        .maybeSingle()
      const risk = prop?.risk_level ?? 'low'
      const createdAt = new Date(exec.created_at)
      const within7d = (Date.now() - createdAt.getTime()) <= 7 * 24 * 60 * 60 * 1000
      if (risk !== 'low' || !within7d) return json({ error: 'Undo not allowed' }, 403)

      const { error: upErr } = await supabase
        .from('executed_actions')
        .update({ status: 'undone', undone_at: new Date().toISOString() })
        .eq('id', executed_action_id)
      if (upErr) return json({ error: 'Failed to undo action' }, 500)

      await supabase.from('action_audit_logs').insert([{
        user_id: userId,
        event: 'action_undone',
        entity_type: 'action',
        entity_id: executed_action_id,
        metadata: {}
      }])

      log('actions.undo', { userId, executed_action_id })
      return json({ ok: true })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    logError('actions.error', { error: String(e) })
    return json({ error: String(e) }, 500)
  }
})
