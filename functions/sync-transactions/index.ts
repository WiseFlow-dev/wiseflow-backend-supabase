// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isStatementNoiseMerchant, normalizeMerchant } from "../_shared/normalize.ts";

const ENV = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
const PLAID_BASE = ENV === "production" 
  ? "https://production.plaid.com" 
  : ENV === "development" 
    ? "https://development.plaid.com" 
    : "https://sandbox.plaid.com";
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const THRESHOLD_GLOBAL_EXACT = 0.80;
const THRESHOLD_GLOBAL_SUGGEST = 0.65;
const FRANKFURTER_API_BASE = "https://api.frankfurter.dev/v2/rate";
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;
const BLOCKED_BANK_CURRENCY_CODES = new Set([
  "BTC",
  "ETH",
  "USDT",
  "USDC",
  "XBT",
  "XRP",
  "BNB",
  "SOL",
  "ADA",
  "DOGE",
  "LTC",
  "BCH",
  "DOT",
  "AVAX",
  "TRX",
  "LINK",
  "MATIC",
  "SHIB",
  "XLM",
  "XMR",
]);

type GlobalMerchantRule = {
  merchant_normalized: string | null;
  category_key: string | null;
  confidence: number | null;
  country: string | null;
};

type UserMerchantRule = {
  merchant_normalized: string | null;
  category_key: string | null;
  confidence: number | null;
};

type TxnCategorizationInput = {
  txn_id: string;
  name: string | null;
  merchant_name: string | null;
  amount: number | null;
  provider: string | null;
  account_subtype: string | null;
  plaid_category: string | null; // e.g. "TRANSFER_IN", "TRANSFER_OUT", "FOOD_AND_DRINK"
};

type CategorizationRunStats = {
  scanned: number;
  autoApplied: number;
  suggested: number;
  aiQueued: number;
  aiApplied: number;
  userOverridesPreserved: number;
  errors: number;
};

function emptyCategorizationStats(): CategorizationRunStats {
  return {
    scanned: 0,
    autoApplied: 0,
    suggested: 0,
    aiQueued: 0,
    aiApplied: 0,
    userOverridesPreserved: 0,
    errors: 0
  };
}

// Plaid sandbox sometimes returns short/generic merchant_name values
// (e.g. "FUN" for SparkFun, "POOL" for Uber*POOL). Prefer the raw name
// when merchant_name is too short to be useful as a categorization signal.
function pickMerchantSource(txn: { name: string | null; merchant_name: string | null }): string {
  const merchantName = (txn.merchant_name ?? "").trim();
  const name = (txn.name ?? "").trim();
  if (!merchantName) return name;
  if (!name) return merchantName;
  if (merchantName.length <= 3 && name.length > merchantName.length) return name;
  return merchantName;
}

// Plaid TRANSFER_IN over-classifies. Real transfers are wallet-to-wallet movements;
// interest income, dividends, and refunds also get TRANSFER_IN but are not transfers.
// These patterns mark rows that should bypass the TRANSFER short-circuit and route
// to the AI pipeline for proper categorization.
const NON_TRANSFER_INCOME_PATTERN =
  /\b(INTRST|INTEREST|INT\s*PAID|INT\s*EARN|INT\s*PYMNT|DIV(?:IDEND)?|DIV\s*REINVEST|REFUND|REVERSAL|REBATE|CASHBACK)\b/i;

function isFalseTransfer(txn: { name: string | null; merchant_name: string | null }): boolean {
  const text = `${txn.name ?? ""} ${txn.merchant_name ?? ""}`;
  return NON_TRANSFER_INCOME_PATTERN.test(text);
}

type FxResolved = {
  rate: number;
  rateDate: string;
  provider: string;
};

function normalizeCurrencyCode(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return CURRENCY_CODE_RE.test(value) ? value : null;
}

function normalizeCurrencyCodeOrUsd(raw: unknown): string {
  return normalizeCurrencyCode(raw) ?? "USD";
}

function resolvePlaidCurrencyCode(isoRaw: unknown, unofficialRaw: unknown): string {
  return normalizeCurrencyCode(isoRaw) ?? normalizeCurrencyCode(unofficialRaw) ?? "USD";
}

function isSupportedBankCurrencyCode(raw: unknown): boolean {
  const code = normalizeCurrencyCode(raw) ?? "USD";
  return !BLOCKED_BANK_CURRENCY_CODES.has(code);
}

