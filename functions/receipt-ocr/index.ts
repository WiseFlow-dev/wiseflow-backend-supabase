import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cors } from "../_shared/cors.ts";
import {
  getServiceSupabaseClient,
  getUserFromAuthHeader,
} from "../_shared/supabaseClient.ts";
import {
  buildReceiptOcrSuccessPayload,
  buildReceiptStructuringPrompt,
  extractGeminiText,
} from "./receiptStructuring.ts";

const VISION_API_KEY = Deno.env.get("GOOGLE_CLOUD_VISION_API_KEY") ?? "";

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[receipt-ocr] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }

  const clientEmail = GOOGLE_SA.client_email;
  const privateKeyPem: string = GOOGLE_SA.private_key;
  const tokenUri: string = GOOGLE_SA.token_uri ?? "https://oauth2.googleapis.com/token";

  if (!clientEmail || !privateKeyPem) {
    throw new Error("Service account client_email or private_key missing");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const unsignedJwt = `${enc(header)}.${enc(payload)}`;

  // Import RSA private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedJwt),
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const signedJwt = `${unsignedJwt}.${sig}`;

  const tokenRes = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`,
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => "");
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errText.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json();
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + 3_300_000, // 55 minutes
  };
  return cachedAccessToken.token;
}

const GEMINI_KEYS: string[] = ["vertex_sa"];
const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB base64 ~= 7.5 MB raw
const VISION_TIMEOUT_MS = 10_000;
const GEMINI_TIMEOUT_MS = 12_000;

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    const supabase = getServiceSupabaseClient();
    await getUserFromAuthHeader(supabase, req);
  } catch {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  if (!VISION_API_KEY) {
    return jsonRes(
      { error: "OCR service not configured" },
      503,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "Invalid JSON body" }, 400);
  }

  const imageBase64 = typeof body.image_base64 === "string"
    ? body.image_base64
    : "";
  if (!imageBase64 || imageBase64.length < 100) {
    return jsonRes({ error: "Missing or empty image_base64" }, 400);
  }
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return jsonRes({ error: "Image too large" }, 413);
  }

  const languageHints: string[] = Array.isArray(body.language_hints)
    ? (body.language_hints as string[]).filter(
      (hint) => typeof hint === "string" && hint.length <= 5,
    )
    : ["en"];

  const visionReq = {
    requests: [
      {
        image: { content: imageBase64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints },
      },
    ],
  };

  let visionRes: Response;
  try {
    visionRes = await fetchWithTimeout(
      `${VISION_URL}?key=${VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(visionReq),
      },
      VISION_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return jsonRes(
      { error: timedOut ? "OCR service timed out" : "OCR service error" },
      timedOut ? 504 : 502,
    );
  }

  if (!visionRes.ok) {
    const errText = await visionRes.text().catch(() => "");
    console.error(
      `Vision API error ${visionRes.status}: ${errText.slice(0, 300)}`,
    );
    return jsonRes(
      { error: "OCR service error", detail: `status ${visionRes.status}` },
      502,
    );
  }

  const visionData = await visionRes.json();
  const firstResponse = visionData?.responses?.[0];

  if (firstResponse?.error) {
    return jsonRes(
      { error: firstResponse.error.message ?? "Vision API error" },
      502,
    );
  }

  const fullText = (
    firstResponse?.fullTextAnnotation?.text ?? ""
  ).trim();
  const fallbackText = (
    firstResponse?.textAnnotations?.[0]?.description ?? ""
  ).trim();
  const text = fullText || fallbackText;

  if (!text) {
    return jsonRes({ success: false, text: "", error: "No text detected" });
  }

  const { structuredText, structuredError } = await callGeminiReceiptStructurer(text);
  return jsonRes(buildReceiptOcrSuccessPayload(text, structuredText, structuredError));
});

async function callGeminiReceiptStructurer(
  rawText: string,
): Promise<{ structuredText: string | null; structuredError: string | null }> {
  if (!VERTEX_PROJECT) {
    return {
      structuredText: null,
      structuredError: "Gemini receipt structuring is not configured",
    };
  }

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: buildReceiptStructuringPrompt(rawText) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  try {
    const accessToken = await getAccessToken();
    const endpoint =
      `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
      },
      GEMINI_TIMEOUT_MS,
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[receipt-ocr] Vertex AI error ${response.status}: ${errText.slice(0, 300)}`);
      return {
        structuredText: null,
        structuredError: `Vertex AI request failed (${response.status})`,
      };
    }

    const geminiData = await response.json().catch(() => null);
    const structuredText = extractGeminiText(geminiData);
    if (!structuredText) {
      return {
        structuredText: null,
        structuredError: "Gemini returned no structured receipt JSON",
      };
    }

    return { structuredText, structuredError: null };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return {
      structuredText: null,
      structuredError: timedOut
        ? "Gemini receipt structuring timed out"
        : "Gemini receipt structuring failed",
    };
  }
}

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
