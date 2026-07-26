import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[spending-insights-llm] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) return cachedAccessToken.token;
  const sa = GOOGLE_SA;
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlBytes = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claims}`)));
  const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
  const tokenRes = await fetch(sa.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`Service account token exchange failed: ${JSON.stringify(tokenData)}`);
  cachedAccessToken = { token: tokenData.access_token, expiresAt: Date.now() + 3_300_000 };
  return tokenData.access_token;
}

async function fetchGeminiWithKeyFallback(model: string, body: Record<string, unknown>): Promise<Response | null> {
  const accessToken = await getAccessToken();
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
  const vertexBody = { ...body } as any;
  if (vertexBody.contents && Array.isArray(vertexBody.contents)) {
    vertexBody.contents = vertexBody.contents.map((c: any) => ({ ...c, role: c.role || 'user' }));
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(vertexBody)
    })
    if (res.ok) return res
  } catch (_e) { /* network error */ }
  return null
}

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

function logError(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), level: 'error', event, ...meta }
  console.error(JSON.stringify(payload))
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

// Helper to get language name for prompt
function getLanguageName(locale: string): string {
  const names: Record<string, string> = {
    'en': 'English',
    'es': 'Spanish',
    'ru': 'Russian',
    'fr': 'French',
    'de': 'German'
  }
  return names[locale] || 'English'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const startTime = Date.now()
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const body = await req.json().catch(() => ({}))
    const month = String(body.month || '').trim() // e.g. "2025-11"
    const localeRaw = String(body.locale || 'en').trim().toLowerCase()
    const locale = localeRaw.split('-')[0] // Normalize "es-ES" → "es", "ru-RU" → "ru"
    const insights = Array.isArray(body.insights) ? body.insights : []

    if (!month || insights.length === 0) {
      return json({ ok: false, error: 'month and insights[] are required' }, 400)
    }

    log('spending_insights_llm.start', { userId, month, locale, insightCount: insights.length })

    // Fetch a compact snapshot of goals & challenges for this user
    const goalsSummary = await buildGoalsAndChallengesSummary(supabase, userId)

    // Ask Gemini (Wisey) to rewrite insight texts + generate notification summaries
    const geminiStart = Date.now()
    const rewritten = await generateInsightNarrativesWithGemini({
      month,
      locale,
      insights,
      goalsSummary
    })
    const geminiDuration = Date.now() - geminiStart
    
    log('spending_insights_llm.gemini_complete', { userId, month, durationMs: geminiDuration, resultCount: rewritten.length })

    // Best-effort: store notification-sized summaries as in-app nudges for the Actions Center
    try {
      const { error: cleanupError } = await supabase
        .from('nudges')
        .delete()
        .eq('user_id', userId)
        .eq('trigger', 'spending_insight')

      if (cleanupError) {
        logError('spending_insights_llm.nudges_cleanup_error', { userId, error: cleanupError.message })
      }

      const rows = rewritten
        .filter((r) => r.notification_title && r.notification_body)
        .map((r) => ({
          user_id: userId,
          trigger: 'spending_insight',
          channel: 'in_app',
          payload_json: {
            title: r.notification_title,
            body: r.notification_body,
            insight_id: r.id,
            month
          }
        }))

      if (rows.length > 0) {
        const { error: nudgesError } = await supabase
          .from('nudges')
          .insert(rows)
        if (nudgesError) {
          logError('spending_insights_llm.nudges_error', { userId, error: nudgesError.message })
        }
      }
    } catch (e) {
      logError('spending_insights_llm.nudges_exception', { userId, error: String(e) })
    }

    log('spending_insights_llm.generated', {
      userId,
      month,
      locale,
      insight_count: rewritten.length
    })

    const totalDuration = Date.now() - startTime
    log('spending_insights_llm.complete', { userId, month, totalDurationMs: totalDuration, insightCount: rewritten.length })

    return json({ ok: true, insights: rewritten })
  } catch (e) {
    logError('spending_insights_llm.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})

async function buildGoalsAndChallengesSummary(supabase: any, userId: string): Promise<string> {
  try {
    const { data: goals, error } = await supabase
      .from('goals')
      .select('name, is_wish, is_challenge, current_amount_cents, target_amount_cents, target_date_millis')
      .eq('user_id', userId)
      .limit(10)

    if (error || !goals || goals.length === 0) {
      return 'User has no active goals or challenges recorded.'
    }

    const isWishGoal = (g: any) =>
      !g?.is_challenge &&
      (g?.is_wish === true || (g?.is_wish !== false && Number(g?.target_amount_cents ?? 0) <= 0))
    const activeGoals = goals.filter((g: any) => !g.is_challenge && !isWishGoal(g))
    const wishItems = goals.filter((g: any) => isWishGoal(g))
    const activeChallenges = goals.filter((g: any) => !!g.is_challenge)

    const parts: string[] = []

    if (activeGoals.length > 0) {
      const goalLines = activeGoals.slice(0, 5).map((g: any) => {
        const curr = (g.current_amount_cents || 0) / 100
        const target = (g.target_amount_cents || 0) / 100
        const progress = target > 0 ? Math.round((curr / target) * 100) : 0
        return `${g.name}: ${curr.toFixed(0)}/${target.toFixed(0)} (${progress}%)`
      })
      parts.push(`Goals: ${goalLines.join('; ')}`)
    }

    if (wishItems.length > 0) {
      const wishLines = wishItems.slice(0, 5).map((w: any) => {
        const targetDateMillis = Number(w.target_date_millis ?? 0)
        if (targetDateMillis > 0) {
          return `${w.name} (date hint ${new Date(targetDateMillis).toISOString().slice(0, 10)})`
        }
        return `${w.name}`
      })
      parts.push(`Wish items: ${wishLines.join(', ')}`)
    }

    if (activeChallenges.length > 0) {
      const challengeLines = activeChallenges.slice(0, 5).map((c: any) => c.name)
      parts.push(`Challenges: ${challengeLines.join(', ')}`)
    }

    if (parts.length === 0) {
      return 'User has no active goals or challenges recorded.'
    }

    return parts.join(' | ')
  } catch (e) {
    logError('spending_insights_llm.goals_error', { error: String(e) })
    return 'User goals and challenges could not be loaded.'
  }
}

async function generateInsightNarrativesWithGemini(payload: {
  month: string
  locale: string
  insights: any[]
  goalsSummary: string
}): Promise<
  Array<{
    id: string
    title: string
    short: string
    recommendation: string
    notification_title: string
    notification_body: string
  }>
> {
  const { month, locale, insights, goalsSummary } = payload
  const languageName = getLanguageName(locale)

  const prompt = `You are Wisey, WiseFlow's in-app money companion.

