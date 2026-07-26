import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const JSON_HEADERS = { "Content-Type": "application/json" };
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS,GET",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WebhookStage =
  | "request_validation"
  | "payload_parse"
  | "env_validation"
  | "resolve_user"
  | "persist_event"
  | "sync_kick"
  | "completed";

function logStage(stage: WebhookStage, event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ source: "finverse-webhook", stage, event, ...data }));
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...CORS_HEADERS },
  });
}

function safeBodyPreview(value: string, keep = 500): string {
  if (!value) return "";
  return value.length <= keep ? value : `${value.slice(0, keep)}...`;
}

async function getFcmAccessToken(serviceAccount: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const signingInput = `${header}.${payload}`;
  const pemKey = serviceAccount.private_key.replace(/\\n/g, "\n");
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signingInput}.${sig}`,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => "unknown");
    throw new Error(`OAuth2 token exchange failed: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function pushBankSyncToUser(admin: any, userId: string | null): Promise<void> {
  if (!userId) return;
  if (!FCM_SERVICE_ACCOUNT_JSON) {
    console.warn("finverse-webhook: FCM_SERVICE_ACCOUNT not set - skipping bank_sync push");
    return;
  }

  const { data: rows, error } = await admin
    .from("device_tokens")
    .select("token")
    .eq("user_id", userId);

  if (error || !rows || rows.length === 0) {
    console.log(`finverse-webhook: no device tokens for user=${userId} - skipping bank_sync push`);
    return;
  }

  let accessToken: string;
  let projectId: string;
  try {
    const serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    projectId = serviceAccount.project_id;
    accessToken = await getFcmAccessToken(serviceAccount);
  } catch (error: any) {
    console.error("finverse-webhook: failed to prepare FCM push", {
      userId,
      error: error?.message || String(error),
    });
    return;
  }

  let successCount = 0;
  const deadTokens: string[] = [];
  for (const row of rows) {
    const token = String(row?.token ?? "");
    if (!token) continue;
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              data: { type: "bank_sync" },
              android: { priority: "HIGH" },
            },
          }),
        },
      );
      if (response.ok) {
        successCount += 1;
      } else {
        const body = await response.json().catch(() => null);
        const status = body?.error?.status ?? "";
        if (status === "NOT_FOUND" || status === "UNREGISTERED") {
          deadTokens.push(token);
        } else {
          console.warn(`finverse-webhook: FCM push failed ${response.status}`, body);
        }
      }
    } catch (error: any) {
      console.warn("finverse-webhook: FCM push error", { error: error?.message || String(error) });
    }
  }

  if (deadTokens.length > 0) {
    const { error: deleteError } = await admin
      .from("device_tokens")
      .delete()
      .eq("user_id", userId)
      .in("token", deadTokens);
    if (deleteError) {
      console.warn("finverse-webhook: failed to delete dead FCM tokens", { error: deleteError.message });
    }
  }

  console.log(`finverse-webhook: bank_sync push complete ${successCount}/${rows.length} for user=${userId}`);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
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

function tryUserIdFromState(state: unknown): string | null {
  const raw = String(state ?? "").trim();
  if (!raw) return null;

  if (raw.includes(".")) {
    const [compactUserId] = raw.split(".", 1);
    const userId = compactToUuid(compactUserId);
    if (userId && UUID_RE.test(userId)) return userId;
  }

  if (raw.includes(":")) {
    const [maybeUuid] = raw.split(":", 1);
    if (UUID_RE.test(maybeUuid)) return maybeUuid;
  }

  return UUID_RE.test(raw) ? raw : null;
}

function headerObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

function shouldKickSync(eventType: string | null): boolean {
  return eventType === "ONLINE_TRANSACTIONS_RETRIEVED" ||
    eventType === "HISTORICAL_TRANSACTIONS_RETRIEVED" ||
    eventType === "DATA_RETRIEVAL_COMPLETE";
}

async function kickFinverseSync(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string | null,
  loginIdentityId: string | null,
  eventType: string | null,
): Promise<boolean> {
  if (!supabaseUrl || !serviceRoleKey || !userId || !loginIdentityId || !shouldKickSync(eventType)) {
    return false;
  }

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/finverse-sync-accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        login_identity_id: loginIdentityId,
        source: "finverse-webhook",
        event_type: eventType,
      }),
    });
    const preview = await response.text().catch(() => "");
    logStage("sync_kick", "done", {
      userId,
      loginIdentityId,
      eventType,
      status: response.status,
      bodyPreview: safeBodyPreview(preview, 240),
    });
    return response.ok;
  } catch (error: any) {
    console.error("finverse-webhook: sync kick failed", {
      userId,
      loginIdentityId,
      eventType,
      error: error?.message || String(error),
    });
    return false;
  }
}

