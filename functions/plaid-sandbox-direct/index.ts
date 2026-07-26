// supabase/functions/plaid-sandbox-direct/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Content-Type": "application/json",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST" }), { status: 405, headers: CORS });
  }

  try {
    const { user_id, institution_id = "ins_109508", initial_products = ["transactions"], webhook = null } =
      await req.json().catch(() => ({}));

    if (!user_id) {
      return new Response(JSON.stringify({ error: "Missing user_id" }), { status: 400, headers: CORS });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET");

    const missing: string[] = [];
    if (!SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!SERVICE_ROLE) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (!PLAID_CLIENT_ID) missing.push("PLAID_CLIENT_ID");
    if (!PLAID_SECRET) missing.push("PLAID_SECRET");
    if (missing.length) {
      return new Response(JSON.stringify({ error: "Missing envs", missing }), { status: 500, headers: CORS });
    }

    // 1) Create a sandbox public_token directly (no UI)
    const pubRes = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        institution_id,
        initial_products,
        options: { webhook },
      }),
    });
    const pubData = await pubRes.json();
    if (!pubRes.ok) {
      return new Response(JSON.stringify({ stage: "sandbox/public_token/create", details: pubData }), {
        status: 500,
        headers: CORS,
      });
    }
    const public_token = pubData.public_token;

    // 2) Exchange for access_token
    const exRes = await fetch("https://sandbox.plaid.com/item/public_token/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        public_token,
      }),
    });
    const exData = await exRes.json();
    if (!exRes.ok) {
      return new Response(JSON.stringify({ stage: "item/public_token/exchange", details: exData }), {
        status: 500,
        headers: CORS,
      });
    }

    const access_token = exData.access_token;
    const item_id = exData.item_id;

    // 3) Store in plaid_items (service role)
    const supa = createClient(SUPABASE_URL!, SERVICE_ROLE!);
    const { error: insErr } = await supa.from("plaid_items").insert([
      {
        user_id,
        item_id,
        access_token,
        institution_name: "Sandbox Institution",
      },
    ]);
    if (insErr) {
      return new Response(JSON.stringify({ stage: "db.insert", details: insErr }), {
        status: 500,
        headers: CORS,
      });
    }

    return new Response(JSON.stringify({ ok: true, user_id, item_id, access_token }), {
      status: 200,
      headers: CORS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), {
      status: 500,
      headers: CORS,
    });
  }
});
