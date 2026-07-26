import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const JSON_HEADERS = { "Content-Type": "application/json" };
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
  });
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

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { ok: false, error: "missing_authorization_header" });
    }
    const [scheme, accessToken] = authHeader.split(" ");
    if (scheme !== "Bearer" || !accessToken) {
      return json(401, { ok: false, error: "invalid_authorization_header" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!supabaseUrl || !supabaseAnonKey) {
      return json(500, { ok: false, error: "supabase_env_missing" });
    }

    const payload = await req.json().catch(() => ({}));
    const loginIdentityId = String(payload?.login_identity_id ?? "").trim();
    if (!loginIdentityId) {
      return json(400, { ok: false, error: "missing_login_identity_id" });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
    const user = userData?.user;
    if (userError || !user) {
      return json(401, { ok: false, error: "unauthorized" });
    }
    if (!userHasProAccess(user)) {
      return json(403, { ok: false, error: "pro_required", message: "Bank sync is Premium only." });
    }

    const { data: connection, error: connectionError } = await supabase
      .from("finverse_connections")
      .select("status, updated_at, created_at")
      .eq("user_id", user.id)
      .eq("login_identity_id", loginIdentityId)
      .maybeSingle();
    if (connectionError) {
      return json(500, { ok: false, error: "connection_lookup_failed", details: connectionError.message });
    }

    const { data: accounts, error: accountsError } = await supabase
      .from("accounts")
      .select("account_id")
      .eq("user_id", user.id)
      .eq("provider", "finverse")
      .eq("item_id", loginIdentityId);
    if (accountsError) {
      return json(500, { ok: false, error: "accounts_lookup_failed", details: accountsError.message });
    }

    const accountIds = Array.from(
      new Set((accounts ?? [])
        .map((row: any) => String(row?.account_id ?? "").trim())
        .filter(Boolean)),
    );

    const { data: itemTransactions, error: itemTransactionsError, count } = await supabase
      .from("transactions")
      .select("account_id", { count: "exact" })
      .eq("user_id", user.id)
      .eq("provider", "finverse")
      .eq("item_id", loginIdentityId)
      .eq("is_removed", false);
    if (itemTransactionsError) {
      return json(500, { ok: false, error: "transaction_count_failed", details: itemTransactionsError.message });
    }

    const transactionDerivedAccountIds = Array.from(
      new Set((itemTransactions ?? [])
        .map((row: any) => String(row?.account_id ?? "").trim())
        .filter(Boolean)),
    );
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : transactionDerivedAccountIds;
    const transactionCount = Number(count ?? 0);

    const connectionStatus = String(connection?.status ?? "").trim();
    const retrievalComplete = connectionStatus === "DATA_RETRIEVAL_COMPLETE";

    return json(200, {
      ok: true,
      env: "finverse",
      login_identity_id: loginIdentityId,
      connection_status: connectionStatus || null,
      connection_updated_at: connection?.updated_at ?? connection?.created_at ?? null,
      account_count: resolvedAccountIds.length,
      transaction_count: transactionCount,
      account_count_source: accountIds.length > 0 ? "accounts" : (transactionDerivedAccountIds.length > 0 ? "transactions" : "none"),
      accounts_ready: resolvedAccountIds.length > 0,
      transactions_ready: transactionCount > 0,
      retrieval_complete: retrievalComplete,
    });
  } catch (error: any) {
    console.error("finverse-sync-status error:", error);
    return json(500, {
      ok: false,
      error: "internal_error",
      details: error?.message || "Internal server error",
    });
  }
});


