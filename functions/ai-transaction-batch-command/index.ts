// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  type AiCommandPayload,
  type AllowedCategory,
  type AllowedWallet,
  clampConfidence,
  enforceTransactionDirection,
  normalizeCurrencyCodeOrNull,
  parseJsonObject,
  resolveAiTransaction,
  todayInTimeZone,
} from "../ai-transaction-command/core.ts";

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
  console.error("[ai-transaction-batch-command] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_MODELS = [GEMINI_MODEL, "gemini-2.5-flash"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_ITEMS = 5;

type ParsedBatchItem = {
  index: number;
  transactionType: "expense" | "income";
  typeConfidence: number;
  amountMinor: number;
  sourceCurrency: string;
  title: string;
  merchant: string | null;
  dateYmd: string;
  dateWasSpecified: boolean;
  walletId: string;
  walletName: string;
  walletCurrency: string;
  categoryId: string | null;
  categoryName: string;
  categoryConfidence: number;
  warning: string | null;
  rawText: string;
};

type IgnoredBatchItem = {
  index: number;
  reason: string;
  rawText: string;
  warning: string | null;
};

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
    expenseCategories.find((row) =>
      row.name.trim().toLowerCase() === "uncategorized"
    ) ??
      expenseCategories.find((row) =>
        row.name.trim().toLowerCase() === "other"
      ) ??
      { id: null, name: "Uncategorized" };
  const incomeFallback =
    incomeCategories.find((row) =>
      row.name.trim().toLowerCase() === "uncategorized"
    ) ??
      incomeCategories.find((row) =>
        row.name.trim().toLowerCase() === "other income"
      ) ??
      { id: null, name: "Uncategorized" };
  return {
    expenseCategories,
    incomeCategories,
    expenseFallback,
    incomeFallback,
    preferredCurrencyCode: normalizeCurrencyCodeOrNull(preference?.currency),
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
          maxOutputTokens: 2200,
        },
      }),
    });
    if (response.ok) {
      const body = await response.json();
      return text(body?.candidates?.[0]?.content?.parts?.[0]?.text, 12000);
    }
    const errorBody = await response.text().catch(() => "");
    lastError = `${response.status} ${errorBody.slice(0, 140)}`;
    if (
      response.status === 429 || response.status === 500 ||
      response.status === 502 || response.status === 503 ||
      response.status === 504
    ) {
      console.warn(
        `[ai-transaction-batch-command] ${model} ${response.status}; trying next model`,
      );
      continue;
    }
    break;
  }
  throw new Error(`Gemini request failed: ${lastError}`);
}

function parseBatchCommand(raw: string): {
  items: Array<Record<string, unknown>>;
} | null {
  const parsed = parseJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return {
    items: parsed.items
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .slice(0, MAX_BATCH_ITEMS) as Array<Record<string, unknown>>,
  };
}

function nullableString(input: unknown): string | null {
  const value = String(input ?? "").trim();
  return value && value.toLowerCase() !== "null" ? value : null;
}

function toAiCommandPayload(item: Record<string, unknown>): AiCommandPayload {
  const intentRaw = String(item.intent ?? "").trim().toLowerCase();
  const intent = [
      "expense",
      "income",
      "transfer",
      "question",
      "future",
      "unknown",
    ].includes(intentRaw)
    ? intentRaw as AiCommandPayload["intent"]
    : "unknown";
  return {
    intent,
    completed: item.completed === true,
    typeConfidence: clampConfidence(item.typeConfidence),
    amountMajor: nullableString(item.amountMajor),
    currencyCode: nullableString(item.currencyCode)?.toUpperCase() ?? null,
    title: nullableString(item.title),
    merchant: nullableString(item.merchant),
    dateYmd: nullableString(item.dateYmd),
    walletId: nullableString(item.walletId),
    requestedWalletName: nullableString(item.requestedWalletName),
    categoryName: nullableString(item.categoryName),
    categoryConfidence: clampConfidence(item.categoryConfidence),
  };
}

function ignoredReason(ai: AiCommandPayload, code?: string): string {
  if (code) return code;
  if (ai.intent === "transfer") return "transfer";
  if (ai.intent === "question") return "question";
  if (ai.intent === "future") return "future_or_planned";
  if (!ai.completed) return "not_completed";
  return "not_transaction";
}

