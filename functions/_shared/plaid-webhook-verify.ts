// deno-lint-ignore-file no-explicit-any
/**
 * Plaid webhook signature verification.
 *
 * Plaid signs each webhook delivery with an ES256 JWT in the `Plaid-Verification`
 * header. The JWT payload contains a `request_body_sha256` claim — the hex-encoded
 * SHA-256 of the raw request body. Verification steps:
 *
 *   1. Decode the JWT header to get `kid` (key ID).
 *   2. Fetch the matching public JWK from Plaid's key endpoint.
 *   3. Verify the JWT signature with Web Crypto.
 *   4. Check the JWT `exp` claim (5-minute tolerance by default).
 *   5. SHA-256 the raw body and compare to `request_body_sha256`.
 *
 * Only call side effects when `ok === true`.
 */

/** Base64url string → Uint8Array (returns Uint8Array<ArrayBuffer> for Web Crypto compat) */
function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface PlaidVerifyOptions {
  plaidClientId: string;
  plaidSecret: string;
  /** Base URL for Plaid API, e.g. "https://production.plaid.com" */
  plaidBaseUrl: string;
  /**
   * Maximum age of a valid JWT in seconds (applied as tolerance on top of
   * the `exp` claim). Default: 300 (5 minutes), matching Plaid's window.
   */
  maxAgeSeconds?: number;
  /** Override fetch for unit tests. */
  fetchFn?: typeof fetch;
}

/**
 * Verify a Plaid webhook request.
 *
 * @param verificationToken  Value of the `Plaid-Verification` header.
 * @param rawBody            Raw request body bytes (must not be decoded).
 * @param opts               Plaid credentials + optional overrides.
 */
export async function verifyPlaidWebhook(
  verificationToken: string,
  rawBody: ArrayBuffer | Uint8Array,
  opts: PlaidVerifyOptions,
): Promise<VerifyResult> {
  // Normalise to ArrayBuffer for Web Crypto APIs.
  const bodyBuffer: ArrayBuffer =
    rawBody instanceof ArrayBuffer ? rawBody : rawBody.buffer as ArrayBuffer;
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAge = opts.maxAgeSeconds ?? 300;

  // ── 1. Split and basic-validate the JWT structure ──────────────────────────
  const parts = verificationToken.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_jwt" };
  const [headerB64, payloadB64, sigB64] = parts;

  // ── 2. Decode JWT header + payload ────────────────────────────────────────
  let header: Record<string, any>;
  let jwtPayload: Record<string, any>;
  try {
    header = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(headerB64)),
    );
    jwtPayload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payloadB64)),
    );
  } catch {
    return { ok: false, reason: "decode_error" };
  }

  const kid: string | undefined = header.kid;
  const alg: string | undefined = header.alg;

  if (!kid) return { ok: false, reason: "missing_kid" };
  if (alg !== "ES256") return { ok: false, reason: `unsupported_alg:${alg}` };

  // ── 3. Fetch the public JWK from Plaid ────────────────────────────────────
  let jwk: JsonWebKey;
  try {
    const keyRes = await fetchFn(
      `${opts.plaidBaseUrl}/webhook/verification_key/get`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: opts.plaidClientId,
          secret: opts.plaidSecret,
          key_id: kid,
        }),
      },
    );
    if (!keyRes.ok) {
      return { ok: false, reason: `plaid_key_fetch_failed:${keyRes.status}` };
    }
    const keyData = await keyRes.json();
    jwk = keyData?.key;
    if (!jwk) return { ok: false, reason: "plaid_key_missing_in_response" };
  } catch (err: any) {
    return { ok: false, reason: `plaid_key_fetch_error:${err?.message}` };
  }

  // ── 4. Import the JWK and verify the ES256 signature ──────────────────────
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch (err: any) {
    return { ok: false, reason: `key_import_error:${err?.message}` };
  }

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlToBytes(sigB64);

  let valid: boolean;
  try {
    // deno-lint-ignore no-explicit-any
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      sigBytes as unknown as BufferSource,
      signedData,
    );
  } catch {
    return { ok: false, reason: "verify_error" };
  }

  if (!valid) return { ok: false, reason: "invalid_signature" };

  // ── 5. Check JWT expiry ────────────────────────────────────────────────────
  const exp = typeof jwtPayload.exp === "number" ? jwtPayload.exp : null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (exp !== null && nowSec > exp + maxAge) {
    return { ok: false, reason: `expired:exp=${exp},now=${nowSec}` };
  }

  // ── 6. Verify request body SHA-256 ────────────────────────────────────────
  const expectedHash =
    typeof jwtPayload.request_body_sha256 === "string"
      ? jwtPayload.request_body_sha256
      : null;
  if (!expectedHash) return { ok: false, reason: "missing_body_hash_claim" };

  const actualHashBuf = await crypto.subtle.digest("SHA-256", bodyBuffer);
  const actualHash = Array.from(new Uint8Array(actualHashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedHash !== actualHash) {
    return {
      ok: false,
      reason: `body_hash_mismatch:expected=${expectedHash},got=${actualHash}`,
    };
  }

  return { ok: true };
}
