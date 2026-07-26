import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const SALTEDGE_BASE = "https://www.saltedge.com/api/v6";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const saltedgeAppId = Deno.env.get("SALTEDGE_APP_ID");
    const saltedgeSecret = Deno.env.get("SALTEDGE_SECRET");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json({ error: "supabase_env_missing" }, 500);
    }
    if (!saltedgeAppId || !saltedgeSecret) {
      return json({ error: "saltedge_env_missing" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearerToken) {
      return json({ error: "unauthorized", details: "missing_bearer_token" }, 401);
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(bearerToken);
    if (userError || !user) {
      return json({ error: "unauthorized", details: userError?.message ?? "invalid_jwt" }, 401);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: existingRows, error: existingError } = await adminClient
      .from("saltedge_customers")
      .select("customer_id")
      .eq("user_id", user.id)
      .limit(1);
    if (existingError) {
      console.error("Failed reading saltedge_customers:", existingError);
      return json({ error: "failed_to_read_saltedge_customers" }, 500);
    }

    const existingCustomerRaw = existingRows?.[0]?.customer_id;
    const existingCustomerId = existingCustomerRaw == null ? null : String(existingCustomerRaw).trim();
    if (existingCustomerId) {
      return json({ ok: true, customer_id: existingCustomerId });
    }

    const createRes = await fetch(`${SALTEDGE_BASE}/customers`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "App-id": saltedgeAppId,
        "Secret": saltedgeSecret,
      },
      body: JSON.stringify({
        data: {
          identifier: user.id,
        },
      }),
    });

    const createBody = await createRes.text();
    const createJson = createBody ? JSON.parse(createBody) : {};
    if (!createRes.ok) {
      console.error("Salt Edge customer create failed:", createJson);
      return json(
        {
          error: "saltedge_customer_create_failed",
          details: createJson?.error || createBody || `HTTP ${createRes.status}`,
        },
        502,
      );
    }

    const customerId = createJson?.data?.customer_id ?? createJson?.data?.id ?? null;
    if (!customerId) {
      console.error("Salt Edge customer create missing customer id:", createJson);
      return json({ error: "saltedge_customer_id_missing" }, 502);
    }

    const { data: afterRows, error: afterReadError } = await adminClient
      .from("saltedge_customers")
      .select("customer_id")
      .eq("user_id", user.id)
      .limit(1);
    if (afterReadError) {
      console.error("Failed reading saltedge_customers (after create):", afterReadError);
      return json({ error: "failed_to_read_saltedge_customers" }, 500);
    }

    if ((afterRows?.length ?? 0) > 0) {
      const { error: updateError } = await adminClient
        .from("saltedge_customers")
        .update({ customer_id: String(customerId) })
        .eq("user_id", user.id);
      if (updateError) {
        console.error("Failed updating saltedge_customers:", updateError);
        return json({ error: "failed_to_update_saltedge_customer" }, 500);
      }
    } else {
      const { error: insertError } = await adminClient
        .from("saltedge_customers")
        .insert({
          user_id: user.id,
          customer_id: String(customerId),
        });
      if (insertError) {
        console.error("Failed inserting saltedge_customers:", insertError);
        return json({ error: "failed_to_insert_saltedge_customer" }, 500);
      }
    }

    return json({
      ok: true,
      customer_id: String(customerId),
    });
  } catch (error) {
    console.error("Error in saltedge-create-customer:", error);
    return json({ error: error instanceof Error ? error.message : "internal_error" }, 500);
  }
});
