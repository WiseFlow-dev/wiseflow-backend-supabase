// ============================================
// TrueLayer: Exchange Auth Code for Access Token
// Exchanges authorization code for access/refresh tokens
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const TRUELAYER_AUTH_URL = "https://auth.truelayer-sandbox.com";
const REDIRECT_URI = "wiseflow://truelayer/callback";
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Supabase environment not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 1) Resolve calling user from JWT
    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", details: "missing_bearer_token" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(bearerToken);
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", details: userError?.message ?? "invalid_jwt" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!userHasProAccess(user)) {
      return new Response(JSON.stringify({ error: "pro_required", message: "Bank connection is Premium only." }), {
        status: 403, headers: { "Content-Type": "application/json" }
      });
    }

    // 2) Parse request body
    const body = await req.json();
    const { code } = body;
    if (!code) {
      return new Response(
        JSON.stringify({ error: "Authorization code is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3) Get TrueLayer credentials
    const clientId = Deno.env.get("TRUELAYER_CLIENT_ID");
    const clientSecret = Deno.env.get("TRUELAYER_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: "TrueLayer credentials not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4) Exchange code for token
    const tokenResponse = await fetch(`${TRUELAYER_AUTH_URL}/connect/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT_URI,
        code: code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("TrueLayer token exchange error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to exchange token", details: errorText }),
        { status: tokenResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const tokenData = await tokenResponse.json();
    const expiresInSec = Number(tokenData.expires_in ?? 0);
    const tokenExpiresAt = new Date(Date.now() + Math.max(expiresInSec, 0) * 1000).toISOString();

    // 5) Persist connection tokens using service role client
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { error: deleteError } = await adminClient
      .from("truelayer_connections")
      .delete()
      .eq("user_id", user.id);
    if (deleteError) {
      console.error("Failed to clear existing TrueLayer connection:", deleteError);
      return new Response(
        JSON.stringify({ error: "Failed to store TrueLayer connection" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const { error: insertError } = await adminClient
      .from("truelayer_connections")
      .insert({
        user_id: user.id,
        auth_code: code,
        provider_id: "truelayer",
        token_expires_at: tokenExpiresAt,
        access_token: tokenData.access_token ?? null,
        refresh_token: tokenData.refresh_token ?? null,
      });
    if (insertError) {
      console.error("Failed to insert TrueLayer connection:", insertError);
      return new Response(
        JSON.stringify({ error: "Failed to store TrueLayer connection" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6) Return token-safe response shape
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in truelayer-exchange-token:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});


