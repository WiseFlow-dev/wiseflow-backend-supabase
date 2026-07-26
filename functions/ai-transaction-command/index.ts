// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  type AllowedCategory,
  type AllowedWallet,
  enforceTransactionDirection,
  normalizeCurrencyCodeOrNull,
  parseAiCommand,
  parseJsonObject,
  resolveAiTransaction,
  resolveRuleBasedTransaction,
  todayInTimeZone,
} from "./core.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}",
  );
} catch (e) {
  console.error("[ai-transaction-command] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_MODELS = [GEMINI_MODEL, "gemini-2.5-flash"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function text(value: unknown, max = 240): string {
  return String(value ?? "").trim().slice(0, max);
}

function createTimer(scope: string) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const started = performance.now();
  let previous = started;
  return {
    requestId,
    mark(stage: string, extra: Record<string, unknown> = {}) {
      const now = performance.now();
      console.log(
        `[${scope}:timing] ${
          JSON.stringify({
            requestId,
            stage,
            deltaMs: Math.round(now - previous),
            totalMs: Math.round(now - started),
            ...extra,
          })
        }`,
      );
      previous = now;
    },
  };
}

function normalizeTier(value: unknown): "free" | "pro" | "premium" {
  const tier = String(value ?? "").trim().toLowerCase();
  if (tier === "premium") return "premium";
  if (tier === "pro" || tier === "paid") return "pro";
  return "free";
}

