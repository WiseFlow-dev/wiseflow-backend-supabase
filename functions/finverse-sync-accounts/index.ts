import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import {
  isStatementNoiseMerchant,
  normalizeMerchant,
  STATEMENT_NOISE_SENTINEL
} from "../_shared/normalize.ts";

const FINVERSE_BASE_URL = "https://api.prod.finverse.net";
const JSON_HEADERS = { "Content-Type": "application/json" };
const UNCATEGORIZED_KEY = "Uncategorized";
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

type SyncStage =
  | "request_validation"
  | "auth"
  | "connection_lookup"
  | "item_upsert"
  | "fetch_accounts"
  | "accounts_upsert"
  | "fetch_transactions"
  | "transactions_upsert"
  | "queue_upsert"
  | "noise_upsert"
  | "ai_kick"
  | "connection_status_update"
  | "completed";

type SyncEventName =
  | "sync_started"
  | "sync_success"
  | "sync_failed";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function logStage(stage: SyncStage, event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ source: "finverse-sync-accounts", stage, event, ...data }));
}
function userHasProAccess(user: any): boolean {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const truthyFlag = (value: unknown) => value === true || asLower(value) === "true" || asLower(value) === "1";
  if (truthyFlag(appMeta["is_premium"]) || truthyFlag(appMeta["premium"]) || truthyFlag(userMeta["is_premium"]) || truthyFlag(userMeta["premium"])) return true;
  return [appMeta["plan"], appMeta["tier"], appMeta["subscription_tier"], appMeta["subscription_plan"], userMeta["plan"], userMeta["tier"], userMeta["subscription_tier"], userMeta["subscription_plan"]]
    .map(asLower).filter(Boolean)
    .some((v) => v === "premium" || v.startsWith("premium_"));
}
function tierLooksPro(tier: unknown): boolean {
  const value = String(tier ?? "").trim().toLowerCase();
  return value === "premium" || value.startsWith("premium_");
}
function entitlementStillValid(validUntil: unknown): boolean {
  if (!validUntil) return true;
  const expiry = new Date(String(validUntil));
  if (!Number.isFinite(expiry.getTime())) return false;
  return expiry.getTime() > Date.now();
}
async function userHasProAccessWithFallback(
  adminClient: any,
  userId: string,
  userClaimsCandidate: any,
): Promise<boolean> {
  if (userHasProAccess(userClaimsCandidate)) return true;

  try {
    const { data: entitlement, error } = await adminClient
      .from("user_entitlements")
      .select("tier, valid_until")
      .eq("user_id", userId)
      .maybeSingle();
    if (!error && entitlement) {
      if (tierLooksPro(entitlement.tier) && entitlementStillValid(entitlement.valid_until)) {
        return true;
      }
    }
  } catch (_error) {
    // no-op: fall through to auth-admin fallback
  }

  try {
    const { data: adminUserData, error: adminUserErr } = await adminClient.auth.admin.getUserById(userId);
    if (!adminUserErr && adminUserData?.user && userHasProAccess(adminUserData.user)) {
      return true;
    }
  } catch (_error) {
    // no-op
  }

  return false;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCurrencyCode(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return CURRENCY_CODE_RE.test(value) ? value : null;
}

function normalizeCurrencyCodeOrUsd(raw: unknown): string {
  return normalizeCurrencyCode(raw) ?? "USD";
}

function isSupportedBankCurrencyCode(raw: unknown): boolean {
  const code = normalizeCurrencyCodeOrUsd(raw);
  return !BLOCKED_BANK_CURRENCY_CODES.has(code);
}

function toDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toLower(value: unknown): string | null {
  const s = String(value ?? "").trim().toLowerCase();
  return s || null;
}

function getMaskedLast4(masked: unknown): string | null {
  const s = String(masked ?? "").trim();
  if (!s) return null;
  const last4 = s.slice(-4);
  return last4 || null;
}

async function findCanonicalFinverseAccount(
  supabase: any,
  params: {
    userId: string;
    loginIdentityId: string;
    incomingAccountId: string;
    institutionId: string | null;
    mask: string | null;
    subtype: string | null;
  },
): Promise<{ id: string; account_id: string | null; item_id: string | null } | null> {
  const { userId, loginIdentityId, incomingAccountId, institutionId, mask, subtype } = params;

  const { data: directMatch, error: directMatchErr } = await supabase
    .from("accounts")
    .select("id, account_id, item_id")
    .eq("user_id", userId)
    .eq("provider", "finverse")
    .eq("item_id", loginIdentityId)
    .eq("account_id", incomingAccountId)
    .maybeSingle();
  if (directMatchErr) {
    console.error("canonical finverse account direct lookup failed:", {
      user_id: userId,
      login_identity_id: loginIdentityId,
      account_id: incomingAccountId,
      error: directMatchErr,
    });
  }
  if (directMatch?.id) return directMatch;

  if (!institutionId || !mask || !subtype) {
    return null;
  }

  const { data: stableMatch, error: stableMatchErr } = await supabase
    .from("accounts")
    .select("id, account_id, item_id")
    .eq("user_id", userId)
    .eq("provider", "finverse")
    .eq("institution_id", institutionId)
    .eq("mask", mask)
    .eq("subtype", subtype)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (stableMatchErr) {
    console.error("canonical finverse account stable lookup failed:", {
      user_id: userId,
      login_identity_id: loginIdentityId,
      institution_id: institutionId,
      mask,
      subtype,
      error: stableMatchErr,
    });
    return null;
  }
  return stableMatch ?? null;
}

async function writeSyncEvent(
  adminClient: any,
  params: {
    userId: string;
    eventName: SyncEventName;
    latencyMs?: number | null;
    providerRef?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    source?: string;
  },
) {
  try {
    const row = {
      user_id: params.userId,
      provider: "finverse",
      event_name: params.eventName,
      latency_ms: params.latencyMs != null ? Math.max(0, Math.round(params.latencyMs)) : null,
      provider_ref: params.providerRef ?? null,
      error_code: params.errorCode?.slice(0, 64) ?? null,
      error_message: params.errorMessage?.slice(0, 500) ?? null,
      source: params.source ?? "finverse-sync-accounts",
    };
    const { error } = await adminClient
      .from("sync_event_logs")
      .insert(row);
    if (error) {
      console.error("finverse sync event log write failed:", {
        event_name: params.eventName,
        error,
      });
    }
  } catch (error) {
    console.error("finverse sync event log unexpected failure:", {
      event_name: params.eventName,
      error,
    });
  }
}

async function getJson(url: string, token: string): Promise<any> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`finverse_get_failed:${response.status}:${details}`);
  }

  return await response.json();
}