function normalizeRequestedDate(raw: unknown): string {
  const parsed = new Date(String(raw ?? "").trim());
  if (!Number.isFinite(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function parsePositiveRate(raw: unknown): number | null {
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseCurrencyProvider(raw: unknown): string {
  const value = String(raw ?? "").trim();
  return value.length > 0 ? value : "frankfurter";
}

function decodeJwtRole(bearerToken: string): string | null {
  try {
    const parts = bearerToken.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1])) as { role?: unknown };
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function userLooksProFromClaims(user: any): boolean {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const truthyFlag = (value: unknown) =>
    value === true || asLower(value) === "true" || asLower(value) === "1";

  if (
    truthyFlag(appMeta["is_premium"]) ||
    truthyFlag(appMeta["premium"]) ||
    truthyFlag(userMeta["is_premium"]) ||
    truthyFlag(userMeta["premium"])
  ) {
    return true;
  }

  return [
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
    .filter(Boolean)
    .some(
      (value) =>
        value === "premium" || value.startsWith("premium_"),
    );
}

function tierLooksPro(tier: unknown): boolean {
  const value = String(tier ?? "").trim().toLowerCase();
  return (
    value === "premium" || value.startsWith("premium_")
  );
}

function entitlementStillValid(validUntil: unknown): boolean {
  if (!validUntil) return true;
  const expiry = new Date(String(validUntil));
  if (!Number.isFinite(expiry.getTime())) return false;
  return expiry.getTime() > Date.now();
}

async function userHasProAccess(
  sb: any,
  userId: string,
  userClaimsCandidate: any,
  reqId: string,
): Promise<boolean> {
  if (userLooksProFromClaims(userClaimsCandidate)) return true;

  try {
    const { data: entitlement, error } = await sb
      .from("user_entitlements")
      .select("tier, valid_until")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && entitlement) {
      if (tierLooksPro(entitlement.tier) && entitlementStillValid(entitlement.valid_until)) {
        return true;
      }
    } else if (error) {
      console.warn(`[${reqId}] entitlement query failed for user=${userId}: ${error.message}`);
    }
  } catch (error) {
    console.warn(`[${reqId}] entitlement check exception for user=${userId}:`, error);
  }

  try {
    const { data: adminUserData, error: adminUserErr } = await sb.auth.admin.getUserById(userId);
    if (!adminUserErr && adminUserData?.user && userLooksProFromClaims(adminUserData.user)) {
      return true;
    }
  } catch (error) {
    console.warn(`[${reqId}] admin user lookup failed for user=${userId}:`, error);
  }

  return false;
}

async function resolveUserMainCurrencyCode(
  sb: any,
  userId: string,
  reqId: string
): Promise<string> {
  const { data, error } = await sb
    .from("user_preferences")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(`[${reqId}] Failed to resolve main currency, defaulting to USD:`, error.message);
    return "USD";
  }

  const resolved = normalizeCurrencyCode((data as { currency?: unknown } | null)?.currency);
  if (!resolved) {
    console.warn(`[${reqId}] user_preferences.currency missing/invalid, defaulting to USD`);
    return "USD";
  }
  return resolved;
}

async function resolveFxRateForDate(
  sb: any,
  baseCurrency: string,
  quoteCurrency: string,
  requestedDate: string,
  reqId: string,
  fxCache: Map<string, FxResolved | null>
): Promise<FxResolved | null> {
  if (baseCurrency === quoteCurrency) {
    return {
      rate: 1,
      rateDate: requestedDate,
      provider: "identity"
    };
  }

  const cacheKey = `${baseCurrency}|${quoteCurrency}|${requestedDate}`;
  if (fxCache.has(cacheKey)) {
    return fxCache.get(cacheKey) ?? null;
  }

  const { data: cached, error: cacheErr } = await sb
    .from("fx_rate_cache")
    .select("rate,rate_date,provider")
    .eq("base", baseCurrency)
    .eq("quote", quoteCurrency)
    .eq("requested_date", requestedDate)
    .maybeSingle();

  if (!cacheErr) {
    const cachedRate = parsePositiveRate(cached?.rate);
    if (cachedRate) {
      const resolved: FxResolved = {
        rate: cachedRate,
        rateDate: normalizeRequestedDate(cached?.rate_date ?? requestedDate),
        provider: parseCurrencyProvider(cached?.provider)
      };
      fxCache.set(cacheKey, resolved);
      return resolved;
    }
  } else {
    console.warn(`[${reqId}] FX cache lookup failed for ${cacheKey}:`, cacheErr.message);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9000);

  try {
    const url = `${FRANKFURTER_API_BASE}/${encodeURIComponent(baseCurrency)}/${encodeURIComponent(quoteCurrency)}?date=${encodeURIComponent(requestedDate)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!res.ok) {
      fxCache.set(cacheKey, null);
      return null;
    }

    const payload = await res.json().catch(() => ({}));
    const rate = parsePositiveRate(payload?.rate);
    const rateDate = normalizeRequestedDate(payload?.date ?? requestedDate);
    if (!rate) {
      fxCache.set(cacheKey, null);
      return null;
    }

    await sb
      .from("fx_rate_cache")
      .upsert(
        {
          base: baseCurrency,
          quote: quoteCurrency,
          requested_date: requestedDate,
          rate_date: rateDate,
          rate,
          provider: "frankfurter",
          fetched_at: new Date().toISOString()
        },
        { onConflict: "base,quote,requested_date" }
      );

    const resolved: FxResolved = {
      rate,
      rateDate,
      provider: "frankfurter"
    };
    fxCache.set(cacheKey, resolved);
    return resolved;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[${reqId}] FX fetch failed for ${cacheKey}:`, reason);
    fxCache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function mergeCategorizationStats(
  left: CategorizationRunStats,
  right: CategorizationRunStats
): CategorizationRunStats {
  return {
    scanned: left.scanned + right.scanned,
    autoApplied: left.autoApplied + right.autoApplied,
    suggested: left.suggested + right.suggested,
    aiQueued: left.aiQueued + right.aiQueued,
    aiApplied: left.aiApplied + right.aiApplied,
    userOverridesPreserved: left.userOverridesPreserved + right.userOverridesPreserved,
    errors: left.errors + right.errors
  };
}

function findGlobalRule(
  title: string,
  merchantName: string | null,
  rules: GlobalMerchantRule[]
): { categoryKey: string; confidence: number; merchantNormalized: string } | null {
  const candidates = [
    normalizeMerchant(merchantName || ""),
    normalizeMerchant(title || ""),
    normalizeMerchant(`${title || ""} ${merchantName || ""}`)
  ].filter((value) => value.length > 0);

  let best: { categoryKey: string; confidence: number; merchantNormalized: string; keyLen: number } | null = null;

  for (const candidate of candidates) {
    for (const rule of rules) {
      const ruleKey = normalizeMerchant(rule.merchant_normalized || "");
      const categoryKey = rule.category_key?.trim();
      if (!ruleKey || !categoryKey) continue;

      const matches = candidate === ruleKey || candidate.includes(ruleKey) || ruleKey.includes(candidate);
      if (!matches) continue;

      const confidence = Number(rule.confidence ?? 0);
      if (
        !best ||
        confidence > best.confidence ||
        (confidence === best.confidence && ruleKey.length > best.keyLen)
      ) {
        best = {
          categoryKey,
          confidence,
          merchantNormalized: ruleKey,
          keyLen: ruleKey.length
        };
      }
    }
  }

  if (!best) return null;
  return {
    categoryKey: best.categoryKey,
    confidence: best.confidence,
    merchantNormalized: best.merchantNormalized
  };
}

async function enqueueAiCandidate(
  sb: any,
  userId: string,
  txn: TxnCategorizationInput
): Promise<boolean> {
  const merchantRaw = pickMerchantSource(txn).trim() || null;
  const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : "";
  if (merchantNormalized && isStatementNoiseMerchant(merchantNormalized)) {
    return false;
  }
  const amount = Number(txn.amount ?? 0);
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : null;

  const { error: queueErr } = await sb
    .from("ai_categorization_queue")
    .upsert(
      {
        user_id: userId,
        txn_id: txn.txn_id,
        provider: txn.provider || "plaid",
        merchant_raw: merchantRaw,
        merchant_normalized: merchantNormalized || null,
        amount_cents: amountCents,
        account_subtype: txn.account_subtype || null,
        status: "pending"
      },
      {
        onConflict: "user_id,txn_id,provider",
        ignoreDuplicates: true
      }
    );

  if (queueErr) {
    throw queueErr;
  }
  return true;
}

async function loadValidCategoryNames(sb: any, userId: string): Promise<Set<string>> {
  const { data } = await sb
    .from("categories")
    .select("name")
    .or(`user_id.eq.${userId},is_system.eq.true`);
  const names = new Set<string>();
  for (const row of (data || [])) {
    if (typeof row.name === "string") names.add(row.name.toLowerCase().trim());
  }
  return names;
}

async function categorizeSyncedTransactions(
  sb: any,
  userId: string,
  txns: TxnCategorizationInput[],
  userRuleMap: Map<string, UserMerchantRule>,
  globalRules: GlobalMerchantRule[],
  reqId: string,
  validCategoryNames: Set<string>
): Promise<CategorizationRunStats> {
  const stats = emptyCategorizationStats();
  if (txns.length === 0) return stats;

  const txnIds = Array.from(new Set(txns.map((t) => t.txn_id).filter(Boolean)));
  if (txnIds.length === 0) return stats;

  const { data: existingRows, error: existingErr } = await sb
    .from("txn_categorization")
    .select("txn_id,category_user")
    .eq("user_id", userId)
    .in("txn_id", txnIds);

  if (existingErr) {
    console.error(`[${reqId}] Failed to query existing categorizations:`, existingErr);
    stats.errors += txns.length;
    return stats;
  }

  const existingByTxnId = new Map<string, { category_user: string | null }>();
  for (const row of existingRows || []) {
    if (typeof row?.txn_id === "string") {
      existingByTxnId.set(row.txn_id, { category_user: row.category_user ?? null });
    }
  }

  for (const txn of txns) {
    stats.scanned += 1;

    const existing = existingByTxnId.get(txn.txn_id);
    if (existing?.category_user) {
      stats.userOverridesPreserved += 1;
      continue;
    }

    // Plaid convention: negative amount = money IN (income/credit/refund).
    // Global merchant rules are expense-oriented, so skip them for money-in rows
    // and let AI choose a valid income-side category.
    const isMoneyIn =
      typeof txn.amount === "number" &&
      Number.isFinite(txn.amount) &&
      txn.amount < 0;

    // Plaid marks transfers explicitly, so map them directly and skip merchant rules + AI.
    // Skip the short-circuit for interest/dividend/refund patterns that Plaid mis-bucks
    // into TRANSFER_IN — those need real AI categorization, not a Transfer label.
    const plaidCat = (txn.plaid_category || "").toUpperCase();
    if (plaidCat.startsWith("TRANSFER") && !isFalseTransfer(txn)) {
      const merchantNorm = normalizeMerchant(pickMerchantSource(txn));
      const transferCategory = validCategoryNames.has("transfer") ? "Transfer" : "Uncategorized";
      const { error: tErr } = await sb.rpc("upsert_txn_categorization_model_guarded", {
        p_user_id: userId,
        p_txn_id: txn.txn_id,
        p_category_model: transferCategory,
        p_category_confidence: 1.0,
        p_is_suggested: false,
        p_merchant_normalized: merchantNorm || null
      });
      if (tErr) {
        console.error(`[${reqId}] Transfer assign failed txn=${txn.txn_id}:`, tErr);
        stats.errors += 1;
      } else {
        stats.autoApplied += 1;
      }
      continue;
    }

    if (isMoneyIn) {
      let wasQueued = false;
      try {
        wasQueued = await enqueueAiCandidate(sb, userId, txn);
      } catch (queueErr) {
        console.error(`[${reqId}] Failed to enqueue AI income candidate for txn=${txn.txn_id}:`, queueErr);
        stats.errors += 1;
      }
      // Immediate placeholder so the transaction is never null in the UI.
      // ai-categorize-batch will overwrite with the correct income category.
      const { error: fbErr4 } = await sb.rpc("upsert_txn_categorization_model_guarded", {
        p_user_id: userId, p_txn_id: txn.txn_id,
        p_category_model: "Uncategorized", p_category_confidence: 0.0,
        p_is_suggested: false,
        p_merchant_normalized: normalizeMerchant(pickMerchantSource(txn)) || null
      });
      if (fbErr4) console.error(`[${reqId}] Fallback RPC failed txn=${txn.txn_id}:`, fbErr4);
      if (wasQueued) stats.aiQueued += 1;
      continue;
    }

    const merchantNormalized = normalizeMerchant(pickMerchantSource(txn));
    const userRule = merchantNormalized ? userRuleMap.get(merchantNormalized) : undefined;

    let picked: { categoryKey: string; confidence: number; merchantNormalized: string } | null = null;
    let isSuggested = false;

    if (userRule?.category_key) {
      picked = {
        categoryKey: userRule.category_key,
        confidence: 1.0,
        merchantNormalized
      };
    } else {
      const globalRule = findGlobalRule(txn.name || "Transaction", txn.merchant_name, globalRules);
      if (!globalRule) {
        let wasQueued = false;
        try {
          wasQueued = await enqueueAiCandidate(sb, userId, txn);
        } catch (queueErr) {
          console.error(`[${reqId}] Failed to enqueue AI candidate for txn=${txn.txn_id}:`, queueErr);
          stats.errors += 1;
        }
        const { error: fbErr3 } = await sb.rpc("upsert_txn_categorization_model_guarded", {
          p_user_id: userId, p_txn_id: txn.txn_id,
          p_category_model: "Uncategorized", p_category_confidence: 0.0,
          p_is_suggested: false,
          p_merchant_normalized: normalizeMerchant(pickMerchantSource(txn)) || null
        });
        if (fbErr3) console.error(`[${reqId}] Fallback RPC failed txn=${txn.txn_id}:`, fbErr3);
        if (wasQueued) stats.aiQueued += 1;
        continue;
      }

      if (globalRule.confidence >= THRESHOLD_GLOBAL_EXACT) {
        picked = globalRule;
        isSuggested = false;
      } else if (globalRule.confidence >= THRESHOLD_GLOBAL_SUGGEST) {
        picked = globalRule;
        isSuggested = true;
      } else {
        let wasQueued = false;
        try {
          wasQueued = await enqueueAiCandidate(sb, userId, txn);
        } catch (queueErr) {
          console.error(`[${reqId}] Failed to enqueue AI candidate for txn=${txn.txn_id}:`, queueErr);
          stats.errors += 1;
        }
        const { error: fbErr2 } = await sb.rpc("upsert_txn_categorization_model_guarded", {
          p_user_id: userId, p_txn_id: txn.txn_id,
          p_category_model: "Uncategorized", p_category_confidence: 0.0,
          p_is_suggested: false,
          p_merchant_normalized: normalizeMerchant(pickMerchantSource(txn)) || null
        });
        if (fbErr2) console.error(`[${reqId}] Fallback RPC failed txn=${txn.txn_id}:`, fbErr2);
        if (wasQueued) stats.aiQueued += 1;
        continue;
      }
    }

    if (!picked) continue;

    // Enforce user-category whitelist: never write a category the user doesn't have.
    // If user has no categories at all → queue for AI; if picked key not in their list → queue.
    const pickedNameLower = picked.categoryKey.toLowerCase().trim();
    if (validCategoryNames.size === 0 || !validCategoryNames.has(pickedNameLower)) {
      let wasQueued = false;
      try {
        wasQueued = await enqueueAiCandidate(sb, userId, txn);
      } catch (queueErr) {
        console.error(`[${reqId}] Failed to enqueue AI candidate for txn=${txn.txn_id}:`, queueErr);
        stats.errors += 1;
      }
      const { error: fbErr } = await sb.rpc("upsert_txn_categorization_model_guarded", {
        p_user_id: userId, p_txn_id: txn.txn_id,
        p_category_model: "Uncategorized", p_category_confidence: 0.0,
        p_is_suggested: false,
        p_merchant_normalized: normalizeMerchant(pickMerchantSource(txn)) || null
      });
      if (fbErr) console.error(`[${reqId}] Fallback RPC failed txn=${txn.txn_id}:`, fbErr);
      if (wasQueued) stats.aiQueued += 1;
      continue;
    }

    // Use atomic guarded RPC — WHERE category_user IS NULL prevents
    // overwriting a user-set category if they categorized between our read and write.
    const { data: guardedOk, error: guardedErr } = await sb.rpc(
      "upsert_txn_categorization_model_guarded",
      {
        p_user_id: userId,
        p_txn_id: txn.txn_id,
        p_category_model: picked.categoryKey,
        p_category_confidence: picked.confidence,
        p_is_suggested: isSuggested,
        p_merchant_normalized: picked.merchantNormalized || null
      }
    );

    if (guardedErr) {
      console.error(`[${reqId}] Failed to upsert categorization for txn=${txn.txn_id}:`, guardedErr);
      stats.errors += 1;
      continue;
    }

    if (!guardedOk) {
      // category_user was set concurrently — honour it
      stats.userOverridesPreserved += 1;
    } else if (isSuggested) {
      stats.suggested += 1;
    } else {
      stats.autoApplied += 1;
    }
  }

  return stats;
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, {
    status: res.status,
    headers: h
  });
}

function json(payload, status = 200) {
  return cors(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}

async function markItemAsNeedsAttention(sb, itemId, errorCode) {
  await sb
    .from("plaid_items")
    .update({ 
      needs_attention: true,
      last_error: errorCode,
      updated_at: new Date().toISOString()
    })
    .eq("item_id", itemId);
}

async function processItemAccounts(sb, item, user, allowSet, reqId) {
  const { access_token, item_id } = item;
  let accounts = [];

  try {
    // 1. Get item info first
    const itemRes = await fetch(`${PLAID_BASE}/item/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token
      })
    });

    const itemData = await itemRes.json();
    if (!itemRes.ok) {
      if (itemData.error_code === "ITEM_LOGIN_REQUIRED") {
        console.warn(`[${reqId}] Item ${item_id} needs re-authentication`);
        await markItemAsNeedsAttention(sb, item_id, "ITEM_LOGIN_REQUIRED");
        return { success: false, accounts: [] };
      }
      throw new Error(itemData.error_message || "Failed to get item info");
    }

    // 2. Get accounts
    const accRes = await fetch(`${PLAID_BASE}/accounts/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token
      })
    });

    const accData = await accRes.json();
    
    if (!accRes.ok) {
      if (accData.error_code === "ITEM_LOGIN_REQUIRED" || 
          accData.error_code === "NO_ACCOUNTS") {
        console.warn(`[${reqId}] Item ${item_id} has issues: ${accData.error_code}`);
        await markItemAsNeedsAttention(sb, item_id, accData.error_code);
        return { success: false, accounts: [] };
      }
      throw new Error(accData.error_message || "Failed to get accounts");
    }

    accounts = accData.accounts || [];
    if (accounts.length === 0) {
      console.warn(`[${reqId}] No accounts found for item ${item_id}`);
      await markItemAsNeedsAttention(sb, item_id, "NO_ACCOUNTS_FOUND");
      return { success: false, accounts: [] };
    }

    // Filter accounts if needed
    const scopedAccounts = allowSet.size > 0
      ? accounts.filter(a => allowSet.has(a.account_id))
      : accounts;
    const filteredAccounts = scopedAccounts.filter((acc) => {
      const currencyCode = resolvePlaidCurrencyCode(
        acc?.balances?.iso_currency_code,
        acc?.balances?.unofficial_currency_code,
      );
      return isSupportedBankCurrencyCode(currencyCode);
    });
    const unsupportedScopedCount = scopedAccounts.length - filteredAccounts.length;
    if (unsupportedScopedCount > 0) {
      console.log(
        `[${reqId}] Item ${item_id}: skipped ${unsupportedScopedCount} unsupported-currency account(s)`,
      );
    }
    if (filteredAccounts.length === 0) {
      console.warn(`[${reqId}] No supported accounts left for item ${item_id} after filtering`);
      return { success: false, accounts: [] };
    }

    // Process accounts with proper types
    const rows = filteredAccounts.map(acc => ({
      user_id: user.id,
      item_id: item_id,
      account_id: acc.account_id,
      name: acc.name,
      official_name: acc.official_name,
      type: acc.type,
      subtype: acc.subtype,
      mask: acc.mask,
      currency: resolvePlaidCurrencyCode(
        acc.balances?.iso_currency_code,
        acc.balances?.unofficial_currency_code,
      ),
      balances: {
        available: acc.balances?.available,
        current: acc.balances?.current,
        limit: acc.balances?.limit,
        iso_currency_code: acc.balances?.iso_currency_code,
        unofficial_currency_code: acc.balances?.unofficial_currency_code
      }
    }));

    // Upsert accounts one by one to handle conflicts
    for (const row of rows) {
      const { error } = await sb
        .from('accounts')
        .upsert(row, { 
          onConflict: 'user_id,item_id,account_id'
        });
      
      if (error) {
        console.error(`[${reqId}] Failed to upsert account ${row.account_id}:`, error);
      }
    }

    return { success: true, accounts: filteredAccounts };

  } catch (error) {
    console.error(`[${reqId}] Error processing accounts for item ${item_id}:`, error);
    await markItemAsNeedsAttention(sb, item_id, "PROCESSING_ERROR");
    return { success: false, accounts: [] };
  }
}