async function verifyEntitlement(admin: any, userId: string) {
  const { data, error } = await admin
    .from("user_entitlements")
    .select("tier,valid_until")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify entitlement: ${error.message}`);
  const tier = normalizeTier(data?.tier);
  const validUntil = data?.valid_until
    ? new Date(data.valid_until).getTime()
    : null;
  const expired = validUntil !== null && Number.isFinite(validUntil) &&
    validUntil <= Date.now();
  return {
    tier: expired ? "free" as const : tier,
    paid: tier !== "free" && !expired,
  };
}

function parseArchivedCategoryIds(raw: unknown): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function walletRank(type: string): number {
  switch (type.trim().toUpperCase()) {
    case "SPENDING":
      return 0;
    case "CASH":
      return 1;
    case "BANK":
      return 2;
    case "EMERGENCY":
      return 3;
    case "SAVINGS":
      return 4;
    default:
      return 5;
  }
}

async function loadVerifiedWallets(
  admin: any,
  userId: string,
  requested: any[],
): Promise<AllowedWallet[]> {
  const requestOrder = new Map<string, number>();
  for (const [index, row] of requested.entries()) {
    const id = text(row?.id, 80);
    if (UUID_RE.test(id) && !requestOrder.has(id)) requestOrder.set(id, index);
  }
  const ids = [...requestOrder.keys()];
  if (ids.length === 0) return [];

  const { data, error } = await admin
    .from("wallets")
    .select("id,name,type,currency_code,archived")
    .eq("user_id", userId)
    .eq("archived", false)
    .in("id", ids);
  if (error) throw new Error(`Failed to verify wallets: ${error.message}`);

  return (data ?? [])
    .map((row: any) => ({
      id: String(row.id),
      name: text(row.name, 100),
      type: text(row.type, 40).toUpperCase(),
      currencyCode: text(row.currency_code, 3).toUpperCase() || "USD",
    }))
    .filter((row: AllowedWallet) =>
      row.name && /^[A-Z]{3}$/.test(row.currencyCode)
    )
    .sort((left: AllowedWallet, right: AllowedWallet) => {
      const clientOrder = (requestOrder.get(left.id) ?? 999) -
        (requestOrder.get(right.id) ?? 999);
      return clientOrder || walletRank(left.type) - walletRank(right.type);
    });
}

async function loadCategories(admin: any, userId: string): Promise<{
  expenseCategories: AllowedCategory[];
  incomeCategories: AllowedCategory[];
  expenseFallback: AllowedCategory;
  incomeFallback: AllowedCategory;
  preferredCurrencyCode: string | null;
}> {
  const [{ data: preference }, { data, error }] = await Promise.all([
    admin
      .from("user_preferences")
      .select("category_archived_custom_ids,currency")
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("categories")
      .select("id,name,user_id,is_system,is_income")
      .or(`user_id.eq.${userId},and(is_system.eq.true,user_id.is.null)`),
  ]);
  if (error) throw new Error(`Failed to load categories: ${error.message}`);

  const archived = parseArchivedCategoryIds(
    preference?.category_archived_custom_ids,
  );
  const buildCategories = (isIncome: boolean): AllowedCategory[] => {
    const seenNames = new Set<string>();
    return (data ?? [])
      .filter((row: any) =>
        !archived.has(String(row.id)) &&
        (isIncome ? row.is_income === true : row.is_income !== true)
      )
      .map((row: any) => ({ id: String(row.id), name: text(row.name, 100) }))
      .filter((row: AllowedCategory) => {
        const key = row.name.toLowerCase();
        if (!row.name || seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
  };
  const expenseCategories = buildCategories(false);
  const incomeCategories = buildCategories(true);
  const expenseFallback =
    expenseCategories.find((row: AllowedCategory) =>
      row.name.trim().toLowerCase() === "uncategorized"
    ) ??
      expenseCategories.find((row: AllowedCategory) =>
        row.name.trim().toLowerCase() === "other"
      ) ??
      { id: null, name: "Uncategorized" };
  const incomeFallback =
    incomeCategories.find((row: AllowedCategory) =>
      row.name.trim().toLowerCase() === "uncategorized"
    ) ??
      incomeCategories.find((row: AllowedCategory) =>
        row.name.trim().toLowerCase() === "other income"
      ) ??
      { id: null, name: "Uncategorized" };
  return {
    expenseCategories,
    incomeCategories,
    expenseFallback,
    incomeFallback,
    preferredCurrencyCode: normalizeCurrencyCodeOrNull(
      preference?.currency,
    ),
  };
}

async function loadHistoryHints(admin: any, userId: string): Promise<string> {
  const { data } = await admin
    .from("wallet_transactions")
    .select("amount,category,title,note")
    .eq("user_id", userId)
    .eq("source", "manual")
    .order("created_at", { ascending: false })
    .limit(120);
  const grouped = new Map<string, string[]>();
  for (const row of data ?? []) {
    const category = text(row.category, 100);
    const sample = text(row.title || row.note, 120);
    if (!category || !sample) continue;
    const transactionType = Number(row.amount) >= 0 ? "income" : "expense";
    const key = `${transactionType} / ${category}`;
    const values = grouped.get(key) ?? [];
    if (values.length < 3 && !values.includes(sample)) values.push(sample);
    grouped.set(key, values);
  }
  return [...grouped.entries()]
    .map(([typeAndCategory, samples]) =>
      `- ${typeAndCategory}: ${samples.join(" | ")}`
    )
    .join("\n");
}

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
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  );
  const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
  const tokenRes = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(
      `Service account token exchange failed: ${JSON.stringify(tokenData)}`,
    );
  }
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + 3_300_000,
  };
  return tokenData.access_token;
}

async function callGemini(prompt: string): Promise<string> {
  const accessToken = await getAccessToken();
  let lastError = "unknown";
  for (const model of GEMINI_MODELS) {
    const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.05,
          maxOutputTokens: 900,
        },
      }),
    });
    if (response.ok) {
      const body = await response.json();
      return text(body?.candidates?.[0]?.content?.parts?.[0]?.text, 5000);
    }
    const errorBody = await response.text().catch(() => "");
    lastError = `${response.status} ${errorBody.slice(0, 140)}`;
    if (
      response.status === 429 || response.status === 500 ||
      response.status === 502 || response.status === 503 ||
      response.status === 504
    ) {
      console.warn(
        `[ai-transaction-command] ${model} ${response.status}; trying next model`,
      );
      continue;
    }
    break;
  }
  throw new Error(`Gemini request failed: ${lastError}`);
}

async function resolveSession(admin: any, input: {
  userId: string;
  sessionId: string | null;
  proposedSessionId: string;
  forceNewSession: boolean;
  personalityMode: string;
  rawText: string;
}) {
  const { userId, proposedSessionId, personalityMode, rawText } = input;
  let sessionId = input.sessionId;

  if (input.forceNewSession) {
    await admin
      .from("chat_sessions")
      .update({ is_archived: true })
      .eq("user_id", userId)
      .eq("is_archived", false);
    sessionId = null;
  } else if (sessionId) {
    const { data } = await admin
      .from("chat_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) sessionId = null;
  }

  if (!sessionId) {
    const title = rawText.slice(0, 52) || "Transaction command";
    const { data, error } = await admin
      .from("chat_sessions")
      .insert({
        id: proposedSessionId,
        user_id: userId,
        title,
        personality_mode: personalityMode,
        is_archived: false,
      })
      .select("id,title,created_at,updated_at,message_count,personality_mode")
      .single();
    if (error) {
      throw new Error(`Failed to create chat session: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await admin
    .from("chat_sessions")
    .update({ personality_mode: personalityMode, is_archived: false })
    .eq("id", sessionId)
    .eq("user_id", userId)
    .select("id,title,created_at,updated_at,message_count,personality_mode")
    .single();
  if (error) throw new Error(`Failed to update chat session: ${error.message}`);
  return data;
}

