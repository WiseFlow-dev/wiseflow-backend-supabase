import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const SALTEDGE_BASE = "https://www.saltedge.com/api/v6";
const SALTEDGE_RETURN_TO = "wiseflow://saltedge-callback";
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

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createConnectSession(
  customerId: string,
  appId: string,
  secret: string,
): Promise<{ connectUrl: string; expiresAt: string | null; raw: unknown }> {
  const today = new Date().toISOString().slice(0, 10);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const isTestMode = (Deno.env.get("SALTEDGE_MODE") ?? "").toLowerCase() === "test";

  const requestBody = {
    data: {
      customer_id: customerId,
      ...(isTestMode ? { include_fake_providers: true } : {}),
      consent: {
        scopes: ["accounts", "transactions"],
      },
      attempt: {
        fetch_scopes: ["accounts", "balance", "transactions"],
        fetch_from_date: ninetyDaysAgo,
        fetch_to_date: today,
        return_to: SALTEDGE_RETURN_TO,
        locale: "en",
      },
      return_connection_id: true,
      automatic_refresh: true,
    },
  };

  const endpoints = [
    `${SALTEDGE_BASE}/connections/connect`,
    `${SALTEDGE_BASE}/connect_sessions/create`,
  ];

  let lastErrorBody = "";
  let lastStatus = 500;

  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "App-id": appId,
        "Secret": secret,
      },
      body: JSON.stringify(requestBody),
    });
    const bodyText = await res.text();
    const bodyJson = bodyText ? JSON.parse(bodyText) : {};

    if (res.ok) {
      const connectUrl = bodyJson?.data?.connect_url ?? bodyJson?.data?.connectUrl ?? null;
      if (!connectUrl) {
        throw new Error("saltedge_connect_url_missing");
      }
      const expiresAt = bodyJson?.data?.expires_at ?? null;
      return {
        connectUrl: String(connectUrl),
        expiresAt: typeof expiresAt === "string" ? expiresAt : null,
        raw: bodyJson,
      };
    }

    lastStatus = res.status;
    lastErrorBody = bodyText || `HTTP ${res.status}`;
  }

  throw new Error(`saltedge_session_create_failed:${lastStatus}:${lastErrorBody}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const isTestMode = (Deno.env.get("SALTEDGE_MODE") ?? "").toLowerCase() === "test";
    console.log(`Salt Edge session mode: ${isTestMode ? "TEST (fakebank)" : "LIVE"}`);

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
      return json({ error: "pro_required", message: "Bank connection is Premium only." }, 403);
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

    const customerRaw = customerRows?.[0]?.customer_id;
    const customerId = customerRaw == null ? null : String(customerRaw).trim();
    if (!customerId) {
      return json(
        {
          error: "missing_saltedge_customer",
          details: "Create customer first by calling saltedge-create-customer",
        },
        400,
      );
    }

    const session = await createConnectSession(customerId, saltedgeAppId, saltedgeSecret);
    return json({
      ok: true,
      customer_id: customerId,
      connect_url: session.connectUrl,
      expires_at: session.expiresAt,
    });
  } catch (error) {
    console.error("Error in saltedge-create-session:", error);
    const message = error instanceof Error ? error.message : "internal_error";
    return json({ error: message }, 500);
  }
});


