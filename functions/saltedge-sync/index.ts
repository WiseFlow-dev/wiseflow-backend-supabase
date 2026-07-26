import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const SALTEDGE_BASE = "https://www.saltedge.com/api/v6";
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

type JsonRecord = Record<string, unknown>;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function saltedgeRequest(
  appId: string,
  secret: string,
  path: string,
  query: Record<string, string> = {},
): Promise<JsonRecord> {
  const params = new URLSearchParams(query);
  const url = `${SALTEDGE_BASE}${path}${params.toString() ? `?${params.toString()}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "App-id": appId,
      "Secret": secret,
    },
  });

  const bodyText = await res.text();
  const bodyJson = bodyText ? JSON.parse(bodyText) : {};
  if (!res.ok) {
    throw new Error(`saltedge_http_${res.status}:${bodyText || "empty_body"}`);
  }
  return bodyJson as JsonRecord;
}

async function listPaged(
  appId: string,
  secret: string,
  path: string,
  baseQuery: Record<string, string>,
  perPage: number,
): Promise<JsonRecord[]> {
  const all: JsonRecord[] = [];
  let fromId: string | null = null;
  let safety = 0;

  while (true) {
    const query: Record<string, string> = {
      ...baseQuery,
      per_page: String(perPage),
    };
    if (fromId) query.from_id = fromId;

    const payload = await saltedgeRequest(appId, secret, path, query);
    const page = Array.isArray(payload?.data) ? payload.data as JsonRecord[] : [];
    all.push(...page);

    const nextIdRaw = (payload?.meta as JsonRecord | undefined)?.next_id;
    const nextId = typeof nextIdRaw === "string" || typeof nextIdRaw === "number"
      ? String(nextIdRaw)
      : null;

    if (!nextId || page.length === 0 || nextId === fromId) break;
    fromId = nextId;

    safety += 1;
    if (safety > 1000) break;
  }

  return all;
}

