import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  buildChatMemoryExtractionPrompt,
  parseChatMemoryExtraction,
  upsertChatMemory,
} from '../_shared/chatMemory.ts'

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[archive-chat-session] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }
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

function safeErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) return error
  return fallback
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

async function fetchGemini(path: string, body: Record<string, unknown>): Promise<Response> {
  const accessToken = await getAccessToken();
  const model = path.split(':')[0];
  const action = path.split(':')[1] || 'generateContent';
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${model}:${action}`;
  const vertexBody = { ...body } as any;
  if (vertexBody.contents && Array.isArray(vertexBody.contents)) {
    vertexBody.contents = vertexBody.contents.map((c: any) => ({ ...c, role: c.role || 'user' }));
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(vertexBody),
  })
  return res
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    })
  }

  try {
    const { sessionId } = await req.json()
    if (!sessionId) throw new Error('Missing sessionId')

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } },
    )

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace('Bearer ', ''),
    )
    if (authError || !user) throw new Error('Invalid or expired token')

    const userId = user.id

    const { data: ownedSession, error: ownershipError } = await supabaseClient
      .from('chat_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()

    if (ownershipError || !ownedSession) {
      console.error(`Session ownership check failed: user ${userId} tried to archive session ${sessionId}`)
      return jsonResponse({ error: 'Session not found or access denied' }, 403)
    }

    const { data: messages, error: messagesError } = await supabaseClient
      .from('chat_messages')
      .select('content, is_from_user')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (messagesError) {
      console.error('Error fetching messages:', messagesError)
      throw new Error('Failed to fetch messages')
    }

    if (!messages || messages.length === 0) {
      await supabaseClient
        .from('chat_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', userId)

      return jsonResponse({
        success: true,
        deleted: true,
        message: 'Empty session deleted',
      })
    }

    const { data: session } = await supabaseClient
      .from('chat_sessions')
      .select('title')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single()

    let title = session?.title || 'New Chat'
    if (title === 'New Chat' && messages.length >= 2) {
      const firstUserMessage = messages.find((m: { is_from_user: boolean }) => m.is_from_user)?.content || ''
      const firstAiMessage = messages.find((m: { is_from_user: boolean }) => !m.is_from_user)?.content || ''
      title = await generateChatTitle(firstUserMessage, firstAiMessage)
    }

    const { error: updateError } = await supabaseClient
      .from('chat_sessions')
      .update({
        is_archived: true,
        title,
      })
      .eq('id', sessionId)
      .eq('user_id', userId)

    if (updateError) {
      console.error('Error archiving session:', updateError)
      throw new Error('Failed to archive session')
    }

    const conversation = messages
      .map((m: { is_from_user: boolean; content: string }) => `${m.is_from_user ? 'User' : 'Wisey'}: ${m.content}`)
      .join('\n')

    try {
      await Promise.all([
        generateSessionSummary(conversation).then((summary) => {
          return supabaseClient
            .from('chat_sessions')
            .update({
              summary,
              summary_updated_at: new Date().toISOString(),
            })
            .eq('id', sessionId)
            .eq('user_id', userId)
        }),
        extractSessionMemory(supabaseClient, sessionId, userId, conversation),
      ])
    } catch (err) {
      console.error('Background processing failed:', err)
    }

    return jsonResponse({
      success: true,
      title,
      summary: 'Summary generated',
    })
  } catch (error) {
    console.error('Error:', error)
    return jsonResponse({ error: safeErrorMessage(error, 'Failed to archive session') }, 500)
  }
})

async function generateChatTitle(userMessage: string, aiResponse: string): Promise<string> {
  const titlePrompt = `Based on this conversation, generate a SHORT 2-4 word title that captures the main topic:

User: ${userMessage}
Wisey: ${aiResponse}

Rules for title:
- Maximum 4 words
- Descriptive and clear
- No quotes or punctuation
- Examples: "Budget Planning", "Debt Strategy", "Goal Review", "Wallet Check"

Title:`

  try {
    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: titlePrompt }],
      }],
    })

    if (!response.ok) {
      throw new Error(`Title generation failed: ${response.status}`)
    }

    const data = await response.json()
    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!title) {
      if (userMessage.toLowerCase().includes('wallet')) return 'Wallet Check'
      if (userMessage.toLowerCase().includes('goal')) return 'Goal Review'
      if (userMessage.toLowerCase().includes('debt')) return 'Debt Analysis'
      if (userMessage.toLowerCase().includes('budget')) return 'Budget Planning'
      return 'Financial Chat'
    }

    return title.substring(0, 50)
  } catch (error) {
    console.error('Title generation error:', error)
    return 'Financial Chat'
  }
}

async function generateSessionSummary(conversation: string): Promise<string> {
  try {
    const summaryPrompt = `Summarize this financial conversation in 1-2 sentences (max 150 characters):

${conversation}

Summary:`

    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: summaryPrompt }],
      }],
    })

    if (!response.ok) {
      throw new Error(`Summary generation failed: ${response.status}`)
    }

    const data = await response.json()
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    return summary ? summary.substring(0, 200) : 'Chat conversation'
  } catch (error) {
    console.error('Summary generation error:', error)
    return 'Chat conversation'
  }
}

async function extractSessionMemory(supabaseClient: any, sessionId: string, userId: string, conversation: string): Promise<void> {
  try {
    console.log(`Extracting memory from session: ${sessionId}`)

    const memoryPrompt = buildChatMemoryExtractionPrompt(conversation)
    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: memoryPrompt }],
      }],
    })

    if (!response.ok) {
      throw new Error(`Memory extraction failed: ${response.status}`)
    }

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!text) {
      console.log('No memory data extracted')
      return
    }

    let memoryPayload
    try {
      memoryPayload = parseChatMemoryExtraction(text)
    } catch (parseError) {
      console.error('Failed to parse memory JSON:', parseError)
      return
    }

    const { error: insertError } = await upsertChatMemory(supabaseClient, {
      userId,
      sessionId,
      payload: memoryPayload,
    })

    if (insertError) {
      console.error('Failed to store memory:', insertError)
      return
    }

    console.log(`Memory indexed: "${memoryPayload.topic}" (${memoryPayload.memoryKey})`)
  } catch (error) {
    console.error('Memory extraction error:', error)
  }
}
