import { getServiceSupabaseClient } from './supabaseClient.ts'
import { log, logError } from './logger.ts'

const FCM_SERVER_KEY = Deno.env.get('FCM_SERVER_KEY') || ''

export async function sendPushToUser(userId: string, title: string, body: string, data: Record<string, string> = {}) {
  try {
    if (!FCM_SERVER_KEY) {
      log('push.skip_no_key', { userId })
      return { sent: 0 }
    }

    const supabase = getServiceSupabaseClient()
    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('token, platform')
      .eq('user_id', userId)

    if (error) {
      logError('push.tokens_error', { userId, error })
      return { sent: 0 }
    }

    if (!tokens || tokens.length === 0) {
      log('push.no_tokens', { userId })
      return { sent: 0 }
    }

    let sent = 0
    for (const t of tokens) {
      try {
        const res = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `key=${FCM_SERVER_KEY}`
          },
          body: JSON.stringify({
            to: t.token,
            notification: { title, body },
            data
          })
        })
        if (res.ok) sent += 1
        else logError('push.send_failed', { userId, status: res.status, token: t.token })
      } catch (e) {
        logError('push.exception', { userId, error: String(e) })
      }
    }

    log('push.sent', { userId, count: sent })
    return { sent }
  } catch (e) {
    logError('push.global_error', { userId, error: String(e) })
    return { sent: 0 }
  }
}
