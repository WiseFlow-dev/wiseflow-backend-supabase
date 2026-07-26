import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const FINVERSE_BASE_URL = "https://api.prod.finverse.net";
const FINVERSE_CALLBACK_URL =
  "https://gkwjbnvvluknfwnaxmay.supabase.co/functions/v1/finverse-callback";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_NONCE_BYTES = 6;
const STATE_SIGNATURE_BYTES = 12;

const JSON_HEADERS = { "Content-Type": "application/json" };
const textEncoder = new TextEncoder();

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
function userHasProAccess(user: any): boolean {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const truthyFlag = (value: unknown) => value === true || asLower(value) === "true" || asLower(value) === "1";
  if (truthyFlag(appMeta["is_premium"]) || truthyFlag(appMeta["premium"]) || truthyFlag(userMeta["is_premium"]) || truthyFlag(userMeta["premium"])) return true;
  return [appMeta["plan"], appMeta["tier"], appMeta["subscription_tier"], appMeta["subscription_plan"], userMeta["plan"], userMeta["tier"], userMeta["subscription_tier"], userMeta["subscription_plan"]]
    .map(asLower).filter(Boolean)
    .some((v) => v === "premium" || v.startsWith("premium_"));
}

function safePreview(value: string, keep = 12): string {
  if (!value) return "";
  return value.length <= keep ? value : `${value.slice(0, keep)}...`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromHexPair(pair: string): number {
  return Number.parseInt(pair, 16);
}

function uuidToCompact(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("invalid_user_id");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = fromHexPair(hex.slice(i * 2, i * 2 + 2));
  }
  return toBase64Url(bytes);
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
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

async function buildSignedState(userId: string, nonce: string, secret: string): Promise<string> {
  const compactUserId = uuidToCompact(userId);
  const issuedAt = Date.now().toString(36);
  const safeNonce = nonce || randomBase64Url(STATE_NONCE_BYTES);
  const payload = `${compactUserId}.${issuedAt}.${safeNonce}`;
  const signature = await signStatePayload(payload, secret);
  const compactSignature = toBase64Url(signature.slice(0, STATE_SIGNATURE_BYTES));
  return `${payload}.${compactSignature}`;
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
  try {
    if (req.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(401, { error: "Missing authorization header" });
    }
    const [scheme, accessToken] = authHeader.split(" ");
    if (scheme !== "Bearer" || !accessToken) {
      return json(401, { error: "Invalid authorization header" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const clientId = Deno.env.get("FINVERSE_CLIENT_ID") ?? "";
    const clientSecret = Deno.env.get("FINVERSE_CLIENT_SECRET") ?? "";

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(500, { error: "Supabase env is not configured" });
    }
    if (!clientId || !clientSecret) {
      return json(500, { error: "Finverse env is not configured" });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !user) {
      return json(401, { error: "Unauthorized" });
    }
    if (!userHasProAccess(user)) {
      return json(403, { error: "pro_required", message: "Bank connection is Premium only." });
    }

    const body = await req.json().catch(() => ({}));
    const stateNonce = randomBase64Url(STATE_NONCE_BYTES);
    const state = await buildSignedState(user.id, stateNonce, clientSecret);
    console.log("finverse-create-link: issuing link", {
      userId: user.id,
      stateLength: state.length,
      statePreview: safePreview(state),
    });

    const customerToken = await getCustomerToken(clientId, clientSecret);

    const linkResponse = await fetch(`${FINVERSE_BASE_URL}/link/token`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        customer_token: customerToken,
        client_id: clientId,
        grant_type: "client_credentials",
        expires_in: Math.floor(STATE_MAX_AGE_MS / 1000),
        redirect_uri: FINVERSE_CALLBACK_URL,
        response_mode: "query",
        response_type: "code",
        state,
        user_id: user.id,
        ui_mode: "auto_redirect",
      }),
    });

    if (!linkResponse.ok) {
      const details = await linkResponse.text().catch(() => "");
      console.error("finverse-create-link: link/token failed", {
        status: linkResponse.status,
        details,
      });
      return json(502, { error: "link_token_failed", details });
    }

    const linkPayload = await linkResponse.json();
    const linkUrl = String(linkPayload?.link_url ?? "").trim();
    if (!linkUrl) {
      console.error("finverse-create-link: link_url missing", {
        payloadKeys: Object.keys(linkPayload ?? {}),
      });
      return json(502, { error: "link_url_missing" });
    }

    console.log("finverse-create-link: link ready", {
      userId: user.id,
      linkUrlPreview: safePreview(linkUrl, 60),
    });

    return json(200, {
      ok: true,
      link_url: linkUrl,
      state,
    });
  } catch (error: any) {
    console.error("finverse-create-link error:", error);
    return json(500, { error: error?.message || "Internal server error" });
  }
});


