import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const ENV = (Deno.env.get("PLAID_ENV") ?? "sandbox").toLowerCase();
const PLAID_BASE = ENV === "production" ? "https://production.plaid.com" : ENV === "development" ? "https://development.plaid.com" : "https://sandbox.plaid.com";
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cors = (res)=>{
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, {
    status: res.status,
    headers: h
  });
};
const json = (p, s = 200)=>cors(new Response(JSON.stringify(p), {
    status: s,
    headers: {
      "Content-Type": "application/json"
    }
  }));
function userHasProAccess(user) {
  const appMeta = user?.app_metadata ?? {};
  const userMeta = user?.user_metadata ?? {};
  const asLower = (value)=>String(value ?? "").trim().toLowerCase();
  const truthyFlag = (value)=>value === true || asLower(value) === "true" || asLower(value) === "1";
  if (truthyFlag(appMeta["is_premium"]) || truthyFlag(appMeta["premium"]) || truthyFlag(userMeta["is_premium"]) || truthyFlag(userMeta["premium"])) return true;
  return [
    appMeta["plan"],
    appMeta["tier"],
    appMeta["subscription_tier"],
    appMeta["subscription_plan"],
    userMeta["plan"],
    userMeta["tier"],
    userMeta["subscription_tier"],
    userMeta["subscription_plan"]
  ].map(asLower).filter(Boolean).some((v)=>v === "premium" || v.startsWith("premium_"));
}
serve(async (req)=>{
  if (req.method === "OPTIONS") return cors(new Response(null, {
    status: 204
  }));
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: {
        headers: {
          Authorization: auth
        }
      },
      auth: {
        persistSession: false
      }
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({
      error: "unauthorized"
    }, 401);
    if (!userHasProAccess(u.user)) return json({
      error: "pro_required",
      message: "Bank connection is Premium only."
    }, 403);
    const userId = u.user.id;
    const body = await req.json().catch(()=>({}));
    const public_token = body?.public_token;
    if (!public_token) return json({
      error: "missing_public_token"
    }, 400);
    const res = await fetch(`${PLAID_BASE}/item/public_token/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        public_token
      })
    });
    const raw = await res.json();
    if (!res.ok) return json({
      error: "exchange_failed",
      status: res.status,
      details: raw
    }, 400);
    const access_token = raw?.access_token;
    const item_id = raw?.item_id;
    if (!access_token || !item_id) return json({
      error: "missing_access_token_or_item_id",
      raw
    }, 500);
    // --- FIX: Use a composite key for the onConflict constraint ---
    const { error: upErr } = await sb.from("plaid_items").upsert({
      user_id: userId,
      item_id,
      access_token
    }, {
      onConflict: "user_id, item_id" // Corrected constraint
    });
    if (upErr) return json({
      error: "items_upsert_failed",
      details: upErr.message
    }, 500);
    return json({
      ok: true,
      item_id
    });
  } catch (e) {
    return json({
      error: "exchange_public_token_failed",
      details: String(e)
    }, 500);
  }
});