The app has already detected several monthly spending patterns for a user.
Your job is to turn each raw pattern into:
- A SHORT INSIGHT TITLE for the Spending screen
- A SHORT CONTEXT LINE (1-2 sentences, max ~160 characters)
- A SHORT RECOMMENDATION (1 sentence, max ~160 characters)
- A NOTIFICATION TITLE (max ~60 characters)
- A NOTIFICATION BODY (1-2 short lines, max ~140 characters) that can appear in a notification center.

CRITICAL LANGUAGE REQUIREMENT:
Write all output in ${languageName} language. All titles, descriptions, recommendations, and notifications must be in ${languageName}.

IMPORTANT RULES:
- Month context: This is specifically for the month ${month}. Keep wording month-focused.
- Variation: Do NOT repeat the exact same phrasing across insights. Vary structure and style slightly.
- Tone: Calm, supportive, non-judgmental. No fear or shame. Be concrete and helpful.
- Numbers: You may lightly rephrase but do NOT invent big numbers beyond what is implied in the raw text.
- Goals & challenges: If it naturally fits, gently connect suggestions to the user's goals and challenges below. Treat contributions toward goals (savings, transfers into goals, paying down debt) as positive progress, not as "overspending".
- If you mention transfers or moving money, make it clear when it's moving money into a goal/savings (a win) versus spending on a merchant (consumption).
- Length limits are HARD caps. Stay compact.
- DO NOT mention that you are an AI, a model, or that this text was generated.

USER GOALS & CHALLENGES SNAPSHOT:
${goalsSummary}

RAW INSIGHTS (one per line):
${insights
  .map((i: any, idx: number) => {
    const id = String(i.id || `insight_${idx}`)
    const type = String(i.type || 'GENERIC')
    const title = String(i.title || '')
    const short = String(i.short || '')
    const recommendation = String(i.recommendation || '')
    return `- id=${id}; type=${type}; title="${title}"; short="${short}"; recommendation="${recommendation}"`
  })
  .join('\n')}

For EACH insight above, return a JSON array where each element has this exact shape:
[
  {
    "id": "<matches one of the ids above>",
    "title": "<short insight title in ${languageName}, <= 45 chars>",
    "short": "<short context line in ${languageName}, 1-2 sentences, <= 160 chars>",
    "recommendation": "<1 sentence suggestion in ${languageName}, <= 160 chars>",
    "notification_title": "<notification title in ${languageName}, <= 60 chars>",
    "notification_body": "<notification body in ${languageName}, 1-2 short lines, <= 140 chars>"
  }
]

Return ONLY valid JSON. No backticks, no markdown, no extra commentary.`

  const res = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
    contents: [{
      parts: [{ text: prompt }]
    }]
  })

  if (!res) {
    throw new Error('All Gemini keys failed')
  }

  const data = await res.json()
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!rawText) {
    throw new Error('No text from Gemini')
  }

  try {
    // Allow either plain JSON or JSON inside a code block
    const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/i) || rawText.match(/\[[\s\S]*\]/)
    const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawText
    const parsed = JSON.parse(jsonText)
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array')

    return parsed.map((item: any) => ({
      id: String(item.id || ''),
      title: String(item.title || '').slice(0, 60),
      short: String(item.short || '').slice(0, 200),
      recommendation: String(item.recommendation || '').slice(0, 220),
      notification_title: String(item.notification_title || '').slice(0, 80),
      notification_body: String(item.notification_body || '').slice(0, 220)
    }))
  } catch (e) {
    logError('spending_insights_llm.parse_error', { rawText, error: String(e) })
    throw e
  }
}
