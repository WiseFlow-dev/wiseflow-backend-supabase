import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const cors = (res)=>{
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, {
    status: res.status,
    headers: h
  });
};
const json = (p, s = 200)=>cors(new Response(JSON.stringify(p), {
    status: s,
    headers: {
      "Content-Type": "application/json"
    }
  }));
serve(async (req)=>{
  if (req.method === "OPTIONS") return cors(new Response(null, {
    status: 204
  }));
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: {
        headers: {
          Authorization: auth
        }
      },
      auth: {
        persistSession: false
      }
    });
    const { data: u } = await sb.auth.getUser();
    if (!u?.user) return json({
      error: "unauthorized"
    }, 401);
    const body = await req.json().catch(()=>({}));
    const limit = Math.min(Number(body?.limit ?? 100), 1000);
    const { data: accounts, error: ea } = await sb.from("user_accounts").select("*").limit(limit);
    if (ea) return json({
      error: "accounts_query_failed",
      details: ea.message
    }, 500);
    const { data: transactions, error: et } = await sb.from("user_transactions").select("*").limit(limit);
    if (et) return json({
      error: "transactions_query_failed",
      details: et.message
    }, 500);
    return json({
      accounts,
      transactions
    });
  } catch (e) {
    return json({
      error: "fetch_user_finance_failed",
      details: String(e)
    }, 500);
  }
});
