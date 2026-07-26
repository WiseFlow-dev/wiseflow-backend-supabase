import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID")!;
const PLAID_SECRET    = Deno.env.get("PLAID_SECRET")!;

const json=(p:unknown,s=200)=>new Response(JSON.stringify(p),{status:s,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

serve(async (req) => {
  if (req.method === "OPTIONS") return json(null, 204);
  try {
    const body = await req.json().catch(()=>({}));
    const { institution_id = "ins_109508", initial_products = ["transactions"] } = body;

    const res = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        institution_id,
        initial_products
      })
    });

    const text = await res.text();
    if (!res.ok) return json({ error: "plaid_sandbox_error", status: res.status, details: JSON.parse(text) }, res.status);
    return json(JSON.parse(text));
  } catch (e) {
    return json({ error: "sandbox_public_token_failed", details: String(e) }, 500);
  }
});
