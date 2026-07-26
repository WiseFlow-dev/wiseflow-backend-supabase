// ============================================
// GoCardless: List Available Institutions (Banks)
// Returns list of banks available in a country
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!supabaseUrl || !supabaseAnonKey || !bearerToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const supabase = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await supabase.auth.getUser(bearerToken);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (!userHasProAccess(user)) {
      return new Response(JSON.stringify({ error: "pro_required", message: "Bank connection is Premium only." }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // 2. Parse query parameters
    const url = new URL(req.url);
    const country = url.searchParams.get("country") || "GB"; // Default: UK

    // 3. Get access token
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

    // 4. Fetch institutions for the country
    const institutionsResponse = await fetch(
      `${GOCARDLESS_API_URL}/institutions/?country=${country}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!institutionsResponse.ok) {
      const errorText = await institutionsResponse.text();
      console.error("GoCardless institutions error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to fetch institutions", details: errorText }),
        { status: institutionsResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const institutions = await institutionsResponse.json();

    // 5. Return formatted list
    return new Response(
      JSON.stringify({
        ok: true,
        country: country,
        count: institutions.length,
        institutions: institutions.map((inst: any) => ({
          id: inst.id,
          name: inst.name,
          bic: inst.bic,
          logo: inst.logo,
          countries: inst.countries,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in gocardless-list-institutions:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});


