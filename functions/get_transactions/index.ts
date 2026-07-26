// supabase/functions/get_transactions/index.ts
// INPUT: { "user_id": "android-user-1", "account_id": "<optional>" }
// Returns last 30 days transactions (optionally filtered by account)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const { user_id, account_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({
        error: "Missing user_id"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...cors
        }
      });
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    // 1) get access_token from plaid_items
    const { data: rows, error: qErr } = await supabase.from("plaid_items").select("*").eq("user_id", user_id).order("created_at", {
      ascending: false
    }).limit(1);
    if (qErr) throw qErr;
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({
        error: "No linked bank for user"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...cors
        }
      });
    }
    const access_token = rows[0].access_token;
    if (!access_token) {
      return new Response(JSON.stringify({
        error: "Empty access_token"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...cors
        }
      });
    }
    // 2) call Plaid /transactions/get for last 30 days
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
    const base = Deno.env.get("PLAID_BASE_URL") ?? "https://sandbox.plaid.com";
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const fmt = (d)=>d.toISOString().slice(0, 10);
    const payload = {
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      access_token,
      start_date: fmt(start),
      end_date: fmt(today),
      options: {
        count: 100,
        offset: 0
      }
    };
    if (account_id) payload.options.account_ids = [
      account_id
    ];
    const resp = await fetch(`${base}/transactions/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({
        error: "Plaid /transactions/get failed",
        body: err
      }), {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          ...cors
        }
      });
    }
    const body = await resp.json();
    // 3) slim payload
    const txns = (body.transactions ?? []).map((t)=>({
        transaction_id: t.transaction_id,
        account_id: t.account_id,
        name: t.name,
        date: t.date,
        amount: t.amount,
        currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
        merchant_name: t.merchant_name ?? null,
        category: (t.category ?? []).join(" / "),
        pending: !!t.pending
      }));
    return new Response(JSON.stringify({
      user_id,
      transactions: txns
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...cors
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: e?.message ?? String(e)
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...cors
      }
    });
  }
});
