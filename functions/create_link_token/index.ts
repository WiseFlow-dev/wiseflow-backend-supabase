// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ENV = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
const PLAID_BASE =
  ENV === "production"   ? "https://production.plaid.com" :
  ENV === "development"  ? "https://development.plaid.com" :
                           "https://sandbox.plaid.com";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET    = Deno.env.get("PLAID_SECRET")!;
const ANDROID_PACKAGE = Deno.env.get("PLAID_ANDROID_PACKAGE") ?? "com.wiserworkflow.app";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function cors(res: Response) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
const json = (p: any, s = 200) => cors(new Response(JSON.stringify(p), { status: s, headers: { "Content-Type": "application/json" } }));

function userHasProAccess(user: any): boolean {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const truthyFlag = (value: unknown) => value === true || asLower(value) === "true" || asLower(value) === "1";
  if (truthyFlag(appMeta["is_premium"]) || truthyFlag(appMeta["premium"]) || truthyFlag(userMeta["is_premium"]) || truthyFlag(userMeta["premium"])) return true;
  return [appMeta["plan"], appMeta["tier"], appMeta["subscription_tier"], appMeta["subscription_plan"], userMeta["plan"], userMeta["tier"], userMeta["subscription_tier"], userMeta["subscription_plan"]]
    .map(asLower)
    .filter(Boolean)
    .some((v) => v === "premium" || v.startsWith("premium_"));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) return json({ ok: false, error: "unauthorized" }, 401);
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json({ ok: false, error: "supabase_env_missing" }, 500);
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await sb.auth.getUser(bearerToken);
    if (userError || !user) return json({ ok: false, error: "unauthorized" }, 401);
    if (!userHasProAccess(user)) return json({ ok: false, error: "pro_required", message: "Bank connection is Premium only." }, 403);

    // (Optional) allow client to send its appId (useful if you have .debug suffix)
    const body = await req.json().catch(() => ({}));
    const clientPkg = typeof body?.android_package_name === "string" && body.android_package_name.trim().length > 0
      ? body.android_package_name.trim()
      : ANDROID_PACKAGE;

    const payload = {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      client_name: "WiseFlow",
      products: ["transactions"],
      country_codes: ["US", "CA"],
      language: "en",
      user: { client_user_id: crypto.randomUUID() }, // You can attach your Supabase user id here if you like
      android_package_name: clientPkg,
    };

    const res = await fetch(`${PLAID_BASE}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    if (!res.ok) {
      let details: any = raw;
      try { details = JSON.parse(raw); } catch {}
      return json({ ok: false, error: "plaid_link_token_error", env: ENV, status: res.status, details }, 400);
    }

    const parsed = JSON.parse(raw);
    const link_token = parsed?.link_token;
    if (!link_token) return json({ ok: false, error: "missing_link_token", parsed }, 500);

    // include what we sent for easy debugging
    return json({ ok: true, link_token, android_package_name: clientPkg, env: ENV });
  } catch (e) {
    return json({ ok: false, error: "create_link_token_failed", details: String(e) }, 500);
  }
});