function safeString(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveTypeFromNature(natureRaw: unknown): string {
  const nature = String(natureRaw ?? "").toLowerCase();
  if (["credit", "credit_card", "loan", "mortgage"].includes(nature)) return "credit";
  if (["investment", "bonus", "insurance"].includes(nature)) return "investment";
  if (["account", "checking", "savings", "card", "debit_card", "ewallet"].includes(nature)) return "depository";
  return "other";
}

function deriveMask(account: JsonRecord): string | null {
  const direct = safeString(account.account_number) ?? safeString(account.card_number);
  const extra = (account.extra as JsonRecord | undefined) ?? {};
  const extraValue = safeString(extra.account_number) ?? safeString(extra.card_number);
  const source = direct ?? extraValue;
  if (!source) return null;
  const digits = source.replace(/\D/g, "");
  if (digits.length >= 4) return digits.slice(-4);
  return source.length > 4 ? source.slice(-4) : source;
}

async function getExistingTxnIds(
  adminClient: any,
  userId: string,
  txnIds: string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  for (const idsChunk of chunk(txnIds, 500)) {
    const { data, error } = await adminClient
      .from("transactions")
      .select("txn_id")
      .eq("user_id", userId)
      .in("txn_id", idsChunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const txnId = safeString((row as JsonRecord).txn_id);
      if (txnId) set.add(txnId);
    }
  }
  return set;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const isTestMode = (Deno.env.get("SALTEDGE_MODE") ?? "").toLowerCase() === "test";
    console.log(`Salt Edge sync mode: ${isTestMode ? "TEST" : "LIVE"}`);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const saltedgeAppId = Deno.env.get("SALTEDGE_APP_ID");
    const saltedgeSecret = Deno.env.get("SALTEDGE_SECRET");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json({ error: "supabase_env_missing" }, 500);
    }
    if (!saltedgeAppId || !saltedgeSecret) {
      return json({ error: "saltedge_env_missing" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) {
      return json({ error: "unauthorized", details: "missing_bearer_token" }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(bearerToken);
    if (userError || !user) {
      return json({ error: "unauthorized", details: userError?.message ?? "invalid_jwt" }, 401);
    }
    if (!userHasProAccess(user)) {
      return json({ error: "pro_required", message: "Bank sync is Premium only." }, 403);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: customerRows, error: customerError } = await adminClient
      .from("saltedge_customers")
      .select("customer_id")
      .eq("user_id", user.id)
      .limit(1);
    if (customerError) {
      console.error("Failed reading saltedge_customers:", customerError);
      return json({ error: "failed_to_read_saltedge_customers" }, 500);
    }

    const customerId = safeString(customerRows?.[0]?.customer_id);
    if (!customerId) {
      return json(
        {
          ok: false,
          error: "missing_saltedge_customer",
          details: "Create customer first by calling saltedge-create-customer",
        },
        400,
      );
    }

    const connections = await listPaged(
      saltedgeAppId,
      saltedgeSecret,
      "/connections",
      { customer_id: customerId },
      120,
    );

    let accountsUpserted = 0;
    let txnsAdded = 0;
    let txnsModified = 0;
    const txnsRemoved = 0;

    for (const connection of connections) {
      const connectionId = safeString(connection.id);
      if (!connectionId) continue;

      const providerCode = safeString(connection.provider_code) ?? "saltedge";

      const accounts = await listPaged(
        saltedgeAppId,
        saltedgeSecret,
        "/accounts",
        { connection_id: connectionId },
        500,
      );

      if (accounts.length === 0) continue;

      const accountRows = accounts
        .map((account) => {
          const accountId = safeString(account.id);
          if (!accountId) return null;

          const currencyCode = safeString(account.currency_code) ?? "USD";
          const currentBalance = toNumber(account.balance) ?? 0;
          const extra = (account.extra as JsonRecord | undefined) ?? {};
          const availableBalance = toNumber(extra.available_amount) ?? currentBalance;
          const nature = safeString(account.nature);
          const name = safeString(account.name) ?? "Salt Edge Account";

          return {
            user_id: user.id,
            item_id: connectionId,
            account_id: accountId,
            name,
            official_name: name,
            type: deriveTypeFromNature(nature),
            subtype: nature,
            mask: deriveMask(account),
            balances: {
              available: availableBalance,
              current: currentBalance,
              iso_currency_code: currencyCode,
            },
            currency: currencyCode,
            institution_id: providerCode,
            provider: "saltedge",
          };
        })
        .filter((row): row is Record<string, unknown> => row !== null);

      for (const accountChunk of chunk(accountRows, 200)) {
        const { error: upsertAccountError } = await adminClient
          .from("accounts")
          .upsert(accountChunk, { onConflict: "user_id,item_id,account_id" });
        if (upsertAccountError) {
          console.error("Failed to upsert Salt Edge accounts:", upsertAccountError);
          continue;
        }
        accountsUpserted += accountChunk.length;
      }

      for (const account of accounts) {
        const accountId = safeString(account.id);
        if (!accountId) continue;

        const txns = await listPaged(
          saltedgeAppId,
          saltedgeSecret,
          "/transactions",
          {
            connection_id: connectionId,
            account_id: accountId,
            pending: "false",
            duplicated: "false",
          },
          250,
        );
        if (txns.length === 0) continue;

        const accountCurrency = safeString(account.currency_code) ?? "USD";
        const txnRows = txns
          .map((txn) => {
            const saltEdgeTxnId = safeString(txn.id);
            if (!saltEdgeTxnId) return null;
            const amount = toNumber(txn.amount) ?? 0;
            const currency = safeString(txn.currency_code) ?? accountCurrency;
            const extra = (txn.extra as JsonRecord | undefined) ?? {};
            const merchant = safeString(extra.payee_information)
              ?? safeString(extra.payee)
              ?? safeString(extra.payer_information)
              ?? safeString(extra.payer);
            const name = safeString(txn.description) ?? merchant ?? "Transaction";
            const txnDate = safeString(txn.made_on)
              ?? safeString(txn.posting_date)
              ?? safeString((safeString(txn.created_at) ?? "").slice(0, 10))
              ?? new Date().toISOString().slice(0, 10);

            return {
              user_id: user.id,
              item_id: connectionId,
              txn_id: `se_${saltEdgeTxnId}`,
              account_id: accountId,
              name,
              amount,
              currency,
              pending: safeString(txn.status) === "pending",
              merchant_name: merchant,
              merchant,
              category: safeString(txn.category) ?? "uncategorized",
              txn_date: txnDate,
              provider: "saltedge",
              raw: txn,
            };
          })
          .filter((row): row is Record<string, unknown> => row !== null);

        if (txnRows.length === 0) continue;

        const txnIds = txnRows.map((row) => String(row.txn_id));
        const existingSet = await getExistingTxnIds(adminClient, user.id, txnIds);

        for (const txChunk of chunk(txnRows, 200)) {
          const { error: upsertTxnError } = await adminClient
            .from("transactions")
            .upsert(txChunk, { onConflict: "user_id,txn_id" });
          if (upsertTxnError) {
            console.error("Failed to upsert Salt Edge transactions:", upsertTxnError);
            continue;
          }
        }

        for (const txnId of txnIds) {
          if (existingSet.has(txnId)) txnsModified += 1;
          else txnsAdded += 1;
        }
      }
    }

    return json({
      ok: true,
      accounts_upserted: accountsUpserted,
      txns_added: txnsAdded,
      txns_modified: txnsModified,
      txns_removed: txnsRemoved,
    });
  } catch (error) {
    console.error("Error in saltedge-sync:", error);
    return json({ error: error instanceof Error ? error.message : "internal_error" }, 500);
  }
});


