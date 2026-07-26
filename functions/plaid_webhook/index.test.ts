/**
 * Unit tests for Plaid webhook signature verification.
 *
 * These tests exercise verifyPlaidWebhook() in isolation — no real Plaid
 * credentials needed. A live ECDSA P-256 key pair is generated at test startup
 * so the crypto path is exercised end-to-end; the Plaid key-fetch HTTP call is
 * replaced by a mock fetch that returns the generated public JWK.
 *
 * Run with:
 *   deno test --allow-all supabase/functions/plaid_webhook/index.test.ts
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  verifyPlaidWebhook,
  type PlaidVerifyOptions,
} from "../_shared/plaid-webhook-verify.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Uint8Array → base64url string */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Sign a JWT with an ECDSA P-256 private key, embedding kid in the header. */
async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  jwtPayload: Record<string, unknown>,
): Promise<string> {
  const header = { alg: "ES256", kid, typ: "JWT" };
  const h = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const p = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(jwtPayload)),
  );
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  const s = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${h}.${p}.${s}`;
}

/** Compute SHA-256 hex of a Uint8Array. */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Test fixtures (generated once for all tests) ─────────────────────────────

const TEST_KID = "wiseflow-test-key-1";

const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

/** A realistic webhook body. */
const BODY = new TextEncoder().encode(
  JSON.stringify({
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: "item_test_123",
  }),
);

/**
 * Make a mock fetch that returns `key` when called on the Plaid verification
 * key endpoint. Pass `null` as key to simulate a 400 error response.
 */
function makeMockFetch(key: JsonWebKey | null): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    if (key === null) {
      return new Response(JSON.stringify({ error: "INVALID_KEY" }), {
        status: 400,
      }) as Response;
    }
    return new Response(JSON.stringify({ key }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as Response;
  };
}

/** Base options shared across tests — uses the test public JWK. */
const BASE_OPTS: PlaidVerifyOptions = {
  plaidClientId: "test-client-id",
  plaidSecret: "test-secret",
  plaidBaseUrl: "https://sandbox.plaid.com",
  fetchFn: makeMockFetch(publicJwk),
};

/** Build a valid token for BODY with exp = now + offsetSec. */
async function validToken(offsetSec = 120): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(BODY);
  return signJwt(keyPair.privateKey, TEST_KID, {
    exp: nowSec + offsetSec,
    iat: nowSec,
    request_body_sha256: bodyHash,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("valid signature, valid body hash → ok=true", async () => {
  const token = await validToken();
  const result = await verifyPlaidWebhook(token, BODY, BASE_OPTS);
  assertEquals(result, { ok: true });
});

Deno.test("invalid signature (wrong private key) → ok=false, reason=invalid_signature", async () => {
  // Sign with a freshly generated key — public JWK registered is different.
  const otherPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const bodyHash = await sha256Hex(BODY);
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signJwt(otherPair.privateKey, TEST_KID, {
    exp: nowSec + 120,
    iat: nowSec,
    request_body_sha256: bodyHash,
  });

  const result = await verifyPlaidWebhook(token, BODY, BASE_OPTS);
  assertEquals(result.ok, false);
  assertEquals(result.reason, "invalid_signature");
});

Deno.test("missing Plaid-Verification header is handled by caller — verifyPlaidWebhook with empty string → malformed_jwt", async () => {
  // The handler checks for missing header before calling verify.
  // Here we confirm that an empty string token is rejected cleanly.
  const result = await verifyPlaidWebhook("", BODY, BASE_OPTS);
  assertEquals(result.ok, false);
});

Deno.test("expired JWT (exp 600s ago, maxAge=300) → ok=false, reason starts with 'expired'", async () => {
  const token = await validToken(-600); // exp is 600 seconds in the past
  const result = await verifyPlaidWebhook(token, BODY, {
    ...BASE_OPTS,
    maxAgeSeconds: 300,
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason?.startsWith("expired"), true);
});

Deno.test("JWT within grace window (exp 200s ago, maxAge=300) → ok=true", async () => {
  // exp is 200s ago but maxAge is 300 — still within tolerance
  const token = await validToken(-200);
  const result = await verifyPlaidWebhook(token, BODY, {
    ...BASE_OPTS,
    maxAgeSeconds: 300,
  });
  assertEquals(result, { ok: true });
});

Deno.test("body hash mismatch (token signed for different body) → ok=false", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const differentBody = new TextEncoder().encode('{"tampered":"yes"}');
  const differentHash = await sha256Hex(differentBody);
  const token = await signJwt(keyPair.privateKey, TEST_KID, {
    exp: nowSec + 120,
    iat: nowSec,
    request_body_sha256: differentHash,
  });

  // Verify against the real BODY — hashes won't match.
  const result = await verifyPlaidWebhook(token, BODY, BASE_OPTS);
  assertEquals(result.ok, false);
  assertEquals(result.reason?.startsWith("body_hash_mismatch"), true);
});

Deno.test("Plaid key endpoint returns 400 → ok=false, reason starts with 'plaid_key_fetch_failed'", async () => {
  const token = await validToken();
  const result = await verifyPlaidWebhook(token, BODY, {
    ...BASE_OPTS,
    fetchFn: makeMockFetch(null), // Plaid returns 400
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason?.startsWith("plaid_key_fetch_failed"), true);
});

Deno.test("Plaid key endpoint throws network error → ok=false", async () => {
  const token = await validToken();
  const failFetch: typeof fetch = async () => {
    throw new Error("network_timeout");
  };
  const result = await verifyPlaidWebhook(token, BODY, {
    ...BASE_OPTS,
    fetchFn: failFetch,
  });
  assertEquals(result.ok, false);
  assertEquals(result.reason?.startsWith("plaid_key_fetch_error"), true);
});

Deno.test("malformed JWT (not three segments) → ok=false", async () => {
  const result = await verifyPlaidWebhook("header.payload", BODY, BASE_OPTS);
  assertEquals(result.ok, false);
  assertEquals(result.reason, "malformed_jwt");
});

Deno.test("JWT with unsupported algorithm (RS256) → ok=false", async () => {
  // Manually craft a JWT header with alg=RS256
  const nowSec = Math.floor(Date.now() / 1000);
  const bodyHash = await sha256Hex(BODY);
  const header = { alg: "RS256", kid: TEST_KID, typ: "JWT" };
  const h = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const p = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ exp: nowSec + 120, request_body_sha256: bodyHash }),
    ),
  );
  const fakeToken = `${h}.${p}.fakesig`;

  const result = await verifyPlaidWebhook(fakeToken, BODY, BASE_OPTS);
  assertEquals(result.ok, false);
  assertEquals(result.reason, "unsupported_alg:RS256");
});

Deno.test("always-200 contract: verify result does not affect HTTP status (caller responsibility)", async () => {
  // The verify function returns a VerifyResult — it never throws.
  // HTTP status is always controlled by the handler (always 200).
  // This test confirms the function returns a clean result for all failure paths.
  const badToken = "x.y.z";
  const result = await verifyPlaidWebhook(badToken, BODY, BASE_OPTS);
  assertEquals(typeof result.ok, "boolean");
  assertEquals(typeof result.reason, "string");
});
