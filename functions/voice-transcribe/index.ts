// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { cors } from "../_shared/cors.ts";
import {
  getServiceSupabaseClient,
  getUserFromAuthHeader,
} from "../_shared/supabaseClient.ts";
import { repairVoiceTranscript } from "../_shared/voiceTranscriptRepair.ts";

// Pilot: Google Cloud Speech-to-Text REST v1 synchronous recognize.
// The Google key lives ONLY here as a Supabase secret, never in the app.
// Provider is intentionally swappable (OpenAI / Deepgram) without changing
// the Android contract: { audio_base64, language_code } -> { success, text, ... }.
const SPEECH_API_KEY = Deno.env.get("GOOGLE_CLOUD_SPEECH_API_KEY") ?? "";
const SPEECH_URL = "https://speech.googleapis.com/v1/speech:recognize";
const SPEECH_TIMEOUT_MS = 12_000;
// ~60 s of 16 kHz mono 16-bit PCM ~= 1.9 MB raw ~= 2.56 MB base64. Allow headroom.
const MAX_AUDIO_BASE64_CHARS = 5 * 1024 * 1024;

// App-selected speech locales (mirrors selectedSpeechLanguage in QuickAddActivity).
const SUPPORTED_LANGUAGE_CODES = new Set([
  "en-US",
  "es-ES",
  "ru-RU",
  "fr-FR",
  "de-DE",
  "pt-PT",
  "tr-TR",
  "ja-JP",
  "zh-CN",
  "it-IT",
  "pl-PL",
  "nl-NL",
]);

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function normalizeTier(value: unknown): "free" | "pro" | "premium" {
  const tier = String(value ?? "").trim().toLowerCase();
  if (tier === "premium") return "premium";
  if (tier === "pro" || tier === "paid") return "pro";
  return "free";
}

// Same paid gate the Quick Add AI save functions use
// (ai-transaction-command / ai-transaction-batch-command).
async function verifyEntitlement(admin: any, userId: string) {
  const { data, error } = await admin
    .from("user_entitlements")
    .select("tier,valid_until")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify entitlement: ${error.message}`);
  const tier = normalizeTier(data?.tier);
  const validUntil = data?.valid_until
    ? new Date(data.valid_until).getTime()
    : null;
  const expired = validUntil !== null && Number.isFinite(validUntil) &&
    validUntil <= Date.now();
  return {
    tier: expired ? "free" as const : tier,
    paid: tier !== "free" && !expired,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // 1) Authenticate.
  let supabase: any;
  let user: any;
  try {
    supabase = getServiceSupabaseClient();
    user = await getUserFromAuthHeader(supabase, req);
  } catch {
    return jsonRes({ success: false, error: "Unauthorized" }, 401);
  }

  // 2) Paid gate BEFORE reading audio or calling Google, so free users never
  //    consume Speech credits.
  let entitlement: { tier: "free" | "pro" | "premium"; paid: boolean };
  try {
    entitlement = await verifyEntitlement(supabase, user.id);
  } catch (error) {
    console.error(
      `voice-transcribe entitlement check failed: ${String(error).slice(0, 200)}`,
    );
    return jsonRes(
      { success: false, code: "provider_error", error: "Could not transcribe audio" },
      503,
    );
  }
  if (!entitlement.paid) {
    return jsonRes({
      success: false,
      code: "paid_required",
      error: "Voice transcription requires Pro.",
      verifiedTier: entitlement.tier,
    });
  }

  if (!SPEECH_API_KEY) {
    return jsonRes(
      {
        success: false,
        code: "not_configured",
        error: "Transcription service not configured",
      },
      503,
    );
  }

  // 3) Parse + validate body.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes(
      { success: false, code: "bad_request", error: "Invalid JSON body" },
      400,
    );
  }

  const audioBase64 = typeof body.audio_base64 === "string"
    ? body.audio_base64
    : "";
  if (!audioBase64 || audioBase64.length < 100) {
    return jsonRes(
      { success: false, code: "bad_request", error: "Missing audio" },
      400,
    );
  }
  if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
    return jsonRes(
      { success: false, code: "too_long", error: "Audio too long" },
      413,
    );
  }

  const requestedLanguage = typeof body.language_code === "string"
    ? body.language_code.trim()
    : "";
  const languageCode = SUPPORTED_LANGUAGE_CODES.has(requestedLanguage)
    ? requestedLanguage
    : "en-US";
  const approxAudioBytes = Math.floor((audioBase64.length * 3) / 4);

  const speechRequest = {
    config: {
      encoding: "LINEAR16",
      sampleRateHertz: 16000,
      languageCode,
      model: "latest_short",
      enableAutomaticPunctuation: true,
      maxAlternatives: 1,
      speechContexts: [
        {
          phrases: [
            "hundred", "thousand", "million",
            "$OPERAND", "$MONEY",
            "1000", "2000", "3000", "5000", "10000",
            "spent", "paid", "earned", "received",
          ],
          boost: 10,
        },
      ],
    },
    audio: { content: audioBase64 },
  };

  // 4) Call the provider.
  let speechRes: Response;
  try {
    speechRes = await fetchWithTimeout(
      `${SPEECH_URL}?key=${SPEECH_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(speechRequest),
      },
      SPEECH_TIMEOUT_MS,
    );
  } catch (error) {
    const timedOut = error instanceof DOMException &&
      error.name === "AbortError";
    // Safe metadata only: never log audio or transcript.
    console.error(
      JSON.stringify({
        scope: "voice-transcribe",
        result: "fetch_error",
        timedOut,
        languageCode,
        audioBytes: approxAudioBytes,
      }),
    );
    return jsonRes(
      { success: false, code: "provider_error", error: "Could not transcribe audio" },
      timedOut ? 504 : 502,
    );
  }

  console.log(
    JSON.stringify({
      scope: "voice-transcribe",
      languageCode,
      audioBytes: approxAudioBytes,
      googleStatus: speechRes.status,
    }),
  );

  if (!speechRes.ok) {
    const errText = await speechRes.text().catch(() => "");
    console.error(
      `voice-transcribe google status ${speechRes.status}: ${
        errText.slice(0, 200)
      }`,
    );
    return jsonRes(
      { success: false, code: "provider_error", error: "Could not transcribe audio" },
      502,
    );
  }

  const data = await speechRes.json().catch(() => null);
  // Google can split one recording into multiple `results` entries (one per
  // utterance/pause). Keep the best alternative from EACH, in order, so the
  // whole transcript is returned — not just the first sentence.
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  const transcripts: string[] = [];
  const confidences: number[] = [];
  for (const result of results) {
    const alternative = result?.alternatives?.[0];
    const chunk = String(alternative?.transcript ?? "").trim();
    if (!chunk) continue;
    transcripts.push(chunk);
    if (typeof alternative?.confidence === "number") {
      confidences.push(alternative.confidence);
    }
  }
  const rawText = transcripts.join(" ").replace(/\s+/g, " ").trim();
  const text = repairVoiceTranscript(rawText, languageCode);
  const confidence = confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : null;

  // No transcript = speech was empty/unclear (distinct from a provider error).
  if (!text) {
    return jsonRes({
      success: false,
      code: "no_speech",
      error: "Could not transcribe audio",
    });
  }

  return jsonRes({
    success: true,
    text,
    confidence,
    provider: "google",
  });
});

async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
