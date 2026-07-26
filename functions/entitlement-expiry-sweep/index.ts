import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { applyEntitlement } from "../_shared/billing.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
      },
    });
  }

  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Require service role bearer — this endpoint must never be publicly callable.
  const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  if (!serviceRole) return json(500, { error: "missing_supabase_service_role_key" });

  const authHeader = normalize(req.headers.get("Authorization"));
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  if (!bearer || bearer !== serviceRole) {
    return json(401, { error: "unauthorized_service_role_required" });
  }

  const supabaseUrl = normalize(Deno.env.get("SUPABASE_URL"));
  if (!supabaseUrl) return json(500, { error: "missing_supabase_url" });

  const sb = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  // Find all paid entitlement rows whose valid_until has passed according to
  // server time. We do not apply a client-side grace window here — the server
  // is the authoritative cutoff. Grace was a client-only concept (Phase 1) to
  // protect paying users on a flaky connection; the server sweep should be exact.
  const now = new Date().toISOString();
  const { data: expiredRows, error: queryErr } = await sb
    .from("user_entitlements")
    .select("user_id, tier, valid_until")
    .neq("tier", "free")
    .not("valid_until", "is", null)
    .lt("valid_until", now);

  if (queryErr) {
    console.error("entitlement-expiry-sweep.query_failed", { error: queryErr.message });
    return json(500, { error: "query_failed", details: queryErr.message });
  }

  const rows = expiredRows ?? [];
  const executedAt = new Date().toISOString();

  if (rows.length === 0) {
    console.log("entitlement-expiry-sweep.no_expired_rows", { executedAt });
    return json(200, { ok: true, changed: 0, failed: 0, total: 0, executedAt });
  }

  let changed = 0;
  let failed = 0;
  const failures: { userId: string; error: string }[] = [];

  for (const row of rows) {
    const userId = String(row.user_id ?? "");
    if (!userId) {
      failed++;
      failures.push({ userId: "(missing)", error: "null_user_id_in_row" });
      continue;
    }

    const result = await applyEntitlement(sb, userId, "free", "expiry_sweep", null);

    if (result.ok) {
      changed++;
      console.log("entitlement-expiry-sweep.downgraded", {
        userId,
        previousTier: row.tier,
        validUntil: row.valid_until,
      });
    } else {
      failed++;
      failures.push({ userId, error: result.error ?? "unknown" });
      console.error("entitlement-expiry-sweep.downgrade_failed", {
        userId,
        previousTier: row.tier,
        error: result.error,
      });
    }
  }

  const payload = {
    ok: failed === 0,
    changed,
    failed,
    total: rows.length,
    executedAt,
    ...(failures.length > 0 ? { failures } : {}),
  };

  console.log("entitlement-expiry-sweep.complete", payload);
  return json(200, payload);
});
