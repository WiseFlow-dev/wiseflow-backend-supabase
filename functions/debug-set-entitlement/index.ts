import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type Tier = "free" | "pro" | "premium";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function parseTier(input: unknown): Tier | null {
  const normalized = normalize(input).toLowerCase();
  if (normalized === "free" || normalized === "pro" || normalized === "premium") {
    return normalized;
  }
  return null;
}

function decodeJwtSub(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    const sub = normalize(payload?.sub);
    return sub || null;
  } catch {
    return null;
  }
}

function toPlanFields(tier: Tier) {
  const paid = tier === "pro" || tier === "premium";
  return {
    plan: tier,
    tier,
    subscription_tier: tier,
    plan_tier: tier,
    is_pro: paid,
    pro: paid,
    is_premium: tier === "premium",
    premium: tier === "premium",
  };
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const enabled = normalize(Deno.env.get("DEBUG_ENTITLEMENT_ENABLED")).toLowerCase() === "true";
    if (!enabled) return json(403, { error: "debug_entitlement_disabled" });

    const authHeader = req.headers.get("Authorization");
    const accessToken = normalize(authHeader).replace(/^Bearer\s+/i, "");
    if (!accessToken) return json(401, { error: "unauthorized" });

    const supabaseUrl = normalize(Deno.env.get("SUPABASE_URL"));
    const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    if (!supabaseUrl || !serviceRole) return json(500, { error: "missing_supabase_env" });

    const sb = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const { data: authData, error: authErr } = await sb.auth.getUser(accessToken);
    const directUser = authData?.user ?? null;
    let user = directUser;
    if (!user) {
      const tokenUserId = decodeJwtSub(accessToken);
      if (!tokenUserId) {
        return json(401, { error: "unauthorized_user" });
      }
      const { data: adminData, error: adminErr } = await sb.auth.admin.getUserById(tokenUserId);
      if (adminErr || !adminData?.user) {
        return json(401, { error: "unauthorized_user" });
      }
      user = adminData.user;
    }

    const body = await req.json().catch(() => ({}));
    const tier = parseTier((body as Record<string, unknown>)?.tier);
    if (!tier) return json(400, { error: "invalid_tier", allowed: ["free", "pro", "premium"] });

    const { error: upsertErr } = await sb.from("user_entitlements").upsert(
      {
        user_id: user.id,
        tier,
        source: "debug_override",
        valid_until: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (upsertErr) {
      return json(500, { error: "entitlement_upsert_failed", details: upsertErr.message });
    }

    const appMeta = { ...(user.app_metadata ?? {}) };
    const userMeta = { ...(user.user_metadata ?? {}) };
    const planFields = toPlanFields(tier);

    const { error: updateErr } = await sb.auth.admin.updateUserById(user.id, {
      app_metadata: { ...appMeta, ...planFields },
      user_metadata: { ...userMeta, ...planFields },
    });
    if (updateErr) {
      return json(500, { error: "auth_metadata_update_failed", details: updateErr.message });
    }

    return json(200, {
      ok: true,
      tier,
      source: "debug_override",
      userId: user.id,
    });
  } catch (error: any) {
    return json(500, { error: "debug_set_entitlement_failed", details: String(error?.message ?? error) });
  }
});
