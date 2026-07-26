// ============================================
// GoCardless: Sync Accounts & Transactions
// Writes unified accounts/transactions + AI queue
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const GOCARDLESS_API_URL = "https://bankaccountdata.gocardless.com/api/v2";
const JSON_HEADERS = { "Content-Type": "application/json" };
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

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultDateFrom(): string {
  const d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  return isoDay(d);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(digest);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseSignedAmount(txn: any): number {
  const raw = Number(txn?.transactionAmount?.amount ?? 0);
  const amount = Number.isFinite(raw) ? raw : 0;
  const absAmount = Math.abs(amount);
  const indicator = String(txn?.creditDebitIndicator ?? "").toUpperCase();

  // Keep GoCardless direction:
  // DBIT = money out (expense) => negative
  // CRDT = money in  (income)  => positive
  if (indicator === "DBIT") return -absAmount;
  if (indicator === "CRDT") return absAmount;
  return amount;
}

function normalizeDate(input: unknown, fallback: string): string {
  const s = typeof input === "string" ? input.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

async function buildTxnId(
  accountId: string,
  txn: any,
  fallbackDate: string,
  fallbackName: string,
  signedAmount: number,
  occurrence: number,
): Promise<string> {
  const transactionId = String(txn?.transactionId ?? "").trim();
  if (transactionId) return `gc_${accountId}_${transactionId}`;

  const internalId = String(txn?.internalTransactionId ?? "").trim();
  if (internalId) return `gc_${accountId}_${internalId}`;

  const txnDate = normalizeDate(txn?.bookingDate ?? txn?.valueDate, fallbackDate);
  const name = String(fallbackName || "Transaction").trim();
  const amountCents = Math.round(signedAmount * 100);
  const indicator = String(txn?.creditDebitIndicator ?? "").toUpperCase();
  const stableKey = `${accountId}|${txnDate}|${name}|${amountCents}|${indicator}|${occurrence}`;
  return `gc_${await sha256Hex(stableKey)}`;
}

serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { error: "Missing authorization header" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const secretId = Deno.env.get("GOCARDLESS_SECRET_ID");
    const secretKey = Deno.env.get("GOCARDLESS_SECRET_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(500, { error: "Supabase is not configured" });
    }
    if (!secretId || !secretKey) {
      return json(500, { error: "GoCardless credentials are not configured" });
    }

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return json(401, { error: "Unauthorized" });
    }
    if (!userHasProAccess(user)) {
      return json(403, { error: "pro_required", message: "Bank sync is Premium only." });
    }

    const body = await req.json().catch(() => ({}));
    const requisitionId = String(body?.requisition_id ?? "").trim();
    if (!requisitionId) {
      return json(400, { error: "requisition_id is required" });
    }

    const dateFrom = normalizeDate(body?.date_from, defaultDateFrom());
    const dateTo = normalizeDate(body?.date_to, isoDay(new Date()));
    const today = isoDay(new Date());

    const { data: reqOwnerRow, error: reqOwnerErr } = await supabaseClient
      .from("gocardless_requisitions")
      .select("requisition_id,institution_id,status")
      .eq("user_id", user.id)
      .eq("requisition_id", requisitionId)
      .maybeSingle();

    if (reqOwnerErr) {
      console.error("Ownership check failed:", reqOwnerErr);
      return json(500, { error: "ownership_check_failed" });
    }
    if (!reqOwnerRow) {
      return json(403, { error: "requisition_not_owned_by_user" });
    }

    // Ensure item ownership record exists for RLS insert-via-item policies.
    const { error: itemEnsureErr } = await supabaseClient
      .from("plaid_items")
      .upsert(
        {
          user_id: user.id,
          item_id: requisitionId,
          provider: "gocardless",
        },
        { onConflict: "user_id,item_id" },
      );
    if (itemEnsureErr) {
      console.error("Failed to ensure plaid_items row:", itemEnsureErr);
      return json(500, { error: "item_ownership_upsert_failed" });
    }

    const tokenResponse = await fetch(`${GOCARDLESS_API_URL}/token/new/`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
    });
    if (!tokenResponse.ok) {
      const details = await tokenResponse.text().catch(() => "");
      console.error("GoCardless token fetch failed:", details);
      return json(502, { error: "gocardless_token_failed", details });
    }
    const { access: accessToken } = await tokenResponse.json();

    const requisitionResponse = await fetch(
      `${GOCARDLESS_API_URL}/requisitions/${requisitionId}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!requisitionResponse.ok) {
      const details = await requisitionResponse.text().catch(() => "");
      console.error("Failed to fetch requisition:", details);
      return json(502, { error: "requisition_fetch_failed", details });
    }
    const requisition = await requisitionResponse.json();
    const accountIds: string[] = Array.isArray(requisition?.accounts)
      ? requisition.accounts.map((x: unknown) => String(x))
      : [];

    await supabaseClient
      .from("gocardless_requisitions")
      .update({
        status: requisition?.status ?? reqOwnerRow.status ?? null,
        institution_id: requisition?.institution_id ?? reqOwnerRow.institution_id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("requisition_id", requisitionId);

    if (accountIds.length === 0) {
      return json(200, {
        ok: true,
        env: "gocardless",
        accounts_upserted: 0,
        txns_added: 0,
        txns_modified: 0,
        txns_removed: 0,
        warning: "no_accounts",
      });
    }

    let accountsUpserted = 0;
    let txnsAdded = 0;
    let txnsModified = 0;
    let txnsRemoved = 0;

    for (const accountId of accountIds) {
      const accountResponse = await fetch(
        `${GOCARDLESS_API_URL}/accounts/${accountId}/details/`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!accountResponse.ok) {
        const details = await accountResponse.text().catch(() => "");
        console.error(`Account details failed for ${accountId}:`, details);
        continue;
      }
      const accountData = await accountResponse.json();
      const account = accountData?.account ?? {};

      const balanceResponse = await fetch(
        `${GOCARDLESS_API_URL}/accounts/${accountId}/balances/`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      let firstBalance: any = null;
      if (balanceResponse.ok) {
        const balanceData = await balanceResponse.json();
        firstBalance = balanceData?.balances?.[0] ?? null;
      }

      const currency =
        String(firstBalance?.balanceAmount?.currency || account?.currency || "EUR").toUpperCase();
      const currentBalanceRaw = Number(firstBalance?.balanceAmount?.amount ?? 0);
      const currentBalance = Number.isFinite(currentBalanceRaw) ? currentBalanceRaw : 0;
      const accountSubtype = String(account?.cashAccountType ?? "").toLowerCase() || null;

      const institutionId = String(
        requisition?.institution_id ?? reqOwnerRow.institution_id ?? "",
      ).trim() || null;

      const accountRow = {
        user_id: user.id,
        item_id: requisitionId,
        account_id: accountId,
        name: account?.name || account?.product || "Account",
        official_name: account?.ownerName || null,
        type: "depository",
        subtype: accountSubtype,
        mask: typeof account?.iban === "string" ? account.iban.slice(-4) : null,
        currency,
        institution_id: institutionId,
        provider: "gocardless",
        balances: {
          available: currentBalance,
          current: currentBalance,
          limit: null,
          iso_currency_code: currency,
          unofficial_currency_code: null,
        },
      };

      const { error: accountUpsertErr } = await supabaseClient
        .from("accounts")
        .upsert(accountRow, { onConflict: "user_id,item_id,account_id" });
      if (accountUpsertErr) {
        console.error(`Failed to upsert account ${accountId}:`, accountUpsertErr);
      } else {
        accountsUpserted += 1;
      }

      const txnResponse = await fetch(
        `${GOCARDLESS_API_URL}/accounts/${accountId}/transactions/?date_from=${dateFrom}&date_to=${dateTo}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!txnResponse.ok) {
        const details = await txnResponse.text().catch(() => "");
        console.error(`Transactions fetch failed for ${accountId}:`, details);
        continue;
      }
      const txnData = await txnResponse.json();
      const booked: any[] = Array.isArray(txnData?.transactions?.booked)
        ? txnData.transactions.booked
        : [];
      const pending: any[] = Array.isArray(txnData?.transactions?.pending)
        ? txnData.transactions.pending
        : [];

      const keyOccurrence = new Map<string, number>();
      const txRows: Record<string, unknown>[] = [];
      const queueRows: Record<string, unknown>[] = [];

      for (const tx of booked) {
        const txnDate = normalizeDate(tx?.bookingDate ?? tx?.valueDate, today);
        const signedAmount = parseSignedAmount(tx);
        const name =
          String(tx?.remittanceInformationUnstructured ?? tx?.creditorName ?? tx?.debtorName ?? "Transaction");
        const amountCents = Number.isFinite(signedAmount) ? Math.round(signedAmount * 100) : null;
        const occurrenceKey = `${accountId}|${txnDate}|${name}|${amountCents ?? 0}|${String(tx?.creditDebitIndicator ?? "").toUpperCase()}`;
        const occurrence = keyOccurrence.get(occurrenceKey) ?? 0;
        keyOccurrence.set(occurrenceKey, occurrence + 1);

        const txnId = await buildTxnId(accountId, tx, txnDate, name, signedAmount, occurrence);
        const merchantName = String(tx?.creditorName ?? tx?.debtorName ?? "").trim() || null;
        const merchantRaw = (merchantName || name || "").trim();
        const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : null;
        const categoryRaw = String(tx?.proprietaryBankTransactionCode ?? tx?.bankTransactionCode ?? "").trim();

        txRows.push({
          user_id: user.id,
          item_id: requisitionId,
          account_id: accountId,
          txn_id: txnId,
          txn_date: txnDate,
          authorized_date: null,
          name,
          amount: signedAmount,
          currency: String(tx?.transactionAmount?.currency ?? currency).toUpperCase(),
          merchant: merchantName,
          merchant_name: merchantName,
          category: categoryRaw || null,
          pending: false,
          raw: tx,
          provider: "gocardless",
          is_removed: false,
          removed_at: null,
        });

        queueRows.push({
          user_id: user.id,
          txn_id: txnId,
          provider: "gocardless",
          merchant_raw: merchantRaw || null,
          merchant_normalized: merchantNormalized,
          amount_cents: amountCents,
          account_subtype: accountSubtype,
          status: "pending",
        });
      }

      for (const tx of pending) {
        const txnDate = normalizeDate(tx?.valueDate ?? tx?.bookingDate, today);
        const signedAmount = parseSignedAmount(tx);
        const name =
          String(tx?.remittanceInformationUnstructured ?? tx?.creditorName ?? tx?.debtorName ?? "Transaction");
        const amountCents = Number.isFinite(signedAmount) ? Math.round(signedAmount * 100) : null;
        const occurrenceKey = `${accountId}|${txnDate}|${name}|${amountCents ?? 0}|${String(tx?.creditDebitIndicator ?? "").toUpperCase()}`;
        const occurrence = keyOccurrence.get(occurrenceKey) ?? 0;
        keyOccurrence.set(occurrenceKey, occurrence + 1);

        const txnId = await buildTxnId(accountId, tx, txnDate, name, signedAmount, occurrence);
        const merchantName = String(tx?.creditorName ?? tx?.debtorName ?? "").trim() || null;
        const merchantRaw = (merchantName || name || "").trim();
        const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : null;
        const categoryRaw = String(tx?.proprietaryBankTransactionCode ?? tx?.bankTransactionCode ?? "").trim();

        txRows.push({
          user_id: user.id,
          item_id: requisitionId,
          account_id: accountId,
          txn_id: txnId,
          txn_date: txnDate,
          authorized_date: null,
          name,
          amount: signedAmount,
          currency: String(tx?.transactionAmount?.currency ?? currency).toUpperCase(),
          merchant: merchantName,
          merchant_name: merchantName,
          category: categoryRaw || null,
          pending: true,
          raw: tx,
          provider: "gocardless",
          is_removed: false,
          removed_at: null,
        });

        queueRows.push({
          user_id: user.id,
          txn_id: txnId,
          provider: "gocardless",
          merchant_raw: merchantRaw || null,
          merchant_normalized: merchantNormalized,
          amount_cents: amountCents,
          account_subtype: accountSubtype,
          status: "pending",
        });
      }

      if (txRows.length > 0) {
        const txnIds = txRows.map((r) => String(r.txn_id)).filter(Boolean);
        const existingOwned = new Set<string>();

        for (const ids of chunk(txnIds, 500)) {
          const { data: existingRows, error: existingErr } = await supabaseClient
            .from("transactions")
            .select("txn_id")
            .eq("user_id", user.id)
            .in("txn_id", ids);
          if (existingErr) {
            console.error(`Failed reading existing txns for ${accountId}:`, existingErr);
            continue;
          }
          for (const row of existingRows ?? []) existingOwned.add(String(row.txn_id));
        }

        for (const id of txnIds) {
          if (existingOwned.has(id)) txnsModified += 1;
          else txnsAdded += 1;
        }

        for (const rows of chunk(txRows, 100)) {
          const { error: upsertErr } = await supabaseClient
            .from("transactions")
            .upsert(rows, { onConflict: "user_id,txn_id" });
          if (upsertErr) {
            console.error(`Failed upserting transactions for ${accountId}:`, upsertErr);
          }
        }

        for (const rows of chunk(queueRows, 200)) {
          const { error: queueErr } = await supabaseClient
            .from("ai_categorization_queue")
            .upsert(rows, {
              onConflict: "user_id,txn_id,provider",
              ignoreDuplicates: true,
            });
          if (queueErr) {
            console.error(`Failed queue upsert for ${accountId}:`, queueErr);
          }
        }
      }

      // txns_removed reserved for future delta-sync/removal reconciliation.
    }

    return json(200, {
      ok: true,
      env: "gocardless",
      accounts_upserted: accountsUpserted,
      txns_added: txnsAdded,
      txns_modified: txnsModified,
      txns_removed: txnsRemoved,
    });
  } catch (error: any) {
    console.error("Error in gocardless-sync-accounts:", error);
    return json(500, { error: error?.message || "Internal server error" });
  }
});


