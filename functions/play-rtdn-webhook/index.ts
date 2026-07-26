import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { applyEntitlement, type Tier } from "../_shared/billing.ts";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const VOIDED_PRODUCT_TYPE_SUBSCRIPTION = 1;

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

async function verifyPubSubOidcToken(req: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const expectedAudience = normalize(Deno.env.get("GOOGLE_PLAY_RTDN_OIDC_AUDIENCE"));
  const expectedEmail = normalize(Deno.env.get("GOOGLE_PLAY_RTDN_OIDC_EMAIL"));
  if (!expectedAudience || !expectedEmail) {
    return { ok: false, status: 500, error: "missing_rtdn_oidc_env" };
  }

  const authHeader = normalize(req.headers.get("Authorization"));
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) return { ok: false, status: 401, error: "missing_oidc_bearer" };
  const idToken = normalize(bearerMatch[1]);
  if (!idToken) return { ok: false, status: 401, error: "missing_oidc_token" };

  const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const tokenInfoRes = await fetch(tokenInfoUrl, { method: "GET" });
  const tokenInfo = await tokenInfoRes.json().catch(() => ({}));
  if (!tokenInfoRes.ok) return { ok: false, status: 401, error: "invalid_oidc_token" };

  const aud = normalize(tokenInfo?.aud);
  const email = normalize(tokenInfo?.email).toLowerCase();
  const emailVerified = String(tokenInfo?.email_verified ?? "").toLowerCase() === "true";
  const issuer = normalize(tokenInfo?.iss);
  const expSeconds = Number(tokenInfo?.exp ?? 0);

  if (aud !== expectedAudience) return { ok: false, status: 401, error: "invalid_oidc_audience" };
  if (email !== expectedEmail.toLowerCase()) return { ok: false, status: 401, error: "invalid_oidc_email" };
  if (!emailVerified) return { ok: false, status: 401, error: "unverified_oidc_email" };
  if (issuer !== "accounts.google.com" && issuer !== "https://accounts.google.com") {
    return { ok: false, status: 401, error: "invalid_oidc_issuer" };
  }
  if (!Number.isFinite(expSeconds) || expSeconds <= Math.floor(Date.now() / 1000)) {
    return { ok: false, status: 401, error: "expired_oidc_token" };
  }

  return { ok: true };
}

type ParsedRtdnPayload =
  | { kind: "subscription"; purchaseToken: string; subscriptionId: string }
  | { kind: "voided"; purchaseToken: string; orderId: string; productType: number | null; refundType: number | null }
  | { kind: "test" }
  | { kind: "one_time"; purchaseToken: string; sku: string; notificationType: number | null }
  | { kind: "unknown" };

function parsePubSubData(rawBody: any): ParsedRtdnPayload | null {
  const encoded = normalize(rawBody?.message?.data);
  if (!encoded) return null;
  let decodedText = "";
  try {
    decodedText = atob(encoded);
  } catch {
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(decodedText);
  } catch {
    return null;
  }

  if (payload?.subscriptionNotification) {
    const sub = payload.subscriptionNotification ?? {};
    const purchaseToken = normalize(sub?.purchaseToken);
    const subscriptionId = normalize(sub?.subscriptionId);
    if (!purchaseToken || !subscriptionId) return null;
    return { kind: "subscription", purchaseToken, subscriptionId };
  }

  if (payload?.voidedPurchaseNotification) {
    const voided = payload.voidedPurchaseNotification ?? {};
    const purchaseToken = normalize(voided?.purchaseToken);
    const orderId = normalize(voided?.orderId);
    const productTypeRaw = Number(voided?.productType);
    const refundTypeRaw = Number(voided?.refundType);
    if (!purchaseToken) return null;
    return {
      kind: "voided",
      purchaseToken,
      orderId,
      productType: Number.isFinite(productTypeRaw) ? productTypeRaw : null,
      refundType: Number.isFinite(refundTypeRaw) ? refundTypeRaw : null,
    };
  }

  if (payload?.testNotification) {
    return { kind: "test" };
  }

  if (payload?.oneTimeProductNotification) {
    const oneTime = payload.oneTimeProductNotification ?? {};
    const purchaseToken = normalize(oneTime?.purchaseToken);
    const sku = normalize(oneTime?.sku);
    const notificationTypeRaw = Number(oneTime?.notificationType);
    if (!purchaseToken || !sku) return null;
    return {
      kind: "one_time",
      purchaseToken,
      sku,
      notificationType: Number.isFinite(notificationTypeRaw) ? notificationTypeRaw : null,
    };
  }

  if (payload && typeof payload === "object") {
    return { kind: "unknown" };
  }

  return null;
}

function parseExpiryMillis(expiryIso: string): number | null {
  const ms = Date.parse(expiryIso);
  return Number.isFinite(ms) ? ms : null;
}

function isEntitled(subscriptionState: string, latestExpiryIso: string | null): boolean {
  const paidStates = new Set([
    "SUBSCRIPTION_STATE_ACTIVE",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  ]);
  if (paidStates.has(subscriptionState)) return true;
  const expiryMs = latestExpiryIso ? parseExpiryMillis(latestExpiryIso) : null;
  return expiryMs != null && expiryMs > Date.now();
}

function ackIgnored(reason: string, extra: Record<string, unknown> = {}) {
  return json(202, { ok: true, ignored: true, reason, ...extra });
}

