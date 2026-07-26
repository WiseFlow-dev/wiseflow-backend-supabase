// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key, x-main-currency, x-idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
} as const;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[receipt-categorize] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

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
const GEMINI_MAX_RETRIES = 3;
const MIN_AI_CONFIDENCE_TO_TRUST = 0.35;

type CategoryRow = {
  name: string | null;
  is_income: boolean | null;
  is_system?: boolean | null;
  user_id?: string | null;
};

function userHasProAccess(user: unknown): boolean {
  const u = (user ?? {}) as Record<string, unknown>;
  const appMeta = (u["app_metadata"] ?? {}) as Record<string, unknown>;
  const userMeta = (u["user_metadata"] ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown): string => String(value ?? "").trim().toLowerCase();

  const truthyFlag = (value: unknown): boolean =>
    value === true || asLower(value) === "true" || asLower(value) === "1";
  if (
    truthyFlag(appMeta["is_pro"]) ||
    truthyFlag(appMeta["pro"]) ||
    truthyFlag(userMeta["is_pro"]) ||
    truthyFlag(userMeta["pro"])
  ) {
    return true;
  }

  const planCandidates = [
    appMeta["plan"],
    appMeta["tier"],
    appMeta["subscription_tier"],
    appMeta["subscription_plan"],
    userMeta["plan"],
    userMeta["tier"],
    userMeta["subscription_tier"],
    userMeta["subscription_plan"],
  ]
    .map(asLower)
    .filter(Boolean);

  return planCandidates.some((value) =>
    value === "pro" ||
    value === "premium" ||
    value === "paid" ||
    value.startsWith("pro_") ||
    value.startsWith("premium_")
  );
}

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function normText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseConfidence(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const normalized = value.replace("%", "").trim();
    const n = Number(normalized);
    if (!Number.isFinite(n)) return 0;
    const scaled = n > 1 ? n / 100 : n;
    return Math.max(0, Math.min(1, scaled));
  }
  return 0;
}

function stripJsonFence(raw: string): string {
  return raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
}

