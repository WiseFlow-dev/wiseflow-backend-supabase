// ============================================
// TrueLayer: Get Authorization URL
// Creates OAuth URL for user to connect their bank
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const TRUELAYER_AUTH_URL = "https://auth.truelayer-sandbox.com";
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
    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    if (!bearerToken || !supabaseUrl || !supabaseAnonKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const sb = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await sb.auth.getUser(bearerToken);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!userHasProAccess(user)) {
      return new Response(JSON.stringify({ error: "pro_required", message: "Bank connection is Premium only." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // 1. Get TrueLayer credentials from environment
    const clientId = Deno.env.get("TRUELAYER_CLIENT_ID");
    const redirectUri = "wiseflow://truelayer/callback";

    if (!clientId) {
      return new Response(
        JSON.stringify({ error: "TrueLayer credentials not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Build authorization URL
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: "info accounts balance cards transactions direct_debits standing_orders offline_access",
      redirect_uri: redirectUri,
      providers: "uk-cs-mock uk-ob-all uk-oauth-all",
      enable_mock: "true",
    });

    const authUrl = `${TRUELAYER_AUTH_URL}/?${params.toString()}`;

    // 4. Return auth URL
    return new Response(
      JSON.stringify({
        ok: true,
        auth_url: authUrl,
        redirect_uri: redirectUri,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in truelayer-auth-url:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});


