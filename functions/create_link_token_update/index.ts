// supabase/functions/create_link_token_update/index.ts
// Deno deploy target for Plaid Link UPDATE MODE (add accounts to an existing item)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---- env / plaid ----
const ENV = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
const PLAID_BASE =
  ENV === "production" ? "https://production.plaid.com" :
  ENV === "development" ? "https://development.plaid.com" :
  "https://sandbox.plaid.com";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET    = Deno.env.get("PLAID_SECRET")!;
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ---- helpers ----
function cors(res: Response) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
function json(payload: unknown, status = 200) {
  return cors(new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  }));
}
function safeParse(s: string) { try { return JSON.parse(s); } catch { return { raw: s }; } }
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
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  try {
    // ---- auth (as the end-user) ----
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { data: userRes, error: userErr } = await sb.auth.getUser();
    if (userErr || !userRes?.user) return json({ error: "unauthorized" }, 401);
    const user = userRes.user;
    if (!userHasProAccess(user)) return json({ error: "pro_required", message: "Bank connection is Premium only." }, 403);

    // ---- input ----
    const body = await req.json().catch(() => ({}));
    const item_id = (body?.item_id ?? "").toString().trim();
    const android_package_name = typeof body?.android_package_name === "string"
      ? body.android_package_name
      : undefined;

    if (!item_id) return json({ error: "missing_item_id" }, 400);

    // ---- lookup access_token for this user+item ----
    const { data: row, error } = await sb
      .from("plaid_items")
      .select("access_token")
      .eq("user_id", user.id)
      .eq("item_id", item_id)
      .single();

    if (error || !row?.access_token) {
      return json({ error: "item_not_found_for_user", details: error ?? null }, 400);
    }

    // ---- create link token (UPDATE MODE uses access_token) ----
    const reqBody: Record<string, unknown> = {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      user: { client_user_id: user.id },
      client_name: "WiseFlow",
      language: "en",
      country_codes: ["US", "CA"],
      access_token: row.access_token, // 👈 key difference vs create mode
    };
    if (android_package_name) reqBody.android_package_name = android_package_name;

    const r = await fetch(`${PLAID_BASE}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const raw = await r.text();
    if (!r.ok) return json({ error: "plaid_error", details: safeParse(raw) }, 400);

    const data = safeParse(raw);
    return json({ link_token: (data as any).link_token });
  } catch (e) {
    return json({ error: "create_link_token_update_failed", details: String(e) }, 500);
  }
});


