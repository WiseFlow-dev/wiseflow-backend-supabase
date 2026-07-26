// supabase/functions/get_insights/index.ts
// INPUT: { "user_id": "android-user-1" }
// OUTPUT: { user_id, spend_this_week, spend_last_week, delta_abs, delta_pct }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "Missing user_id" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // 1) lookup access_token
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: rows, error: qErr } = await supabase
      .from("plaid_items").select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false }).limit(1);
    if (qErr) throw qErr;
    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ error: "No linked bank for user" }), {
        status: 404, headers: { "Content-Type": "application/json", ...cors },
      });
    }
    const access_token = rows[0].access_token;

    // 2) call Plaid /transactions/get for last 30 days
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET")!;
    const base = Deno.env.get("PLAID_BASE_URL") ?? "https://sandbox.plaid.com";

    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 30);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const resp = await fetch(`${base}/transactions/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        access_token,
        start_date: fmt(start),
        end_date: fmt(today),
        options: { count: 500, offset: 0 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return new Response(JSON.stringify({ error: "Plaid /transactions/get failed", body: err }), {
        status: 502, headers: { "Content-Type": "application/json", ...cors },
      });
    }
    const body = await resp.json();

    // 3) compute weekly spend (sum of outflows) — Plaid amounts are positive for outflow
    const txns: any[] = body.transactions ?? [];
    const todayISO = fmt(today);
    const weekday = new Date(todayISO).getDay(); // 0..6
    // define “this week” as last 7 days from today (rolling window)
    const startThis = new Date(today); startThis.setDate(today.getDate() - 6);
    const startLast = new Date(today); startLast.setDate(today.getDate() - 13);
    const endLast = new Date(today); endLast.setDate(today.getDate() - 7);

    const inRange = (d: string, a: Date, b: Date) => {
      const x = new Date(d + "T00:00:00Z").getTime();
      return x >= new Date(fmt(a) + "T00:00:00Z").getTime()
          && x <= new Date(fmt(b) + "T00:00:00Z").getTime();
    };

    const spendThis = txns
      .filter(t => inRange(t.date, startThis, today))
      .filter(t => !t.pending)
      .reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);

    const spendLast = txns
      .filter(t => inRange(t.date, startLast, endLast))
      .filter(t => !t.pending)
      .reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);

    const deltaAbs = spendThis - spendLast;
    const deltaPct = spendLast === 0 ? null : (deltaAbs / spendLast) * 100;

    return new Response(JSON.stringify({
      user_id,
      spend_this_week: Number(spendThis.toFixed(2)),
      spend_last_week: Number(spendLast.toFixed(2)),
      delta_abs: Number(deltaAbs.toFixed(2)),
      delta_pct: deltaPct === null ? null : Number(deltaPct.toFixed(1)),
      currency: (txns[0]?.iso_currency_code ?? txns[0]?.unofficial_currency_code ?? "USD")
    }), {
      status: 200, headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { "Content-Type": "application/json", ...cors },
    });
  }
});
