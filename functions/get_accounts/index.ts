// supabase/functions/get_accounts/index.ts
// Returns Plaid accounts + balances for a given user_id
// INPUT: { "user_id": "android-user-1" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "Missing user_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1) Fetch access_token for this user from the correct table
    const { data: rows, error: qErr } = await supabase
      .from("plaid_items")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(1);

    if (qErr) throw qErr;
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: "No linked bank for user" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const access_token = rows[0].access_token;
    if (!access_token) {
      return new Response(JSON.stringify({ error: "Empty access_token" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // 2) Call Plaid /accounts/get (no options.include_balance)
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
    const base = Deno.env.get("PLAID_BASE_URL") ?? "https://sandbox.plaid.com";

    const plaidRes = await fetch(`${base}/accounts/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token,
      }),
    });

    if (!plaidRes.ok) {
      const errText = await plaidRes.text();
      return new Response(
        JSON.stringify({ error: "Plaid /accounts/get failed", body: errText }),
        { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const body = await plaidRes.json();

    // 3) Slim payload for the app
    const accounts = (body.accounts ?? []).map((a: any) => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ?? null,
      subtype: a.subtype ?? null,
      balance_current: a.balances?.current ?? null,
      balance_available: a.balances?.available ?? null,
      currency:
        a.balances?.iso_currency_code ??
        a.balances?.unofficial_currency_code ??
        null,
    }));

    return new Response(JSON.stringify({ user_id, accounts }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
