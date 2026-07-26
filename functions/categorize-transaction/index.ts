import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[categorize-transaction] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }
  const sa = GOOGLE_SA;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  }
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlBytes = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey,
      new TextEncoder().encode(`${header}.${claims}`)),
  );
  const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
  const tokenRes = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Service account token exchange failed: ${JSON.stringify(tokenData)}`);
  }
  cachedAccessToken = { token: tokenData.access_token, expiresAt: Date.now() + 3_300_000 };
  return tokenData.access_token;
}

const GEMINI_KEYS: string[] = ['vertex_sa']

console.log('[categorize-transaction] vertex_ai_configured', { project: VERTEX_PROJECT })

async function callGemini(_apiKey: string, prompt: string) {
  const accessToken = await getAccessToken();
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 256
      }
    })
  })
  return res
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

function normalizeText(s: string) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function fallbackSuggestions(categories: string[]): Array<{ category: string; confidence: number; reason: string }> {
  // We avoid guessing a random category. If the model fails, we only return "Other" with very low confidence.
  const other = categories.find((c) => c.trim().toLowerCase() === 'other')
  if (other) return [{ category: other, confidence: 0.05, reason: 'fallback:model_failed' }]
  return []
}

function tryParseJsonObject(rawText: string): any {
  // Try direct JSON
  try {
    return JSON.parse(rawText)
  } catch (_e) {
    // Try extracting the first JSON object from the text
    const start = rawText.indexOf('{')
    const end = rawText.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const slice = rawText.slice(start, end + 1)
      try {
        return JSON.parse(slice)
      } catch (_e2) {
        return null
      }
    }
    return null
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()
    await getUserFromAuthHeader(supabase, req)

    const body = await req.json().catch(() => ({}))
    const title = String(body.title ?? '').trim()
    const merchant = body.merchant == null ? null : String(body.merchant).trim()
    const note = body.note == null ? null : String(body.note).trim()
    const categories = Array.isArray(body.categories) ? body.categories.map((c: any) => String(c ?? '').trim()).filter(Boolean) : []

    console.log('[categorize-transaction] request', {
      title_len: title.length,
      has_merchant: !!merchant,
      has_note: !!note,
      categories_count: categories.length
    })

    if (!title || categories.length === 0) {
      return json({ ok: false, error: 'title and categories[] are required' }, 400)
    }

    const categoryList = categories.map((c: string) => `- ${c}`).join('\n')
    const normTitle = normalizeText(title)
    const normMerchant = merchant ? normalizeText(merchant) : ''
    const normNote = note ? normalizeText(note) : ''

    const prompt = `You are a transaction categorization assistant.

IMPORTANT:
- The user may type the transaction title in ANY language.
- Your job is to understand what the item/service is (meaning), not to match category names.
- Pick the best category from the provided list.
- Do NOT default to "Health" unless it is clearly medical (doctor, pharmacy, hospital, medicine, dentist, etc.).

TASK:
Given a transaction, pick the BEST category suggestions from the provided list.

OUTPUT RULES:
- You MUST pick categories ONLY from the provided list, exactly as written.
- If you are confident (about 0.90+), return ONLY 1 suggestion.
- If you are unsure between two, return EXACTLY 2 suggestions.
- IMPORTANT: Only return the category "Other" if your confidence is below 0.10.
- NEVER return more than 2.
- Return ONLY valid JSON. No markdown. No extra text.

TRANSACTION:
- title: "${normTitle}"
- merchant: "${normMerchant}"
- note: "${normNote}"

CATEGORIES:
${categoryList}

Return JSON in this exact format:
{
  "suggestions": [
    { "category": "<category from list>", "confidence": <0..1>, "reason": "<short reason>" }
  ]
}`

    // Try Gemini (strict JSON). If output is invalid, retry once with an even stricter instruction.
    const retryPrompt = `${prompt}

REMINDER:
- Output must be valid JSON only.
- Return ONLY categories from the list.
- If you are unsure, return exactly 2 suggestions.
`

    let parsed: any = null
    let lastHttpStatus: number | null = null

    // Key failover: key5 -> key6
    for (let keyIndex = 0; keyIndex < GEMINI_KEYS.length; keyIndex++) {
      const apiKey = GEMINI_KEYS[keyIndex]
      const keyTag = keyIndex === 0 ? 'key5' : `key${keyIndex + 5}`

      console.log('[categorize-transaction] gemini_try_key', { key: keyTag })

      for (let attempt = 1; attempt <= 2; attempt++) {
        const p = attempt === 1 ? prompt : retryPrompt
        const res = await callGemini(apiKey, p)
        lastHttpStatus = res.status

        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          console.log('[categorize-transaction] gemini_http_error', {
            key: keyTag,
            attempt,
            status: res.status,
            body: txt.slice(0, 300)
          })

          // If rate-limited, stop retrying this key and move to the next key.
          if (res.status === 429) break

          continue
        }

        const data = await res.json().catch(() => null)
        const rawText = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
        if (!rawText) {
          console.log('[categorize-transaction] gemini_no_text', { key: keyTag, attempt })
          continue
        }

        parsed = tryParseJsonObject(rawText)
        if (parsed == null) {
          console.log('[categorize-transaction] gemini_non_json', { key: keyTag, attempt, text: rawText.slice(0, 300) })
          continue
        }

        break
      }

      if (parsed != null) break
    }

    if (parsed == null) {
      const fb = fallbackSuggestions(categories)
      if (fb.length > 0) {
        console.log('[categorize-transaction] fallback_used', fb.map((s) => ({ category: s.category, confidence: s.confidence })))
        return json({ ok: true, suggestions: fb }, 200)
      }
      return json({ ok: false, error: `Gemini failed (last_status=${lastHttpStatus ?? 'n/a'})` }, 500)
    }

    const allowed = new Set(categories)
    const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : []

    const out: Array<{ category: string; confidence: number; reason: string }> = []
    const seen = new Set<string>()

    const OTHER = 'Other'

    for (const s of rawSuggestions) {
      if (!s) continue
      const cat = String(s.category ?? '').trim()
      if (!cat || !allowed.has(cat) || seen.has(cat)) continue
      const conf = Number(s.confidence)
      const safeConf = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.6
      const reason = String(s.reason ?? '').trim()

      // Do not allow "Other" unless confidence is < 0.10.
      if (cat === OTHER && safeConf >= 0.1) continue

      out.push({ category: cat, confidence: safeConf, reason })
      seen.add(cat)
      if (out.length >= 2) break
    }

    if (out.length === 0) {
      console.log('[categorize-transaction] gemini_no_valid_suggestions')
      const fb = fallbackSuggestions(categories)
      if (fb.length > 0) {
        console.log('[categorize-transaction] fallback_used', fb.map((s) => ({ category: s.category, confidence: s.confidence })))
        return json({ ok: true, suggestions: fb }, 200)
      }

      // Safe fallback: only return "Other" with forced low confidence.
      if (allowed.has(OTHER)) {
        console.log('[categorize-transaction] no valid suggestions; falling back to Other')
        return json(
          {
            ok: true,
            suggestions: [{ category: OTHER, confidence: 0.05, reason: 'No confident match' }]
          },
          200
        )
      }
      return json({ ok: false, error: 'Gemini returned no valid suggestions' }, 500)
    }

    console.log('[categorize-transaction] suggestions', out.map((s) => ({ category: s.category, confidence: s.confidence })))
    return json({ ok: true, suggestions: out }, 200)
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
