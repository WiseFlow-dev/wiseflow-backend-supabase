import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { applyEntitlement, type Tier } from "../_shared/billing.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function toBase64Url(input: Uint8Array): string {
  let binary = "";
  for (const b of input) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromPemPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function signJwt(assertionHeader: object, assertionPayload: object, privateKeyPem: string): Promise<string> {
  const headerPart = toBase64Url(new TextEncoder().encode(JSON.stringify(assertionHeader)));
  const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(assertionPayload)));
  const signingInput = `${headerPart}.${payloadPart}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromPemPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    String(serviceAccount.private_key ?? ""),
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    throw new Error(`google_oauth_failed:${tokenRes.status}:${JSON.stringify(tokenJson)}`);
  }
  const token = normalize(tokenJson?.access_token);
  if (!token) throw new Error("google_oauth_missing_access_token");
  return token;
}

function deriveTierFromProductId(productId: string, proId: string, premiumId: string): Tier | null {
  if (productId === premiumId) return "premium";
  if (productId === proId) return "pro";
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
      });
    }

    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const authHeader = req.headers.get("Authorization");
    const accessToken = normalize(authHeader).replace(/^Bearer\s+/i, "");
    if (!accessToken) return json(401, { error: "unauthorized" });

    const supabaseUrl = normalize(Deno.env.get("SUPABASE_URL"));
    const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    if (!supabaseUrl || !serviceRole) return json(500, { error: "missing_supabase_env" });

    const proProductId = normalize(Deno.env.get("PLAY_PRO_SUBS_PRODUCT_ID")) || "wiseflow_pro";
    const premiumProductId = normalize(Deno.env.get("PLAY_PREMIUM_SUBS_PRODUCT_ID")) || "wiseflow_premium";
    const configuredPackageName = normalize(Deno.env.get("GOOGLE_PLAY_PACKAGE_NAME"));
    const serviceAccountRaw = normalize(Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
    if (!configuredPackageName) return json(500, { error: "missing_google_play_package_name" });
    if (!serviceAccountRaw) return json(500, { error: "missing_google_play_service_account_json" });

    const body = await req.json().catch(() => ({}));
    const productId = normalize(body?.productId ?? body?.product_id);
    const purchaseToken = normalize(body?.purchaseToken ?? body?.purchase_token);
    const packageName = configuredPackageName;

    if (!productId || !purchaseToken || !packageName) {
      return json(400, {
        error: "missing_required_fields",
        required: ["productId", "purchaseToken"],
      });
    }

    const requestedTier = deriveTierFromProductId(productId, proProductId, premiumProductId);
    if (!requestedTier) {
      return json(400, { error: "unknown_product_id", productId });
    }

    const sbAuth = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const sb = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false },
    });

    const { data: authData, error: authErr } = await sbAuth.auth.getUser(accessToken);
    if (authErr || !authData?.user) return json(401, { error: "unauthorized_user" });
    const user = authData.user;
    const expectedObfuscatedAccountId = await sha256Hex(user.id);

    const { data: existingOwner, error: ownerLookupErr } = await sb
      .from("play_purchase_tokens")
      .select("user_id")
      .eq("purchase_token", purchaseToken)
      .maybeSingle();
    if (ownerLookupErr) {
      return json(500, { error: "purchase_token_owner_lookup_failed", details: ownerLookupErr.message });
    }
    if (existingOwner?.user_id && existingOwner.user_id !== user.id) {
      return json(409, { error: "purchase_token_owned_by_other_user" });
    }

    let serviceAccount: any;
    try {
      serviceAccount = JSON.parse(serviceAccountRaw);
    } catch {
      return json(500, { error: "invalid_google_service_account_json" });
    }
    if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
      return json(500, { error: "invalid_google_service_account_fields" });
    }

    const googleAccessToken = await getGoogleAccessToken(serviceAccount);
    const verifyUrl =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${
        encodeURIComponent(packageName)
      }/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

    const verifyRes = await fetch(verifyUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    });
    const verifyJson = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
      return json(400, {
        error: "google_verify_failed",
        status: verifyRes.status,
        details: verifyJson,
      });
    }

    const subscriptionState = normalize(verifyJson?.subscriptionState);
    const allowedStates = new Set(["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"]);
    if (!allowedStates.has(subscriptionState)) {
      return json(409, {
        error: "subscription_not_active",
        subscriptionState,
      });
    }

    const verifiedObfuscatedAccountId = normalize(
      verifyJson?.externalAccountIdentifiers?.obfuscatedExternalAccountId,
    );
    const obfuscatedStrictRaw = normalize(Deno.env.get("PLAY_REQUIRE_OBFUSCATED_ACCOUNT_ID")).toLowerCase();
    const requireObfuscatedMatch = obfuscatedStrictRaw === "true" || obfuscatedStrictRaw === "1";
    if (!verifiedObfuscatedAccountId && requireObfuscatedMatch) {
      return json(409, { error: "missing_obfuscated_external_account_id" });
    }
    if (!verifiedObfuscatedAccountId && !requireObfuscatedMatch) {
      console.warn("play-billing-verify: missing obfuscatedExternalAccountId while strict mode is disabled");
    }
    if (verifiedObfuscatedAccountId && verifiedObfuscatedAccountId !== expectedObfuscatedAccountId) {
      return json(409, { error: "obfuscated_account_mismatch" });
    }

    const lineItems = Array.isArray(verifyJson?.lineItems) ? verifyJson.lineItems : [];
    const lineProductIds = lineItems
      .map((item: any) => normalize(item?.productId))
      .filter((id: string) => id.length > 0);

    if (lineProductIds.length === 0) {
      return json(409, { error: "no_line_items_in_verify_response" });
    }

    let resolvedTier: Tier = lineProductIds.includes(premiumProductId)
      ? "premium"
      : lineProductIds.includes(proProductId)
      ? "pro"
      : "free";
    if (resolvedTier === "free") {
      return json(409, { error: "unknown_line_item_product" });
    }

    const validUntilCandidates = lineItems
      .map((item: any) => normalize(item?.expiryTime))
      .filter((v: string) => v.length > 0);
    const validUntil = validUntilCandidates.sort().at(-1) ?? null;

    const { error: tokenErr } = await sb.from("play_purchase_tokens").upsert(
      {
        purchase_token: purchaseToken,
        user_id: user.id,
        product_id: productId,
        package_name: packageName,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "purchase_token" },
    );
    if (tokenErr) {
      return json(500, { error: "purchase_token_upsert_failed", details: tokenErr.message });
    }

    const applyResult = await applyEntitlement(
      sb,
      user.id,
      resolvedTier,
      "google_play",
      validUntil,
    );
    if (!applyResult.ok) {
      return json(500, { error: "entitlement_apply_failed", details: applyResult.error });
    }

    return json(200, {
      ok: true,
      tier: resolvedTier,
      subscriptionState,
      validUntil,
      source: "google_play",
      productId,
    });
  } catch (error: any) {
    return json(500, { error: "play_billing_verify_failed", details: String(error?.message ?? error) });
  }
});