async function resolveUserIdFromLoginIdentity(
  admin: any,
  loginIdentityId: string | null,
): Promise<string | null> {
  if (!loginIdentityId) return null;
  const { data, error } = await admin
    .from("finverse_connections")
    .select("user_id")
    .eq("login_identity_id", loginIdentityId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("finverse-webhook: failed to resolve user by login_identity_id", {
      loginIdentityId,
      error,
    });
    return null;
  }
  return typeof data?.user_id === "string" ? data.user_id : null;
}

serve(async (req) => {
  const startedAt = Date.now();
  let stage: WebhookStage = "request_validation";

  const ack = (
    stored: boolean,
    reason: string,
    extra: Record<string, unknown> = {},
  ) =>
    json(200, {
      ok: true,
      stored,
      reason,
      stage,
      duration_ms: Date.now() - startedAt,
      ...extra,
    });

  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    logStage(stage, "options_response", {
      path: url.pathname,
      queryKeys: Array.from(url.searchParams.keys()),
    });
    return new Response("ok", {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  stage = "payload_parse";
  const rawBody = await req.text().catch(() => "");
  let payload: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  if (rawBody.trim().length > 0) {
    try {
      payload = JSON.parse(rawBody);
    } catch (error: any) {
      parseError = error?.message || "json_parse_failed";
    }
  }

  const eventType = typeof payload?.event_type === "string" ? payload.event_type : null;
  const eventTime =
    typeof payload?.event_time === "string" && payload.event_time.trim()
      ? payload.event_time
      : null;
  const loginIdentityId =
    typeof payload?.login_identity_id === "string" && payload.login_identity_id.trim()
      ? payload.login_identity_id.trim()
      : null;
  const institutionId =
    typeof payload?.institution_id === "string" && payload.institution_id.trim()
      ? payload.institution_id.trim()
      : null;
  const state =
    typeof payload?.state === "string" && payload.state.trim() ? payload.state.trim() : null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  logStage(stage, "received", {
    method: req.method,
    path: url.pathname,
    queryKeys: Array.from(url.searchParams.keys()),
    contentType: req.headers.get("content-type"),
    userAgent: req.headers.get("user-agent"),
    eventType,
    loginIdentityId,
    institutionId,
    hasState: Boolean(state),
    parseError,
    bodyPreview: safeBodyPreview(rawBody),
  });

  stage = "env_validation";
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("finverse-webhook: missing supabase env", { stage });
    return ack(false, "env_missing");
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  stage = "resolve_user";
  const derivedUserId =
    tryUserIdFromState(state) || (await resolveUserIdFromLoginIdentity(admin, loginIdentityId));

  const row = {
    user_id: derivedUserId,
    login_identity_id: loginIdentityId,
    institution_id: institutionId,
    event_type: eventType,
    event_time: eventTime,
    state,
    request_method: req.method,
    request_path: url.pathname,
    query_params: queryObject(url),
    headers: headerObject(req.headers),
    payload,
    payload_raw: rawBody,
    parse_error: parseError,
  };

  stage = "persist_event";
  const { data, error } = await admin
    .from("finverse_webhook_events")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.error("finverse-webhook: insert failed", { error, rowPreview: row });
    return ack(false, "insert_failed");
  }

  logStage(stage, "stored_event", {
    rowId: data?.id,
    derivedUserId,
    eventType,
    loginIdentityId,
  });

  stage = "sync_kick";
  const syncKicked = await kickFinverseSync(supabaseUrl, serviceRoleKey, derivedUserId, loginIdentityId, eventType);
  if (syncKicked) {
    await pushBankSyncToUser(admin, derivedUserId);
  }

  stage = "completed";
  logStage(stage, "success", {
    id: data?.id ?? null,
    derivedUserId,
    eventType,
    loginIdentityId,
    duration_ms: Date.now() - startedAt,
  });

  return ack(true, "stored", { id: data?.id ?? null });
});