serve(async (req) => {
  let stage: SyncStage = "request_validation";
  const startedAt = Date.now();
  let adminClient: any = null;
  let telemetryUserId: string | null = null;
  let telemetryProviderRef: string | null = null;
  let syncStartedLogged = false;

  const fail = (
    status: number,
    errorCode: string,
    errorMessage: string,
    extra: Record<string, unknown> = {},
  ) =>
    json(status, {
      ok: false,
      env: "finverse",
      stage,
      error_code: errorCode,
      error: errorMessage,
      ...extra,
    });

  try {
    logStage(stage, "start", { method: req.method });
    if (req.method !== "POST") {
      return fail(405, "method_not_allowed", "Method not allowed");
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return fail(401, "missing_auth_header", "Missing authorization header");
    }
    const [scheme, userJwt] = authHeader.split(" ");
    if (scheme !== "Bearer" || !userJwt) {
      return fail(401, "invalid_auth_header", "Invalid authorization header");
    }

    stage = "auth";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return fail(500, "supabase_env_not_configured", "Supabase env is not configured");
    }

    const body = await req.json().catch(() => ({}));
    const isServiceRoleCall = Boolean(serviceRoleKey) && userJwt === serviceRoleKey;
    let user: { id: string } | null = null;
    let userClaimsCandidate: any = null;
    adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    let supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    if (isServiceRoleCall) {
      const requestedUserId = String(body?.user_id ?? "").trim();
      if (!requestedUserId) {
        return fail(400, "missing_user_id", "user_id is required for service sync");
      }
      user = { id: requestedUserId };
      supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
    } else {
      const { data: { user: authUser }, error: userError } = await supabase.auth.getUser(userJwt);
      if (userError || !authUser) {
        return fail(401, "unauthorized", "Unauthorized");
      }
      userClaimsCandidate = authUser;
      user = authUser;
    }

    const hasProAccess = await userHasProAccessWithFallback(
      adminClient,
      user.id,
      userClaimsCandidate,
    );
    if (!hasProAccess) {
      return fail(403, "pro_required", "Bank sync is Premium only.");
    }

    const loginIdentityId = String(body?.login_identity_id ?? "").trim();
    if (!loginIdentityId) {
      return fail(400, "missing_login_identity_id", "login_identity_id is required");
    }
    telemetryUserId = user.id;
    telemetryProviderRef = loginIdentityId;

    stage = "connection_lookup";
    logStage(stage, "begin", { user_id: user.id, login_identity_id: loginIdentityId });
    const { data: connection, error: connectionErr } = await supabase
      .from("finverse_connections")
      .select("login_identity_id,institution_id,access_token,status")
      .eq("user_id", user.id)
      .eq("login_identity_id", loginIdentityId)
      .maybeSingle();

    if (connectionErr) {
      console.error("finverse connection lookup failed:", connectionErr);
      return fail(500, "connection_lookup_failed", "connection_lookup_failed");
    }
    if (!connection) {
      return fail(403, "forbidden_login_identity", "forbidden_login_identity");
    }

    const accessToken = String(connection.access_token ?? "").trim();
    if (!accessToken) {
      return fail(400, "missing_access_token", "missing_access_token");
    }

    stage = "item_upsert";
    const { error: itemUpsertErr } = await supabase
      .from("plaid_items")
      .upsert(
        {
          user_id: user.id,
          item_id: loginIdentityId,
          access_token: accessToken,
          provider: "finverse",
        },
        { onConflict: "user_id,item_id" },
      );
    if (itemUpsertErr) {
      console.error("plaid_items upsert failed:", itemUpsertErr);
      return fail(500, "item_upsert_failed", "item_upsert_failed");
    }

    stage = "fetch_accounts";
    await writeSyncEvent(adminClient, {
      userId: user.id,
      eventName: "sync_started",
      providerRef: loginIdentityId,
    });
    syncStartedLogged = true;
    logStage(stage, "begin", { login_identity_id: loginIdentityId });
    const accountsPayload = await getJson(`${FINVERSE_BASE_URL}/accounts`, accessToken);
    const accounts: any[] = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
    logStage(stage, "done", { accounts_count: accounts.length });

    let accountsUpserted = 0;
    let accountUpsertFailures = 0;
    let accountsSkippedUnsupportedCurrency = 0;
    let txnsAdded = 0;
    let txnsModified = 0;
    let txnsRemoved = 0;
    let transactionsSkippedMissingOrUnmappedAccount = 0;
    let transactionsSkippedUnsupportedCurrency = 0;
    let accountsRebound = 0;

    const accountSubtypeById = new Map<string, string | null>();
    const accountInstitutionById = new Map<string, string | null>();
    const accountCurrencyById = new Map<string, string | null>();
    const accountIdSet = new Set<string>();
    const canonicalAccountIdByRemoteId = new Map<string, string>();

    stage = "accounts_upsert";
    for (const account of accounts) {
      try {
        const remoteAccountId = String(account?.account_id ?? "").trim();
        if (!remoteAccountId) continue;

        const currency = normalizeCurrencyCodeOrUsd(account?.account_currency);
        if (!isSupportedBankCurrencyCode(currency)) {
          accountsSkippedUnsupportedCurrency += 1;
          logStage(stage, "skip_unsupported_currency", {
            account_id: remoteAccountId,
            currency,
          });
          continue;
        }

        const subtype = toLower(account?.account_type?.subtype);
        const type = toLower(account?.account_type?.type) || "depository";
        const institutionId =
          String(account?.institution?.institution_id ?? connection.institution_id ?? "").trim() || null;
        const balanceValue = toNumber(account?.balance?.value, 0);
        const mask = getMaskedLast4(account?.account_number_masked);
        const canonicalExisting = await findCanonicalFinverseAccount(supabase, {
          userId: user.id,
          loginIdentityId,
          incomingAccountId: remoteAccountId,
          institutionId,
          mask,
          subtype,
        });
        const canonicalAccountId = String(canonicalExisting?.account_id ?? remoteAccountId).trim() || remoteAccountId;

        const accountRow = {
          user_id: user.id,
          item_id: loginIdentityId,
          account_id: canonicalAccountId,
          name: String(account?.account_name ?? "Account"),
          official_name: null,
          type,
          subtype,
          mask,
          currency,
          institution_id: institutionId,
          provider: "finverse",
          balances: {
            available: balanceValue,
            current: balanceValue,
            limit: null,
            iso_currency_code: currency,
            unofficial_currency_code: null,
          },
        };

        const accountWriteError = canonicalExisting?.id
          ? (await supabase
              .from("accounts")
              .update(accountRow)
              .eq("id", canonicalExisting.id)
              .eq("user_id", user.id)).error
          : (await supabase
              .from("accounts")
              .upsert(accountRow, { onConflict: "user_id,item_id,account_id" })).error;
        if (accountWriteError) {
          console.error(`accounts upsert failed account_id=${remoteAccountId}:`, accountWriteError);
          accountUpsertFailures += 1;
          continue;
        }
        if (canonicalExisting?.id && (
            canonicalExisting.item_id !== loginIdentityId ||
            String(canonicalExisting.account_id ?? "").trim() !== canonicalAccountId
          )) {
          accountsRebound += 1;
          logStage(stage, "rebound_existing_account", {
            remote_account_id: remoteAccountId,
            canonical_account_id: canonicalAccountId,
            previous_item_id: canonicalExisting.item_id,
            next_item_id: loginIdentityId,
          });
        }
        canonicalAccountIdByRemoteId.set(remoteAccountId, canonicalAccountId);
        accountIdSet.add(canonicalAccountId);
        accountSubtypeById.set(canonicalAccountId, subtype);
        accountInstitutionById.set(canonicalAccountId, institutionId);
        accountCurrencyById.set(canonicalAccountId, currency);
        accountsUpserted += 1;
      } catch (accountError) {
        console.error("account processing error:", accountError);
        accountUpsertFailures += 1;
        continue;
      }
    }
    logStage(stage, "done", {
      accounts_upserted: accountsUpserted,
      account_upsert_failures: accountUpsertFailures,
      accounts_skipped_unsupported_currency: accountsSkippedUnsupportedCurrency,
      accounts_rebound: accountsRebound,
    });

    const limit = 1000;
    let offset = 0;
    let totalTransactions = Number.MAX_SAFE_INTEGER;
    const allTransactions: any[] = [];

    stage = "fetch_transactions";
    logStage(stage, "begin", { page_size: limit });
    while (offset < totalTransactions) {
      const txPayload = await getJson(
        `${FINVERSE_BASE_URL}/transactions?limit=${limit}&offset=${offset}`,
        accessToken,
      );
      const txPage: any[] = Array.isArray(txPayload?.transactions) ? txPayload.transactions : [];
      const totalFromPayload = toNumber(txPayload?.total_transactions, txPage.length);
      totalTransactions = Math.max(totalFromPayload, txPage.length);

      allTransactions.push(...txPage);
      if (txPage.length < limit) break;
      offset += limit;
    }
    logStage(stage, "done", { total_transactions_fetched: allTransactions.length });

    const txnRows: Record<string, unknown>[] = [];
    const queueRows: Record<string, unknown>[] = [];
    const noiseCategoryRows: Record<string, unknown>[] = [];

    for (const tx of allTransactions) {
      const remoteAccountId = String(tx?.account_id ?? "").trim();
      const accountId = canonicalAccountIdByRemoteId.get(remoteAccountId);
      if (!accountId) {
        transactionsSkippedMissingOrUnmappedAccount += 1;
        continue;
      }

      const providerTxnId = String(tx?.transaction_id ?? "").trim();
      if (!providerTxnId) continue;
      const txnId = `fv_${providerTxnId}`;

      const amountValue = toNumber(tx?.amount?.value, 0);
      const amountCents = Math.round(amountValue * 100);
      const postedDate = toDate(tx?.posted_date) || toDate(tx?.transaction_date);
      if (!postedDate) continue;

      const authorizedDate = toDate(tx?.transaction_date);
      const description = String(tx?.description ?? "").trim() || "Transaction";
      const merchantName = String(tx?.transaction_details?.counterparty_name ?? "").trim() || null;
      const currency =
        normalizeCurrencyCodeOrUsd(tx?.amount?.currency ?? accountCurrencyById.get(accountId));
      if (!isSupportedBankCurrencyCode(currency)) {
        transactionsSkippedUnsupportedCurrency += 1;
        continue;
      }
      const bankCode = String(tx?.transaction_details?.bank_transaction_code ?? "").trim() || null;
      const pending = Boolean(tx?.is_pending);
      const subtype = accountSubtypeById.get(accountId) ?? null;
      const merchantRaw = (merchantName || description).trim();
      const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : null;

      txnRows.push({
        user_id: user.id,
        item_id: loginIdentityId,
        account_id: accountId,
        txn_id: txnId,
        txn_date: postedDate,
        authorized_date: authorizedDate,
        name: description,
        amount: amountValue,
        currency,
        merchant: merchantName,
        merchant_name: merchantName,
        category: bankCode,
        pending,
        raw: tx,
        provider: "finverse",
        is_removed: false,
        removed_at: null,
      });

      if (merchantNormalized && isStatementNoiseMerchant(merchantNormalized)) {
        noiseCategoryRows.push({
          user_id: user.id,
          txn_id: txnId,
          category_model: UNCATEGORIZED_KEY,
          category_confidence: 1.0,
          merchant_normalized: STATEMENT_NOISE_SENTINEL,
          is_suggested: false,
          updated_at: new Date().toISOString(),
        });
      } else {
        queueRows.push({
          user_id: user.id,
          txn_id: txnId,
          provider: "finverse",
          merchant_raw: merchantRaw || null,
          merchant_normalized: merchantNormalized,
          amount_cents: amountCents,
          account_subtype: subtype,
          status: "pending",
        });
      }
    }

    const txnIds = txnRows.map((r) => String(r.txn_id)).filter(Boolean);
    const existingOwned = new Set<string>();
    for (const ids of chunk(txnIds, 500)) {
      const { data, error } = await supabase
        .from("transactions")
        .select("txn_id")
        .eq("user_id", user.id)
        .in("txn_id", ids);
      if (error) {
        console.error("existing transactions lookup failed:", error);
        continue;
      }
      for (const row of data ?? []) {
        existingOwned.add(String((row as any).txn_id));
      }
    }

    for (const txnId of txnIds) {
      if (existingOwned.has(txnId)) txnsModified += 1;
      else txnsAdded += 1;
    }

    stage = "transactions_upsert";
    for (const rows of chunk(txnRows, 100)) {
      const { error } = await supabase
        .from("transactions")
        .upsert(rows, { onConflict: "user_id,txn_id" });
      if (error) {
        console.error("transactions upsert batch failed:", error);
      }
    }
    logStage(stage, "done", {
      txns_added: txnsAdded,
      txns_modified: txnsModified,
      txn_rows: txnRows.length,
      tx_skipped_missing_or_unmapped_account: transactionsSkippedMissingOrUnmappedAccount,
      tx_skipped_unsupported_currency: transactionsSkippedUnsupportedCurrency,
    });

    stage = "queue_upsert";
    for (const rows of chunk(queueRows, 200)) {
      const { error } = await supabase
        .from("ai_categorization_queue")
        .upsert(rows, {
          onConflict: "user_id,txn_id,provider",
          ignoreDuplicates: true,
        });
      if (error) {
        console.error("ai queue upsert batch failed:", error);
      }
    }
    logStage(stage, "done", { queue_rows: queueRows.length });

    let aiKickStarted = false;
    stage = "ai_kick";
    if (queueRows.length > 0) {
      if (serviceRoleKey) {
        aiKickStarted = true;
        const aiKickResponse = await fetch(`${supabaseUrl}/functions/v1/ai-categorize-batch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({
            user_id: user.id,
            limit: 150,
            source: "finverse-sync-accounts",
          }),
        });
        if (!aiKickResponse.ok) {
          const body = await aiKickResponse.text().catch(() => "");
          console.error("finverse ai categorization kick failed:", aiKickResponse.status, body);
        }
      } else {
        console.error("finverse ai categorization kick skipped: missing service role key");
      }
    }

    stage = "noise_upsert";
    for (const rows of chunk(noiseCategoryRows, 200)) {
      const { error } = await supabase
        .from("txn_categorization")
        .upsert(rows, { onConflict: "user_id,txn_id" });
      if (error) {
        console.error("noise uncategorized upsert batch failed:", error);
      }
    }
    logStage(stage, "done", { noise_rows: noiseCategoryRows.length });

    stage = "connection_status_update";
    const { error: statusErr } = await supabase
      .from("finverse_connections")
      .update({
        status: "DATA_RETRIEVAL_COMPLETE",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("login_identity_id", loginIdentityId);
    if (statusErr) {
      console.error("finverse connection status update failed:", statusErr);
    }

    stage = "completed";
    const durationMs = Date.now() - startedAt;
    logStage(stage, "success", {
      user_id: user.id,
      login_identity_id: loginIdentityId,
      duration_ms: durationMs,
      accounts_upserted: accountsUpserted,
      txns_added: txnsAdded,
      txns_modified: txnsModified,
      tx_skipped_missing_or_unmapped_account: transactionsSkippedMissingOrUnmappedAccount,
      tx_skipped_unsupported_currency: transactionsSkippedUnsupportedCurrency,
      queue_rows: queueRows.length,
      accounts_rebound: accountsRebound,
      ai_kick_started: aiKickStarted,
    });
    await writeSyncEvent(adminClient, {
      userId: user.id,
      eventName: "sync_success",
      latencyMs: durationMs,
      providerRef: loginIdentityId,
    });

    return json(200, {
      ok: true,
      env: "finverse",
      stage,
      duration_ms: durationMs,
      accounts_upserted: accountsUpserted,
      account_upsert_failures: accountUpsertFailures,
      accounts_rebound: accountsRebound,
      txns_added: txnsAdded,
      txns_modified: txnsModified,
      txns_removed: txnsRemoved,
      txns_skipped_missing_or_unmapped_account: transactionsSkippedMissingOrUnmappedAccount,
      txns_skipped_unsupported_currency: transactionsSkippedUnsupportedCurrency,
      ai_queue_rows: queueRows.length,
      ai_kick_started: aiKickStarted,
    });
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const rawMessage = String(error?.message || "Internal server error");
    let status = 500;
    let errorCode = "internal_error";

    if (rawMessage.startsWith("finverse_get_failed:")) {
      const parts = rawMessage.split(":");
      const providerStatus = Number(parts[1] ?? "");
      if (Number.isFinite(providerStatus)) {
        status = 502;
        errorCode = `finverse_provider_http_${providerStatus}`;
      } else {
        errorCode = "finverse_provider_fetch_failed";
      }
    }

    console.error("finverse-sync-accounts error:", {
      stage,
      duration_ms: durationMs,
      message: rawMessage,
      error_code: errorCode,
    });
    if (syncStartedLogged && adminClient && telemetryUserId) {
      await writeSyncEvent(adminClient, {
        userId: telemetryUserId,
        eventName: "sync_failed",
        latencyMs: durationMs,
        providerRef: telemetryProviderRef,
        errorCode,
        errorMessage: rawMessage,
      });
    }

    return fail(status, errorCode, rawMessage, { duration_ms: durationMs });
  }
});