async function applyVoidedSubscriptionEntitlement(
  sb: ReturnType<typeof createClient>,
  purchaseToken: string,
) {
  const { data: ownerRow, error: ownerErr } = await sb
    .from("play_purchase_tokens")
    .select("user_id")
    .eq("purchase_token", purchaseToken)
    .maybeSingle();

  if (ownerErr) {
    return json(500, { error: "token_registry_lookup_failed", details: ownerErr.message });
  }
  if (!ownerRow?.user_id) {
    return ackIgnored("unknown_purchase_token");
  }
  const userId = ownerRow.user_id as string;

  const applyResult = await applyEntitlement(
    sb,
    userId,
    "free",
    "google_play_voided_purchase",
    null,
  );
  if (!applyResult.ok) {
    return json(500, { error: "entitlement_apply_failed", details: applyResult.error });
  }

  return json(200, {
    ok: true,
    userId,
    finalTier: "free",
    source: "google_play_voided_purchase",
  });
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const oidcCheck = await verifyPubSubOidcToken(req);
    if (!oidcCheck.ok) {
      return json(oidcCheck.status, { error: oidcCheck.error });
    }

    const supabaseUrl = normalize(Deno.env.get("SUPABASE_URL"));
    const serviceRole = normalize(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
    if (!supabaseUrl || !serviceRole) return json(500, { error: "missing_supabase_env" });

    const proProductId = normalize(Deno.env.get("PLAY_PRO_SUBS_PRODUCT_ID")) || "wiseflow_pro";
    const premiumProductId = normalize(Deno.env.get("PLAY_PREMIUM_SUBS_PRODUCT_ID")) || "wiseflow_premium";
    const configuredPackageName = normalize(Deno.env.get("GOOGLE_PLAY_PACKAGE_NAME"));
    if (!configuredPackageName) return json(500, { error: "missing_google_play_package_name" });
    const serviceAccountRaw = normalize(Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
    if (!serviceAccountRaw) return json(500, { error: "missing_google_play_service_account_json" });

    const rawBody = await req.json().catch(() => ({}));
    const parsed = parsePubSubData(rawBody);
    if (!parsed) return json(400, { error: "invalid_rtdn_payload" });
    if (parsed.kind === "test") {
      console.log("play-rtdn-webhook.ignored", { reason: "test_notification" });
      return ackIgnored("test_notification");
    }
    if (parsed.kind === "unknown") {
      console.log("play-rtdn-webhook.ignored", { reason: "unknown_notification_type" });
      return ackIgnored("unknown_notification_type");
    }
    if (parsed.kind === "one_time") {
      console.log("play-rtdn-webhook.ignored", {
        reason: "one_time_product_notification",
        sku: parsed.sku,
        notificationType: parsed.notificationType,
      });
      return ackIgnored("one_time_product_notification");
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

    const packageName = configuredPackageName;
    const sb = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

    if (parsed.kind === "voided") {
      if (parsed.productType !== VOIDED_PRODUCT_TYPE_SUBSCRIPTION) {
        console.log("play-rtdn-webhook.ignored", {
          reason: "voided_non_subscription",
          productType: parsed.productType,
          refundType: parsed.refundType,
          orderId: parsed.orderId,
        });
        return ackIgnored("voided_non_subscription");
      }
      return await applyVoidedSubscriptionEntitlement(sb, parsed.purchaseToken);
    }

    const googleAccessToken = await getGoogleAccessToken(serviceAccount);
    const verifyUrl =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${
        encodeURIComponent(packageName)
      }/purchases/subscriptionsv2/tokens/${encodeURIComponent(parsed.purchaseToken)}`;

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

    const lineItems = Array.isArray(verifyJson?.lineItems) ? verifyJson.lineItems : [];
    const lineProductIds = lineItems
      .map((item: any) => normalize(item?.productId))
      .filter((id: string) => id.length > 0);

    let resolvedTier = deriveTierFromProductId(parsed.subscriptionId, proProductId, premiumProductId);
    if (lineProductIds.includes(premiumProductId)) resolvedTier = "premium";
    else if (lineProductIds.includes(proProductId)) resolvedTier = "pro";
    if (!resolvedTier) resolvedTier = "free";

    const validUntilCandidates = lineItems
      .map((item: any) => normalize(item?.expiryTime))
      .filter((v: string) => v.length > 0);
    const validUntil = validUntilCandidates.sort().at(-1) ?? null;
    const subscriptionState = normalize(verifyJson?.subscriptionState);

    const entitled = isEntitled(subscriptionState, validUntil);
    const finalTier: Tier = entitled ? (resolvedTier as Tier) : "free";

    // Resolve user from purchase token registry.
    const { data: ownerRow, error: ownerErr } = await sb
      .from("play_purchase_tokens")
      .select("user_id")
      .eq("purchase_token", parsed.purchaseToken)
      .maybeSingle();

    if (ownerErr) {
      return json(500, { error: "token_registry_lookup_failed", details: ownerErr.message });
    }
    if (!ownerRow?.user_id) {
      return json(202, { ok: true, ignored: true, reason: "unknown_purchase_token" });
    }
    const userId = ownerRow.user_id as string;

    const applyResult = await applyEntitlement(
      sb,
      userId,
      finalTier,
      "google_play_rtdn",
      finalTier === "free" ? null : validUntil,
    );
    if (!applyResult.ok) {
      return json(500, { error: "entitlement_apply_failed", details: applyResult.error });
    }

    return json(200, {
      ok: true,
      userId,
      finalTier,
      subscriptionState,
      validUntil,
      entitled,
    });
  } catch (error: any) {
    return json(500, { error: "play_rtdn_webhook_failed", details: String(error?.message ?? error) });
  }
});
