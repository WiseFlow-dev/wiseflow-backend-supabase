import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { cors } from '../_shared/cors.ts'
import { getServiceSupabaseClient, getUserFromAuthHeader } from '../_shared/supabaseClient.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const serviceClient = getServiceSupabaseClient()

    // Verify the caller's JWT and get their user record
    const user = await getUserFromAuthHeader(serviceClient, req)

    // Hard-delete the user from auth.users. Cascade deletes handle all their
    // app data (wallets, transactions, categories, etc.) via FK constraints.
    const { error } = await serviceClient.auth.admin.deleteUser(user.id)
    if (error) {
      console.error('deleteUser error:', error.message)
      return json({ error: 'Failed to delete account' }, 500)
    }

    console.log(`Account deleted: ${user.id}`)
    return json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('delete-account error:', message)
    return json({ error: message }, 401)
  }
})
