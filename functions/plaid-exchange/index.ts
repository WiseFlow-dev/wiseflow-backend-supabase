// supabase/functions/plaid-exchange/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};
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
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
    const { data: { user: authUser }, error: authError } = await authClient.auth.getUser(bearerToken);
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (!userHasProAccess(authUser)) {
      return new Response(JSON.stringify({ error: "pro_required", message: "Bank connection is Premium only." }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { public_token, institution_name } = await req.json().catch(() => ({}));
    const resolvedUserId = authUser.id;

    // ✅ Handle DUMMY first, regardless of other fields
    if (public_token === "DUMMY") {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { error } = await supabase.from("plaid_items").insert([
        {
          user_id: resolvedUserId,
          item_id: "item_test_123",
          access_token: "access_test_123",
          institution_name: institution_name ?? "Test Bank",
        },
      ]);
      if (error) {
        return new Response(JSON.stringify({ error: "DB insert failed", details: error }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, item_id: "item_test_123" }), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // 🔒 Now validate required fields for real Plaid exchange
    if (!public_token) {
      return new Response(JSON.stringify({ error: "Missing public_token" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // 1) Exchange public_token -> access_token
    const plaidRes = await fetch("https://sandbox.plaid.com/item/public_token/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: Deno.env.get("PLAID_CLIENT_ID"),
        secret: Deno.env.get("PLAID_SECRET"),
        public_token,
      }),
    });

    const plaidData = await plaidRes.json();
    if (!plaidRes.ok) {
      console.error("❌ Plaid exchange failed", plaidRes.status, plaidData);
      return new Response(JSON.stringify({ error: "Plaid exchange failed", details: plaidData }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const access_token = plaidData.access_token;
    const item_id = plaidData.item_id;

    // 2) Insert with Service Role
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error: insertErr } = await supabase.from("plaid_items").insert([
      { user_id: resolvedUserId, item_id, access_token, institution_name: institution_name ?? null },
    ]);

    if (insertErr) {
      console.error("❌ Insert failed", insertErr);
      return new Response(JSON.stringify({ error: "DB insert failed", details: insertErr }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, item_id }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Unhandled", err);
    return new Response(JSON.stringify({ error: err?.message ?? "unknown" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});


