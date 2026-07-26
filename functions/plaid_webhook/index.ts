// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { verifyPlaidWebhook } from "../_shared/plaid-webhook-verify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
const PLAID_ENV = Deno.env.get("PLAID_ENV") ?? "production";
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT");

const PLAID_BASE_URL =
  PLAID_ENV === "sandbox"
    ? "https://sandbox.plaid.com"
    : "https://production.plaid.com";

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── FCM V1 API push ───────────────────────────────────────────────────────────

/**
 * Gets a short-lived OAuth2 access token from the Firebase service account
 * using a manually constructed JWT — no external libraries needed.
 */
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

  const jwt = `${signingInput}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => "unknown");
    throw new Error(`OAuth2 token exchange failed: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

/**
 * Sends a silent FCM data push ("bank_sync") to every device token registered
 * for the given user. Uses FCM HTTP V1 API with service account auth.
 * Failures are logged but never throw — a missed push is gracefully covered
 * by the 1-hour BankRefreshWorker fallback on the device.
 */
async function pushBankSyncToUser(
  sb: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  if (!FCM_SERVICE_ACCOUNT_JSON) {
    console.warn("[plaid_webhook] FCM_SERVICE_ACCOUNT not set - skipping push");
    return;
  }

  const { data: rows, error } = await sb
    .from("device_tokens")
    .select("token")
    .eq("user_id", userId);

  if (error || !rows || rows.length === 0) {
    console.log(`[plaid_webhook] No device tokens for user=${userId} - skipping push`);
    return;
  }

  const tokens: string[] = rows.map((r: { token: string }) => r.token);
  console.log(`[plaid_webhook] Sending bank_sync push to ${tokens.length} device(s) for user=${userId}`);

  let accessToken: string;
  let projectId: string;
  try {
    const serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    projectId = serviceAccount.project_id;
    accessToken = await getFcmAccessToken(serviceAccount);
  } catch (e: any) {
    console.error(`[plaid_webhook] Failed to get FCM access token: ${e?.message}`);
    return;
  }

  // FCM V1 API sends one message per token
  let successCount = 0;
  const deadTokens: string[] = [];

  for (const token of tokens) {
    try {
      const res = await fetch(
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
      if (res.ok) {
        successCount++;
      } else {
        const body = await res.json().catch(() => null);
        const errorStatus = body?.error?.status ?? "";
        if (errorStatus === "NOT_FOUND" || errorStatus === "UNREGISTERED") {
          // Token is stale — device uninstalled or re-registered. Mark for cleanup.
          deadTokens.push(token);
          console.log(`[plaid_webhook] Dead FCM token detected, will remove: ${token.slice(0, 20)}...`);
        } else {
          console.warn(`[plaid_webhook] FCM push failed for token: ${res.status} ${JSON.stringify(body)}`);
        }
      }
    } catch (e: any) {
      console.warn(`[plaid_webhook] FCM push error for token: ${e?.message}`);
    }
  }

  // Delete dead tokens so they don't accumulate
  if (deadTokens.length > 0) {
    const { error: deleteError } = await sb
      .from("device_tokens")
      .delete()
      .eq("user_id", userId)
      .in("token", deadTokens);
    if (deleteError) {
      console.warn(`[plaid_webhook] Failed to delete dead tokens: ${deleteError.message}`);
    } else {
      console.log(`[plaid_webhook] Removed ${deadTokens.length} dead FCM token(s) for user=${userId}`);
    }
  }

  console.log(`[plaid_webhook] FCM push complete: ${successCount}/${tokens.length} succeeded`);
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Plaid requires HTTP 200 for all webhook deliveries — even for unexpected
  // methods or malformed bodies. Always return 200 so Plaid does not retry.
  if (req.method !== "POST") return json({ received: true });

  // Read the raw body bytes first — needed for SHA-256 body hash verification.
  let rawBody: Uint8Array;
  try {
    rawBody = new Uint8Array(await req.arrayBuffer());
  } catch {
    console.warn("[plaid_webhook] Failed to read request body");
    return json({ received: true });
  }

  // Parse JSON from the already-consumed body.
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    console.warn("[plaid_webhook] Failed to parse request body as JSON");
    return json({ received: true });
  }

  // ── Signature Verification ────────────────────────────────────────────────
  const verificationToken = req.headers.get("Plaid-Verification");

  if (!verificationToken) {
    console.warn("[plaid_webhook] Missing Plaid-Verification header — skipping side effects");
    return json({ received: true });
  }

  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    console.error("[plaid_webhook] Missing PLAID_CLIENT_ID or PLAID_SECRET env vars — skipping side effects");
    return json({ received: true });
  }

  const verifyResult = await verifyPlaidWebhook(verificationToken, rawBody, {
    plaidClientId: PLAID_CLIENT_ID,
    plaidSecret: PLAID_SECRET,
    plaidBaseUrl: PLAID_BASE_URL,
  });

  if (!verifyResult.ok) {
    console.error(
      `[plaid_webhook] Signature verification FAILED — reason=${verifyResult.reason} — skipping side effects`,
    );
    return json({ received: true });
  }

  // ── Verified — process the webhook ───────────────────────────────────────
  const webhookType: string = payload?.webhook_type ?? "";
  const webhookCode: string = payload?.webhook_code ?? "";
  const itemId: string = payload?.item_id ?? "";

  console.log(`[plaid_webhook] VERIFIED type=${webhookType} code=${webhookCode} item=${itemId}`);

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error("[plaid_webhook] Missing SUPABASE_URL or SERVICE_ROLE env vars");
    return json({ received: true });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  try {
    if (
      webhookType === "TRANSACTIONS" &&
      (webhookCode === "SYNC_UPDATES_AVAILABLE" || webhookCode === "DEFAULT_UPDATE")
    ) {
      if (itemId) {
        const syncUrl = `${SUPABASE_URL}/functions/v1/sync-transactions`;
        const syncRes = await fetch(syncUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SERVICE_ROLE}`,
          },
          body: JSON.stringify({ item_id: itemId }),
        });
        if (!syncRes.ok) {
          const errText = await syncRes.text().catch(() => "unknown");
          console.error(
            `[plaid_webhook] sync-transactions failed for item=${itemId} status=${syncRes.status}:`,
            errText,
          );
        } else {
          console.log(`[plaid_webhook] sync-transactions triggered for item=${itemId}`);

          // Sync succeeded — look up the user and push instantly to their device(s).
          const { data: itemRow } = await sb
            .from("plaid_items")
            .select("user_id")
            .eq("item_id", itemId)
            .maybeSingle();

          if (itemRow?.user_id) {
            await pushBankSyncToUser(sb, itemRow.user_id);
          }
        }
      }
    } else if (webhookType === "ITEM") {
      if (
        webhookCode === "ERROR" ||
        webhookCode === "PENDING_EXPIRATION" ||
        webhookCode === "USER_PERMISSION_REVOKED"
      ) {
        if (itemId) {
          const { error } = await sb
            .from("plaid_items")
            .update({
              needs_attention: true,
              attention_reason: webhookCode,
            })
            .eq("item_id", itemId);
          if (error) {
            console.error(`[plaid_webhook] Failed to mark item=${itemId} needs_attention:`, error);
          } else {
            console.log(`[plaid_webhook] Marked item=${itemId} needs_attention reason=${webhookCode}`);
          }
        }
      } else if (webhookCode === "WEBHOOK_UPDATE_ACKNOWLEDGED") {
        console.log(`[plaid_webhook] Webhook URL acknowledged for item=${itemId}`);
      } else {
        console.log(`[plaid_webhook] Skipping unsupported ITEM code=${webhookCode}`);
      }
    } else {
      console.log(`[plaid_webhook] Skipping unsupported type=${webhookType} code=${webhookCode}`);
    }
  } catch (err: any) {
    console.error("[plaid_webhook] Error processing webhook:", err?.message ?? err);
  }

  // Always return 200 to acknowledge receipt to Plaid.
  return json({ received: true });
});