async function persistMessage(admin: any, row: any, resetSavingState: boolean) {
  const { data: existing } = await admin
    .from("chat_messages")
    .select(
      "id,session_id,user_id,content,is_from_user,personality_mode,created_at,confidence,metadata",
    )
    .eq("id", row.id)
    .maybeSingle();
  if (existing) {
    if (
      existing.user_id !== row.user_id || existing.session_id !== row.session_id
    ) {
      throw new Error("Stable chat message ID belongs to another session");
    }
    const existingState = existing.metadata?.transactionCommand?.state;
    if (resetSavingState && existingState !== "saved") {
      const { data, error } = await admin
        .from("chat_messages")
        .update({ content: row.content, metadata: row.metadata })
        .eq("id", row.id)
        .eq("user_id", row.user_id)
        .select(
          "id,session_id,user_id,content,is_from_user,personality_mode,created_at,confidence,metadata",
        )
        .single();
      if (error) {
        throw new Error(`Failed to refresh command card: ${error.message}`);
      }
      return data;
    }
    return existing;
  }

  const { data, error } = await admin
    .from("chat_messages")
    .insert(row)
    .select(
      "id,session_id,user_id,content,is_from_user,personality_mode,created_at,confidence,metadata",
    )
    .single();
  if (error) {
    throw new Error(`Failed to persist chat message: ${error.message}`);
  }
  return data;
}