function parseJsonObjectFromText(raw: string): any | null {
  const cleaned = stripJsonFence(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function matchCategory(aiCategory: string, allowed: string[]): string | null {
  const raw = normText(aiCategory);
  if (!raw) return null;

  const exact = allowed.find((c) => normText(c) === raw);
  if (exact) return exact;

  for (const c of allowed) {
    const cn = normText(c);
    if (cn.includes(raw) || raw.includes(cn)) return c;
  }

  return null;
}

function buildUserHistoryHints(
  rows: Array<{ category: string; title?: string | null; note?: string | null }>
): string {
  const byCategory = new Map<string, string[]>();

  for (const row of rows) {
    const category = String(row.category ?? "").trim();
    if (!category) continue;

    const sample = String(row.title ?? row.note ?? "").trim();
    if (!sample) continue;

    const list = byCategory.get(category) ?? [];
    if (list.length >= 3) continue;
    if (list.some((existing) => normText(existing) === normText(sample))) continue;

    list.push(sample);
    byCategory.set(category, list);
  }

  if (byCategory.size === 0) return "";

  return [...byCategory.entries()]
    .map(([category, samples]) => `- ${category}: ${samples.join(" | ")}`)
    .join("\n");
}

async function callGemini(prompt: string): Promise<string> {
  const accessToken = await getAccessToken();
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      }),
    });

    if ((geminiRes.status === 429 || geminiRes.status === 503) && attempt < GEMINI_MAX_RETRIES) {
      const delayMs = Math.pow(2, attempt + 1) * 1000;
      await sleep(delayMs);
      continue;
    }

    if (!geminiRes.ok) {
      const body = await geminiRes.text().catch(() => "");
      throw new Error(`Gemini request failed: ${geminiRes.status} ${body.slice(0, 200)}`);
    }

    const geminiData = await geminiRes.json().catch(() => null);
    return String(geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  }

  throw new Error("Gemini retries exhausted");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonRes({ error: "Missing auth" }, 401);
  }
  const jwt = authHeader.slice(7);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE);
  const {
    data: { user },
    error: authErr,
  } = await adminClient.auth.getUser(jwt);

  if (authErr || !user) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }
  if (!userHasProAccess(user)) {
    return jsonRes({ error: "pro_required", message: "Receipt scan is Pro only." }, 403);
  }

  const userId = user.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "Invalid JSON body" }, 400);
  }

  const rawItems: { index?: number; name?: string; price?: number }[] =
    Array.isArray(body.items) ? body.items : [];

  const items = rawItems
    .map((item, idx) => ({
      index: Number.isInteger(item?.index) ? Number(item.index) : idx,
      name: String(item?.name ?? "").trim(),
      price: typeof item?.price === "number" && Number.isFinite(item.price) ? item.price : undefined,
    }))
    .filter((item) => item.name.length > 0);

  const merchantName: string = body.merchant_name ?? "";
  const rawText: string = body.raw_text ?? "";

  if (items.length === 0 && !merchantName && !rawText) {
    return jsonRes({ error: "Nothing to categorize" }, 400);
  }

  const { data: categoryRows, error: catErr } = await adminClient
    .from("categories")
    .select("name, is_income, is_system, user_id")
    .or(`user_id.eq.${userId},and(is_system.eq.true,user_id.is.null)`);

  if (catErr) {
    console.error("Failed to load categories:", catErr.message);
    return jsonRes({ error: "Could not load categories" }, 500);
  }

  const userExpenseCategories: string[] = (categoryRows ?? [])
    .filter((r: CategoryRow) => r.is_income !== true)
    .map((r: CategoryRow) => String(r.name ?? "").trim())
    .filter((name) => name.length > 0);

  if (userExpenseCategories.length === 0) {
    return jsonRes({ category: "", assignments: [] });
  }

  const itemList = items
    .map((it) => `- index=${it.index}; name="${it.name}"${it.price != null ? `; price=${it.price}` : ""}`)
    .join("\n");

  let userHistoryHints = "";
  try {
    const { data: walletRows } = await adminClient
      .from("wallets")
      .select("id")
      .eq("user_id", userId);

    const walletIds = (walletRows ?? [])
      .map((w: any) => String(w.id ?? "").trim())
      .filter((id: string) => id.length > 0);

    if (walletIds.length > 0) {
      const { data: txRows } = await adminClient
        .from("wallet_transactions")
        .select("category,title,note,amount,created_at")
        .in("wallet_id", walletIds)
        .not("category", "is", null)
        .lt("amount", 0)
        .order("created_at", { ascending: false })
        .limit(200);

      const usableRows = (txRows ?? [])
        .map((r: any) => ({
          category: String(r.category ?? "").trim(),
          title: String(r.title ?? "").trim(),
          note: String(r.note ?? "").trim(),
        }))
        .filter((r: { category: string }) =>
          r.category.length > 0 &&
          userExpenseCategories.some((c) => normText(c) === normText(r.category))
        );

      userHistoryHints = buildUserHistoryHints(usableRows);
    }
  } catch (e) {
    console.error("Failed to load user categorization history:", e);
  }

  const prompt = [
    "You are a personal finance assistant categorizing receipt line items.",
    "Use only the provided user categories. Do not invent categories.",
    "",
    merchantName ? `Merchant: ${merchantName}` : "",
    itemList ? `Items (with stable index):\n${itemList}` : "",
    rawText ? `Receipt text excerpt: ${rawText.slice(0, 600)}` : "",
    "",
    "User expense categories (exact source of truth):",
    JSON.stringify(userExpenseCategories),
    "",
    userHistoryHints ? "Historical category examples from this same user:" : "",
    userHistoryHints,
    "",
    "Rules:",
    "- Assign EACH item index exactly one category from user categories OR null.",
    "- Never output a category that is not in the provided list.",
    "- Prefer assigning a real category when there is reasonable evidence from merchant/items/history.",
    "- If there is no plausible match, output null.",
    "- confidence must be 0..1.",
    "",
    "Return ONLY valid JSON (no markdown):",
    '{"assignments":[{"index":0,"category":"<name from list or null>","confidence":0.0}]}',
  ]
    .filter(Boolean)
    .join("\n");

  const aiAssignmentsByIndex = new Map<number, { category: string; confidence: number }>();

  try {
    const raw = await callGemini(prompt);
    const parsed = parseJsonObjectFromText(raw);
    const rows = Array.isArray(parsed?.assignments) ? parsed.assignments : [];

    for (const row of rows) {
      const index = Number(row?.index);
      if (!Number.isInteger(index)) continue;

      const rawCategory = row?.category;
      if (rawCategory == null) continue;

      const category = String(rawCategory).trim();
      if (!category || category.toLowerCase() === "null") continue;

      const confidence = parseConfidence(row?.confidence);
      const matched = matchCategory(category, userExpenseCategories);
      if (!matched) continue;

      aiAssignmentsByIndex.set(index, { category: matched, confidence });
    }
  } catch (e) {
    console.error("Gemini error:", e);
  }

  const assignments = items.map((item) => {
    const ai = aiAssignmentsByIndex.get(item.index);
    const category = ai && ai.confidence >= MIN_AI_CONFIDENCE_TO_TRUST ? ai.category : "";
    const confidence = category ? ai?.confidence ?? 0 : 0;

    return {
      index: item.index,
      item: item.name,
      category,
      confidence,
    };
  });

  const firstAssigned = assignments.find((a) => String(a.category).trim().length > 0);
  const category = firstAssigned?.category ?? "";

  return jsonRes({ category, assignments, model: GEMINI_MODEL });
});