function buildPrompt(input: {
  rawText: string;
  locale: string;
  timeZone: string;
  todayYmd: string;
  defaultCurrencyCode: string | null;
  wallets: AllowedWallet[];
  blockedLinkedWalletNames: string[];
  expenseCategories: AllowedCategory[];
  incomeCategories: AllowedCategory[];
  historyHints: string;
}): string {
  return [
    "You parse long voice or typed text into completed personal money transactions.",
    `User locale: ${input.locale}`,
    `User timezone: ${input.timeZone}`,
    `User selected/display currency: ${
      input.defaultCurrencyCode ?? "unknown"
    }`,
    `Today's date in that timezone: ${input.todayYmd}`,
    `Raw text: ${JSON.stringify(input.rawText)}`,
    "",
    "Eligible wallets. walletId must be one of these exact IDs:",
    JSON.stringify(input.wallets),
    "",
    "Provider-linked wallet names that must never be selected:",
    JSON.stringify(input.blockedLinkedWalletNames),
    "",
    "Allowed expense categories. For an expense, categoryName must be one exact name from this list:",
    JSON.stringify(input.expenseCategories.map((category) => category.name)),
    "",
    "Allowed income categories. For income, categoryName must be one exact name from this list:",
    JSON.stringify(input.incomeCategories.map((category) => category.name)),
    "",
    input.historyHints ? "Recent category examples from this same user:" : "",
    input.historyHints,
    "",
    "Rules:",
    `- Return at most ${MAX_BATCH_ITEMS} items.`,
    "- Split multiple completed money events into separate items.",
    "- One sentence can contain multiple events, for example 'spent 20 at Nike and received 500 salary'.",
    "- Each completed expense or income becomes one item with intent expense or income and completed true.",
    "- Transfers between wallets, questions, planned/future events, and incomplete items must be returned as ignored items with intent transfer/question/future/unknown and completed false.",
    "- Classification priority: explicit wording first, matching category type second, merchant/employer/sender meaning and user history third, then best guess.",
    "- Expense wording includes spent, paid for, bought, purchased, ordered, charged, cost me, and equivalents in the user's language.",
    "- Income wording includes received, earned, got paid, salary, paycheck, refund, cashback, gift, paid me, sent me, and equivalents in the user's language.",
    "- Refunds, reimbursements, and cashback are income.",
    "- Understand English, Spanish, Russian, French, German, Portuguese, Turkish, Japanese, Chinese, Italian, Polish, and Dutch.",
    "- Preserve amountMajor as a normalized decimal string without currency symbols, for example '20.00'. Handle European decimals by normalizing them.",
    "- ALWAYS convert spoken or written number words into digits in amountMajor, in any supported language: 'fifty' -> '50', 'one hundred' -> '100', 'five hundred' -> '500', 'twenty five' -> '25', 'two thousand' -> '2000'. amountMajor must contain only digits and an optional decimal separator, never words.",
    "- Planned or future events (for example 'I will get paid tomorrow', 'going to pay next week') are NOT completed; return them as ignored items with intent future and completed false. Past references such as 'yesterday' or 'last week' are completed and valid.",
    "- currencyCode is ISO 4217 only when explicitly stated. If the user gives a raw number, currencyCode must be null.",
    "- If a wallet is named, set requestedWalletName and choose its exact walletId only when present in eligible wallets.",
    "- If no wallet is named, walletId and requestedWalletName may be null; the server chooses the default wallet.",
    "- Use null for dateYmd when no date is stated or when the user says today. Resolve yesterday or explicit past dates to YYYY-MM-DD using the supplied timezone.",
    "- Pick categories only from the list matching the chosen transaction type.",
    "- categoryConfidence below 0.90 is allowed; the server will fallback to the correct Uncategorized category.",
    "- title is a short useful transaction title. merchant is null when unknown.",
    "- warning is a short plain-language warning only when the item is uncertain; otherwise null.",
    "",
    "Return only JSON in this shape:",
    JSON.stringify({
      items: [
        {
          rawText: "spent 20 at Nike",
          intent: "expense|income|transfer|question|future|unknown",
          completed: true,
          typeConfidence: 0.98,
          amountMajor: "20.00|null",
          currencyCode: "USD|null",
          title: "Nike",
          merchant: "Nike|null",
          dateYmd: "2026-06-06|null",
          walletId: "uuid|null",
          requestedWalletName: "Spending|null",
          categoryName: "Shopping|null",
          categoryConfidence: 0.95,
          warning: null,
        },
      ],
    }),
  ].filter(Boolean).join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const timer = createTimer("ai-transaction-batch-command");
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

    const rawText = text(body.rawText, 2400);
    const locale = text(body.locale, 35) || "en";
    const timeZone = text(body.timezone, 80) || "UTC";
    const requestCurrencyCode = normalizeCurrencyCodeOrNull(
      body.preferredCurrencyCode,
    );
    const blockedLinkedWalletNames = Array.isArray(body.blockedLinkedWalletNames)
      ? body.blockedLinkedWalletNames.map((value: unknown) => text(value, 100))
        .filter(Boolean)
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
    const defaultCurrencyCode = requestCurrencyCode ?? preferredCurrencyCode ??
      null;
    const todayYmd = todayInTimeZone(timeZone);
    timer.mark("categories", {
      expenseCount: expenseCategories.length,
      incomeCount: incomeCategories.length,
      defaultCurrencyCode,
    });

    if (!rawText) {
      return json({
        outcome: "parsed",
        verifiedTier: entitlement.tier,
        model: GEMINI_MODEL,
        transactions: [],
        ignoredItems: [{
          index: 0,
          reason: "missing_description",
          rawText: "",
          warning: "Nothing was said or typed.",
        }],
      });
    }
    if (wallets.length === 0) {
      return json({
        outcome: "no_wallets",
        code: "no_wallets",
        verifiedTier: entitlement.tier,
        transactions: [],
        ignoredItems: [],
      });
    }

    const historyHints = await loadHistoryHints(admin, user.id);
    timer.mark("history");
    const prompt = buildPrompt({
      rawText,
      locale,
      timeZone,
      todayYmd,
      defaultCurrencyCode,
      wallets,
      blockedLinkedWalletNames,
      expenseCategories,
      incomeCategories,
      historyHints,
    });
    // callGemini already falls back to the larger model if the primary is
    // overloaded. Here we additionally retry once if the model returns
    // unparseable JSON. A genuine model outage throws out to the handler below.
    let batch: { items: Array<Record<string, unknown>> } | null = null;
    for (let attempt = 1; attempt <= 2 && !batch; attempt++) {
      const rawAi = await callGemini(prompt);
      batch = parseBatchCommand(rawAi);
      if (!batch) {
        console.error(
          `[ai-transaction-batch-command] invalid batch JSON (attempt ${attempt}): ${
            rawAi.slice(0, 500)
          }`,
        );
      }
      timer.mark("gemini", { attempt, parsed: Boolean(batch) });
    }
    if (!batch) {
      throw new Error("Gemini did not return valid batch JSON after retry");
    }

    const transactions: ParsedBatchItem[] = [];
    const ignoredItems: IgnoredBatchItem[] = [];
    for (const [index, item] of batch.items.entries()) {
      const itemRawText = text(item.rawText ?? rawText, 360);
      const warning = nullableString(item.warning);
      const ai = enforceTransactionDirection({
        ai: toAiCommandPayload(item),
        rawText: itemRawText,
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
        rawText: itemRawText,
        defaultCurrencyCode,
      });
      if (resolution.outcome === "parsed") {
        const transaction = resolution.transaction;
        transactions.push({
          index,
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
          warning,
          rawText: itemRawText,
        });
      } else {
        ignoredItems.push({
          index,
          reason: ignoredReason(
            ai,
            "code" in resolution ? resolution.code : undefined,
          ),
          rawText: itemRawText,
          warning,
        });
      }
    }
    timer.mark("resolve", {
      transactions: transactions.length,
      ignoredItems: ignoredItems.length,
    });

    timer.mark("complete", { outcome: "parsed" });
    return json({
      outcome: "parsed",
      verifiedTier: entitlement.tier,
      model: GEMINI_MODEL,
      limit: MAX_BATCH_ITEMS,
      transactions,
      ignoredItems,
    });
  } catch (error) {
    console.error("[ai-transaction-batch-command]", {
      requestId: timer.requestId,
      error,
    });
    timer.mark("error");
    return json({
      error: "batch_command_unavailable",
      message: "Could not process these transactions right now. Please try again.",
    }, 503);
  }
});