function commandMetadata(input: {
  state: "saving" | "failed";
  transactionId: string;
  rawText: string;
  userMessageId: string;
  assistantMessageId: string;
  outcome: string;
  code?: string;
  transaction?: any;
}) {
  const transaction = input.transaction;
  return {
    transactionCommand: {
      state: input.state,
      outcome: input.outcome,
      transactionType: transaction?.transactionType ?? "expense",
      typeConfidence: transaction?.typeConfidence ?? null,
      transactionId: input.transactionId,
      rawText: input.rawText,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      sourceAmountMinor: transaction?.amountMinor ?? null,
      sourceCurrency: transaction?.sourceCurrency ?? null,
      walletAmountMinor: null,
      walletCurrency: transaction?.wallet?.currencyCode ?? null,
      walletId: transaction?.wallet?.id ?? null,
      walletName: transaction?.wallet?.name ?? null,
      categoryName: transaction?.category?.name ?? null,
      categoryConfidence: transaction?.categoryConfidence ?? null,
      title: transaction?.title ?? null,
      merchant: transaction?.merchant ?? null,
      dateYmd: transaction?.dateYmd ?? null,
      dateWasSpecified: transaction?.dateWasSpecified ?? null,
      failureCode: input.code ?? null,
      retryable: false,
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const timer = createTimer("ai-transaction-command");
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "unauthorized" }, 401);
    }
    const jwt = authHeader.slice(7);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !user) return json({ error: "unauthorized" }, 401);
    timer.mark("auth");

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "invalid_json" }, 400);
    }
    timer.mark("body");

    const transactionId = text(body.transactionId, 80);
    const userMessageId = text(body.userMessageId, 80);
    const assistantMessageId = text(body.assistantMessageId, 80);
    const proposedSessionId = text(body.proposedSessionId, 80);
    if (
      ![transactionId, userMessageId, assistantMessageId, proposedSessionId]
        .every((id) => UUID_RE.test(id))
    ) {
      return json({ error: "invalid_stable_ids" }, 400);
    }

    const entitlement = await verifyEntitlement(admin, user.id);
    timer.mark("entitlement", { tier: entitlement.tier });
    if (!entitlement.paid) {
      timer.mark("complete", { outcome: "paid_required" });
      return json({
        outcome: "paid_required",
        code: "paid_required",
        verifiedTier: entitlement.tier,
      });
    }

    const rawText = text(body.rawText, 700);
    const locale = text(body.locale, 35) || "en";
    const timeZone = text(body.timezone, 80) || "UTC";
    const personalityMode = text(body.personalityMode, 30) || "companion";
    const requestCurrencyCode = normalizeCurrencyCodeOrNull(
      body.preferredCurrencyCode,
    );
    const persistChat = body.persistChat === true;
    const blockedLinkedWalletNames =
      Array.isArray(body.blockedLinkedWalletNames)
        ? body.blockedLinkedWalletNames.map((value: unknown) =>
          text(value, 100)
        ).filter(Boolean)
        : [];
    const wallets = await loadVerifiedWallets(
      admin,
      user.id,
      Array.isArray(body.eligibleWallets) ? body.eligibleWallets : [],
    );
    timer.mark("wallets", { count: wallets.length });
    const {
      expenseCategories,
      incomeCategories,
      expenseFallback,
      incomeFallback,
      preferredCurrencyCode,
    } = await loadCategories(admin, user.id);
    const defaultCurrencyCode = requestCurrencyCode ??
      preferredCurrencyCode ??
      null;
    timer.mark("categories", {
      expenseCount: expenseCategories.length,
      incomeCount: incomeCategories.length,
      defaultCurrencyCode,
    });
    const todayYmd = todayInTimeZone(timeZone);

    let outcome: string;
    let code: string | undefined;
    let transaction: any = null;

    if (!rawText) {
      outcome = "missing_information";
      code = "missing_description";
    } else if (wallets.length === 0) {
      outcome = "no_wallets";
      code = "no_wallets";
    } else {
      const ruleBased = resolveRuleBasedTransaction({
        rawText,
        wallets,
        blockedLinkedWalletNames,
        expenseCategories,
        incomeCategories,
        expenseFallbackCategory: expenseFallback,
        incomeFallbackCategory: incomeFallback,
        todayYmd,
        defaultCurrencyCode,
      });
      if (ruleBased) {
        timer.mark("rule_based", {
          outcome: ruleBased.outcome,
          code: "code" in ruleBased ? ruleBased.code : undefined,
        });
        outcome = ruleBased.outcome;
        code = "code" in ruleBased ? ruleBased.code : undefined;
        transaction = ruleBased.outcome === "parsed"
          ? ruleBased.transaction
          : null;
      } else {
        const historyHints = await loadHistoryHints(admin, user.id);
        timer.mark("history");
        const prompt = [
          "You parse one completed personal money transaction.",
          `User locale: ${locale}`,
          `User timezone: ${timeZone}`,
          `User selected/display currency: ${defaultCurrencyCode ?? "unknown"}`,
          `Today's date in that timezone: ${todayYmd}`,
          `Sentence: ${JSON.stringify(rawText)}`,
          "",
          "Eligible wallets. walletId must be one of these exact IDs:",
          JSON.stringify(wallets),
          "",
          "Provider-linked wallet names that must never be selected:",
          JSON.stringify(blockedLinkedWalletNames),
          "",
          "Allowed expense categories. For an expense, categoryName must be one exact name from this list:",
          JSON.stringify(expenseCategories.map((category) => category.name)),
          "",
          "Allowed income categories. For income, categoryName must be one exact name from this list:",
          JSON.stringify(incomeCategories.map((category) => category.name)),
          "",
          historyHints ? "Recent category examples from this same user:" : "",
          historyHints,
          "",
          "Rules:",
          "- For a completed money event, choose expense or income. Do not return unknown just because the direction is slightly ambiguous; make the best supported choice.",
          "- Classification priority: explicit wording first, then the matching category type, then merchant/employer/sender meaning and this user's history, then your best guess.",
          "- Expense wording includes spent, paid for, bought, purchased, ordered, and charged.",
          "- Income wording includes received, earned, got paid, salary, paycheck, refund, cashback, gift, paid me, and sent me.",
          "- 'paid me' is income. 'paid for' is expense.",
          "- Refunds, reimbursements, and cashback are income.",
          "- Understand the transaction wording in the user's locale, including English, Spanish, Russian, French, German, Portuguese, Turkish, Japanese, Chinese, Italian, Polish, and Dutch.",
          "- Multilingual expense examples: 'I spent 20 at Nike', 'gasté 20 en Nike', 'потратил 20 в Nike', 'j'ai dépensé 20 chez Nike', '20 bei Nike ausgegeben', 'gastei 20 na Nike', 'Nike'ta 20 harcadım', 'Nikeで20使った', '在Nike花了20', 'ho speso 20 da Nike', 'wydałem 20 w Nike', and '20 uitgegeven bij Nike'.",
          "- Multilingual income examples: 'received 500 salary', 'recibí 500 de salario', 'получил 500 зарплаты', 'j'ai reçu 500 de salaire', '500 Gehalt bekommen', 'recebi 500 de salário', '500 maaş aldım', '給料500を受け取った', '收到500工资', 'ho ricevuto 500 di stipendio', 'otrzymałem 500 pensji', and '500 salaris ontvangen'.",
          "- Also understand everyday completed expense wording such as 'cost me', 'me costó', 'ушло', 'ça m'a coûté', 'hat mich gekostet', 'saiu por', 'tuttu', 'かかった', '花掉了', 'mi è costato', 'poszło na', and 'kostte me'.",
          "- Also understand everyday completed income/refund wording such as 'paycheck landed', 'me devolvieron', 'зарплата пришла', 'on m'a remboursé', 'Gehalt ist da', 'salário caiu na conta', 'maaş yattı', '給料が入った', '工资到账了', 'mi è arrivato lo stipendio', 'wpłynęła wypłata', and 'salaris is binnen'.",
          "- Regional slang words for money are supporting context only. A slang money noun by itself must never prove that a completed transaction happened.",
          "- Transfers between wallets, questions, planned/future events, and incomplete statements are not transactions to save.",
          "- completed is true only when the money movement already happened.",
          "- typeConfidence describes confidence in expense versus income, but low confidence does not prevent a best guess.",
          "- Preserve the amount as a normalized decimal string in amountMajor without currency symbols.",
          "- Convert spoken or written number words into digits in amountMajor: 'fifty' -> '50', 'one hundred' -> '100', 'five hundred salary' -> amountMajor '500'. amountMajor must contain only digits and an optional decimal separator.",
          "- currencyCode is ISO 4217 only when the sentence explicitly states a currency; otherwise null. Raw numbers default to the selected wallet currency on the server.",
          "- If a wallet is named, set requestedWalletName and choose its exact walletId only when present in eligible wallets.",
          "- If no wallet is named, walletId and requestedWalletName may be null; the server chooses the default.",
          "- Use null when no date is stated or when the user says today. Resolve yesterday or an explicit past date to YYYY-MM-DD using the supplied timezone.",
          "- Pick the best category only from the list matching the chosen transaction type and provide categoryConfidence from 0 to 1.",
          "- title is a short useful transaction title. merchant is null when unknown.",
          "",
          "Return only JSON:",
          JSON.stringify({
            intent: "expense|income|transfer|question|future|unknown",
            completed: true,
            typeConfidence: 0.98,
            amountMajor: "50.00|null",
            currencyCode: "USD|null",
            title: "Pharmacy",
            merchant: "Pharmacy|null",
            dateYmd: "2026-06-06|null",
            walletId: "uuid|null",
            requestedWalletName: "Spending|null",
            categoryName: "Health|null",
            categoryConfidence: 0.95,
          }),
        ].filter(Boolean).join("\n");

        const rawAi = await callGemini(prompt);
        timer.mark("gemini");
        const parsedAi = parseAiCommand(rawAi);
        if (!parsedAi) {
          throw new Error(
            `Gemini returned invalid command JSON: ${
              JSON.stringify(parseJsonObject(rawAi))
            }`,
          );
        }
        const ai = enforceTransactionDirection({
          ai: parsedAi,
          rawText,
          expenseCategories,
          incomeCategories,
        });
        const resolution = resolveAiTransaction({
          ai,
          wallets,
          blockedLinkedWalletNames,
          expenseCategories,
          incomeCategories,
          expenseFallbackCategory: expenseFallback,
          incomeFallbackCategory: incomeFallback,
          todayYmd,
          rawText,
          defaultCurrencyCode,
        });
        timer.mark("resolve");
        outcome = resolution.outcome;
        code = "code" in resolution ? resolution.code : undefined;
        transaction = resolution.outcome === "parsed"
          ? resolution.transaction
          : null;
      }
    }

    if (outcome === "not_transaction") {
      timer.mark("complete", { outcome });
      return json({ outcome, code, verifiedTier: entitlement.tier });
    }

    let session = null;
    let userMessage = null;
    let assistantMessage = null;
    if (persistChat) {
      session = await resolveSession(admin, {
        userId: user.id,
        sessionId: UUID_RE.test(text(body.sessionId, 80))
          ? text(body.sessionId, 80)
          : null,
        proposedSessionId,
        forceNewSession: body.forceNewSession === true,
        personalityMode,
        rawText,
      });
      const now = new Date().toISOString();
      const state = outcome === "parsed" ? "saving" : "failed";
      const metadata = commandMetadata({
        state,
        transactionId,
        rawText,
        userMessageId,
        assistantMessageId,
        outcome,
        code,
        transaction,
      });
      userMessage = await persistMessage(admin, {
        id: userMessageId,
        session_id: session.id,
        user_id: user.id,
        content: rawText || "/add",
        is_from_user: true,
        personality_mode: personalityMode,
        created_at: now,
      }, false);
      assistantMessage = await persistMessage(admin, {
        id: assistantMessageId,
        session_id: session.id,
        user_id: user.id,
        content: outcome === "parsed"
          ? `Saving ${transaction?.transactionType ?? "transaction"}`
          : "Transaction was not saved",
        is_from_user: false,
        personality_mode: personalityMode,
        created_at: new Date(Date.now() + 1).toISOString(),
        confidence: outcome === "parsed" ? "high" : "low",
        metadata,
      }, outcome === "parsed");
      timer.mark("persist_chat", { outcome });
    }

    timer.mark("complete", { outcome });
    return json({
      outcome,
      code,
      verifiedTier: entitlement.tier,
      model: GEMINI_MODEL,
      session,
      userMessage,
      assistantMessage,
      transaction: transaction
        ? {
          transactionId,
          transactionType: transaction.transactionType,
          typeConfidence: transaction.typeConfidence,
          amountMinor: transaction.amountMinor,
          sourceCurrency: transaction.sourceCurrency,
          title: transaction.title,
          merchant: transaction.merchant,
          dateYmd: transaction.dateYmd,
          dateWasSpecified: transaction.dateWasSpecified,
          walletId: transaction.wallet.id,
          walletName: transaction.wallet.name,
          walletCurrency: transaction.wallet.currencyCode,
          categoryId: transaction.category.id,
          categoryName: transaction.category.name,
          categoryConfidence: transaction.categoryConfidence,
        }
        : null,
    });
  } catch (error) {
    console.error("[ai-transaction-command]", {
      requestId: timer.requestId,
      error,
    });
    timer.mark("error");
    const message =
      "Could not process this transaction right now. Please try again.";
    return json({ error: "command_unavailable", message }, 503);
  }
});
