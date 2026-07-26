import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type Tier = "free" | "pro" | "premium";

export interface EntitlementResult {
  ok: boolean;
  error?: string;
}

/**
 * The full set of plan fields written to auth.users app_metadata / user_metadata.
 * Keeping a single canonical shape here means both the expiry sweep and the RTDN
 * webhook always write the same fields and never drift.
 */
export function planMetaFields(tier: Tier): Record<string, unknown> {
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

/**
 * Writes an entitlement tier to user_entitlements and clears / sets the matching
 * auth metadata fields in a single logical pass.
 *
 * Used by:
 * - play-billing-verify      (any tier,      source = "google_play")
 * - entitlement-expiry-sweep (tier = "free", source = "expiry_sweep")
 * - play-rtdn-webhook        (any tier,      source = "google_play_rtdn")
 *
 * Idempotent: calling with the same tier a second time is safe and a no-op in
 * effect, though it does issue the DB write.
 *
 * @param sb         A service-role Supabase client (bypasses RLS).
 * @param userId     auth.users UUID of the subscriber.
 * @param tier       The effective tier to record.
 * @param source     Audit label written to user_entitlements.source.
 * @param validUntil ISO-8601 expiry timestamp, or null if the tier is free or
 *                   expiry is unknown.
 */
export async function applyEntitlement(
  sb: SupabaseClient,
  userId: string,
  tier: Tier,
  source: string,
  validUntil: string | null,
): Promise<EntitlementResult> {
  const { error: entErr } = await sb.from("user_entitlements").upsert(
    {
      user_id: userId,
      tier,
      source,
      valid_until: validUntil,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (entErr) return { ok: false, error: `entitlement_upsert: ${entErr.message}` };

  const { data: adminData, error: userErr } = await sb.auth.admin.getUserById(userId);
  if (userErr || !adminData?.user) {
    return { ok: false, error: `user_lookup: ${userErr?.message ?? "missing_user"}` };
  }

  const fields = planMetaFields(tier);
  const { error: metaErr } = await sb.auth.admin.updateUserById(userId, {
    app_metadata: { ...(adminData.user.app_metadata ?? {}), ...fields },
    user_metadata: { ...(adminData.user.user_metadata ?? {}), ...fields },
  });
  if (metaErr) return { ok: false, error: `metadata_update: ${metaErr.message}` };

  return { ok: true };
}
