// ============================================
// GoCardless: Create Bank Requisition
// Creates a requisition (agreement) to connect a bank
// Similar to Plaid's create_link_token
// ============================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const GOCARDLESS_API_URL = "https://bankaccountdata.gocardless.com/api/v2";
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
    // 1. Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Get Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!userHasProAccess(user)) {
      return new Response(JSON.stringify({ error: "pro_required", message: "Bank connection is Premium only." }), {
        status: 403, headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Parse request body
    const body = await req.json();
    const {
      institution_id,
      redirect_url = "https://wiseflow.app/callback", // Your app's callback URL
      reference_id = user.id, // User ID as reference
    } = body;

    if (!institution_id) {
      return new Response(
        JSON.stringify({ error: "institution_id is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Get access token
    const secretId = Deno.env.get("GOCARDLESS_SECRET_ID");
    const secretKey = Deno.env.get("GOCARDLESS_SECRET_KEY");

    const tokenResponse = await fetch(`${GOCARDLESS_API_URL}/token/new/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret_id: secretId, secret_key: secretKey }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to get GoCardless token");
    }

    const { access: accessToken } = await tokenResponse.json();

    // 5. Create requisition
    const requisitionResponse = await fetch(`${GOCARDLESS_API_URL}/requisitions/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        redirect: redirect_url,
        institution_id: institution_id,
        reference: reference_id,
        user_language: "EN", // Can be dynamic based on user preference
      }),
    });

    if (!requisitionResponse.ok) {
      const errorText = await requisitionResponse.text();
      console.error("GoCardless requisition error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to create requisition", details: errorText }),
        { status: requisitionResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const requisitionData = await requisitionResponse.json();

    // 6. Store requisition in database
    const { error: dbError } = await supabaseClient
      .from("gocardless_requisitions")
      .insert({
        user_id: user.id,
        requisition_id: requisitionData.id,
        institution_id: institution_id,
        status: requisitionData.status,
      });

    if (dbError) {
      console.error("Database error:", dbError);
    }

    // 7. Also store in plaid_items for unified access
    await supabaseClient
      .from("plaid_items")
      .insert({
        user_id: user.id,
        item_id: requisitionData.id,
        provider: "gocardless",
      });

    // 8. Return requisition link
    return new Response(
      JSON.stringify({
        ok: true,
        requisition_id: requisitionData.id,
        link: requisitionData.link, // User opens this URL to connect bank
        status: requisitionData.status,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in gocardless-create-requisition:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});


