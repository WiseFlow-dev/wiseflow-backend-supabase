import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
} as const;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function getServiceClient() {
  const supabaseUrl = normalize(Deno.env.get("SUPABASE_URL"));
  const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!serviceRole) return json(500, { error: "missing_supabase_service_role_key" });

  const authHeader = normalize(req.headers.get("Authorization"));
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  if (!bearer || bearer !== serviceRole) {
    return json(401, { error: "unauthorized_service_role_required" });
  }

  let days = 90;
  const body = await req.json().catch(() => ({}));
  const rawDays = Number((body as Record<string, unknown>)?.days);
  if (Number.isFinite(rawDays) && rawDays >= 30 && rawDays <= 3650) {
    days = Math.trunc(rawDays);
  }

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.rpc("cleanup_stale_play_purchase_tokens", { p_days: days });

    if (error) {
      console.error("play-token-cleanup-cron.rpc_error", { message: error.message, details: error.details });
      return json(500, { error: "cleanup_rpc_failed", details: error.message });
    }

    const deleted = typeof data === "number" ? data : Number(data ?? 0);
    const payload = {
      ok: true,
      deleted,
      days,
      executedAt: new Date().toISOString(),
    };
    console.log("play-token-cleanup-cron.success", payload);
    return json(200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("play-token-cleanup-cron.error", { message });
    return json(500, { error: "cleanup_failed", details: message });
  }
});