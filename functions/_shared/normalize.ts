/**
 * Canonical merchant text normalizer.
 * Must stay in sync with MerchantNormalizer.kt and the normalize_merchant SQL function.
 *
 * Phase 1 rollout safety:
 * - USE_PHASE1_NORMALIZER=false -> legacy behavior (default)
 * - USE_PHASE1_NORMALIZER=true  -> phase1 behavior
 */

function readFlag(name: string, defaultValue = false): boolean {
  const raw = Deno.env.get(name);
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

const USE_PHASE1_NORMALIZER = readFlag("USE_PHASE1_NORMALIZER", false);

const TRAILING_DATE_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[ _-]?\d{1,2}$/i,
  /(?:^|\s)(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\d{4}$/i,
  /(?:^|\s)\d{4}[/-]\d{1,2}[/-]\d{1,2}$/i,
  /(?:^|\s)\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/i
];

export const STATEMENT_NOISE_SENTINEL = "__statement_noise__";

// If this list changes, run a 117-style backfill migration so historical rows
// stay aligned with live normalization behavior.
const STATEMENT_NOISE_EXACT = new Set<string>([
  "payment thank you",
  "autopay",
  "automatic payment",
  "auto payment",
  "thank you"
]);

function stripTrailingDates(value: string): string {
  let out = value;
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (const pattern of TRAILING_DATE_PATTERNS) {
      const next = out.replace(pattern, "").trim();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function normalizeMerchantLegacy(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\b(inc|llc|ltd|co|corp|the)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMerchantPhase1(raw: string): string {
  let normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_*]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(inc|llc|ltd|co|corp|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  normalized = stripTrailingDates(normalized)
    .replace(/\s+/g, " ")
    .trim();

  if (STATEMENT_NOISE_EXACT.has(normalized)) return STATEMENT_NOISE_SENTINEL;
  return normalized;
}

export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  const input = String(raw);
  return USE_PHASE1_NORMALIZER
    ? normalizeMerchantPhase1(input)
    : normalizeMerchantLegacy(input);
}

export function isStatementNoiseMerchant(normalized: string | null | undefined): boolean {
  return String(normalized ?? "").trim() === STATEMENT_NOISE_SENTINEL;
}
