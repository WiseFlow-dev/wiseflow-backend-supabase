// ============================================
// TrueLayer: Sync Accounts & Transactions
// Reads TrueLayer token from DB, syncs accounts/transactions,
// and queues synced transactions for AI categorization.
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { normalizeMerchant } from "../_shared/normalize.ts";

const TRUELAYER_DATA_URL = "https://api.truelayer-sandbox.com/data/v1";
const TRUELAYER_AUTH_URL = "https://auth.truelayer-sandbox.com";
const FRANKFURTER_API_BASE = "https://api.frankfurter.dev/v2/rate";
const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

type FxResolved = {
  rate: number;
  rateDate: string;
  provider: string;
};
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

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractTransactions(payload: any): any[] {
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeCurrencyCode(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return CURRENCY_CODE_RE.test(value) ? value : null;
}

function normalizeCurrencyCodeOrUsd(raw: unknown): string {
  return normalizeCurrencyCode(raw) ?? "USD";
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

function stableHashHex(seed: string): string {
  const hash = Array.from(seed).reduce(
    (h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0,
    0
  );
  return (hash >>> 0).toString(16);
}

function chunkStrings(values: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

async function resolveUserMainCurrencyCode(
  adminClient: any,
  userId: string
): Promise<string> {
  const { data, error } = await adminClient
    .from("user_preferences")
    .select("currency")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(`Failed to resolve main currency for user ${userId}, defaulting to USD:`, error.message);
    return "USD";
  }

  return normalizeCurrencyCode((data as { currency?: unknown } | null)?.currency) ?? "USD";
}

async function resolveFxRateForDate(
  adminClient: any,
  baseCurrency: string,
  quoteCurrency: string,
  requestedDate: string,
  fxCache: Map<string, FxResolved | null>
): Promise<FxResolved | null> {
  if (baseCurrency === quoteCurrency) {
    return {
      rate: 1,
      rateDate: requestedDate,
      provider: "identity",
    };
  }

  const cacheKey = `${baseCurrency}|${quoteCurrency}|${requestedDate}`;
  if (fxCache.has(cacheKey)) {
    return fxCache.get(cacheKey) ?? null;
  }

  const { data: cached, error: cacheErr } = await adminClient
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
        provider: parseCurrencyProvider(cached?.provider),
      };
      fxCache.set(cacheKey, resolved);
      return resolved;
    }
  } else {
    console.warn(`FX cache lookup failed for ${cacheKey}:`, cacheErr.message);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9000);
  try {
    const url =
      `${FRANKFURTER_API_BASE}/${encodeURIComponent(baseCurrency)}/${encodeURIComponent(quoteCurrency)}?date=${encodeURIComponent(requestedDate)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
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

    await adminClient
      .from("fx_rate_cache")
      .upsert(
        {
          base: baseCurrency,
          quote: quoteCurrency,
          requested_date: requestedDate,
          rate_date: rateDate,
          rate,
          provider: "frankfurter",
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "base,quote,requested_date" }
      );

    const resolved: FxResolved = {
      rate,
      rateDate,
      provider: "frankfurter",
    };
    fxCache.set(cacheKey, resolved);
    return resolved;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`FX fetch failed for ${cacheKey}:`, reason);
    fxCache.set(cacheKey, null);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    const body = await req.json().catch(() => ({}));
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json({ error: "Supabase environment not configured" }, 500);
    }

    // 1) Resolve caller from JWT.
    // Supports either:
    // - normal user JWT (legacy behavior)
    // - service-role JWT for internal smoke/webhook calls (requires body.user_id)
    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) {
      return json({ error: "Unauthorized", details: "missing_bearer_token" }, 401);
    }
    const jwtRole = decodeJwtRole(bearerToken);
    const isServiceRole = jwtRole === "service_role";

    let user: { id: string } | null = null;
    let userClaimsCandidate: any = null;
    if (isServiceRole) {
      const userId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
      if (!userId) {
        return json({ error: "Unauthorized", details: "user_id_required_for_service_role" }, 401);
      }
      user = { id: userId };
    } else {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: false },
      });
      const {
        data: { user: resolvedUser },
        error: userError,
      } = await userClient.auth.getUser(bearerToken);
      if (userError || !resolvedUser) {
        return json({ error: "Unauthorized", details: userError?.message ?? "invalid_jwt" }, 401);
      }
      userClaimsCandidate = resolvedUser;
      user = { id: resolvedUser.id };
    }

    // 2) Read access token from truelayer_connections via service role
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const hasProAccess = await userHasProAccessWithFallback(
      adminClient,
      user.id,
      userClaimsCandidate,
    );
    if (!hasProAccess) {
      return json({ error: "pro_required", message: "Bank sync is Premium only." }, 403);
    }
    const { data: connection, error: connError } = await adminClient
      .from("truelayer_connections")
      .select("id, access_token, refresh_token, token_expires_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (connError) {
      console.error("Failed reading truelayer_connections:", connError);
      return json({ error: "failed_to_read_connection" }, 500);
    }
    if (!connection?.access_token) {
      return json({ ok: false, error: "missing_connection" }, 400);
    }

    // 3) Token expiry check — Fix B: attempt refresh before giving up.
    let accessToken = connection.access_token;
    if (connection.token_expires_at) {
      const expiresAtMs = Date.parse(connection.token_expires_at);
      const refreshWindowMs = 5 * 60 * 1000; // refresh slightly before hard expiry
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now() + refreshWindowMs) {
        const refreshToken = connection.refresh_token as string | null;
        const tlClientId = Deno.env.get("TRUELAYER_CLIENT_ID");
        const tlClientSecret = Deno.env.get("TRUELAYER_CLIENT_SECRET");
        const markConnectionExpired = async () => {
          await adminClient
            .from("truelayer_connections")
            .update({
              status: "expired",
              updated_at: new Date().toISOString(),
            })
            .eq("id", connection.id);
        };

        if (refreshToken && tlClientId && tlClientSecret) {
          console.log(`TrueLayer token expired for user ${user.id} — attempting refresh`);
          try {
            const refreshRes = await fetch(`${TRUELAYER_AUTH_URL}/connect/token`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: tlClientId,
                client_secret: tlClientSecret,
                refresh_token: refreshToken,
              }),
            });

            if (refreshRes.ok) {
              const refreshData = await refreshRes.json();
              const newAccessToken = refreshData.access_token as string | undefined;
              const newRefreshToken = (refreshData.refresh_token as string | undefined) ?? refreshToken;
              const expiresInSec = Number(refreshData.expires_in ?? 3600);
              const newExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

              if (newAccessToken) {
                const { error: updateErr } = await adminClient
                  .from("truelayer_connections")
                  .update({
                    access_token: newAccessToken,
                    refresh_token: newRefreshToken,
                    token_expires_at: newExpiresAt,
                    status: "active",
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", connection.id);

                if (updateErr) {
                  console.error("Failed persisting refreshed TrueLayer tokens:", updateErr);
                  return json({ ok: false, error: "token_expired" }, 200);
                }

                accessToken = newAccessToken;
                console.log(`TrueLayer token refreshed successfully for user ${user.id}`);
              } else {
                console.warn("TrueLayer refresh response missing access_token");
                return json({ ok: false, error: "token_expired" }, 200);
              }
            } else {
              const details = await refreshRes.text();
              console.warn(`TrueLayer token refresh failed (${refreshRes.status}):`, details);
              const lower = details.toLowerCase();
              if (
                refreshRes.status === 400 ||
                refreshRes.status === 401 ||
                lower.includes("invalid_grant") ||
                lower.includes("invalid_token")
              ) {
                await markConnectionExpired();
              }
              return json({ ok: false, error: "token_expired" }, 200);
            }
          } catch (refreshErr) {
            const reason = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            console.error("TrueLayer token refresh threw:", reason);
            return json({ ok: false, error: "token_expired" }, 200);
          }
        } else {
          // No refresh token available — fall through to token_expired.
          await markConnectionExpired();
          return json({ ok: false, error: "token_expired" }, 200);
        }
      }
    }
    const itemId = String(connection.id); // accounts.item_id is TEXT
    const today = new Date().toISOString().split("T")[0];
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    let accounts_count = 0;
    let transactions_count = 0;
    let transactions_seen = 0;
    let transactions_mapped = 0;
    let transactions_removed = 0;
    const mainCurrencyCode = await resolveUserMainCurrencyCode(adminClient, user.id);
    const fxCache = new Map<string, FxResolved | null>();

    // 4) Fetch accounts from TrueLayer
    const accountsResponse = await fetch(`${TRUELAYER_DATA_URL}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!accountsResponse.ok) {
      const details = await accountsResponse.text();
      console.error("Failed to fetch TrueLayer accounts:", details);
      return json({ error: "failed_to_fetch_accounts", details }, 502);
    }
    const accountsData = await accountsResponse.json();
    const accounts = Array.isArray(accountsData?.results) ? accountsData.results : [];

    // 5) Upsert accounts table rows (real schema columns)
    for (const account of accounts) {
      const accountId = String(account?.account_id ?? "");
      if (!accountId) continue;

      let balanceCurrent: number | null = null;
      let balanceAvailable: number | null = null;
      let currency = String(account?.currency ?? "USD");

      const balanceRes = await fetch(
        `${TRUELAYER_DATA_URL}/accounts/${accountId}/balance`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (balanceRes.ok) {
        const balanceData = await balanceRes.json();
        const firstBalance = Array.isArray(balanceData?.results) ? balanceData.results[0] : null;
        if (firstBalance) {
          const currentVal = Number(firstBalance.current ?? firstBalance.available ?? 0);
          const availableVal = Number(firstBalance.available ?? firstBalance.current ?? 0);
          balanceCurrent = Number.isFinite(currentVal) ? currentVal : null;
          balanceAvailable = Number.isFinite(availableVal) ? availableVal : null;
          if (firstBalance.currency) currency = String(firstBalance.currency);
        }
      }

      const accountRow = {
        user_id: user.id,
        item_id: itemId,
        account_id: accountId,
        name: String(account?.display_name ?? account?.account_number?.number ?? "Bank Account"),
        official_name: String(account?.display_name ?? account?.account_number?.number ?? "Bank Account"),
        balances: {
          available: balanceAvailable,
          current: balanceCurrent,
          iso_currency_code: currency,
        },
        currency,
        institution_id: String(account?.provider?.provider_id ?? "truelayer"),
        provider: "truelayer",
      };

      const { error: upsertAccountError } = await adminClient
        .from("accounts")
        .upsert(accountRow, { onConflict: "user_id,item_id,account_id" });
      if (upsertAccountError) {
        console.error("Failed to upsert account:", upsertAccountError, accountRow);
        continue;
      }
      accounts_count += 1;

      // 6) Fetch transactions for account.
      // Some TrueLayer sandbox providers return empty for one query shape/date range,
      // so we try a narrow window first, then broader fallbacks.
      const txnCandidates = [
        `${TRUELAYER_DATA_URL}/accounts/${accountId}/transactions?from=${ninetyDaysAgo}&to=${today}`,
        `${TRUELAYER_DATA_URL}/accounts/${accountId}/transactions?from=2020-01-01&to=${today}`,
        `${TRUELAYER_DATA_URL}/accounts/${accountId}/transactions`,
      ];

      let txns: any[] = [];
      let txnFetchSucceeded = false;
      for (const txnUrl of txnCandidates) {
        const txnResponse = await fetch(txnUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!txnResponse.ok) {
          const details = await txnResponse.text();
          console.error(`Failed to fetch transactions for account ${accountId}:`, details);
          continue;
        }
        txnFetchSucceeded = true;
        const txnData = await txnResponse.json();
        const extracted = extractTransactions(txnData);
        if (extracted.length > 0) {
          txns = extracted;
          break;
        }
      }
      transactions_seen += txns.length;
      if (!txnFetchSucceeded) continue;

      // keyMap tracks how many times a given stable key appears in this batch (Fix 8).
      // Two identical purchases at the same merchant on the same day (same amount) would
      // otherwise produce the same hash and collapse into one row. The counter appended
      // to fullKey makes each occurrence unique while keeping re-syncs idempotent.
      const keyMap = new Map<string, number>();
      const txnRows: Record<string, unknown>[] = [];
      const stableKeyByTxnId = new Map<string, string>();
      let unresolvedFxCount = 0;
      for (const t of txns) {
        const amountNum = Number(t?.amount ?? 0);
        const amount = Number.isFinite(amountNum) ? amountNum : 0;
        const txnDateRaw = String(t?.timestamp ?? t?.booking_date ?? t?.date ?? "");
        const txnDate = txnDateRaw ? txnDateRaw.slice(0, 10) : today;
        const merchant = String(t?.merchant_name ?? "");
        const name = String(t?.description ?? merchant ?? "Transaction");
        const merchantName = merchant || null;

        // Generate a stable txn_id from logical identity (account + date + name + amount).
        // Append a sequence counter for same-key transactions within this sync batch
        // so two identical transactions on the same day get distinct IDs.
        const stableKey = `${accountId}:${txnDate}:${name}:${Math.round(amount * 100)}`;
        const count = keyMap.get(stableKey) ?? 0;
        keyMap.set(stableKey, count + 1);
        const fullKey = count > 0 ? `${stableKey}:${count}` : stableKey;
        const stableHash = stableHashHex(fullKey);
        // Use unsigned hex from the stable identity key.
        const txnId = `tl_${stableHash}`;
        stableKeyByTxnId.set(txnId, fullKey);

        const sourceCurrency = normalizeCurrencyCodeOrUsd(t?.currency ?? currency ?? "USD");
        const requestedDate = normalizeRequestedDate(txnDate);
        const nowIso = new Date().toISOString();
        const fxResolved = await resolveFxRateForDate(
          adminClient,
          sourceCurrency,
          mainCurrencyCode,
          requestedDate,
          fxCache
        );
        if (!fxResolved) {
          unresolvedFxCount += 1;
        }

        txnRows.push({
          txn_id: txnId,
          account_id: accountId,
          txn_date: txnDate,
          name,
          amount,
          currency: sourceCurrency,
          merchant: merchantName,
          merchant_name: merchantName,
          category: String(t?.transaction_type ?? ""),
          pending: false,
          raw: t,
          item_id: itemId,
          user_id: user.id,
          provider: "truelayer",
          reporting_amount: fxResolved ? Number((amount * fxResolved.rate).toFixed(6)) : null,
          reporting_currency: fxResolved ? mainCurrencyCode : null,
          fx_rate_used: fxResolved ? fxResolved.rate : null,
          fx_requested_date: fxResolved ? requestedDate : null,
          fx_rate_date: fxResolved ? fxResolved.rateDate : null,
          fx_provider: fxResolved ? fxResolved.provider : null,
          reporting_version: 1,
          normalized_at: fxResolved ? nowIso : null,
          is_removed: false,
          removed_at: null,
        });
      }
      if (unresolvedFxCount > 0) {
        console.warn(
          `FX unresolved for ${unresolvedFxCount}/${txns.length} truelayer txn(s) account=${accountId}`
        );
      }
      transactions_mapped += txnRows.length;

      if (txnRows.length > 0) {
        // Protect against cross-user txn_id collisions.
        // If a generated txn_id already belongs to another user, re-key it
        // deterministically with user.id so one user's sync never overwrites
        // another user's rows.
        const txnIds = txnRows.map((r) => String(r.txn_id));
        const { data: existingTxns, error: existingErr } = await adminClient
          .from("transactions")
          .select("txn_id,user_id")
          .in("txn_id", txnIds);
        if (existingErr) {
          console.error("Failed reading existing txn ownership:", existingErr);
        } else {
          const ownerByTxnId = new Map(
            (existingTxns || []).map((r: any) => [
              String(r.txn_id),
              String(r.user_id ?? ""),
            ])
          );
          const usedTxnIds = new Set<string>();
          const userIdSlug = user.id.replace(/-/g, "");
          for (const row of txnRows) {
            const currentTxnId = String(row.txn_id);
            const ownerUserId = ownerByTxnId.get(currentTxnId);
            if (ownerUserId && ownerUserId !== user.id) {
              const fullKey = stableKeyByTxnId.get(currentTxnId) ?? currentTxnId;
              let attempt = 0;
              let candidate = `tl_${userIdSlug}_${stableHashHex(fullKey)}`;
              while (
                usedTxnIds.has(candidate) ||
                ((ownerByTxnId.get(candidate) ?? "") !== "" &&
                  ownerByTxnId.get(candidate) !== user.id)
              ) {
                attempt += 1;
                candidate = `tl_${userIdSlug}_${stableHashHex(`${fullKey}:${attempt}`)}`;
              }
              row.txn_id = candidate;
            }
            usedTxnIds.add(String(row.txn_id));
          }
        }

        const { error: upsertTxnError } = await adminClient
          .from("transactions")
          .upsert(txnRows, { onConflict: "txn_id" });
        if (upsertTxnError) {
          console.error("Failed to upsert transactions:", upsertTxnError);
          continue;
        }

        transactions_count += txnRows.length;
      }

      // Fix A: Stale transaction reconciliation.
      // Any txn previously active for this account that was NOT returned by TrueLayer
      // in this sync is soft-deleted (is_removed = true). This handles TrueLayer returning
      // fewer transactions on re-sync (e.g. sandbox reset, transaction history truncation).
      const seenTxnIds = new Set(txnRows.map((r) => String(r.txn_id)));
      const { data: existingActiveTxns, error: existingActiveErr } = await adminClient
        .from("transactions")
        .select("txn_id")
        .eq("user_id", user.id)
        .eq("item_id", itemId)
        .eq("account_id", accountId)
        .eq("provider", "truelayer")
        .eq("is_removed", false);
      if (existingActiveErr) {
        console.warn(`Fix A: failed to query existing active txns for account ${accountId}:`, existingActiveErr.message);
      } else {
        const toRemove = (existingActiveTxns ?? [])
          .map((r: any) => String(r.txn_id))
          .filter((id: string) => !seenTxnIds.has(id));
        if (toRemove.length > 0) {
          console.log(`Fix A: soft-deleting ${toRemove.length} stale txn(s) for account ${accountId}`);
          for (const chunk of chunkStrings(toRemove, 200)) {
            const { error: removeErr } = await adminClient
              .from("transactions")
              .update({ is_removed: true, removed_at: new Date().toISOString() })
              .eq("user_id", user.id)
              .eq("item_id", itemId)
              .in("txn_id", chunk);
            if (removeErr) {
              console.error(`Fix A: failed to soft-delete stale txns for account ${accountId}:`, removeErr.message);
            } else {
              transactions_removed += chunk.length;
            }
          }
        }
      }

      // 7) Queue AI categorization for synced transactions.
      // Queue dedupe is enforced by ai_categorization_queue unique key
      // (user_id, txn_id, provider), so this safely backfills older rows that
      // were imported but never queued.
      const queueRows = txnRows
        .map((row) => {
          const merchantRaw = String(row.merchant_name ?? row.name ?? "").trim() || null;
          const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : null;
          const amount = Number(row.amount ?? 0);
          const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : null;
          // Keep TrueLayer's original sign convention in the queue (negative = expense).
          // The ai-categorize-batch function uses providerIsMoneyIn() to handle this correctly.

          return {
            user_id: user.id,
            txn_id: String(row.txn_id),
            provider: "truelayer",
            merchant_raw: merchantRaw,
            merchant_normalized: merchantNormalized,
            amount_cents: amountCents,
            account_subtype: null,
            status: "pending",
          };
        });

      if (queueRows.length > 0) {
        // Safety net: rows can occasionally fail for transient AI reasons.
        // Requeue only FAILED rows for the current sync set so users recover
        // automatically on next sync without touching DONE rows.
        const queueTxnIds = queueRows.map((r) => String(r.txn_id));
        for (const idsChunk of chunkStrings(queueTxnIds, 500)) {
          const { error: retryResetErr } = await adminClient
            .from("ai_categorization_queue")
            .update({
              status: "pending",
              claimed_at: null,
              processed_at: null,
            })
            .eq("user_id", user.id)
            .eq("provider", "truelayer")
            .eq("status", "failed")
            .in("txn_id", idsChunk);
          if (retryResetErr) {
            console.error("Failed resetting failed AI queue rows:", retryResetErr);
          }
        }

        const { error: queueError } = await adminClient
          .from("ai_categorization_queue")
          .upsert(queueRows, {
            onConflict: "user_id,txn_id,provider",
            ignoreDuplicates: true,
          });
        if (queueError) {
          console.error("Failed to enqueue AI categorization:", queueError);
        }

        // Fire-and-forget: kick off AI categorization immediately server-side
        const batchUrl = `${supabaseUrl}/functions/v1/ai-categorize-batch`;
        fetch(batchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${supabaseServiceRoleKey}`,
          },
          body: JSON.stringify({ user_id: user.id, limit: 50 }),
        }).catch(() => {}); // intentionally fire-and-forget, ignore errors
      }
    }

    return json({
      ok: true,
      accounts_upserted: accounts_count,
      txns_added: transactions_count,
      txns_seen: transactions_seen,
      txns_mapped: transactions_mapped,
      txns_modified: 0,
      txns_removed: transactions_removed,
    });
  } catch (error) {
    console.error("Error in truelayer-sync-accounts:", error);
    return json({ error: error.message || "Internal server error" }, 500);
  }
});


