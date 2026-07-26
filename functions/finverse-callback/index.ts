import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const FINVERSE_BASE_URL = "https://api.prod.finverse.net";
const FINVERSE_CALLBACK_URL =
  "https://gkwjbnvvluknfwnaxmay.supabase.co/functions/v1/finverse-callback";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_SIGNATURE_BYTES = 12;

const JSON_HEADERS = { "Content-Type": "application/json" };
const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const textEncoder = new TextEncoder();

type CallbackStage =
  | "request_validation"
  | "env_validation"
  | "provider_error_check"
  | "state_verification"
  | "state_user_lookup"
  | "customer_token"
  | "token_exchange"
  | "duplicate_recovery"
  | "connection_persist"
  | "item_upsert"
  | "sync_kick"
  | "completed";

function logStage(stage: CallbackStage, event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ source: "finverse-callback", stage, event, ...data }));
}

function redirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url, ...CORS_HEADERS },
  });
}

function safePreview(value: string, keep = 20): string {
  if (!value) return "";
  return value.length <= keep ? value : `${value.slice(0, keep)}...`;
}

function optionsResponse(): Response {
  return new Response("ok", {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function kickFinverseSync(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  loginIdentityId: string,
) {
  if (!supabaseUrl || !serviceRoleKey || !userId || !loginIdentityId) return;
  fetch(`${supabaseUrl}/functions/v1/finverse-sync-accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      user_id: userId,
      login_identity_id: loginIdentityId,
      source: "finverse-callback",
    }),
  }).then(async (response) => {
    const preview = await response.text().catch(() => "");
    logStage("sync_kick", "done", {
      userId,
      loginIdentityId,
      status: response.status,
      bodyPreview: safePreview(preview, 160),
    });
  }).catch((error) => {
    console.error("finverse-callback sync kick failed", {
      userId,
      loginIdentityId,
      error: error?.message || String(error),
    });
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function compactToUuid(compact: string): string | null {
  const bytes = fromBase64Url(compact);
  if (!bytes || bytes.length !== 16) return null;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function signStatePayload(payload: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return new Uint8Array(signature);
}

async function verifyStateAndGetUserId(rawState: string, secret: string): Promise<string | null> {
  const state = String(rawState || "").trim();
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [compactUserId, issuedAtRaw, nonce, providedSignature] = parts;
  if (!compactUserId || !issuedAtRaw || !nonce || !providedSignature) return null;
  const userId = compactToUuid(compactUserId);
  if (!userId) return null;
  const issuedAtMs = Number.parseInt(issuedAtRaw, 36);
  if (!Number.isFinite(issuedAtMs)) return null;
  const ageMs = Date.now() - issuedAtMs;
  if (ageMs < 0 || ageMs > STATE_MAX_AGE_MS) return null;
  const payload = `${compactUserId}.${issuedAtRaw}.${nonce}`;
  const expectedSignature = await signStatePayload(payload, secret);
  const expectedCompactSignature = toBase64Url(expectedSignature.slice(0, STATE_SIGNATURE_BYTES));
  return constantTimeEquals(expectedCompactSignature, providedSignature) ? userId : null;
}

async function getCustomerToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`${FINVERSE_BASE_URL}/auth/customer/token`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`customer_token_failed:${response.status}:${details}`);
  }

  const payload = await response.json();
  const token = String(
    payload?.customer_token ??
      payload?.access_token ??
      payload?.token ??
      payload?.data?.customer_token ??
      payload?.data?.access_token ??
      payload?.result?.customer_token ??
      payload?.result?.access_token ??
      "",
  ).trim();
  if (!token) {
    throw new Error(`customer_token_missing:keys=${Object.keys(payload ?? {}).join(",")}`);
  }
  return token;
}

serve(async (req) => {
  const startedAt = Date.now();
  let stage: CallbackStage = "request_validation";

  const fail = (reason: string, description?: string | null, details?: string | null) => {
    const params = new URLSearchParams({
      status: "error",
      reason,
      stage,
    });
    if (description) params.set("description", description);
    if (details) params.set("details", details);
    const deepLink = `wiseflow://finverse/callback?${params.toString()}`;
    console.error("finverse-callback redirecting failure", {
      reason,
      description,
      details,
      stage,
      deepLink,
    });
    return redirect(deepLink);
  };

  try {
    logStage(stage, "start", { method: req.method });
    const requestUrl = new URL(req.url);
    logStage(stage, "incoming_request", {
      method: req.method,
      path: requestUrl.pathname,
      queryKeys: Array.from(requestUrl.searchParams.keys()),
      stateLength: requestUrl.searchParams.get("state")?.length ?? 0,
      codePresent: requestUrl.searchParams.has("code"),
      errorPresent: requestUrl.searchParams.has("error"),
    });

    if (req.method === "OPTIONS") {
      logStage(stage, "options_response");
      return optionsResponse();
    }
    if (req.method !== "GET") {
      console.warn("finverse-callback method not allowed", { method: req.method, stage });
      return new Response("Method not allowed", {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    stage = "env_validation";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const clientId = Deno.env.get("FINVERSE_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("FINVERSE_CLIENT_SECRET") ?? "";

    if (!supabaseUrl || !serviceRoleKey || !clientId || !clientSecret) {
      return fail("server_env_missing");
    }

    const code = requestUrl.searchParams.get("code")?.trim() || "";
    const state = requestUrl.searchParams.get("state")?.trim() || "";
    const institutionId = requestUrl.searchParams.get("institution_id")?.trim() || null;
    const requestedLoginIdentityId =
      requestUrl.searchParams.get("login_identity_id")?.trim() || null;
    const providerError = requestUrl.searchParams.get("error")?.trim() || "";
    const providerErrorDescription = requestUrl.searchParams.get("error_description")?.trim() || "";
    const providerErrorDetails = requestUrl.searchParams.get("error_details")?.trim() || "";

    stage = "provider_error_check";
    if (providerError) {
      console.error("finverse-callback provider error", {
        providerError,
        providerErrorDescription,
        providerErrorDetails,
        institutionId,
        stage,
      });
      return fail(
        providerError,
        providerErrorDescription || providerError,
        providerErrorDetails || null,
      );
    }

    if (!code || !state) {
      return fail("missing_code_or_state");
    }

    stage = "state_verification";
    const userId = await verifyStateAndGetUserId(state, clientSecret);
    if (!userId) {
      return fail("invalid_state");
    }
    logStage(stage, "done", {
      userId,
      institutionId,
      codePreview: safePreview(code),
    });

    stage = "state_user_lookup";
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
    if (userErr || !userData?.user?.id) {
      return fail("state_user_not_found");
    }

    stage = "customer_token";
    const customerToken = await getCustomerToken(clientId, clientSecret);

    stage = "token_exchange";
    const tokenForm = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: FINVERSE_CALLBACK_URL,
      grant_type: "authorization_code",
    });

    const tokenResponse = await fetch(`${FINVERSE_BASE_URL}/auth/token`, {
      method: "POST",
      headers: {
        ...FORM_HEADERS,
        Authorization: `Bearer ${customerToken}`,
      },
      body: tokenForm.toString(),
    });

    if (!tokenResponse.ok) {
      const details = await tokenResponse.text().catch(() => "");
      console.error("finverse-callback auth/token failed", {
        stage,
        status: tokenResponse.status,
        details: safePreview(details, 300),
      });
      const tokenErrorPayload = (() => {
        try {
          return JSON.parse(details);
        } catch {
          return null;
        }
      })();
      const tokenErrorCode = String(tokenErrorPayload?.error?.error_code || "").trim();
      if (tokenResponse.status === 400 && tokenErrorCode === "INVALID_GRANT" && requestedLoginIdentityId) {
        stage = "duplicate_recovery";
        const { data: existingConn, error: existingConnErr } = await admin
          .from("finverse_connections")
          .select("login_identity_id, access_token")
          .eq("user_id", userId)
          .eq("login_identity_id", requestedLoginIdentityId)
          .maybeSingle();

        if (!existingConnErr && existingConn?.login_identity_id) {
          const { error: itemErr } = await admin
            .from("plaid_items")
            .upsert(
              {
                user_id: userId,
                item_id: requestedLoginIdentityId,
                access_token: existingConn.access_token,
                provider: "finverse",
              },
              { onConflict: "user_id,item_id" },
            );

          if (!itemErr) {
            const deepLink =
              `wiseflow://finverse/callback?status=success&login_identity_id=${encodeURIComponent(requestedLoginIdentityId)}`;
            logStage(stage, "recovered_duplicate_as_success", {
              userId,
              requestedLoginIdentityId,
              deepLink,
            });
            return redirect(deepLink);
          }
          console.error("finverse-callback duplicate recovery plaid_items failed:", itemErr);
        }
      }
      return fail(
        "token_exchange_failed",
        `finverse_auth_token_${tokenResponse.status}`,
        details || null,
      );
    }

    const tokenPayload = await tokenResponse.json();
    const loginIdentityId = String(tokenPayload?.login_identity_id || "").trim();
    const accessToken = String(tokenPayload?.access_token || "").trim();
    const refreshToken = String(tokenPayload?.refresh_token || "").trim() || null;

    if (!loginIdentityId || !accessToken) {
      console.error("finverse-callback token payload missing fields", {
        stage,
        payloadKeys: Object.keys(tokenPayload ?? {}),
      });
      return fail("token_payload_missing_fields");
    }
    logStage("token_exchange", "done", {
      userId,
      loginIdentityId,
      accessTokenPreview: safePreview(accessToken),
      hasRefreshToken: Boolean(refreshToken),
    });

    stage = "connection_persist";
    const nowIso = new Date().toISOString();
    const { error: connErr } = await admin
      .from("finverse_connections")
      .upsert(
        {
          user_id: userId,
          login_identity_id: loginIdentityId,
          institution_id: institutionId,
          status: "LINKED",
          access_token: accessToken,
          refresh_token: refreshToken,
          updated_at: nowIso,
        },
        { onConflict: "user_id,login_identity_id" },
      );

    if (connErr) {
      console.error("finverse_connections upsert failed:", connErr);
      return fail("connection_persist_failed");
    }

    stage = "item_upsert";
    const { error: itemErr } = await admin
      .from("plaid_items")
      .upsert(
        {
          user_id: userId,
          item_id: loginIdentityId,
          access_token: accessToken,
          provider: "finverse",
        },
        { onConflict: "user_id,item_id" },
      );

    if (itemErr) {
      console.error("plaid_items finverse upsert failed:", itemErr);
      return fail("item_upsert_failed");
    }

    stage = "sync_kick";
    const deepLink =
      `wiseflow://finverse/callback?status=success&login_identity_id=${encodeURIComponent(loginIdentityId)}`;
    logStage(stage, "kicking_sync", {
      userId,
      loginIdentityId,
      deepLink,
    });
    kickFinverseSync(supabaseUrl, serviceRoleKey, userId, loginIdentityId);
    stage = "completed";
    logStage(stage, "success", {
      userId,
      loginIdentityId,
      duration_ms: Date.now() - startedAt,
    });
    return redirect(deepLink);
  } catch (error: any) {
    console.error("finverse-callback error:", {
      stage,
      duration_ms: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    return fail(error?.message || "internal_error");
  }
});