async function processItemTransactions(
  sb,
  item,
  user,
  reqId,
  mainCurrencyCode: string,
  fxCache: Map<string, FxResolved | null>,
  allowedAccountIds: Set<string>,
  accountSubtypeByAccountId: Map<string, string>,
  userRuleMap: Map<string, UserMerchantRule>,
  globalRules: GlobalMerchantRule[],
  validCategoryNames: Set<string>
) {
  const { access_token, item_id, txn_cursor } = item;
  let cursor = txn_cursor;
  let hasMore = true;
  let txAdded = 0;
  let txModified = 0;
  let txRemoved = 0;
  let categorization = emptyCategorizationStats();

  try {
    while (hasMore) {
      const syncRes = await fetch(`${PLAID_BASE}/transactions/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: PLAID_CLIENT_ID,
          secret: PLAID_SECRET,
          access_token,
          cursor,
          count: 500,
          options: {
            include_personal_finance_category: true,
            include_original_description: true
          }
        })
      });

      const response = await syncRes.json().catch(() => ({}));
      
      if (!syncRes.ok) {
        if (response.error_code === "ITEM_LOGIN_REQUIRED" || 
            response.error_code === "NO_ACCOUNTS") {
          console.warn(`[${reqId}] Item ${item_id} sync issue: ${response.error_code}`);
          await markItemAsNeedsAttention(sb, item_id, response.error_code);
          break;
        }
        throw new Error(response.error_message || "Transaction sync failed");
      }

      // Process transactions
      const added = response.added || [];
      const modified = response.modified || [];
      const removed = response.removed || [];

      // Process added/modified transactions
      const syncedTxns = [...added, ...modified];
      const txns = [];
      const categorizationInputs: TxnCategorizationInput[] = [];
      let unresolvedFxCount = 0;
      let skippedByAccountScope = 0;
      let skippedByUnsupportedCurrency = 0;
      for (const t of syncedTxns) {
        const accountId = String(t?.account_id ?? "").trim();
        if (allowedAccountIds.size > 0 && (!accountId || !allowedAccountIds.has(accountId))) {
          skippedByAccountScope += 1;
          continue;
        }
        const sourceCurrency = resolvePlaidCurrencyCode(t.iso_currency_code, t.unofficial_currency_code);
        if (!isSupportedBankCurrencyCode(sourceCurrency)) {
          skippedByUnsupportedCurrency += 1;
          continue;
        }
        const requestedDate = normalizeRequestedDate(t.date);
        const amount = Number(t.amount ?? 0);
        const nowIso = new Date().toISOString();

        let reportingAmount: number | null = null;
        let reportingCurrency: string | null = null;
        let fxRateUsed: number | null = null;
        let fxRateDate: string | null = null;
        let fxProvider: string | null = null;
        let normalizedAt: string | null = null;

        const fxResolved = await resolveFxRateForDate(
          sb,
          sourceCurrency,
          mainCurrencyCode,
          requestedDate,
          reqId,
          fxCache
        );
        if (fxResolved) {
          reportingAmount = Number((amount * fxResolved.rate).toFixed(6));
          reportingCurrency = mainCurrencyCode;
          fxRateUsed = fxResolved.rate;
          fxRateDate = fxResolved.rateDate;
          fxProvider = fxResolved.provider;
          normalizedAt = nowIso;
        } else {
          unresolvedFxCount += 1;
        }

        txns.push({
          user_id: user.id,
          item_id,
          txn_id: t.transaction_id,
          account_id: accountId,
          name: t.name || t.merchant_name,
          amount,
          currency: sourceCurrency,
          pending: !!t.pending,
          merchant_name: t.merchant_name,
          category: Array.isArray(t.category)
            ? t.category.join(" > ")
            : t.personal_finance_category?.primary,
          txn_date: t.date,
          authorized_date: t.authorized_date,
          provider: "plaid",
          created_at: nowIso,
          reporting_amount: reportingAmount,
          reporting_currency: reportingCurrency,
          fx_rate_used: fxRateUsed,
          fx_requested_date: fxResolved ? requestedDate : null,
          fx_rate_date: fxRateDate,
          fx_provider: fxProvider,
          reporting_version: 1,
          normalized_at: normalizedAt,
          // Un-remove any transaction that Plaid previously removed but now re-reports.
          is_removed: false,
          removed_at: null
        });

        categorizationInputs.push({
          txn_id: t.transaction_id,
          name: t.name || t.merchant_name || null,
          merchant_name: t.merchant_name || null,
          amount: Number(t.amount ?? 0),
          provider: "plaid",
          account_subtype: accountSubtypeByAccountId.get(accountId) || null,
          plaid_category: t.personal_finance_category?.primary || null
        });
      }
      if (unresolvedFxCount > 0) {
        console.warn(
          `[${reqId}] FX unresolved for ${unresolvedFxCount}/${syncedTxns.length} plaid txn(s) item=${item_id}`
        );
      }
      if (skippedByAccountScope > 0 || skippedByUnsupportedCurrency > 0) {
        console.log(
          `[${reqId}] Item ${item_id}: skipped txns by scope=${skippedByAccountScope}, unsupported_currency=${skippedByUnsupportedCurrency}`
        );
      }

      // Upsert transactions in batches
      for (let i = 0; i < txns.length; i += 100) {
        const batch = txns.slice(i, i + 100);
        const { error } = await sb
          .from('transactions')
          .upsert(batch, { onConflict: 'user_id,txn_id' });
        
        if (error) {
          console.error(`[${reqId}] Error upserting transactions batch ${i}-${i + batch.length}:`, error);
        }
      }

      // Deterministic categorization is now in the sync pipeline (Phase 3).
      // categorize-txns remains available for backfill/reprocess runs.
      const pageCategorization = await categorizeSyncedTransactions(
        sb,
        user.id,
        categorizationInputs,
        userRuleMap,
        globalRules,
        reqId,
        validCategoryNames
      );
      categorization = mergeCategorizationStats(categorization, pageCategorization);

      // Soft-delete removed transactions instead of ignoring them (Fix 2).
      // Aggregators can incorrectly mark legitimate transactions as removed.
      // Soft-delete keeps them recoverable if the aggregator corrects the error.
      if (removed.length > 0) {
        const removedIds = removed
          .filter((r: any) => {
            if (allowedAccountIds.size === 0) return true;
            const accountId = String(r?.account_id ?? "").trim();
            return accountId.length > 0 && allowedAccountIds.has(accountId);
          })
          .map((r: any) => r.transaction_id)
          .filter(Boolean);
        if (removedIds.length > 0) {
          const { error: removeErr } = await sb
            .from('transactions')
            .update({ is_removed: true, removed_at: new Date().toISOString() })
            .eq('user_id', user.id)
            .in('txn_id', removedIds);
          if (removeErr) {
            console.error(`[${reqId}] Failed to soft-delete removed txns:`, removeErr);
          }
        }
      }

      // Update counts
      txAdded += added.length;
      txModified += modified.length;
      txRemoved += removed.length;

      // Update cursor
      hasMore = response.has_more;
      cursor = response.next_cursor;

      if (cursor) {
        await sb
          .from("plaid_items")
          .update({ txn_cursor: cursor })
          .eq("item_id", item_id);
      }
    }

    return { success: true, txAdded, txModified, txRemoved, categorization };

  } catch (error) {
    console.error(`[${reqId}] Error syncing transactions for item ${item_id}:`, error);
    await markItemAsNeedsAttention(sb, item_id, "TRANSACTION_SYNC_ERROR");
    return { success: false, txAdded: 0, txModified: 0, txRemoved: 0, categorization: emptyCategorizationStats() };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  const reqId = crypto.randomUUID();
  console.log(`[${reqId}] START sync-transactions`);

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth) console.warn(`[${reqId}] Missing Authorization header`);

    // Parse body early — needed for service-role bypass below.
    const body = await req.json().catch(() => ({}));

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false }
    });

    // Authenticate user.
    // Webhook/internal calls may come with either:
    // 1) the exact service-role key string, or
    // 2) a valid JWT whose role claim is service_role.
    // In either case, resolve user from plaid_items.item_id in request body.
    const bearerToken = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    const jwtRole = decodeJwtRole(bearerToken);
    const isServiceRole =
      (!!SERVICE_ROLE && bearerToken === SERVICE_ROLE) ||
      jwtRole === "service_role";
    let user: { id: string };

    if (isServiceRole) {
      const itemIdInBody = typeof body.item_id === "string" ? body.item_id.trim() : "";
      if (!itemIdInBody) {
        console.error(`[${reqId}] Service-role call missing item_id`);
        return json({ error: "item_id_required_for_service_role" }, 400);
      }
      const { data: itemRow, error: itemErr } = await sb
        .from("plaid_items")
        .select("user_id")
        .eq("item_id", itemIdInBody)
        .single();
      if (itemErr || !itemRow?.user_id) {
        console.error(`[${reqId}] Service-role: item not found for item_id=${itemIdInBody}`, itemErr);
        return json({ error: "item_not_found" }, 404);
      }
      user = { id: itemRow.user_id };
      console.log(`[${reqId}] Service-role bypass: resolved user ${user.id} from item ${itemIdInBody}`);
    } else {
      const { data: userRes, error: userErr } = await sb.auth.getUser();
      if (userErr || !userRes?.user) {
        console.error(`[${reqId}] Unauthorized:`, userErr);
        return json({ error: "unauthorized" }, 401);
      }
      user = userRes.user;
    }

    // Parse request body (already parsed above for service-role auth bypass)
    const wantedItemId = typeof body.item_id === "string" && body.item_id.trim().length > 0
      ? body.item_id.trim()
      : null;

    const selectedIds = Array.isArray(body.account_ids)
      ? body.account_ids.map(String).filter(Boolean)
      : [];

    const allowSet = new Set(selectedIds);
    // Fix 12: reset_cursor=true clears the Plaid sync cursor so the next sync
    // fetches all transactions from scratch instead of only incremental changes.
    const shouldResetCursor = body.reset_cursor === true;

    // Check plaid items BEFORE the premium gate. Users with no linked banks
    // get a silent 200 instead of a 403, keeping sync logs clean.
    let itemsList = [];
    if (wantedItemId) {
      const { data: one, error } = await sb
        .from("plaid_items")
        .select("item_id, access_token, txn_cursor")
        .eq("user_id", user.id)
        .eq("item_id", wantedItemId)
        .single();

      if (error || !one?.access_token) {
        console.error(`[${reqId}] Missing item or token:`, error);
        return json({ error: "missing_item_or_token" }, 400);
      }
      itemsList = [one];
    } else {
      const { data: all, error } = await sb
        .from("plaid_items")
        .select("item_id, access_token, txn_cursor")
        .eq("user_id", user.id);

      if (error) {
        console.error(`[${reqId}] Failed to get items:`, error);
        return json({ error: "items_query_failed" }, 400);
      }
      itemsList = all ?? [];
    }

    if (itemsList.length === 0) {
      console.log(`[${reqId}] No items found for user`);
      return json({
        ok: true,
        accounts_upserted: 0,
        txns_added: 0,
        txns_modified: 0,
        txns_removed: 0,
        categorization: emptyCategorizationStats(),
        warning: "no_items"
      });
    }

    const hasProAccess = await userHasProAccess(
      sb,
      user.id,
      !isServiceRole ? user : null,
      reqId,
    );
    if (!hasProAccess) {
      console.warn(`[${reqId}] pro_required for user=${user.id}`);
      return json({ error: "pro_required", message: "Bank sync is Premium only." }, 403);
    }

    console.log(`[${reqId}] Processing for user: ${user.id}`);

    const globalRulesWithStatus = await sb
      .from("global_merchant_rules")
      .select("merchant_normalized,category_key,confidence,country")
      .eq("status", "active")
      .order("confidence", { ascending: false });

    if (globalRulesWithStatus.error) {
      // Never fall back to loading all rules without status filter — that would apply
      // pending_review rules (potentially wrong categories) to real transactions.
      console.error(`[${reqId}] Failed to load global rules:`, globalRulesWithStatus.error);
      return json({ error: "global_rules_query_failed", details: globalRulesWithStatus.error.message }, 500);
    }

    const globalRules = (globalRulesWithStatus.data || []) as GlobalMerchantRule[];

    const userRulesResp = await sb
      .from("user_merchant_rules")
      .select("merchant_normalized,category_key,confidence")
      .eq("user_id", user.id);

    const userRuleMap = new Map<string, UserMerchantRule>();
    if (userRulesResp.error) {
      console.warn(`[${reqId}] user_merchant_rules unavailable: ${userRulesResp.error.message}`);
    } else {
      for (const rule of (userRulesResp.data || []) as UserMerchantRule[]) {
        const key = normalizeMerchant(rule.merchant_normalized || "");
        const categoryKey = rule.category_key?.trim();
        if (!key || !categoryKey) continue;
        const existing = userRuleMap.get(key);
        if (!existing || Number(rule.confidence ?? 0) >= Number(existing.confidence ?? 0)) {
          userRuleMap.set(key, {
            merchant_normalized: key,
            category_key: categoryKey,
            confidence: Number(rule.confidence ?? 1)
          });
        }
      }
    }

    // Fix 12: null out cursors in DB and in-memory before processing so the
    // sync loop starts from the beginning (no cursor = full history from Plaid).
    if (shouldResetCursor) {
      let resetQuery = sb
        .from("plaid_items")
        .update({ txn_cursor: null })
        .eq("user_id", user.id);
      if (wantedItemId) {
        resetQuery = resetQuery.eq("item_id", wantedItemId);
      }
      const { error: resetErr } = await resetQuery;
      if (resetErr) {
        console.error(`[${reqId}] Failed to reset cursors:`, resetErr);
        return json({ error: "cursor_reset_failed", details: resetErr.message }, 500);
      }
      itemsList = itemsList.map((item: any) => ({ ...item, txn_cursor: null }));
      console.log(`[${reqId}] Reset ${itemsList.length} cursor(s) for user ${user.id}`);
    }

    // Load valid category names once for the whole sync run
    const validCategoryNames = await loadValidCategoryNames(sb, user.id);
    console.log(`[${reqId}] Valid categories for user: ${validCategoryNames.size}`);
    const mainCurrencyCode = await resolveUserMainCurrencyCode(sb, user.id, reqId);
    console.log(`[${reqId}] Main currency resolved: ${mainCurrencyCode}`);

    // Process each item
    let totalAccounts = 0;
    let totalTxAdded = 0;
    let totalTxModified = 0;
    let totalTxRemoved = 0;
    let totalCategorization = emptyCategorizationStats();
    const itemsWithIssues = [];
    const fxCache = new Map<string, FxResolved | null>();

    for (const item of itemsList) {
      try {
        // Process accounts
        const { success: accountsSuccess, accounts } = await processItemAccounts(
          sb, item, user, allowSet, reqId
        );

        if (!accountsSuccess || accounts.length === 0) {
          itemsWithIssues.push({
            item_id: item.item_id,
            error: "no_valid_accounts"
          });
          continue;
        }

        const accountSubtypeByAccountId = new Map<string, string>();
        const allowedAccountIds = new Set<string>();
        for (const account of accounts) {
          if (typeof account?.account_id === "string" && typeof account?.subtype === "string") {
            accountSubtypeByAccountId.set(account.account_id, account.subtype);
          }
          if (typeof account?.account_id === "string") {
            const normalizedAccountId = account.account_id.trim();
            if (normalizedAccountId.length > 0) {
              allowedAccountIds.add(normalizedAccountId);
            }
          }
        }

        // Process transactions
        const { 
          success: txSuccess, 
          txAdded, 
          txModified, 
          txRemoved,
          categorization
        } = await processItemTransactions(
          sb,
          item,
          user,
          reqId,
          mainCurrencyCode,
          fxCache,
          allowedAccountIds,
          accountSubtypeByAccountId,
          userRuleMap,
          globalRules,
          validCategoryNames
        );

        if (!txSuccess) {
          itemsWithIssues.push({
            item_id: item.item_id,
            error: "transaction_sync_failed"
          });
          continue;
        }

        totalAccounts += accounts.length;
        totalTxAdded += txAdded;
        totalTxModified += txModified;
        totalTxRemoved += txRemoved;
        totalCategorization = mergeCategorizationStats(totalCategorization, categorization);

        console.log(`[${reqId}] Processed item ${item.item_id}: ${accounts.length} accounts, ${txAdded} txs added, ${txModified} modified, ${txRemoved} removed`);

      } catch (error) {
        console.error(`[${reqId}] Error processing item ${item.item_id}:`, error);
        itemsWithIssues.push({
          item_id: item.item_id,
          error: "processing_error",
          details: error.message
        });
      }
    }

    // Return results
    const result = {
      ok: true,
      accounts_upserted: totalAccounts,
      txns_added: totalTxAdded,
      txns_modified: totalTxModified,
      txns_removed: totalTxRemoved,
      categorization: totalCategorization,
      items_processed: itemsList.length - itemsWithIssues.length,
      items_with_issues: itemsWithIssues.length > 0 ? itemsWithIssues : undefined
    };

    console.log(`[${reqId}] Sync completed:`, JSON.stringify(result, null, 2));
    return json(result);

  } catch (error) {
    console.error(`[${reqId}] Fatal error:`, error);
    return json({
      ok: false,
      error: "sync_failed",
      details: error.message
    }, 500);
  }
});


