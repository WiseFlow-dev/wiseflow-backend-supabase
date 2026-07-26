// ============================================
// GoCardless: Get Access Token
// Exchanges Secret ID + Secret Key for access token
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GOCARDLESS_API_URL = "https://bankaccountdata.gocardless.com/api/v2";

serve(async (req) => {
  try {
    // 1. Verify user is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Get GoCardless credentials from environment
    const secretId = Deno.env.get("GOCARDLESS_SECRET_ID");
    const secretKey = Deno.env.get("GOCARDLESS_SECRET_KEY");

    if (!secretId || !secretKey) {
      return new Response(
        JSON.stringify({ error: "GoCardless credentials not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Request access token from GoCardless
    const tokenResponse = await fetch(`${GOCARDLESS_API_URL}/token/new/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        secret_id: secretId,
        secret_key: secretKey,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("GoCardless token error:", errorText);
      return new Response(
        JSON.stringify({
          error: "Failed to get GoCardless token",
          details: errorText,
        }),
        { status: tokenResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const tokenData = await tokenResponse.json();

    // 4. Return token data
    return new Response(
      JSON.stringify({
        ok: true,
        access_token: tokenData.access,
        access_expires: tokenData.access_expires,
        refresh_token: tokenData.refresh,
        refresh_expires: tokenData.refresh_expires,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in gocardless-get-token:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
