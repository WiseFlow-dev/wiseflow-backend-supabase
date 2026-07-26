import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@6.9.13'
import { cors } from '../_shared/cors.ts'

const SENDER_EMAIL = Deno.env.get('CONTACT_SENDER_EMAIL') ?? ''
const SENDER_APP_PASSWORD = Deno.env.get('CONTACT_SENDER_APP_PASSWORD') ?? ''
const RECEIVER_EMAIL = Deno.env.get('CONTACT_RECEIVER_EMAIL') ?? ''

type ContactRequest = {
  name?: unknown
  email?: unknown
  subject?: unknown
  message?: unknown
}

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getUserFromAuthHeader(supabase: ReturnType<typeof getServiceSupabaseClient>, req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Error('Missing Authorization header')
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired token')
  return user
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  if (!SENDER_EMAIL || !SENDER_APP_PASSWORD || !RECEIVER_EMAIL) {
    console.error('send-contact-email: missing SMTP secrets')
    return json({ ok: false, error: 'Server misconfiguration' }, 500)
  }

  const supabase = getServiceSupabaseClient()

  try {
    await getUserFromAuthHeader(supabase, req)

    const body = await req.json().catch(() => ({})) as ContactRequest
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim()
    const subject = String(body.subject ?? '').trim()
    const message = String(body.message ?? '').trim()

    if (!name || !email || !subject || !message) {
      return json({ ok: false, error: 'All fields are required' }, 400)
    }

    const emailBody = `Hey, ${name} with email ${email} said:\n\n${message}`

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: SENDER_EMAIL,
        pass: SENDER_APP_PASSWORD,
      },
    })

    await transporter.sendMail({
      from: `"WiseFlow Support" <${SENDER_EMAIL}>`,
      to: RECEIVER_EMAIL,
      replyTo: email,
      subject: subject,
      text: emailBody,
    })

    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'contact_email.sent', subject }))
    return json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('Missing Authorization') || message.includes('Invalid or expired token')) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'contact_email.error', error: message }))
    return json({ ok: false, error: 'Failed to send message. Please try again.' }, 500)
  }
})
