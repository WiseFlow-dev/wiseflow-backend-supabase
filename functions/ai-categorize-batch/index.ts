// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  isStatementNoiseMerchant,
  normalizeMerchant,
  STATEMENT_NOISE_SENTINEL
} from "../_shared/normalize.ts";
import {
  maybeResolveSemanticCategory,
  type SemanticResolverDecision
} from "../_shared/semanticResolver.ts";
import ontologySeed from "../_shared/category_ontology_seed_v1.json" with { type: "json" };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
let GOOGLE_SA_ACB: any = {};
try {
  GOOGLE_SA_ACB = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[ai-categorize-batch] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT_ACB = GOOGLE_SA_ACB.project_id ?? "";
const VERTEX_REGION_ACB = "global";
const GEMINI_API_KEY = VERTEX_PROJECT_ACB ? "vertex_sa" : "";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

let cachedAccessTokenACB: { token: string; expiresAt: number } | null = null;

async function getAccessTokenACB(): Promise<string> {
  if (cachedAccessTokenACB && Date.now() < cachedAccessTokenACB.expiresAt) return cachedAccessTokenACB.token;
  const sa = GOOGLE_SA_ACB;
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlBytes = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claims}`)));
  const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
  const tokenRes = await fetch(sa.token_uri, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}` });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`Service account token exchange failed: ${JSON.stringify(tokenData)}`);
  cachedAccessTokenACB = { token: tokenData.access_token, expiresAt: Date.now() + 3_300_000 };
  return tokenData.access_token;
}

const THRESHOLD_AI = 0.80;
const THRESHOLD_AI_SUGGEST = 0.65;
const PROMOTE_TO_REVIEW_THRESHOLD = 0.85;
const DEFAULT_BATCH_LIMIT = 150;
const UNCATEGORIZED_KEY = "Uncategorized";
const RETRYABLE_AI_FAILURE_STAGES = ["missing_ai_result", "ai_result_shape_invalid", "ai_chunk_error"];
const LEGACY_PROMPT_VERSION = "legacy_v1";
const PHASE4_PROMPT_VERSION = "phase4_v2";
const ONTOLOGY_TOKEN_TARGET = 1100;
const ONTOLOGY_TOKEN_HARD_LIMIT = 1500;
const ONTOLOGY_HINT_LIMIT = 6;
const PHASE4_PROMPT_HINT_LIMIT = 3;
const ONTOLOGY_EXAMPLE_LIMIT = 3;
const ONTOLOGY_SEED_VERSION = String((ontologySeed as any)?.version ?? "unknown");
const USE_PHASE3_DETERMINISTIC = readFlag("USE_PHASE3_DETERMINISTIC", true);
const DETERMINISTIC_CONFIDENCE = 0.96;
const PHASE3_DETERMINISTIC_PERCENT = readPercentFlag("PHASE3_DETERMINISTIC_PERCENT", 100);
const USE_PHASE4_PROMPT = readFlag("USE_PHASE4_PROMPT", false);
const PHASE4_PROMPT_PERCENT = readPercentFlag("PHASE4_PROMPT_PERCENT", 0);
const USE_PHASE5_SEMANTIC_RESOLVER = readFlag("USE_PHASE5_SEMANTIC_RESOLVER", false);

function readFlag(name: string, defaultValue = false): boolean {
  const raw = Deno.env.get(name);
  if (raw == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function readPercentFlag(name: string, defaultValue = 0): number {
  const raw = Deno.env.get(name);
  if (raw == null || raw.trim() === "") return defaultValue;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

// Hard safety gate: fixture mode is disabled unless explicitly enabled.
const ENABLE_FIXTURE_MODE = readFlag("AI_CATEGORIZE_FIXTURE_MODE", false);

type UserCategoryRow = {
  id: string | null;
  user_id: string | null;
  name: string | null;
  is_income: boolean | null;
  is_system?: boolean | null;
};

type QueueRow = {
  id: string;
  txn_id: string;
  provider: string;
  user_id: string;
  merchant_raw: string | null;
  merchant_normalized: string | null;
  amount_cents: number | null;
  account_subtype: string | null;
  status: string;
};

type DeterministicObservation = {
  merchantNormalized: string;
  isMoneyIn: boolean;
  deterministicEnabledForUser: boolean;
  deterministicKillSwitch: boolean;
  userRuleCategory: string | null;
  deterministicMatch: DeterministicMatch | null;
  wouldMatch: boolean;
  wouldMatchCategoryKey: string | null;
};

type FixtureInputRow = {
  id?: string | null;
  provider?: string | null;
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  amount_cents?: number | null;
  account_subtype?: string | null;
  expected_category?: string | null;
  strict_scoring?: boolean | null;
  script_bucket?: string | null;
  locale_hint?: string | null;
  row_source?: string | null;
};

type AiResult = {
  category: string | null;
  confidence: number;
  rawCategory?: string | null;
  broadConcept?: string | null;
  languageDetected?: string | null;
  merchantClean?: string | null;
  reasoning?: string | null;
  needsReview?: boolean;
  alternateCategory?: string | null;
  validationError?: string | null;
  promptVersion?: string;
};

type PromptBuildStats = {
  prompt: string;
  ontologyTokenEstimate: number;
  promptTokenEstimate: number;
  ontologyEntryCount: number;
  promptVersion: string;
};

type BatchStats = {
  processed: number;
  applied: number;
  suggested: number;
  skipped: number;
  promoted_to_review: number;
  userOverridesPreserved: number;
  deterministicApplied: number;
  deterministicShadowMatches: number;
  deterministicSkippedByOverride: number;
  semanticResolverApplied: number;
  semanticResolverSuggested: number;
  semanticResolverDeclined: number;
  moneyMovementGuardApplied: number;
  moneyMovementTransferMatched: number;
  moneyMovementTransferBlocked: number;
  errors: number;
};

type TxnMetaRow = {
  user_id: string;
  txn_id: string;
  account_id: string | null;
  provider: string | null;
  name: string | null;
  merchant: string | null;
  merchant_name: string | null;
  txn_date: string | null;
  amount: number | null;
};

type TxnMeta = {
  user_id: string;
  txn_id: string;
  account_id: string | null;
  provider: string | null;
  name: string;
  merchant: string | null;
  merchant_name: string | null;
  txn_date: string;
  amount_cents: number | null;
};

type TransferCandidate = {
  userId: string;
  txnId: string;
  accountId: string | null;
  provider: string;
  txnDate: string;
  amountCents: number;
  isMoneyIn: boolean;
  text: string;
};

type TransferEvidence = {
  matched: boolean;
  matchTxnId: string | null;
  reason: string;
};

type TransferEvidenceOptions = {
  currentProvider?: string | null;
  candidateProvider?: string | null;
  requireCurrentOwnAccountText?: boolean;
  requireCandidateOwnAccountText?: boolean;
  maxAmountDiffCents?: number;
  maxDateGapDays?: number;
};

type ProtectedMoneyMovementCategory = {
  categoryKey: string;
  confidence: number;
  reason: string;
};

type MoneyMovementGuardDecision = {
  categoryKey: string;
  confidence: number;
  needsReview: boolean;
  isSuggested: boolean;
  resultSource: string;
  reason: string;
  transferMatched: boolean;
  transferBlocked: boolean;
};

type StatementImportFallbackDecision = {
  categoryKey: string;
  confidence: number;
  needsReview: boolean;
  resultSource: "statement_import_generic_fallback";
  reason: string;
};

type OntologyDbRow = {
  category_key: string | null;
  side: "income" | "expense" | string | null;
  section: string | null;
  parent_concept: string | null;
  definition: string | null;
  multilingual_hints: unknown;
  examples: unknown;
  is_active?: boolean | null;
};

type OntologySeedEntry = {
  category_key: string;
  side: "income" | "expense";
  section: string;
  parent_concept: string;
  definition: string;
  multilingual_hints: string[];
  examples: string[];
};

type OntologyPromptEntry = {
  category: string;
  side: "income" | "expense";
  section: string;
  parent_concept: string;
  definition: string;
  multilingual_hints: string[];
  examples: string[];
};

function userHasProAccess(user: unknown): boolean {
  const u = (user ?? {}) as Record<string, unknown>;
  const appMeta = (u["app_metadata"] ?? {}) as Record<string, unknown>;
  const userMeta = (u["user_metadata"] ?? {}) as Record<string, unknown>;
  const asLower = (value: unknown): string => String(value ?? "").trim().toLowerCase();

  const truthyFlag = (value: unknown): boolean =>
    value === true || asLower(value) === "true" || asLower(value) === "1";
  if (
    truthyFlag(appMeta["is_pro"]) ||
    truthyFlag(appMeta["pro"]) ||
    truthyFlag(userMeta["is_pro"]) ||
    truthyFlag(userMeta["pro"])
  ) {
    return true;
  }

  const planCandidates = [
    appMeta["plan"],
    appMeta["tier"],
    appMeta["subscription_tier"],
    appMeta["subscription_plan"],
    userMeta["plan"],
    userMeta["tier"],
    userMeta["subscription_tier"],
    userMeta["subscription_plan"],
  ]
    .map(asLower)
    .filter(Boolean);

  return planCandidates.some((value) =>
    value === "pro" ||
    value === "premium" ||
    value === "paid" ||
    value.startsWith("pro_") ||
    value.startsWith("premium_")
  );
}

function tierLooksPro(tier: unknown): boolean {
  const value = String(tier ?? "").trim().toLowerCase();
  return (
    value === "pro" ||
    value === "premium" ||
    value === "paid" ||
    value.startsWith("pro_") ||
    value.startsWith("premium_")
  );
}

function entitlementStillValid(validUntil: unknown): boolean {
  if (!validUntil) return true;
  const expiry = new Date(String(validUntil));
  if (!Number.isFinite(expiry.getTime())) return false;
  return expiry.getTime() > Date.now();
}

async function userIdHasProAccess(adminClient: any, userId: string): Promise<boolean> {
  try {
    const { data: entitlement, error } = await adminClient
      .from("user_entitlements")
      .select("tier, valid_until")
      .eq("user_id", userId)
      .maybeSingle();

    if (!error && entitlement) {
      if (tierLooksPro(entitlement.tier) && entitlementStillValid(entitlement.valid_until)) {
        return true;
      }
    }
  } catch (_error) {
    // no-op: try auth-admin fallback
  }

  try {
    const { data: adminUserData, error: adminUserErr } = await adminClient.auth.admin.getUserById(userId);
    if (!adminUserErr && adminUserData?.user && userHasProAccess(adminUserData.user)) {
      return true;
    }
  } catch (_error) {
    // no-op
  }

  return false;
}

type DeterministicPatternRow = {
  category_key: string | null;
  side: "income" | "expense" | string | null;
  pattern_regex: string | null;
  priority: number | null;
  reason: string | null;
  is_active?: boolean | null;
};

type DeterministicPattern = {
  categoryKey: string;
  side: "income" | "expense";
  patternRegex: string;
  priority: number;
  reason: string;
  regex: RegExp;
};

type DeterministicMatch = {
  categoryKey: string;
  confidence: number;
  reason: string;
  patternRegex: string;
  priority: number;
};

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(payload: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    })
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => typeof item === "string" ? item.trim() : "")
        .filter(Boolean)
    )
  ).slice(0, 200);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseConfidence(value: unknown): number {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "string") {
    const n = Number(value.replace("%", "").trim());
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? clamp01(n / 100) : clamp01(n);
  }
  return 0;
}

function normCategoryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function dedupeCategoryNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    const key = normCategoryText(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
}

function normOntologySide(value: unknown): "income" | "expense" | null {
  const side = String(value ?? "").trim().toLowerCase();
  if (side === "income" || side === "expense") return side;
  return null;
}

function dedupeHints(hints: string[], max = ONTOLOGY_HINT_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hint of hints) {
    const trimmed = String(hint ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function dedupeExamples(examples: string[], max = ONTOLOGY_EXAMPLE_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ex of examples) {
    const trimmed = String(ex ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function ontologyIdentityKey(category: string, side: "income" | "expense"): string {
  return `${normCategoryText(category)}::${side}`;
}

function canonicalOntologyEntry(entry: OntologyPromptEntry): string {
  return JSON.stringify({
    category: entry.category,
    side: entry.side,
    section: entry.section,
    parent_concept: entry.parent_concept,
    definition: entry.definition,
    multilingual_hints: entry.multilingual_hints,
    examples: entry.examples
  });
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function hashPercentBucket(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 100;
}

function isDeterministicEnabledForUser(userId: string): boolean {
  if (!USE_PHASE3_DETERMINISTIC) return false;
  if (PHASE3_DETERMINISTIC_PERCENT >= 100) return true;
  if (PHASE3_DETERMINISTIC_PERCENT <= 0) return false;
  return hashPercentBucket(userId) < PHASE3_DETERMINISTIC_PERCENT;
}

function isPhase4EnabledForUser(userId: string): boolean {
  if (!USE_PHASE4_PROMPT) return false;
  if (PHASE4_PROMPT_PERCENT >= 100) return true;
  if (PHASE4_PROMPT_PERCENT <= 0) return false;
  return hashPercentBucket(userId) < PHASE4_PROMPT_PERCENT;
}

function shouldForcePhase4Prompt(body: any): boolean {
  const requested = body?.use_phase4_prompt === true;
  const source = String(body?.source ?? "").trim().toLowerCase();
  const provider = String(body?.provider ?? "").trim().toLowerCase();
  return requested && source === "import-statement-transactions" && provider === "statement_import";
}

function parseDeterministicPatterns(rows: DeterministicPatternRow[]): DeterministicPattern[] {
  const out: DeterministicPattern[] = [];
  for (const row of rows) {
    const categoryKey = String(row.category_key ?? "").trim();
    const side = normOntologySide(row.side);
    const patternRegex = String(row.pattern_regex ?? "")
      .trim()
      // Some SQL seed files escaped Unicode property classes for JS instead of
      // Postgres strings, leaving \\p{L} in the DB. Normalize both forms here
      // so deterministic merchant rules keep working for every provider.
      .replace(/\\\\p\{/g, "\\p{");
    if (!categoryKey || !side || !patternRegex) continue;
    try {
      out.push({
        categoryKey,
        side,
        patternRegex,
        priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
        reason: String(row.reason ?? "").trim() || "deterministic_pattern",
        regex: new RegExp(patternRegex, "iu")
      });
    } catch (error) {
      console.warn(`invalid_deterministic_pattern:${patternRegex}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.patternRegex.localeCompare(b.patternRegex);
  });
}

function matchDeterministicPattern(
  merchantNormalized: string,
  side: "income" | "expense",
  patterns: DeterministicPattern[],
  allowedCategories: string[]
): DeterministicMatch | null {
  if (!merchantNormalized) return null;
  const allowed = new Set(dedupeCategoryNames(allowedCategories).map((name) => normCategoryText(name)));
  for (const pattern of patterns) {
    if (pattern.side !== side) continue;
    if (!allowed.has(normCategoryText(pattern.categoryKey))) continue;
    if (!pattern.regex.test(merchantNormalized)) continue;
    return {
      categoryKey: pattern.categoryKey,
      confidence: DETERMINISTIC_CONFIDENCE,
      reason: pattern.reason,
      patternRegex: pattern.patternRegex,
      priority: pattern.priority
    };
  }
  return null;
}

function parseOntologySeedEntries(): OntologySeedEntry[] {
  const rawEntries = Array.isArray((ontologySeed as any)?.categories)
    ? (ontologySeed as any).categories
    : [];
  const out: OntologySeedEntry[] = [];
  for (const raw of rawEntries) {
    const category = String(raw?.category_key ?? "").trim();
    const side = normOntologySide(raw?.side);
    if (!category || !side) continue;
    out.push({
      category_key: category,
      side,
      section: String(raw?.section ?? "General").trim() || "General",
      parent_concept: String(raw?.parent_concept ?? "General").trim() || "General",
      definition: String(raw?.definition ?? "").trim() || "General spending or income category.",
      multilingual_hints: dedupeHints(stringArray(raw?.multilingual_hints)),
      examples: dedupeExamples(stringArray(raw?.examples))
    });
  }
  return out;
}

function buildSeedMap(seedEntries: OntologySeedEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of seedEntries) {
    const entry: OntologyPromptEntry = {
      category: row.category_key,
      side: row.side,
      section: row.section,
      parent_concept: row.parent_concept,
      definition: row.definition,
      multilingual_hints: row.multilingual_hints,
      examples: row.examples
    };
    map.set(ontologyIdentityKey(row.category_key, row.side), canonicalOntologyEntry(entry));
  }
  return map;
}

function buildDbMap(rows: OntologyDbRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const category = String(row.category_key ?? "").trim();
    const side = normOntologySide(row.side);
    if (!category || !side) continue;
    const entry: OntologyPromptEntry = {
      category,
      side,
      section: String(row.section ?? "General").trim() || "General",
      parent_concept: String(row.parent_concept ?? "General").trim() || "General",
      definition: String(row.definition ?? "").trim() || "General spending or income category.",
      multilingual_hints: dedupeHints(stringArray(row.multilingual_hints)),
      examples: dedupeExamples(stringArray(row.examples))
    };
    map.set(ontologyIdentityKey(category, side), canonicalOntologyEntry(entry));
  }
  return map;
}

function logOntologyDrift(reqId: string, dbRows: OntologyDbRow[]): void {
  const seedEntries = parseOntologySeedEntries();
  const seedMap = buildSeedMap(seedEntries);
  const dbMap = buildDbMap(dbRows);
  const missingInDb: string[] = [];
  const mismatched: string[] = [];
  for (const [key, seedVal] of seedMap.entries()) {
    const dbVal = dbMap.get(key);
    if (!dbVal) {
      missingInDb.push(key);
      continue;
    }
    if (dbVal !== seedVal) mismatched.push(key);
  }
  const extraInDb: string[] = [];
  for (const key of dbMap.keys()) {
    if (!seedMap.has(key)) extraInDb.push(key);
  }
  console.log(JSON.stringify({
    req_id: reqId,
    event: "ontology_drift_check",
    seed_version: ONTOLOGY_SEED_VERSION,
    seed_rows: seedMap.size,
    db_rows: dbMap.size,
    missing_in_db: missingInDb.length,
    mismatched: mismatched.length,
    extra_in_db: extraInDb.length,
    pass: missingInDb.length === 0 && mismatched.length === 0
  }));
}

function buildPromptOntologyEntries(
  expenseCategories: string[],
  incomeCategories: string[],
  ontologyRows: OntologyDbRow[]
): OntologyPromptEntry[] {
  const dbByKey = new Map<string, OntologyPromptEntry>();
  for (const row of ontologyRows) {
    const category = String(row.category_key ?? "").trim();
    const side = normOntologySide(row.side);
    if (!category || !side) continue;
    dbByKey.set(
      ontologyIdentityKey(category, side),
      {
        category,
        side,
        section: String(row.section ?? "General").trim() || "General",
        parent_concept: String(row.parent_concept ?? "General").trim() || "General",
        definition: String(row.definition ?? "").trim() || "General spending or income category.",
        multilingual_hints: dedupeHints(stringArray(row.multilingual_hints)),
        examples: dedupeExamples(stringArray(row.examples))
      }
    );
  }

  const pick = (category: string, side: "income" | "expense"): OntologyPromptEntry | null => {
    const fromDb = dbByKey.get(ontologyIdentityKey(category, side));
    if (fromDb) return fromDb;
    return null;
  };

  const entries: OntologyPromptEntry[] = [];
  for (const cat of dedupeCategoryNames(expenseCategories)) {
    const entry = pick(cat, "expense");
    if (entry) entries.push(entry);
  }
  for (const cat of dedupeCategoryNames(incomeCategories)) {
    const entry = pick(cat, "income");
    if (entry) entries.push(entry);
  }
  return entries;
}

function buildPromptOntologyEntriesFromSeed(
  expenseCategories: string[],
  incomeCategories: string[]
): OntologyPromptEntry[] {
  const seedByKey = new Map<string, OntologyPromptEntry>();
  for (const row of parseOntologySeedEntries()) {
    seedByKey.set(ontologyIdentityKey(row.category_key, row.side), {
      category: row.category_key,
      side: row.side,
      section: row.section,
      parent_concept: row.parent_concept,
      definition: row.definition,
      multilingual_hints: row.multilingual_hints,
      examples: row.examples
    });
  }

  const entries: OntologyPromptEntry[] = [];
  for (const cat of dedupeCategoryNames(expenseCategories)) {
    const entry = seedByKey.get(ontologyIdentityKey(cat, "expense"));
    if (entry) entries.push(entry);
  }
  for (const cat of dedupeCategoryNames(incomeCategories)) {
    const entry = seedByKey.get(ontologyIdentityKey(cat, "income"));
    if (entry) entries.push(entry);
  }
  return entries;
}

function pickFirstAllowed(allowed: string[], preferred: string[]): string | null {
  if (allowed.length === 0 || preferred.length === 0) return null;

  const byNorm = new Map<string, string>();
  for (const a of allowed) byNorm.set(normCategoryText(a), a);

  for (const candidate of preferred) {
    const exact = byNorm.get(normCategoryText(candidate));
    if (exact) return exact;
  }

  for (const candidate of preferred) {
    const cNorm = normCategoryText(candidate);
    for (const a of allowed) {
      const aNorm = normCategoryText(a);
      if (aNorm.includes(cNorm) || cNorm.includes(aNorm)) return a;
    }
  }

  return null;
}

// Simplified lookup: finds AI's returned category in the allowed list.
// No keyword guessing - stored category type is the source of truth.
function normalizeAiCategory(value: unknown, allowedCategories: string[]): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const allowed = dedupeCategoryNames(allowedCategories);
  if (allowed.length === 0) return null;

  const rawNorm = normCategoryText(raw);

  // 1. Exact match (case-insensitive normalised)
  const exact = allowed.find((cat) => normCategoryText(cat) === rawNorm);
  if (exact) return exact;

  // 2. Safe substring match (one side fully contains the other)
  for (const cat of allowed) {
    const catNorm = normCategoryText(cat);
    if (catNorm.includes(rawNorm) || rawNorm.includes(catNorm)) return cat;
  }

  return null;
}

// Type enforcement uses stored category type and falls back to the legacy is_income flag.
// Always returns a non-null string ("Uncategorized" of the correct type as fallback).
function enforceTypeCheck(
  candidate: string | null,
  isMoneyIn: boolean,
  categoryIsIncomeMap: Map<string, boolean>,
  incomeCategories: string[],
  expenseCategories: string[]
): string {
  const uncategorizedFallback = isMoneyIn
    ? pickFirstAllowed(incomeCategories, ["Uncategorized"]) ?? "Uncategorized"
    : pickFirstAllowed(expenseCategories, ["Uncategorized"]) ?? "Uncategorized";

  if (!candidate) return uncategorizedFallback;

  const candidateNorm = normCategoryText(candidate);
  const incomeAllowed = incomeCategories.some((name) => normCategoryText(name) === candidateNorm);
  const expenseAllowed = expenseCategories.some((name) => normCategoryText(name) === candidateNorm);

  if (isMoneyIn && incomeAllowed) return candidate;
  if (!isMoneyIn && expenseAllowed) return candidate;

  const candidateIsIncome = categoryIsIncomeMap.get(candidateNorm);

  // Not found in our category map — safety fallback
  if (candidateIsIncome === undefined) return uncategorizedFallback;

  // Type mismatch: expense category for income txn, or vice versa
  if (isMoneyIn && !candidateIsIncome) return uncategorizedFallback;
  if (!isMoneyIn && candidateIsIncome) return uncategorizedFallback;

  return candidate;
}


function buildLegacyPrompt(
  rows: QueueRow[],
  expenseCategories: string[],
  incomeCategories: string[],
  ontologyEntries: OntologyPromptEntry[]
): PromptBuildStats {
  const serializedInput = rows.map((row, idx) => ({
    idx,
    provider: row.provider || "plaid",
    merchant_raw: row.merchant_raw ?? "",
    merchant_normalized: row.merchant_normalized ?? "",
    // Normalize to pipeline convention (positive = expense, negative = income)
    // so Plaid/GoCardless/Finverse transactions are treated consistently by Gemini.
    amount: normalizedAmountForPrompt(row),
    account_subtype: row.account_subtype ?? ""
  }));

  const expenseList = dedupeCategoryNames(expenseCategories);
  const incomeList = dedupeCategoryNames(incomeCategories);
  // Compact payload: keep meaning-bearing fields + multilingual hints only.
  // This keeps the full ontology block under the Phase 2 token budget.
  const compactOntology = ontologyEntries.map((entry) => ({
    category: entry.category,
    side: entry.side,
    concept: entry.parent_concept,
    definition: entry.definition,
    multilingual_hints: dedupeHints(entry.multilingual_hints, ONTOLOGY_HINT_LIMIT)
  }));
  const ontologyPayload = JSON.stringify({
    version: ONTOLOGY_SEED_VERSION,
    categories: compactOntology
  });
  const ontologyTokenEstimate = estimateTokensFromText(ontologyPayload);
  if (ontologyTokenEstimate > ONTOLOGY_TOKEN_HARD_LIMIT) {
    throw new Error(
      `ontology_token_budget_exceeded:${ontologyTokenEstimate}:hard_limit_${ONTOLOGY_TOKEN_HARD_LIMIT}`
    );
  }

  const prompt = [
    "You are categorizing bank transactions.",
    "",
    "Category ontology (meaning-first, multilingual hints):",
    ontologyPayload,
    "",
    "EXPENSE categories (for amount > 0, money OUT):",
    expenseList.join(", "),
    "",
    "INCOME categories (for amount < 0, money IN):",
    incomeList.join(", "),
    "",
    "Rules:",
    "- amount > 0 = money OUT → pick ONLY from EXPENSE categories",
    "- amount < 0 = money IN  → pick ONLY from INCOME categories",
    "- Never cross lists. Never invent categories outside the lists.",
    "- If unsure or no good match → return {\"category\":\"Uncategorized\",\"confidence\":0.3}",
    "",
    "Return ONLY a JSON array in the exact same order as input.",
    "Each element: {\"reasoning\":\"<3-5 words why>\",\"category\":\"<from correct list>\",\"confidence\":0.0-1.0}",
    "",
    `Input: ${JSON.stringify(serializedInput)}`
  ].join("\n");

  return {
    prompt,
    ontologyTokenEstimate,
    promptTokenEstimate: estimateTokensFromText(prompt),
    ontologyEntryCount: compactOntology.length,
    promptVersion: LEGACY_PROMPT_VERSION
  };
}

function buildPhase4Prompt(
  rows: QueueRow[],
  expenseCategories: string[],
  incomeCategories: string[],
  ontologyEntries: OntologyPromptEntry[]
): PromptBuildStats {
  const serializedInput = rows.map((row, idx) => ({
    idx,
    provider: row.provider || "plaid",
    merchant_raw: row.merchant_raw ?? "",
    merchant_normalized: row.merchant_normalized ?? "",
    amount: normalizedAmountForPrompt(row),
    amount_cents: row.amount_cents ?? null,
    account_subtype: row.account_subtype ?? "",
    direction: providerIsMoneyIn(row) ? "income" : "expense"
  }));

  const expenseList = dedupeCategoryNames(expenseCategories);
  const incomeList = dedupeCategoryNames(incomeCategories);
  const compactOntology = ontologyEntries.map((entry) => ({
    c: entry.category,
    s: entry.side,
    p: entry.parent_concept,
    d: entry.definition,
    h: dedupeHints(entry.multilingual_hints, PHASE4_PROMPT_HINT_LIMIT)
  }));
  const ontologyPayload = JSON.stringify({
    version: ONTOLOGY_SEED_VERSION,
    categories: compactOntology
  });
  const ontologyTokenEstimate = estimateTokensFromText(ontologyPayload);
  if (ontologyTokenEstimate > ONTOLOGY_TOKEN_HARD_LIMIT) {
    throw new Error(
      `ontology_token_budget_exceeded:${ontologyTokenEstimate}:hard_limit_${ONTOLOGY_TOKEN_HARD_LIMIT}`
    );
  }

  const prompt = [
    "You are categorizing bank transactions for WiseFlow.",
    "Return ONLY a JSON array in the exact same order as the input rows.",
    "",
    "Use the ontology to choose the most specific valid category.",
    "Examples:",
    "- Spotify or Netflix -> Streaming Services, not Entertainment",
    "- United Airlines or Flight to Shanghai -> Flights",
    "- Income-side rows for travel, airline, hotel, or booking merchants (e.g. United Airlines, Delta, Hilton, Booking.com, Airbnb when direction=income) -> Refund. Travel companies typically only credit your account when refunding a previous booking, so the income-side case is almost always a refund.",
    "- HKBN -> Internet",
    "- Bank interest income (merchant patterns: INTRST PYMNT, INTEREST PAID, INT EARNED) -> Interest (use the income-side Interest category from the allowed list). Dividend rows -> Dividends. Do NOT map interest or dividends to Balance Adjustment or Transfer.",
    "- CD DEPOSIT INITIAL -> Opening Balance",
    "- CREDIT CARD PAYMENT, AMEX PAYMENT, CARDMEMBER PAYMENT, VISA PAYMENT, or Mastercard payment rows -> Credit Card Payment. Do NOT use Credit Card Fees, Interest Paid, or Transfer from merchant text alone.",
    "- LOAN REPAYMENT, mortgage payment, student loan payment, auto loan payment, or personal loan payment rows -> Loan Payment.",
    "- INTEREST CHARGE, FINANCE CHARGE, APR INTEREST, loan interest, overdraft interest, or cash advance interest rows -> Interest Paid.",
    "- Klarna, Afterpay, Affirm, Tabby, Tamara, Sezzle, Clearpay, Zip, or installment repayment rows -> Buy Now Pay Later.",
    "- Debt repayment, debt recovery, creditor payment, collection payment, payoff, or settlement payment rows -> Debt when no more specific debt category fits.",
    "- Transfer is protected: use Transfer only for clear own-account movement with matching opposite-side evidence. If it merely says loan, debt, credit card, interest, or BNPL payment, use the specific payment category instead.",
    "- Debit card, card purchase, POS, and purchase are payment-method words, not merchants. Do not choose Shopping from those words alone; use the real merchant if present, otherwise return Uncategorized with needs_review=true.",
    "- Gym, fitness center, or climbing gym merchants (Touchstone Climbing, LA Fitness, etc.) -> if a fitness/gym category exists in the allowed list, use it; otherwise return Uncategorized with needs_review=true. Do NOT map gyms to Entertainment.",
    "",
    "Multilingual handling:",
    "- Merchant text may appear in English, Chinese, Japanese, Thai, Bahasa, Vietnamese, Tagalog, Korean, or mixed scripts.",
    "- Use both merchant_raw and merchant_normalized.",
    "- Ontology hints are anchors, not a translation dictionary.",
    "- For recognizable retail brands, well-known companies, and merchants where any reasonable category from the allowed list fits (Shopping, Electronics, Hobbies, and similar categories), pick the closest match. Do NOT return Uncategorized just because no perfectly specific category exists - the allowed list already covers most reasonable cases.",
    "- Reserve Uncategorized + needs_review=true for genuinely ambiguous merchants: short generic names (<=3 chars), unbranded company strings, or rows where the merchant text gives no signal at all.",
    "",
    "Direction rules:",
    "- direction=expense means money OUT. Pick ONLY from expense categories.",
    "- direction=income means money IN. Pick ONLY from income categories.",
    "- Never invent categories outside the ontology or the allowed lists.",
    "- Some valid allowed categories may not appear in the compact ontology block. You may still return them if they are the best exact fit from the allowed category lists.",
    "- If the merchant name is 3 or fewer characters and is not a recognizable global brand, return Uncategorized with needs_review=true. Do not force Entertainment, Shopping, or any broad lifestyle category for a short single-word merchant with weak evidence.",
    "- B2B, SaaS, or professional-services company names (for example a company with Inc, Ltd, or LLC and no clear consumer retail identity) should not be mapped to Shopping. Return Uncategorized with needs_review=true if no better match exists.",
    "",
    "Category ontology:",
    ontologyPayload,
    "",
    "Allowed EXPENSE categories:",
    expenseList.join(", "),
    "",
    "Allowed INCOME categories:",
    incomeList.join(", "),
    "",
    "Return each array element as:",
    "{\"category\":\"<exact category>\",\"broad_concept\":\"<parent concept or short broad bucket>\",\"confidence\":0.0-1.0,\"language_detected\":\"<bcp47-like tag>\",\"merchant_clean\":\"<clean merchant>\",\"reasoning\":\"<short reason>\",\"needs_review\":false,\"alternate_category\":null}",
    "",
    "Validation expectations:",
    "- category must exactly match an allowed ontology category of the correct side",
    "- alternate_category must be null or another allowed ontology category of the correct side",
    "- merchant_clean should be a short cleaned merchant string",
    "- reasoning should be short and concrete",
    "",
    `Input: ${JSON.stringify(serializedInput)}`
  ].join("\n");

  return {
    prompt,
    ontologyTokenEstimate,
    promptTokenEstimate: estimateTokensFromText(prompt),
    ontologyEntryCount: compactOntology.length,
    promptVersion: PHASE4_PROMPT_VERSION
  };
}

function buildPromptForVersion(
  promptVersion: string,
  rows: QueueRow[],
  expenseCategories: string[],
  incomeCategories: string[],
  ontologyEntries: OntologyPromptEntry[]
): PromptBuildStats {
  return promptVersion === PHASE4_PROMPT_VERSION
    ? buildPhase4Prompt(rows, expenseCategories, incomeCategories, ontologyEntries)
    : buildLegacyPrompt(rows, expenseCategories, incomeCategories, ontologyEntries);
}

async function callGeminiForVersion(promptVersion: string, prompt: string): Promise<AiResult[] | null> {
  return promptVersion === PHASE4_PROMPT_VERSION
    ? await callGeminiPhase4(prompt)
    : await callGeminiLegacy(prompt);
}

async function callGeminiForVersionWithShapeRetry(
  promptVersion: string,
  prompt: string,
  expectedCount: number,
  context: { reqId: string; userId: string; chunkIdx: number }
): Promise<AiResult[] | null> {
  const MAX_SHAPE_RETRIES = 2;
  let lastResult: AiResult[] | null = null;

  for (let attempt = 0; attempt <= MAX_SHAPE_RETRIES; attempt += 1) {
    const retryInstruction = attempt === 0
      ? ""
      : [
          "",
          "IMPORTANT RETRY:",
          `Your previous response did not contain exactly ${expectedCount} JSON array item(s).`,
          `Return exactly ${expectedCount} item(s), in the same order as Input, with no markdown and no explanation.`
        ].join("\n");
    const result = await callGeminiForVersion(promptVersion, `${prompt}${retryInstruction}`);
    lastResult = result;

    if (result && result.length >= expectedCount) return result;

    if (attempt < MAX_SHAPE_RETRIES) {
      const delayMs = attempt === 0 ? 1200 : 2500;
      console.warn(
        `[${context.reqId}] ai_result_shape_retry user=${context.userId} chunk=${context.chunkIdx} attempt=${attempt + 1} received=${result?.length ?? 0} expected=${expectedCount} delay_ms=${delayMs}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return lastResult;
}

// GoCardless/Finverse sign convention is opposite to the pipeline standard:
//   amount < 0 = expense (money OUT), amount > 0 = income (money IN)
//   Pipeline:   amount < 0 = income (money IN),   amount > 0 = expense (money OUT)
// Statement imports are normalized by import-statement-transactions before queueing,
// so they follow the pipeline convention here.
function providerIsMoneyIn(row: QueueRow): boolean {
  const cents = row.amount_cents;
  if (typeof cents !== "number" || !Number.isFinite(cents)) return false;
  const provider = String(row.provider ?? "").trim().toLowerCase();
  return provider === "gocardless" || provider === "finverse"
    ? cents > 0
    : cents < 0;
}

function providerAmountIsMoneyIn(provider: string | null | undefined, amountCents: number): boolean {
  const normalizedProvider = String(provider ?? "plaid").trim().toLowerCase();
  return normalizedProvider === "gocardless" || normalizedProvider === "finverse"
    ? amountCents > 0
    : amountCents < 0;
}

function moneyMovementText(row: QueueRow, meta: TxnMeta | null = null): string {
  return [
    row.merchant_raw,
    row.merchant_normalized,
    meta?.name,
    meta?.merchant,
    meta?.merchant_name
  ]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaMoneyMovementText(meta: TxnMeta): string {
  return [meta.name, meta.merchant, meta.merchant_name]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function categoryMatches(category: string | null, target: string): boolean {
  return normCategoryText(String(category ?? "")) === normCategoryText(target);
}

function isTransferCategory(category: string | null): boolean {
  return categoryMatches(category, "Transfer");
}

function isUncategorizedCategory(category: string | null): boolean {
  return categoryMatches(category, UNCATEGORIZED_KEY);
}

function parseIsoDateMillis(value: string | null | undefined): number | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

function addDaysToIsoDate(value: string, days: number): string | null {
  const millis = parseIsoDateMillis(value);
  if (millis == null) return null;
  return new Date(millis + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayDiffAbs(a: string, b: string): number | null {
  const aMillis = parseIsoDateMillis(a);
  const bMillis = parseIsoDateMillis(b);
  if (aMillis == null || bMillis == null) return null;
  return Math.abs(Math.round((aMillis - bMillis) / (24 * 60 * 60 * 1000)));
}

const INTEREST_PAID_PATTERNS = [
  /\b(?:interest|apr).{0,24}\b(?:charge|charged|paid|payment|fee)\b/i,
  /\b(?:finance charge|purchase interest|cash advance interest|loan interest|overdraft interest)\b/i,
  /\b(?:bunga|biaya bunga|beban bunga|bunga pinjaman|bunga kartu kredit|bunga kredit|denda bunga)\b/i,
  /\b(?:lai|lai suat|phi lai|tien lai|lai vay|lai the tin dung|phi tai chinh)\b/i,
  /\b(?:faedah|caj faedah|bayaran faedah|faedah pinjaman|faedah kad kredit|caj kewangan|caj pembiayaan)\b/i,
  /\b(?:interes|interest fee|singil sa interes|bayad sa interes|interes sa utang|interes sa loan|interes sa credit card|finance charge)\b/i,
  /(?:lãi|lãi suất|phí lãi|tiền lãi|lãi vay|lãi thẻ tín dụng|phí tài chính)/i,
  /(?:利息|利息支出|利息收費|財務費用|透支利息|現金透支利息)/
];

const BNPL_PATTERNS = [
  /\b(?:klarna|afterpay|affirm|tabby|tamara|sezzle|clearpay|zip pay|zip co|paylater|pay later|atome|hoolah|pace|kredivo|akulaku|spaylater|shopee paylater|gopaylater|go paylater|traveloka paylater|fundiin|momo paylater|zalopay paylater|shopee tra sau|shopee tra truoc|spaylater|grab paylater|grabpaylater|paylater by grab|billease|tala|cashalo|atome philippines|spaylater philippines|gcash ggives|ggives|gcredit)\b/i,
  /\b(?:installment|instalment|cicilan|angsuran|tra gop|mua truoc tra sau|ansuran|bayaran ansuran|hulugan|installment plan).{0,24}\b(?:payment|repayment|pmt|bayar|pembayaran|thanh toan|tra no|bayaran|bayad)\b/i,
  /\b(?:bayar|pembayaran).{0,24}\b(?:cicilan|angsuran|paylater|pay later)\b/i,
  /\b(?:bayar|bayaran|pembayaran).{0,24}\b(?:ansuran|paylater|pay later|beli sekarang bayar kemudian)\b/i,
  /\b(?:beli sekarang bayar kemudian|bayar kemudian)\b/i,
  /\b(?:bayad|pagbabayad).{0,24}\b(?:hulugan|installment|paylater|pay later|buy now pay later)\b/i,
  /(?:trả góp|mua trước trả sau|thanh toán trả góp|trả sau)/i,
  /(?:先買後付|分期付款|分期還款|分期繳款)/
];

const CREDIT_CARD_PAYMENT_PATTERNS = [
  /\bcredit\s*card\b.{0,40}\b(?:payment|pmt|autopay|auto pay)\b/i,
  /\bcredit\s*card\b.{0,40}\b(?:repayment|settlement)\b/i,
  /\b(?:payment|pmt|autopay|auto pay)\b.{0,40}\bcredit\s*card\b/i,
  /\b(?:repayment|settlement)\b.{0,40}\bcredit\s*card\b/i,
  /\b(?:cc|cardmember|card member)\b.{0,32}\b(?:payment|pmt|autopay|auto pay|repayment|settlement)\b/i,
  /\b(?:amex|american express|visa|mastercard|master card)\b.{0,32}\b(?:payment|pmt|autopay|auto pay|repayment|settlement)\b/i,
  /\b(?:payment|pmt|autopay|auto pay|repayment|settlement)\b.{0,32}\b(?:amex|american express|visa|mastercard|master card)\b/i,
  /\b(?:pembayaran|bayar|pelunasan|tagihan).{0,40}\b(?:kartu kredit|kartu kreditnya|cc)\b/i,
  /\b(?:kartu kredit|cc).{0,40}\b(?:pembayaran|bayar|pelunasan|tagihan)\b/i,
  /\b(?:thanh toan|tra no|tat toan).{0,40}\b(?:the tin dung|credit card)\b/i,
  /\b(?:the tin dung|credit card).{0,40}\b(?:thanh toan|tra no|tat toan)\b/i,
  /\b(?:bayaran|pembayaran|bayar|penyelesaian|jelaskan).{0,40}\b(?:kad kredit|cc)\b/i,
  /\b(?:kad kredit|cc).{0,40}\b(?:bayaran|pembayaran|bayar|penyelesaian|jelaskan)\b/i,
  /\b(?:bayad|pagbabayad|settlement|hulog).{0,40}\b(?:credit card|kredit card|card)\b/i,
  /\b(?:credit card|kredit card|card).{0,40}\b(?:bayad|pagbabayad|settlement|hulog)\b/i,
  /(?:thanh toán|trả nợ|tất toán).{0,40}(?:thẻ tín dụng)/i,
  /(?:thẻ tín dụng).{0,40}(?:thanh toán|trả nợ|tất toán)/i,
  /(?:信用卡|卡數|卡賬|卡帳).{0,16}(?:還款|付款|繳款|自動轉賬|自動轉帳|結算)/,
  /(?:還卡數|繳付信用卡|償還信用卡)/
];

const LOAN_PAYMENT_PATTERNS = [
  /\bloan\b.{0,40}\b(?:payment|repayment|pmt|autopay|auto pay)\b/i,
  /\b(?:payment|repayment|pmt|autopay|auto pay)\b.{0,40}\bloan\b/i,
  /\b(?:mortgage|student loan|auto loan|car loan|personal loan)\b.{0,40}\b(?:payment|repayment|pmt|autopay|auto pay)?\b/i,
  /\b(?:pembayaran|bayar|pelunasan|cicilan|angsuran).{0,40}\b(?:pinjaman|kredit|kpr|kredit rumah|kredit mobil)\b/i,
  /\b(?:pinjaman|kredit|kpr|kredit rumah|kredit mobil).{0,40}\b(?:pembayaran|bayar|pelunasan|cicilan|angsuran)\b/i,
  /\b(?:thanh toan|tra no|tat toan|tra gop).{0,40}\b(?:khoan vay|vay|tin dung|the chap|vay mua nha|vay mua xe)\b/i,
  /\b(?:khoan vay|vay|tin dung|the chap|vay mua nha|vay mua xe).{0,40}\b(?:thanh toan|tra no|tat toan|tra gop)\b/i,
  /\b(?:bayaran|pembayaran|bayar|penyelesaian|ansuran).{0,40}\b(?:pinjaman|pembiayaan|gadai janji|pinjaman perumahan|pinjaman kereta|pinjaman peribadi)\b/i,
  /\b(?:pinjaman|pembiayaan|gadai janji|pinjaman perumahan|pinjaman kereta|pinjaman peribadi).{0,40}\b(?:bayaran|pembayaran|bayar|penyelesaian|ansuran)\b/i,
  /\b(?:bayad|pagbabayad|hulog|settlement).{0,40}\b(?:loan|pautang|home loan|car loan|personal loan)\b/i,
  /\b(?:loan|pautang|home loan|car loan|personal loan).{0,40}\b(?:bayad|pagbabayad|hulog|settlement)\b/i,
  /(?:thanh toán|trả nợ|tất toán|trả góp).{0,40}(?:khoản vay|vay|tín dụng|thế chấp|vay mua nhà|vay mua xe)/i,
  /(?:khoản vay|vay|tín dụng|thế chấp|vay mua nhà|vay mua xe).{0,40}(?:thanh toán|trả nợ|tất toán|trả góp)/i,
  /(?:貸款|按揭|私人貸款).{0,16}(?:還款|付款|供款|繳款)/,
  /(?:還貸|供樓|按揭供款|按揭還款)/
];

const DEBT_PAYMENT_PATTERNS = [
  /\bdebt\b.{0,40}\b(?:payment|repayment|recovery|collection|settlement|payoff)\b/i,
  /\b(?:collection payment|debt recovery|debt repayment|debt payment|creditor payment|settlement payment|payoff payment)\b/i,
  /\b(?:utang|hutang).{0,40}\b(?:pembayaran|bayar|pelunasan|cicilan|angsuran|penagihan|tagihan)\b/i,
  /\b(?:pembayaran|bayar|pelunasan|cicilan|angsuran|penagihan|tagihan).{0,40}\b(?:utang|hutang)\b/i,
  /\b(?:no|khoan no|cong no).{0,40}\b(?:thanh toan|tra no|tat toan|thu hoi)\b/i,
  /\b(?:thanh toan|tra no|tat toan|thu hoi).{0,40}\b(?:no|khoan no|cong no)\b/i,
  /\b(?:hutang|utang).{0,40}\b(?:bayaran|pembayaran|bayar|penyelesaian|ansuran|kutipan|tuntutan)\b/i,
  /\b(?:bayaran|pembayaran|bayar|penyelesaian|ansuran|kutipan|tuntutan).{0,40}\b(?:hutang|utang)\b/i,
  /\b(?:utang|pautang).{0,40}\b(?:bayad|pagbabayad|settlement|singil|koleksyon|collection)\b/i,
  /\b(?:bayad|pagbabayad|settlement|singil|koleksyon|collection).{0,40}\b(?:utang|pautang)\b/i,
  /(?:nợ|khoản nợ|công nợ).{0,40}(?:thanh toán|trả nợ|tất toán|thu hồi)/i,
  /(?:thanh toán|trả nợ|tất toán|thu hồi).{0,40}(?:nợ|khoản nợ|công nợ)/i,
  /(?:債務|欠款).{0,16}(?:還款|付款|償還|清還|結清|追討)/,
  /(?:還債|清還欠款|債務重組|追討欠款)/
];

const OWN_ACCOUNT_TRANSFER_PATTERNS = [
  /\b(?:internal transfer|own account transfer|between accounts|account transfer|wallet transfer|self transfer)\b/i,
  /\b(?:transfer|xfer)\b.{0,40}\b(?:checking|savings|wallet|account|own|internal)\b/i,
  /\b(?:checking|savings|wallet|account)\b.{0,40}\b(?:transfer|xfer)\b/i,
  /\b(?:from|to)\b.{0,24}\b(?:checking|savings|wallet|account)\b/i,
  /\b(?:transfer|pindah dana|pemindahan dana).{0,40}\b(?:rekening sendiri|antar rekening|rekening saya|tabungan|giro|dompet)\b/i,
  /\b(?:rekening sendiri|antar rekening|rekening saya|tabungan|giro|dompet).{0,40}\b(?:transfer|pindah dana|pemindahan dana)\b/i,
  /\b(?:chuyen khoan|chuyen tien).{0,40}\b(?:tai khoan cua toi|tai khoan minh|giua cac tai khoan|tiet kiem|vi|vi dien tu)\b/i,
  /\b(?:tai khoan cua toi|tai khoan minh|giua cac tai khoan|tiet kiem|vi|vi dien tu).{0,40}\b(?:chuyen khoan|chuyen tien)\b/i,
  /\b(?:pindahan|pemindahan|transfer).{0,40}\b(?:akaun sendiri|antara akaun|akaun saya|simpanan|semasa|dompet)\b/i,
  /\b(?:akaun sendiri|antara akaun|akaun saya|simpanan|semasa|dompet).{0,40}\b(?:pindahan|pemindahan|transfer)\b/i,
  /\b(?:lipat|paglipat|transfer).{0,40}\b(?:sariling account|aking account|account ko|savings|checking|wallet|gcash|maya)\b/i,
  /\b(?:sariling account|aking account|account ko|savings|checking|wallet|gcash|maya).{0,40}\b(?:lipat|paglipat|transfer)\b/i,
  /(?:chuyển khoản|chuyển tiền).{0,40}(?:tài khoản của tôi|tài khoản mình|giữa các tài khoản|tiết kiệm|ví điện tử|ví)/i,
  /(?:tài khoản của tôi|tài khoản mình|giữa các tài khoản|tiết kiệm|ví điện tử|ví).{0,40}(?:chuyển khoản|chuyển tiền)/i,
  /(?:內部轉賬|內部轉帳|本人戶口|戶口轉賬|戶口轉帳|賬戶轉賬|帳戶轉帳|轉賬至|轉帳至|由.{0,12}轉至)/
];

function detectProtectedMoneyMovementCategory(
  row: QueueRow,
  meta: TxnMeta | null,
  expenseCategories: string[]
): ProtectedMoneyMovementCategory | null {
  const text = moneyMovementText(row, meta);
  if (!text) return null;

  const pick = (name: string, confidence: number, reason: string): ProtectedMoneyMovementCategory | null => {
    const categoryKey = pickFirstAllowed(expenseCategories, [name]);
    return categoryKey ? { categoryKey, confidence, reason } : null;
  };

  if (matchesAny(text, INTEREST_PAID_PATTERNS)) {
    return pick("Interest Paid", 0.98, "interest_charge_text");
  }
  if (matchesAny(text, BNPL_PATTERNS)) {
    return pick("Buy Now Pay Later", 0.98, "bnpl_provider_text");
  }
  if (matchesAny(text, CREDIT_CARD_PAYMENT_PATTERNS)) {
    return pick("Credit Card Payment", 0.98, "credit_card_payment_text");
  }
  if (matchesAny(text, LOAN_PAYMENT_PATTERNS)) {
    return pick("Loan Payment", 0.98, "loan_payment_text");
  }
  if (matchesAny(text, DEBT_PAYMENT_PATTERNS)) {
    return pick("Debt", 0.94, "debt_payment_text");
  }
  return null;
}

function looksLikeOwnAccountTransferText(text: string): boolean {
  return matchesAny(text, OWN_ACCOUNT_TRANSFER_PATTERNS);
}

function transferCandidateFromMeta(meta: TxnMeta): TransferCandidate | null {
  if (typeof meta.amount_cents !== "number" || !Number.isFinite(meta.amount_cents)) return null;
  const amountCents = Math.round(meta.amount_cents);
  const provider = String(meta.provider ?? "plaid").trim().toLowerCase() || "plaid";
  return {
    userId: meta.user_id,
    txnId: meta.txn_id,
    accountId: meta.account_id,
    provider,
    txnDate: meta.txn_date,
    amountCents,
    isMoneyIn: providerAmountIsMoneyIn(provider, amountCents),
    text: metaMoneyMovementText(meta)
  };
}

function currentTransferCandidate(row: QueueRow, meta: TxnMeta | null): TransferCandidate | null {
  const amountCentsRaw =
    typeof row.amount_cents === "number" && Number.isFinite(row.amount_cents)
      ? row.amount_cents
      : meta?.amount_cents;
  if (typeof amountCentsRaw !== "number" || !Number.isFinite(amountCentsRaw)) return null;
  const provider = String(row.provider || meta?.provider || "plaid").trim().toLowerCase() || "plaid";
  const txnDate = String(meta?.txn_date ?? "").trim();
  if (!txnDate) return null;
  const amountCents = Math.round(amountCentsRaw);
  return {
    userId: row.user_id,
    txnId: row.txn_id,
    accountId: meta?.account_id ?? null,
    provider,
    txnDate,
    amountCents,
    isMoneyIn: providerAmountIsMoneyIn(provider, amountCents),
    text: moneyMovementText(row, meta)
  };
}

function findStrongTransferEvidence(
  row: QueueRow,
  meta: TxnMeta | null,
  transferCandidatesByUser: Map<string, TransferCandidate[]>,
  options: TransferEvidenceOptions = {}
): TransferEvidence {
  const current = currentTransferCandidate(row, meta);
  if (!current) {
    return { matched: false, matchTxnId: null, reason: "missing_transfer_metadata" };
  }

  const requiredCurrentProvider = String(options.currentProvider ?? "").trim().toLowerCase() || null;
  if (requiredCurrentProvider && current.provider !== requiredCurrentProvider) {
    return { matched: false, matchTxnId: null, reason: `current_provider_mismatch:${current.provider}` };
  }

  const currentAbs = Math.abs(current.amountCents);
  const currentLooksTransfer = looksLikeOwnAccountTransferText(current.text);
  if (options.requireCurrentOwnAccountText && !currentLooksTransfer) {
    return { matched: false, matchTxnId: null, reason: "current_missing_own_account_markers" };
  }
  const requiredCandidateProvider = String(options.candidateProvider ?? "").trim().toLowerCase() || null;
  const maxAmountDiffCents = Number.isFinite(options.maxAmountDiffCents)
    ? Math.max(0, Math.trunc(options.maxAmountDiffCents as number))
    : 2;
  const maxDateGapDays = Number.isFinite(options.maxDateGapDays)
    ? Math.max(0, Math.trunc(options.maxDateGapDays as number))
    : 1;
  const candidates = transferCandidatesByUser.get(row.user_id) || [];
  for (const candidate of candidates) {
    if (candidate.txnId === current.txnId) continue;
    if (requiredCandidateProvider && candidate.provider !== requiredCandidateProvider) continue;
    if (candidate.accountId && current.accountId && candidate.accountId === current.accountId) continue;
    if (candidate.isMoneyIn === current.isMoneyIn) continue;
    if (Math.abs(Math.abs(candidate.amountCents) - currentAbs) > maxAmountDiffCents) continue;
    const dateGap = dayDiffAbs(current.txnDate, candidate.txnDate);
    if (dateGap == null || dateGap > maxDateGapDays) continue;
    const candidateLooksTransfer = looksLikeOwnAccountTransferText(candidate.text);
    if (options.requireCandidateOwnAccountText && !candidateLooksTransfer) continue;
    if (
      !options.requireCurrentOwnAccountText &&
      !options.requireCandidateOwnAccountText &&
      !currentLooksTransfer &&
      !candidateLooksTransfer
    ) {
      continue;
    }
    return {
      matched: true,
      matchTxnId: candidate.txnId,
      reason: `matched_opposite_transaction:${candidate.txnId}`
    };
  }
  return { matched: false, matchTxnId: null, reason: "no_matching_opposite_transaction" };
}

function maybeApplyMoneyMovementGuard(params: {
  row: QueueRow;
  txnMeta: TxnMeta | null;
  transferCandidatesByUser: Map<string, TransferCandidate[]>;
  categoryKey: string;
  confidence: number;
  isMoneyIn: boolean;
  incomeCategories: string[];
  expenseCategories: string[];
  allowUserOverride: boolean;
}): MoneyMovementGuardDecision | null {
  if (params.allowUserOverride) return null;

  const allowedForSide = params.isMoneyIn ? params.incomeCategories : params.expenseCategories;
  const uncategorizedFallback = pickFirstAllowed(allowedForSide, [UNCATEGORIZED_KEY]) ?? UNCATEGORIZED_KEY;
  const transferCategory = pickFirstAllowed(allowedForSide, ["Transfer"]);
  const transferEvidence = findStrongTransferEvidence(
    params.row,
    params.txnMeta,
    params.transferCandidatesByUser
  );

  if (!params.isMoneyIn) {
    const protectedCategory = detectProtectedMoneyMovementCategory(
      params.row,
      params.txnMeta,
      params.expenseCategories
    );
    if (protectedCategory) {
      return {
        categoryKey: protectedCategory.categoryKey,
        confidence: Math.max(params.confidence, protectedCategory.confidence),
        needsReview: false,
        isSuggested: false,
        resultSource: "money_movement_guard",
        reason: protectedCategory.reason,
        transferMatched: false,
        transferBlocked: isTransferCategory(params.categoryKey)
      };
    }
  }

  if (isTransferCategory(params.categoryKey)) {
    if (transferCategory && transferEvidence.matched) {
      return {
        categoryKey: transferCategory,
        confidence: Math.max(params.confidence, 0.97),
        needsReview: false,
        isSuggested: false,
        resultSource: "transfer_evidence",
        reason: transferEvidence.reason,
        transferMatched: true,
        transferBlocked: false
      };
    }
    return {
      categoryKey: uncategorizedFallback,
      confidence: 1.0,
      needsReview: true,
      isSuggested: false,
      resultSource: "money_movement_guard_blocked_transfer",
      reason: transferEvidence.reason,
      transferMatched: false,
      transferBlocked: true
    };
  }

  if (
    transferCategory &&
    transferEvidence.matched &&
    isUncategorizedCategory(params.categoryKey) &&
    looksLikeOwnAccountTransferText(moneyMovementText(params.row, params.txnMeta))
  ) {
    return {
      categoryKey: transferCategory,
      confidence: 0.97,
      needsReview: false,
      isSuggested: false,
      resultSource: "transfer_evidence",
      reason: transferEvidence.reason,
      transferMatched: true,
      transferBlocked: false
    };
  }

  return null;
}

function maybeApplyStatementImportGenericFallback(params: {
  row: QueueRow;
  txnMeta: TxnMeta | null;
  transferCandidatesByUser: Map<string, TransferCandidate[]>;
  isMoneyIn: boolean;
  incomeCategories: string[];
  expenseCategories: string[];
}): StatementImportFallbackDecision | null {
  const provider = String(params.row.provider ?? "").trim().toLowerCase();
  if (provider !== "statement_import") return null;

  const merchantNorm = normalizeMerchant(params.row.merchant_normalized || params.row.merchant_raw || "");
  if (!merchantNorm) return null;

  const allowed = params.isMoneyIn ? params.incomeCategories : params.expenseCategories;
  const pick = (preferred: string[]): string | null => pickFirstAllowed(allowed, preferred);
  const hasTurkishOwnAccountMarkers =
    /\bhesa[pb](?:a|tan)\b/.test(merchantNorm) &&
    /\b(?:ziraat\b.{0,24}\bmobil|\bmobil\b.{0,24}\bziraat)\b/.test(merchantNorm);
  const hasTurkishVirmanRail = /\b(?:virman|viman|vırman)\b/.test(merchantNorm);
  const hasTurkishHavaleRail = /\bhavale\b/.test(merchantNorm) &&
    /\b(?:ziraat\b.{0,24}\bmobil|\bmobil\b.{0,24}\bziraat)\b/.test(merchantNorm);
  const hasTurkishAtmCashOut =
    /\batm\b/.test(merchantNorm) &&
    /\b(?:para cekme|qr ile para cekme|cash withdrawal|cashout)\b/.test(merchantNorm);
  const isExactPlaceholderLabel = (labels: string[]): boolean => labels.includes(merchantNorm);

  // Ziraat "Virman" is an explicit own-account transfer rail, so treat it as
  // pure transfer evidence without requiring an opposite-leg match.
  if (hasTurkishOwnAccountMarkers && hasTurkishVirmanRail) {
    const categoryKey = pick(["Transfer"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.97,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_turkish_virman"
      };
    }
  }

  // Keep generic/person-to-person "Havale" out of automatic Transfer unless
  // the row also carries the same own-account proof we require elsewhere.
  if (hasTurkishHavaleRail && hasTurkishOwnAccountMarkers) {
    const categoryKey = pick(["Transfer"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.94,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_turkish_havale_own_account"
      };
    }
  }

  if (/\b(neft|rtgs|imps|transfer|xfer|wire|swift|ach|cheque|check|upi)\b/.test(merchantNorm)) {
    // Preserve the same strict transfer policy as bank flow:
    // Transfer only when we have opposite-side matching evidence.
    const transferEvidence = findStrongTransferEvidence(
      params.row,
      params.txnMeta,
      params.transferCandidatesByUser,
      {
        currentProvider: "statement_import",
        candidateProvider: "statement_import",
        requireCurrentOwnAccountText: true,
        requireCandidateOwnAccountText: true,
        maxAmountDiffCents: 0,
        maxDateGapDays: 0
      }
    );
    if (!transferEvidence.matched) return null;

    const categoryKey = pick(["Transfer"]);
    if (!categoryKey) return null;
    return {
      categoryKey,
      confidence: 0.95,
      needsReview: false,
      resultSource: "statement_import_generic_fallback",
      reason: "statement_import_transfer_rail_matched"
    };
  }

  if (merchantNorm === "atm" || hasTurkishAtmCashOut) {
    if (!params.isMoneyIn) {
      const categoryKey = pick(["ATM Withdrawals"]);
      if (categoryKey) {
        return {
          categoryKey,
          confidence: 0.90,
          needsReview: false,
          resultSource: "statement_import_generic_fallback",
          reason: "statement_import_atm_cash_out"
        };
      }
    }
    return null;
  }

  if (isExactPlaceholderLabel(["interest", "intrst"])) {
    const categoryKey = params.isMoneyIn
      ? pick(["Interest"])
      : pick(["Interest Paid", "Bank Fees"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.92,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_interest"
      };
    }
  }

  if (merchantNorm === "commission") {
    const categoryKey = params.isMoneyIn
      ? pick(["Bonus"])
      : pick(["Bank Fees", "Credit Card Fees"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.90,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_commission"
      };
    }
  }

  if (isExactPlaceholderLabel(["tax", "taxes"])) {
    const categoryKey = params.isMoneyIn
      ? pick(["Tax Refund", "Refund"])
      : pick(["Taxes"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.90,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_tax"
      };
    }
  }

  if (merchantNorm === "reversal") {
    if (!params.isMoneyIn) return null;
    const categoryKey = pick(["Refund"]);
    if (categoryKey) {
      return {
        categoryKey,
        confidence: 0.88,
        needsReview: false,
        resultSource: "statement_import_generic_fallback",
        reason: "statement_import_refund_reversal"
      };
    }
  }

  if (/\b(debit card|purchase|pos)\b/.test(merchantNorm)) {
    return null;
  }

  return null;
}

function buildDeterministicObservation(
  row: QueueRow,
  deterministicPatterns: DeterministicPattern[],
  deterministicKillSwitchSet: Set<string>,
  userMerchantRuleMap: Map<string, string>,
  incomeCats: string[],
  expenseCats: string[]
): DeterministicObservation {
  const merchantNormalized = normalizeMerchant(row.merchant_normalized || row.merchant_raw || "");
  const isMoneyIn = providerIsMoneyIn(row);
  const deterministicEnabledForUser = isDeterministicEnabledForUser(row.user_id);
  const userRuleCategory = merchantNormalized
    ? (userMerchantRuleMap.get(`${row.user_id}::${merchantNormalized}`) ?? null)
    : null;
  const deterministicKillSwitch = merchantNormalized
    ? deterministicKillSwitchSet.has(`${row.user_id}::${merchantNormalized}`)
    : false;
  const allowedCategories = isMoneyIn ? incomeCats : expenseCats;
  const deterministicMatch = merchantNormalized && !deterministicKillSwitch && !userRuleCategory
    ? matchDeterministicPattern(
        merchantNormalized,
        isMoneyIn ? "income" : "expense",
        deterministicPatterns,
        allowedCategories
      )
    : null;
  return {
    merchantNormalized,
    isMoneyIn,
    deterministicEnabledForUser,
    deterministicKillSwitch,
    userRuleCategory,
    deterministicMatch,
    wouldMatch: Boolean(deterministicMatch),
    wouldMatchCategoryKey: deterministicMatch?.categoryKey ?? null
  };
}


// Normalize amount to pipeline convention (positive = expense, negative = income)
// so Gemini always sees the same sign semantics regardless of provider.
function normalizedAmountForPrompt(row: QueueRow): number | null {
  if (row.amount_cents == null) return null;
  const provider = String(row.provider ?? "").trim().toLowerCase();
  const cents = provider === "gocardless" || provider === "finverse" || provider === "statement_import"
    ? -row.amount_cents
    : row.amount_cents;
  return Number((cents / 100).toFixed(2));
}

function merchantDedupKey(row: QueueRow): string {
  const merchantBase = String(row.merchant_normalized ?? row.merchant_raw ?? "").trim();
  const merchant = normalizeMerchant(merchantBase);
  return `${merchant}::${providerIsMoneyIn(row) ? "in" : "out"}`;
}

function utcDayBounds(dateStr: string): { startIso: string; endIso: string } | null {
  if (!dateStr) return null;
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function callGeminiRaw(prompt: string): Promise<string | null> {
  const accessToken = await getAccessTokenACB();
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ACB}/locations/${VERTEX_REGION_ACB}/publishers/google/models/${GEMINI_MODEL}:generateContent`;

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 8192
        }
      })
    });

    if ((res.status === 503 || res.status === 429) && attempt < MAX_RETRIES) {
      const delayMs = Math.pow(2, attempt + 1) * 1000;
      console.warn(`Gemini ${res.status} on attempt ${attempt + 1}, retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Gemini request failed: ${res.status} ${body.slice(0, 500)}`);
    }

    const data = await res.json().catch(() => null);
    const rawText = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
    if (!rawText) return null;
    return rawText;
  }

  throw new Error("Gemini exhausted all retries");
}

function parseJsonArray(rawText: string | null): unknown[] | null {
  if (!rawText) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(rawText);
  } catch {
    return null;
  }
  return Array.isArray(arr) ? arr : null;
}

function normalizeLanguageDetected(value: unknown): { value: string | null; valid: boolean } {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, valid: false };
  const normalized = raw.replace(/_/g, "-");
  const valid = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(normalized);
  return { value: valid ? normalized : null, valid };
}

function parseLegacyAiResults(rawText: string | null): AiResult[] | null {
  const arr = parseJsonArray(rawText);
  if (!arr) return null;
  return arr.map((item: any) => ({
    category: String((item as any)?.category ?? "").trim() || null,
    confidence: parseConfidence((item as any)?.confidence),
    rawCategory: String((item as any)?.category ?? "").trim() || null,
    promptVersion: LEGACY_PROMPT_VERSION
  }));
}

function parsePhase4AiResults(rawText: string | null): AiResult[] | null {
  const arr = parseJsonArray(rawText);
  if (!arr) return null;
  return arr.map((item: any) => {
    const rawCategory = String((item as any)?.category ?? "").trim() || null;
    const broadConcept = String((item as any)?.broad_concept ?? "").trim() || null;
    const merchantClean = String((item as any)?.merchant_clean ?? "").trim() || null;
    const reasoning = String((item as any)?.reasoning ?? "").trim() || null;
    const alternateCategory = String((item as any)?.alternate_category ?? "").trim() || null;
    const needsReviewRaw = (item as any)?.needs_review;
    const needsReview = typeof needsReviewRaw === "boolean"
      ? needsReviewRaw
      : (/^(1|true|yes)$/i.test(String(needsReviewRaw ?? "").trim()));
    const languageDetected = normalizeLanguageDetected((item as any)?.language_detected);

    const validationErrors: string[] = [];
    const hasConfidence = (item as any)?.confidence !== undefined && (item as any)?.confidence !== null && String((item as any)?.confidence).trim?.() !== "";
    let confidence = parseConfidence((item as any)?.confidence);
    if (!hasConfidence) {
      validationErrors.push("missing_confidence");
    } else if (confidence === 0 && String((item as any)?.confidence ?? "").trim() !== "0") {
      confidence = 0.5;
      validationErrors.push("malformed_confidence_defaulted");
    }
    if (!rawCategory) validationErrors.push("missing_category");
    if (!broadConcept) validationErrors.push("missing_broad_concept");
    if (!merchantClean) validationErrors.push("missing_merchant_clean");
    if (!reasoning) validationErrors.push("missing_reasoning");
    if (typeof needsReviewRaw !== "boolean") validationErrors.push("missing_needs_review");
    if ((item as any)?.language_detected !== undefined && (item as any)?.language_detected !== null && !languageDetected.valid) {
      validationErrors.push("invalid_language_detected");
    }

    return {
      category: rawCategory,
      rawCategory,
      confidence,
      broadConcept,
      languageDetected: languageDetected.value,
      merchantClean,
      reasoning,
      needsReview,
      alternateCategory,
      validationError: validationErrors.length > 0 ? validationErrors.join(",") : null,
      promptVersion: PHASE4_PROMPT_VERSION
    };
  });
}

function appendValidationError(existing: string | null | undefined, next: string): string {
  const current = String(existing ?? "").trim();
  if (!current) return next;
  const parts = current.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(next)) parts.push(next);
  return parts.join(",");
}

function hasFatalPhase4ValidationError(validationError: string | null | undefined): boolean {
  const parts = String(validationError ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.some((part) => [
    "missing_confidence",
    "missing_category",
    "missing_broad_concept",
    "missing_merchant_clean",
    "missing_reasoning",
    "missing_needs_review",
    "category_not_in_ontology",
    "alternate_category_not_in_ontology"
  ].includes(part));
}

function composeAiReasoning(
  aiReasoning: string | null | undefined,
  semanticResolverReason: string | null,
  moneyMovementGuardReason: string | null
): string | null {
  const parts = [
    String(aiReasoning ?? "").trim() || null,
    semanticResolverReason ? `resolver:${semanticResolverReason}` : null,
    moneyMovementGuardReason ? `guard:${moneyMovementGuardReason}` : null
  ].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(" | ") : null;
}

async function callGeminiLegacy(prompt: string): Promise<AiResult[] | null> {
  const rawText = await callGeminiRaw(prompt);
  return parseLegacyAiResults(rawText);
}

async function callGeminiPhase4(prompt: string): Promise<AiResult[] | null> {
  const rawText = await callGeminiRaw(prompt);
  return parsePhase4AiResults(rawText);
}

function isRetryableAiChunkError(message: string | null): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  return [
    " 429 ",
    " 503 ",
    "rate limit",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "fetch failed",
    "network",
    "econn",
    "enotfound",
    "socket",
    "exhausted all retries"
  ].some((needle) => text.includes(needle));
}

async function markQueueRow(
  sb: any,
  rowId: string,
  updates: {
    status: "done" | "failed";
    result_category_key?: string | null;
    result_confidence?: number | null;
    is_suggested?: boolean;
    result_source?: string | null;
    deterministic_would_match?: boolean | null;
    deterministic_would_match_category_key?: string | null;
    deterministic_did_apply?: boolean | null;
    failure_stage?: string | null;
    prompt_version?: string | null;
    ai_broad_concept?: string | null;
    ai_language_detected?: string | null;
    ai_merchant_clean?: string | null;
    ai_reasoning?: string | null;
    ai_needs_review?: boolean | null;
    ai_alternate_category?: string | null;
    ai_validation_error?: string | null;
    ai_raw_category?: string | null;
  }
) {
  await sb
    .from("ai_categorization_queue")
    .update({
      status: updates.status,
      result_category_key: updates.result_category_key ?? null,
      result_confidence: updates.result_confidence ?? null,
      result_source: updates.result_source ?? null,
      deterministic_would_match: updates.deterministic_would_match ?? null,
      deterministic_would_match_category_key: updates.deterministic_would_match_category_key ?? null,
      deterministic_did_apply: updates.deterministic_did_apply ?? null,
      failure_stage: updates.failure_stage ?? null,
      prompt_version: updates.prompt_version ?? null,
      ai_broad_concept: updates.ai_broad_concept ?? null,
      ai_language_detected: updates.ai_language_detected ?? null,
      ai_merchant_clean: updates.ai_merchant_clean ?? null,
      ai_reasoning: updates.ai_reasoning ?? null,
      ai_needs_review: updates.ai_needs_review ?? null,
      ai_alternate_category: updates.ai_alternate_category ?? null,
      ai_validation_error: updates.ai_validation_error ?? null,
      ai_raw_category: updates.ai_raw_category ?? null,
      is_suggested: Boolean(updates.is_suggested ?? false),
      claimed_at: null,
      processed_at: new Date().toISOString()
    })
    .eq("id", rowId);
}

async function resolveDeterministicRetryableFailures(sb: any, userId: string): Promise<number> {
  const { data: rows, error } = await sb
    .from("ai_categorization_queue")
    .select("id,user_id,txn_id,merchant_normalized,deterministic_would_match_category_key")
    .eq("user_id", userId)
    .eq("status", "failed")
    .eq("deterministic_would_match", true)
    .in("failure_stage", RETRYABLE_AI_FAILURE_STAGES)
    .not("deterministic_would_match_category_key", "is", null)
    .limit(200);

  if (error) {
    throw new Error(`deterministic_retry_query_failed: ${error.message}`);
  }

  let resolved = 0;
  for (const row of rows || []) {
    const categoryKey = String(row.deterministic_would_match_category_key ?? "").trim();
    if (!categoryKey) continue;

    const { error: upsertErr } = await sb.rpc("upsert_txn_categorization_model_guarded", {
      p_user_id: row.user_id,
      p_txn_id: row.txn_id,
      p_category_model: categoryKey,
      p_category_confidence: 0.95,
      p_is_suggested: false,
      p_merchant_normalized: row.merchant_normalized ?? null
    });
    if (upsertErr) {
      console.warn(`deterministic_retry_upsert_failed row=${row.id} error=${upsertErr.message}`);
      continue;
    }

    await markQueueRow(sb, row.id, {
      status: "done",
      result_category_key: categoryKey,
      result_confidence: 0.95,
      result_source: "deterministic",
      deterministic_would_match: true,
      deterministic_would_match_category_key: categoryKey,
      deterministic_did_apply: true,
      failure_stage: null,
      prompt_version: "deterministic_retry_rescue",
      ai_needs_review: false
    });
    resolved += 1;
  }

  if (resolved > 0) {
    await sb.rpc("backfill_wallet_categories", { p_user_id: userId });
  }

  return resolved;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const reqId = crypto.randomUUID();
  const stats: BatchStats = {
    processed: 0,
    applied: 0,
    suggested: 0,
    skipped: 0,
    promoted_to_review: 0,
    userOverridesPreserved: 0,
    deterministicApplied: 0,
    deterministicShadowMatches: 0,
    deterministicSkippedByOverride: 0,
    semanticResolverApplied: 0,
    semanticResolverSuggested: 0,
    semanticResolverDeclined: 0,
    moneyMovementGuardApplied: 0,
    moneyMovementTransferMatched: 0,
    moneyMovementTransferBlocked: 0,
    errors: 0
  };

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json({ ok: false, error: "missing_supabase_env" }, 500);
    }
    if (!GEMINI_API_KEY) {
      return json({ ok: false, error: "missing_gemini_key" }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") ?? "";
    const [scheme, bearerToken] = authHeader.split(" ");
    const requestingUserId = typeof body?.user_id === "string" && body.user_id.trim() ? body.user_id.trim() : null;
    const forcePhase4Prompt = shouldForcePhase4Prompt(body);
    let authUser: any = null;

    if (scheme !== "Bearer" || !bearerToken) {
      return json({ ok: false, error: "missing_authorization" }, 401);
    }

    const isServiceCall = bearerToken === SERVICE_ROLE;
    if (!isServiceCall) {
      if (!SUPABASE_ANON_KEY) {
        return json({ ok: false, error: "missing_anon_env" }, 500);
      }
      if (!requestingUserId) {
        return json({ ok: false, error: "user_id_required" }, 400);
      }
      const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false }
      });
      const { data: { user }, error: authError } = await authClient.auth.getUser(bearerToken);
      if (authError || !user || user.id !== requestingUserId) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      authUser = user;
      if (!userHasProAccess(authUser)) {
        return json({ ok: false, error: "pro_required", message: "AI categorization is Pro only." }, 403);
      }
    } else {
      if (!requestingUserId) {
        return json({ ok: false, error: "user_id_required_for_service_call" }, 400);
      }
      const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false },
      });
      const hasProAccess = await userIdHasProAccess(adminClient, requestingUserId);
      if (!hasProAccess) {
        return json({ ok: false, error: "pro_required", message: "AI categorization is Pro only." }, 403);
      }
    }

    if (body?.fixture_mode === true) {
      if (!ENABLE_FIXTURE_MODE) {
        return json({ ok: false, error: "fixture_mode_disabled" }, 403);
      }
      const requestRowSource = String(
        body?.row_source ?? body?.fixture_row_source ?? ""
      ).trim().toLowerCase();
      if (requestRowSource !== "fixture") {
        return json({ ok: false, error: "fixture_row_source_required" }, 400);
      }
      const fixtureRowsRaw = Array.isArray(body?.fixture_rows)
        ? (body.fixture_rows as FixtureInputRow[])
        : [];
      const fixturePromptVersion = body?.use_phase4_prompt === true
        ? PHASE4_PROMPT_VERSION
        : LEGACY_PROMPT_VERSION;
      const expenseCategories = dedupeCategoryNames(stringArray(body?.expense_categories));
      const incomeCategories = dedupeCategoryNames(stringArray(body?.income_categories));
      const allowedCategories = dedupeCategoryNames([...expenseCategories, ...incomeCategories]);

      if (fixtureRowsRaw.length === 0) {
        return json({ ok: false, error: "fixture_rows_required" }, 400);
      }
      if (expenseCategories.length === 0 || incomeCategories.length === 0) {
        return json({ ok: false, error: "expense_and_income_categories_required" }, 400);
      }

      const categoryIsIncomeMap = new Map<string, boolean>();
      for (const name of expenseCategories) categoryIsIncomeMap.set(normCategoryText(name), false);
      for (const name of incomeCategories) categoryIsIncomeMap.set(normCategoryText(name), true);
      const fixtureOntologyEntries = buildPromptOntologyEntriesFromSeed(expenseCategories, incomeCategories);

      const fixtureQueueRows: QueueRow[] = fixtureRowsRaw.map((row, idx) => {
        const rowSource = String(row?.row_source ?? requestRowSource).trim().toLowerCase();
        if (rowSource !== "fixture") {
          throw new Error(`fixture_row_source_invalid_at_index_${idx}`);
        }
        const merchantRaw = String(row?.merchant_raw ?? "").trim();
        const merchantNormalizedInput = String(row?.merchant_normalized ?? "").trim();
        const merchantNormalized = merchantNormalizedInput || normalizeMerchant(merchantRaw);
        const amountCents = Number(row?.amount_cents ?? 0);
        return {
          id: String(row?.id ?? `fixture_${idx + 1}`),
          txn_id: String(row?.id ?? `fixture_${idx + 1}`),
          provider: String(row?.provider ?? "finverse").trim().toLowerCase() || "finverse",
          user_id: "fixture_user",
          merchant_raw: merchantRaw || null,
          merchant_normalized: merchantNormalized || null,
          amount_cents: Number.isFinite(amountCents) ? amountCents : 0,
          account_subtype: String(row?.account_subtype ?? "").trim() || null,
          status: "pending"
        };
      });

      const AI_CHUNK_SIZE = 20;
      const chunks: QueueRow[][] = [];
      for (let i = 0; i < fixtureQueueRows.length; i += AI_CHUNK_SIZE) {
        chunks.push(fixtureQueueRows.slice(i, i + AI_CHUNK_SIZE));
      }

      const aiResultsByIndex: AiResult[] = [];
      const tokenObservability: Array<{
        chunk_index: number;
        prompt_version: string;
        ontology_entries: number;
        ontology_tokens: number;
        prompt_tokens_estimate: number;
        target_tokens: number;
        hard_limit: number;
        within_target: boolean;
      }> = [];
      for (const chunk of chunks) {
        const promptStats = buildPromptForVersion(
          fixturePromptVersion,
          chunk,
          expenseCategories,
          incomeCategories,
          fixtureOntologyEntries
        );
        console.log(JSON.stringify({
          req_id: reqId,
          event: "ontology_token_budget",
          scope: "fixture_mode",
          prompt_version: promptStats.promptVersion,
          ontology_seed_version: ONTOLOGY_SEED_VERSION,
          ontology_entries: promptStats.ontologyEntryCount,
          ontology_tokens: promptStats.ontologyTokenEstimate,
          prompt_tokens_estimate: promptStats.promptTokenEstimate,
          target_tokens: ONTOLOGY_TOKEN_TARGET,
          hard_limit: ONTOLOGY_TOKEN_HARD_LIMIT,
          within_target: promptStats.ontologyTokenEstimate <= ONTOLOGY_TOKEN_TARGET
        }));
        tokenObservability.push({
          chunk_index: tokenObservability.length,
          prompt_version: promptStats.promptVersion,
          ontology_entries: promptStats.ontologyEntryCount,
          ontology_tokens: promptStats.ontologyTokenEstimate,
          prompt_tokens_estimate: promptStats.promptTokenEstimate,
          target_tokens: ONTOLOGY_TOKEN_TARGET,
          hard_limit: ONTOLOGY_TOKEN_HARD_LIMIT,
          within_target: promptStats.ontologyTokenEstimate <= ONTOLOGY_TOKEN_TARGET
        });
        const result = await callGeminiForVersionWithShapeRetry(
          promptStats.promptVersion,
          promptStats.prompt,
          chunk.length,
          { reqId, userId: "fixture_user", chunkIdx: tokenObservability.length - 1 }
        );
        if (!result || result.length !== chunk.length) {
          return json({
            ok: false,
            error: "fixture_ai_result_shape_invalid",
            prompt_version: promptStats.promptVersion,
            expected: chunk.length,
            received: result?.length ?? 0
          }, 500);
        }
        aiResultsByIndex.push(...result);
      }

      const evalRows = fixtureQueueRows.map((row, idx) => {
        const ai = aiResultsByIndex[idx] ?? { category: null, confidence: 0 };
        const expectedCategory = String(fixtureRowsRaw[idx]?.expected_category ?? "").trim() || null;
        const strict = fixtureRowsRaw[idx]?.strict_scoring !== false;
        const isMoneyIn = providerIsMoneyIn(row);
        const rawCategory = normalizeAiCategory(ai.category, allowedCategories);
        const alternateCategory = normalizeAiCategory(ai.alternateCategory, allowedCategories);
        const aiResolvedCategory = enforceTypeCheck(
          rawCategory,
          isMoneyIn,
          categoryIsIncomeMap,
          incomeCategories,
          expenseCategories
        );
        const alternateResolvedCategory = enforceTypeCheck(
          alternateCategory,
          isMoneyIn,
          categoryIsIncomeMap,
          incomeCategories,
          expenseCategories
        );
        let effectiveAiCategory =
          normCategoryText(aiResolvedCategory) === normCategoryText(UNCATEGORIZED_KEY) &&
          normCategoryText(alternateResolvedCategory) !== normCategoryText(UNCATEGORIZED_KEY)
            ? alternateResolvedCategory
            : aiResolvedCategory;
        if (
          normCategoryText(effectiveAiCategory) === normCategoryText(UNCATEGORIZED_KEY) &&
          isMoneyIn &&
          /refund/i.test(String(ai?.reasoning ?? ""))
        ) {
          const refundResolvedCategory = pickFirstAllowed(incomeCategories, ["Refund"]);
          if (refundResolvedCategory) {
            effectiveAiCategory = refundResolvedCategory;
          }
        }
        const semanticResolverDecision = maybeResolveSemanticCategory(
          ai,
          normalizeMerchant(row.merchant_normalized || row.merchant_raw || ""),
          row.merchant_raw,
          isMoneyIn ? incomeCategories : expenseCategories,
          effectiveAiCategory,
          UNCATEGORIZED_KEY,
          ai?.promptVersion === PHASE4_PROMPT_VERSION && hasFatalPhase4ValidationError(ai?.validationError)
        );
        let resolvedCategory = enforceTypeCheck(
          semanticResolverDecision?.categoryKey ?? effectiveAiCategory,
          isMoneyIn,
          categoryIsIncomeMap,
          incomeCategories,
          expenseCategories
        );
        const moneyMovementGuardDecision = maybeApplyMoneyMovementGuard({
          row,
          txnMeta: null,
          transferCandidatesByUser: new Map(),
          categoryKey: resolvedCategory,
          confidence: semanticResolverDecision?.confidence ?? clamp01(ai.confidence),
          isMoneyIn,
          incomeCategories,
          expenseCategories,
          allowUserOverride: false
        });
        if (moneyMovementGuardDecision) {
          resolvedCategory = enforceTypeCheck(
            moneyMovementGuardDecision.categoryKey,
            isMoneyIn,
            categoryIsIncomeMap,
            incomeCategories,
            expenseCategories
          );
        }
        const matchesExpected = expectedCategory
          ? normCategoryText(expectedCategory) === normCategoryText(resolvedCategory)
          : null;

        return {
          id: row.id,
          provider: row.provider,
          merchant_raw: row.merchant_raw,
          amount_cents: row.amount_cents,
          script_bucket: fixtureRowsRaw[idx]?.script_bucket ?? null,
          locale_hint: fixtureRowsRaw[idx]?.locale_hint ?? null,
          strict_scoring: strict,
          expected_category: expectedCategory,
          ai_category_raw: ai.category,
          ai_confidence: clamp01(ai.confidence),
          ai_broad_concept: ai.broadConcept ?? null,
          ai_language_detected: ai.languageDetected ?? null,
          ai_merchant_clean: ai.merchantClean ?? null,
          ai_reasoning: ai.reasoning ?? null,
          ai_needs_review: ai.needsReview ?? false,
          ai_alternate_category: ai.alternateCategory ?? null,
          ai_validation_error: ai.validationError ?? null,
          prompt_version: ai.promptVersion ?? fixturePromptVersion,
          semantic_resolver_applied: Boolean(semanticResolverDecision),
          semantic_resolver_category: semanticResolverDecision?.categoryKey ?? null,
          semantic_resolver_confidence: semanticResolverDecision?.confidence ?? null,
          semantic_resolver_reason: semanticResolverDecision?.reason ?? null,
          money_movement_guard_applied: Boolean(moneyMovementGuardDecision),
          money_movement_guard_reason: moneyMovementGuardDecision?.reason ?? null,
          category_resolved: resolvedCategory,
          is_money_in: isMoneyIn,
          matched_expected: matchesExpected
        };
      });

      const strictRows = evalRows.filter((row) => row.strict_scoring);
      const strictCorrect = strictRows.filter((row) => row.matched_expected === true).length;
      const strictTotal = strictRows.length;
      const strictAccuracyPct = strictTotal > 0
        ? Number(((strictCorrect * 100) / strictTotal).toFixed(2))
        : null;

      const byScript: Record<string, { total: number; strict_total: number; strict_correct: number }> = {};
      const byLocale: Record<string, { total: number; strict_total: number; strict_correct: number }> = {};
      for (const row of evalRows) {
        const key = String(row.script_bucket ?? "unknown");
        if (!byScript[key]) byScript[key] = { total: 0, strict_total: 0, strict_correct: 0 };
        byScript[key].total += 1;
        if (row.strict_scoring) byScript[key].strict_total += 1;
        if (row.strict_scoring && row.matched_expected === true) byScript[key].strict_correct += 1;
        const localeKey = String(row.locale_hint ?? "unknown");
        if (!byLocale[localeKey]) byLocale[localeKey] = { total: 0, strict_total: 0, strict_correct: 0 };
        byLocale[localeKey].total += 1;
        if (row.strict_scoring) byLocale[localeKey].strict_total += 1;
        if (row.strict_scoring && row.matched_expected === true) byLocale[localeKey].strict_correct += 1;
      }

      return json({
        ok: true,
        fixture_mode: true,
        model: GEMINI_MODEL,
        prompt_version: fixturePromptVersion,
        phase5_semantic_resolver_enabled: USE_PHASE5_SEMANTIC_RESOLVER,
        totals: {
          rows: evalRows.length,
          strict_rows: strictTotal,
          strict_correct: strictCorrect,
          strict_accuracy_pct: strictAccuracyPct
        },
        token_observability: tokenObservability,
        by_script: byScript,
        by_locale: byLocale,
        rows: evalRows
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    // Auto-heal rows that are genuinely stale before claiming new ones.
    // Rows claimed recently must remain untouched to avoid duplicate in-flight work.
    const staleCutoffIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await sb
      .from("ai_categorization_queue")
      .update({ status: "pending", claimed_at: null })
      .eq("status", "processing")
      .is("claimed_at", null);
    await sb
      .from("ai_categorization_queue")
      .update({ status: "pending", claimed_at: null })
      .eq("status", "processing")
      .lt("claimed_at", staleCutoffIso);
    const limit = Math.max(1, Math.min(Number(body?.limit ?? DEFAULT_BATCH_LIMIT), 200));
    if (requestingUserId) {
      const deterministicRetryResolved = await resolveDeterministicRetryableFailures(sb, requestingUserId);
      if (deterministicRetryResolved > 0) {
        stats.deterministicApplied += deterministicRetryResolved;
        console.info(`[${reqId}] deterministic_retry_rescue resolved=${deterministicRetryResolved} user=${requestingUserId}`);
      }
    }
    // Auto-retry failed rows for the requesting user. Failures are transient (Gemini
    // rate limits, timeouts) — reset them to pending so they are picked up this run.
    if (requestingUserId) {
      await sb
        .from("ai_categorization_queue")
        .update({ status: "pending", claimed_at: null, processed_at: null })
        .eq("user_id", requestingUserId)
        .eq("status", "failed");
    }
    const requestedTxnIds = stringList(body?.txn_ids);
    const requestedProvider = String(body?.provider ?? "").trim().toLowerCase();
    const hasScopedTxnRequest = requestingUserId !== null && requestedTxnIds.length > 0;
    const hopCount = typeof body?.hop_count === "number" ? body.hop_count : 0;
    const MAX_HOPS = 10;
    if (hopCount > MAX_HOPS) {
      return json({ ok: true, message: "max_hops_reached", hop_count: hopCount });
    }

    let rows: QueueRow[] = [];
    if (hasScopedTxnRequest) {
      // Scoped import retries must not reset successful rows back to pending.
      // The connected-bank flow only works pending/failed work; keep the same
      // behavior here so retrying one flaky row does not erase the rest.
      let resetQuery = sb
        .from("ai_categorization_queue")
        .update({ status: "pending", claimed_at: null, processed_at: null })
        .eq("user_id", requestingUserId)
        .in("txn_id", requestedTxnIds)
        .in("status", ["pending", "failed"]);
      if (requestedProvider) {
        resetQuery = resetQuery.eq("provider", requestedProvider);
      }
      const { error: resetErr } = await resetQuery;
      if (resetErr) {
        return json({ ok: false, error: "scoped_reset_failed", details: resetErr.message }, 500);
      }

      // Statement import can re-run the same file often. If a prior run marked rows as
      // done but left them unresolved, reopen only those unresolved rows for another pass.
      if (requestedProvider === "statement_import") {
        let doneReviewQuery = sb
          .from("ai_categorization_queue")
          .select("id")
          .eq("user_id", requestingUserId)
          .eq("status", "done")
          .in("txn_id", requestedTxnIds)
          .or("ai_needs_review.eq.true,result_category_key.eq.Uncategorized,result_category_key.is.null");
        doneReviewQuery = doneReviewQuery.eq("provider", requestedProvider);
        const { data: doneReviewRows, error: doneReviewErr } = await doneReviewQuery;
        if (doneReviewErr) {
          return json({ ok: false, error: "scoped_reopen_done_lookup_failed", details: doneReviewErr.message }, 500);
        }
        const doneReviewIds = new Set(
          ((doneReviewRows || []) as { id?: string | null }[])
            .map((row) => String(row.id ?? "").trim())
            .filter((id) => id.length > 0)
        );

        // Re-open prior Transfer rows that came from generic fallback so a stricter
        // statement-import transfer gate can re-evaluate them on repeated imports.
        const { data: doneFallbackTransferRows, error: doneFallbackTransferErr } = await sb
          .from("ai_categorization_queue")
          .select("id")
          .eq("user_id", requestingUserId)
          .eq("provider", requestedProvider)
          .eq("status", "done")
          .eq("result_source", "statement_import_generic_fallback")
          .eq("result_category_key", "Transfer")
          .in("txn_id", requestedTxnIds);
        if (doneFallbackTransferErr) {
          return json({
            ok: false,
            error: "scoped_reopen_done_transfer_lookup_failed",
            details: doneFallbackTransferErr.message
          }, 500);
        }
        for (const row of (doneFallbackTransferRows || []) as { id?: string | null }[]) {
          const id = String(row.id ?? "").trim();
          if (id) doneReviewIds.add(id);
        }
        console.log(JSON.stringify({
          req_id: reqId,
          event: "scoped_reopen_done_statement_import",
          user_id: requestingUserId,
          requested_txn_ids: requestedTxnIds.length,
          unresolved_rows: (doneReviewRows || []).length,
          transfer_fallback_rows: (doneFallbackTransferRows || []).length,
          total_reopened: doneReviewIds.size
        }));
        if (doneReviewIds.size > 0) {
          const { error: reopenErr } = await sb
            .from("ai_categorization_queue")
            .update({ status: "pending", claimed_at: null, processed_at: null })
            .in("id", Array.from(doneReviewIds));
          if (reopenErr) {
            return json({ ok: false, error: "scoped_reopen_done_failed", details: reopenErr.message }, 500);
          }
        }
      }

      let scopedQuery = sb
        .from("ai_categorization_queue")
        .select("*")
        .eq("user_id", requestingUserId)
        .in("txn_id", requestedTxnIds)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(limit);
      if (requestedProvider) {
        scopedQuery = scopedQuery.eq("provider", requestedProvider);
      }
      const { data: scopedPendingRows, error: scopedErr } = await scopedQuery;
      if (scopedErr) {
        return json({ ok: false, error: "scoped_claim_lookup_failed", details: scopedErr.message }, 500);
      }

      const scopedIds = ((scopedPendingRows || []) as QueueRow[]).map((row) => row.id).filter(Boolean);
      if (scopedIds.length > 0) {
        const { data: claimedScopedRows, error: scopedClaimErr } = await sb
          .from("ai_categorization_queue")
          .update({ status: "processing", claimed_at: new Date().toISOString() })
          .in("id", scopedIds)
          .select("*");
        if (scopedClaimErr) {
          return json({ ok: false, error: "scoped_claim_failed", details: scopedClaimErr.message }, 500);
        }
        rows = (claimedScopedRows || []) as QueueRow[];
      }
    } else {
      const { data: claimedRows, error: claimErr } = await sb.rpc("claim_ai_categorization_queue", {
        p_limit: limit,
        p_user_id: requestingUserId
      });

      if (claimErr) {
        return json({ ok: false, error: "claim_failed", details: claimErr.message }, 500);
      }

      rows = (claimedRows || []) as QueueRow[];
    }
    if (rows.length === 0) {
      return json({
        ok: true,
        ...stats,
        phase3_deterministic_enabled: USE_PHASE3_DETERMINISTIC,
        phase3_deterministic_percent: PHASE3_DETERMINISTIC_PERCENT,
        phase4_prompt_enabled: USE_PHASE4_PROMPT,
        phase4_prompt_percent: PHASE4_PROMPT_PERCENT,
        phase4_prompt_forced: forcePhase4Prompt,
        message: "no_pending_rows"
      });
    }
    stats.processed = rows.length;

    const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
    const txnIds = Array.from(new Set(rows.map((r) => r.txn_id)));
    const aiByRowId = new Map<string, AiResult>();
    const aiFailureFallbackStageByRowId = new Map<string, string>();
    const failedRowIds = new Set<string>();

    const { data: userCategoryRows, error: userCategoriesErr } = await sb
      .from("categories")
      .select("id,user_id,name,is_income,is_system")
      .or(`user_id.in.(${userIds.join(",")}),is_system.eq.true`);
    if (userCategoriesErr) {
      return json({ ok: false, error: "user_categories_query_failed", details: userCategoriesErr.message }, 500);
    }

    const { data: ontologyRowsRaw, error: ontologyErr } = await sb
      .from("category_ontology")
      .select("category_key,side,section,parent_concept,definition,multilingual_hints,examples,is_active")
      .eq("is_active", true);
    if (ontologyErr) {
      return json({ ok: false, error: "ontology_query_failed", details: ontologyErr.message }, 500);
    }
    const ontologyRows = (ontologyRowsRaw || []) as OntologyDbRow[];
    logOntologyDrift(reqId, ontologyRows);
    const { data: deterministicPatternRowsRaw, error: deterministicPatternErr } = await sb
      .from("deterministic_category_patterns")
      .select("category_key,side,pattern_regex,priority,reason,is_active")
      .eq("is_active", true)
      .order("priority", { ascending: true });
    if (deterministicPatternErr) {
      return json({ ok: false, error: "deterministic_patterns_query_failed", details: deterministicPatternErr.message }, 500);
    }
    const deterministicPatterns = parseDeterministicPatterns(
      (deterministicPatternRowsRaw || []) as DeterministicPatternRow[]
    );

    const systemCategoryNames: string[] = [];
    const systemCategories: UserCategoryRow[] = [];
    const allowedCategoriesByUser = new Map<string, string[]>();
    const groupedUserCategories = new Map<string, UserCategoryRow[]>();
    for (const row of (userCategoryRows || []) as UserCategoryRow[]) {
      const name = String(row.name ?? "").trim();
      if (!name) continue;
      if (row.is_system) {
        systemCategoryNames.push(name);
        systemCategories.push(row);
        continue;
      }
      const uid = String(row.user_id ?? "").trim();
      if (!uid) continue;
      const existing = groupedUserCategories.get(uid) || [];
      existing.push(row);
      groupedUserCategories.set(uid, existing);
    }
    for (const userId of userIds) {
      const userCategoryNames = (groupedUserCategories.get(userId) || [])
        .map((row) => String(row.name ?? "").trim())
        .filter((name) => name.length > 0);
      const combined = dedupeCategoryNames([...userCategoryNames, ...systemCategoryNames]);
      allowedCategoriesByUser.set(userId, combined);
    }

    // Build income/expense split + type lookup map (used by enforceTypeCheck).
    // categoryIsIncomeMap: normCategoryText(name) -> resolved income side from stored category type.
    const categoryIsIncomeMap = new Map<string, boolean>();
    const incomeCategoriesByUser = new Map<string, string[]>();
    const expenseCategoriesByUser = new Map<string, string[]>();

    for (const row of (userCategoryRows || []) as UserCategoryRow[]) {
      const name = String(row.name ?? "").trim();
      if (!name) continue;
      categoryIsIncomeMap.set(normCategoryText(name), row.is_income === true);
    }
    for (const userId of userIds) {
      const allCatRows = [
        ...(groupedUserCategories.get(userId) || []),
        ...systemCategories
      ];
      incomeCategoriesByUser.set(userId, dedupeCategoryNames(
        allCatRows
          .filter(r => r.is_income === true)
          .map(r => String(r.name ?? "").trim())
          .filter(Boolean)
      ));
      expenseCategoriesByUser.set(userId, dedupeCategoryNames(
        allCatRows
          .filter(r => r.is_income !== true)
          .map(r => String(r.name ?? "").trim())
          .filter(Boolean)
      ));
    }

    // Map normalized category name -> category UUID for each user.
    // Prefer user categories first, then system categories as fallback.
    const categoryIdByUser = new Map<string, Map<string, string>>();
    for (const userId of userIds) {
      const byName = new Map<string, string>();
      for (const row of groupedUserCategories.get(userId) || []) {
        const id = String(row.id ?? "").trim();
        const name = String(row.name ?? "").trim();
        if (!id || !name) continue;
        byName.set(normCategoryText(name), id);
      }
      for (const row of systemCategories) {
        const id = String(row.id ?? "").trim();
        const name = String(row.name ?? "").trim();
        if (!id || !name) continue;
        const key = normCategoryText(name);
        if (!byName.has(key)) byName.set(key, id);
      }
      categoryIdByUser.set(userId, byName);
    }

    // Build merchant key set from all rows upfront — needed for both
    // user_merchant_rules lookup (per-user loop) and global rules (per-row loop).
    const merchantKeys = Array.from(
      new Set(
        rows
          .map((r) => normalizeMerchant(r.merchant_normalized || r.merchant_raw || ""))
          .filter((v) => v.length > 0 && !isStatementNoiseMerchant(v))
      )
    );

    // Fetch user_merchant_rules before the per-user loop. These are set when a user
    // manually recategorizes a transaction and taps "Apply to all". They carry confidence
    // 1.0 and take priority over global rules and Gemini for all future transactions.
    const userMerchantRuleMap = new Map<string, string>(); // "userId::merchantNorm" → category_key
    if (merchantKeys.length > 0 && userIds.length > 0) {
      const { data: userRuleRows } = await sb
        .from("user_merchant_rules")
        .select("user_id,merchant_normalized,category_key")
        .in("user_id", userIds)
        .in("merchant_normalized", merchantKeys);
      for (const row of userRuleRows || []) {
        const uid = String(row.user_id ?? "").trim();
        const norm = String(row.merchant_normalized ?? "").trim();
        const cat = String(row.category_key ?? "").trim();
        if (uid && norm && cat) {
          userMerchantRuleMap.set(`${uid}::${norm}`, cat);
        }
      }
    }

    const deterministicKillSwitchSet = new Set<string>();
    if (merchantKeys.length > 0 && userIds.length > 0) {
      const { data: overrideRows, error: overrideErr } = await sb
        .from("txn_categorization")
        .select("user_id,merchant_normalized,category_user")
        .in("user_id", userIds)
        .in("merchant_normalized", merchantKeys)
        .not("category_user", "is", null);
      if (overrideErr) {
        return json({ ok: false, error: "deterministic_kill_switch_query_failed", details: overrideErr.message }, 500);
      }
      for (const row of overrideRows || []) {
        const uid = String((row as any).user_id ?? "").trim();
        const norm = String((row as any).merchant_normalized ?? "").trim();
        if (uid && norm) deterministicKillSwitchSet.add(`${uid}::${norm}`);
      }
    }

    const rowsByUser = new Map<string, QueueRow[]>();
    for (const row of rows) {
      const existing = rowsByUser.get(row.user_id) || [];
      existing.push(row);
      rowsByUser.set(row.user_id, existing);
    }

    for (const [userId, userRows] of rowsByUser.entries()) {
      const allowedCategories = allowedCategoriesByUser.get(userId) || [];
      const promptVersionForUser = forcePhase4Prompt || isPhase4EnabledForUser(userId)
        ? PHASE4_PROMPT_VERSION
        : LEGACY_PROMPT_VERSION;
      if (allowedCategories.length === 0) {
        console.warn(`[${reqId}] no_user_categories user=${userId}; skipping ${userRows.length} rows`);
        for (const row of userRows) {
          stats.skipped += 1;
          await markQueueRow(sb, row.id, {
            status: "done",
            result_category_key: null,
            result_confidence: null,
            is_suggested: false,
            result_source: "skipped_no_categories",
            deterministic_would_match: false,
            deterministic_would_match_category_key: null,
            deterministic_did_apply: false,
            failure_stage: null,
            prompt_version: promptVersionForUser
          });
        }
        continue;
      }
      const expenseCats = expenseCategoriesByUser.get(userId) || [];
      const incomeCats = incomeCategoriesByUser.get(userId) || [];
      const ontologyEntries = buildPromptOntologyEntries(expenseCats, incomeCats, ontologyRows);

      const dedupGroups = new Map<string, QueueRow[]>();
      const uniqueRows: QueueRow[] = [];
      for (const row of userRows) {
        const key = merchantDedupKey(row);
        const existing = dedupGroups.get(key);
        if (existing) {
          existing.push(row);
        } else {
          dedupGroups.set(key, [row]);
          uniqueRows.push(row);
        }
      }

      // Skip Gemini for merchants already covered by a user rule — no point calling AI
      // when the user has already told us exactly how to categorize this merchant.
      const rowsForGemini = uniqueRows.filter((row) => {
        const norm = normalizeMerchant(row.merchant_normalized || row.merchant_raw || "");
        if (isStatementNoiseMerchant(norm)) return false;
        return !norm || !userMerchantRuleMap.has(`${userId}::${norm}`);
      });

      const AI_CHUNK_SIZE = 20;
      const chunks: QueueRow[][] = [];
      for (let c = 0; c < rowsForGemini.length; c += AI_CHUNK_SIZE) {
        chunks.push(rowsForGemini.slice(c, c + AI_CHUNK_SIZE));
      }

      const chunkResults = await Promise.all(
        chunks.map(async (chunk, chunkIdx) => {
          try {
            const promptStats = buildPromptForVersion(
              promptVersionForUser,
              chunk,
              expenseCats,
              incomeCats,
              ontologyEntries
            );
            console.log(JSON.stringify({
              req_id: reqId,
              event: "ontology_token_budget",
              user_id: userId,
              chunk_index: chunkIdx,
              prompt_version: promptStats.promptVersion,
              ontology_seed_version: ONTOLOGY_SEED_VERSION,
              ontology_entries: promptStats.ontologyEntryCount,
              ontology_tokens: promptStats.ontologyTokenEstimate,
              prompt_tokens_estimate: promptStats.promptTokenEstimate,
              target_tokens: ONTOLOGY_TOKEN_TARGET,
              hard_limit: ONTOLOGY_TOKEN_HARD_LIMIT,
              within_target: promptStats.ontologyTokenEstimate <= ONTOLOGY_TOKEN_TARGET
            }));
            const aiResults = await callGeminiForVersionWithShapeRetry(
              promptStats.promptVersion,
              promptStats.prompt,
              chunk.length,
              { reqId, userId, chunkIdx }
            );
            return { chunk, chunkIdx, aiResults, error: null as string | null };
          } catch (error) {
            return {
              chunk,
              chunkIdx,
              aiResults: null as AiResult[] | null,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })
      );

      const aiByMerchantKey = new Map<string, AiResult>();

      for (const outcome of chunkResults) {
        if (outcome.error || !outcome.aiResults) {
          const failureStage = outcome.error ? "ai_chunk_error" : "ai_result_shape_invalid";
          const canDeterministicFallback = !outcome.error || !isRetryableAiChunkError(outcome.error);
          console.error(
            `[${reqId}] ai_result_shape_invalid user=${userId} chunk=${outcome.chunkIdx} received=${outcome.aiResults?.length ?? 0} expected=${outcome.chunk.length} error=${outcome.error ?? "none"}`
          );
          for (const representative of outcome.chunk) {
            const rowsForKey = dedupGroups.get(merchantDedupKey(representative)) || [representative];
            for (const row of rowsForKey) {
              const observation = buildDeterministicObservation(
                row,
                deterministicPatterns,
                deterministicKillSwitchSet,
                userMerchantRuleMap,
                incomeCats,
                expenseCats
              );
              if (canDeterministicFallback) {
                aiByRowId.set(row.id, { category: UNCATEGORIZED_KEY, confidence: 0 });
                aiFailureFallbackStageByRowId.set(row.id, failureStage);
                continue;
              }
              if (failedRowIds.has(row.id)) continue;
              failedRowIds.add(row.id);
              stats.errors += 1;
              await markQueueRow(sb, row.id, {
                status: "failed",
                deterministic_would_match: observation.wouldMatch,
                deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
                deterministic_did_apply: false,
                failure_stage: failureStage,
                prompt_version: promptVersionForUser
              });
            }
          }
          continue;
        }

        if (outcome.aiResults.length !== outcome.chunk.length) {
          console.warn(
            `[${reqId}] ai_result_length_mismatch user=${userId} chunk=${outcome.chunkIdx} received=${outcome.aiResults.length} expected=${outcome.chunk.length}`
          );
        }
        const validCount = Math.min(outcome.aiResults.length, outcome.chunk.length);
        for (let idx = 0; idx < validCount; idx += 1) {
          const representative = outcome.chunk[idx];
          aiByMerchantKey.set(merchantDedupKey(representative), outcome.aiResults[idx]);
        }
        if (outcome.aiResults.length < outcome.chunk.length) {
          for (let idx = outcome.aiResults.length; idx < outcome.chunk.length; idx += 1) {
            const representative = outcome.chunk[idx];
            const rowsForKey = dedupGroups.get(merchantDedupKey(representative)) || [representative];
            for (const row of rowsForKey) {
              aiByRowId.set(row.id, { category: UNCATEGORIZED_KEY, confidence: 0 });
              aiFailureFallbackStageByRowId.set(row.id, "ai_result_shape_invalid");
            }
          }
        }
      }

      for (const [dedupKey, rowsForKey] of dedupGroups.entries()) {
        const aiResult = aiByMerchantKey.get(dedupKey);
        if (!aiResult) {
          // Check if this merchant is covered by a user rule — those intentionally
          // skip Gemini, so no AI result is expected. They'll be resolved below.
          const representative = rowsForKey[0];
          const norm = representative
            ? normalizeMerchant(representative.merchant_normalized || representative.merchant_raw || "")
            : "";
          const hasUserRule = norm ? userMerchantRuleMap.has(`${userId}::${norm}`) : false;
          const isNoise = isStatementNoiseMerchant(norm);
          if (hasUserRule || isNoise) {
            for (const row of rowsForKey) {
              aiByRowId.set(row.id, { category: null, confidence: 0 });
            }
            continue;
          }
          for (const row of rowsForKey) {
            aiByRowId.set(row.id, { category: UNCATEGORIZED_KEY, confidence: 0 });
            aiFailureFallbackStageByRowId.set(row.id, "missing_ai_result");
          }
          continue;
        }
        for (const row of rowsForKey) {
          aiByRowId.set(row.id, aiResult);
        }
      }
    }

    const { data: existingCats, error: existingCatsErr } = await sb
      .from("txn_categorization")
      .select("user_id,txn_id,category_user")
      .in("user_id", userIds)
      .in("txn_id", txnIds);

    if (existingCatsErr) {
      return json({ ok: false, error: "existing_cats_query_failed", details: existingCatsErr.message }, 500);
    }

    const existingMap = new Map<string, { category_user: string | null }>();
    for (const row of existingCats || []) {
      existingMap.set(`${row.user_id}::${row.txn_id}`, { category_user: row.category_user ?? null });
    }

    const txnMetaMap = new Map<string, TxnMeta>();
    if (txnIds.length > 0) {
      const { data: txnMetaRows } = await sb
        .from("transactions")
        .select("user_id,txn_id,account_id,provider,name,merchant,merchant_name,txn_date,amount")
        .in("user_id", userIds)
        .in("txn_id", txnIds);

      for (const row of (txnMetaRows || []) as TxnMetaRow[]) {
        const name = String(row.name ?? "").trim();
        const txnDate = String(row.txn_date ?? "").trim();
        if (!name || !txnDate) continue;
        const amountNum = Number(row.amount ?? 0);
        const amountCents = Number.isFinite(amountNum) ? Math.round(amountNum * 100) : null;
        txnMetaMap.set(`${row.user_id}::${row.txn_id}`, {
          user_id: String(row.user_id),
          txn_id: String(row.txn_id),
          account_id: String(row.account_id ?? "").trim() || null,
          provider: String(row.provider ?? "").trim().toLowerCase() || null,
          name,
          merchant: String(row.merchant ?? "").trim() || null,
          merchant_name: String(row.merchant_name ?? "").trim() || null,
          txn_date: txnDate,
          amount_cents: amountCents
        });
      }
    }

    const transferCandidatesByUser = new Map<string, TransferCandidate[]>();
    const datesByUser = new Map<string, string[]>();
    for (const meta of txnMetaMap.values()) {
      const existing = datesByUser.get(meta.user_id) || [];
      existing.push(meta.txn_date);
      datesByUser.set(meta.user_id, existing);
    }
    for (const userId of userIds) {
      const dates = (datesByUser.get(userId) || []).filter(Boolean).sort();
      if (dates.length === 0) continue;
      const startDate = addDaysToIsoDate(dates[0], -1);
      const endDate = addDaysToIsoDate(dates[dates.length - 1], 1);
      if (!startDate || !endDate) continue;

      const { data: candidateRows, error: candidateErr } = await sb
        .from("transactions")
        .select("user_id,txn_id,account_id,provider,name,merchant,merchant_name,txn_date,amount")
        .eq("user_id", userId)
        .gte("txn_date", startDate)
        .lte("txn_date", endDate)
        .or("is_removed.is.null,is_removed.eq.false")
        .limit(5000);

      if (candidateErr) {
        console.warn(`[${reqId}] transfer candidate lookup failed user=${userId}: ${candidateErr.message}`);
        continue;
      }

      const candidates: TransferCandidate[] = [];
      for (const row of (candidateRows || []) as TxnMetaRow[]) {
        const name = String(row.name ?? "").trim();
        const txnDate = String(row.txn_date ?? "").trim();
        const txnId = String(row.txn_id ?? "").trim();
        if (!txnId || !txnDate) continue;
        const amountNum = Number(row.amount ?? 0);
        const amountCents = Number.isFinite(amountNum) ? Math.round(amountNum * 100) : null;
        const meta: TxnMeta = {
          user_id: String(row.user_id),
          txn_id: txnId,
          account_id: String(row.account_id ?? "").trim() || null,
          provider: String(row.provider ?? "").trim().toLowerCase() || null,
          name,
          merchant: String(row.merchant ?? "").trim() || null,
          merchant_name: String(row.merchant_name ?? "").trim() || null,
          txn_date: txnDate,
          amount_cents: amountCents
        };
        const candidate = transferCandidateFromMeta(meta);
        if (candidate) candidates.push(candidate);
      }
      transferCandidatesByUser.set(userId, candidates);
    }

    const existingGlobalMap = new Map<string, { status: string | null; category_key: string | null; confidence: number }>();
    if (merchantKeys.length > 0) {
      const { data: globalRows } = await sb
        .from("global_merchant_rules")
        .select("merchant_normalized,status,category_key,confidence")
        .in("merchant_normalized", merchantKeys);
      for (const row of globalRows || []) {
        existingGlobalMap.set(String(row.merchant_normalized ?? ""), {
          status: row.status ?? null,
          category_key: row.category_key ?? null,
          confidence: Number(row.confidence ?? 0)
        });
      }
    }

    for (let i = 0; i < rows.length; i += 1) {
      const queueRow = rows[i];
      if (failedRowIds.has(queueRow.id)) continue;
      const ai = aiByRowId.get(queueRow.id);
      const key = `${queueRow.user_id}::${queueRow.txn_id}`;
      const existing = existingMap.get(key);

      const allowedCategories = allowedCategoriesByUser.get(queueRow.user_id) || [];
      const promptVersionForUser = forcePhase4Prompt || isPhase4EnabledForUser(queueRow.user_id)
        ? PHASE4_PROMPT_VERSION
        : LEGACY_PROMPT_VERSION;
      const incomeCats = incomeCategoriesByUser.get(queueRow.user_id) || [];
      const expenseCats = expenseCategoriesByUser.get(queueRow.user_id) || [];
      const observation = buildDeterministicObservation(
        queueRow,
        deterministicPatterns,
        deterministicKillSwitchSet,
        userMerchantRuleMap,
        incomeCats,
        expenseCats
      );
      const isMoneyIn = observation.isMoneyIn;
      const merchantNormForRule = observation.merchantNormalized;
      const isStatementNoise = isStatementNoiseMerchant(merchantNormForRule);

      if (existing?.category_user) {
        stats.userOverridesPreserved += 1;
        await markQueueRow(sb, queueRow.id, {
          status: "done",
          result_category_key: null,
          result_confidence: null,
          is_suggested: false,
          deterministic_would_match: observation.wouldMatch,
          deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
          deterministic_did_apply: false,
          failure_stage: null,
          prompt_version: promptVersionForUser
        });
        continue;
      }

      if (isStatementNoise) {
        const { data: guardedOk, error: guardedErr } = await sb.rpc(
          "upsert_txn_categorization_model_guarded",
          {
            p_user_id: queueRow.user_id,
            p_txn_id: queueRow.txn_id,
            p_category_model: UNCATEGORIZED_KEY,
            p_category_confidence: 1.0,
            p_is_suggested: false,
            p_merchant_normalized: STATEMENT_NOISE_SENTINEL
          }
        );
        if (guardedErr) {
          stats.errors += 1;
          await markQueueRow(sb, queueRow.id, {
            status: "failed",
            deterministic_would_match: observation.wouldMatch,
            deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
            deterministic_did_apply: false,
            failure_stage: "statement_noise_apply_guard_failed",
            prompt_version: promptVersionForUser
          });
          continue;
        }
        if (guardedOk) {
          stats.applied += 1;
        } else {
          stats.userOverridesPreserved += 1;
        }
        await markQueueRow(sb, queueRow.id, {
          status: "done",
          result_category_key: UNCATEGORIZED_KEY,
          result_confidence: 1.0,
          is_suggested: false,
          result_source: "statement_noise",
          deterministic_would_match: observation.wouldMatch,
          deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
          deterministic_did_apply: false,
          failure_stage: null,
          prompt_version: promptVersionForUser
        });
        continue;
      }

      // User merchant rules take absolute priority - the user explicitly told us
      // how to categorize this merchant. Apply with confidence 1.0, skip Gemini.
      const userRuleCategory = observation.userRuleCategory;

      // If an active global rule covers this merchant, prefer it over AI -
      // but only if the rule's category type matches the transaction direction.
      const activeRule = merchantNormForRule ? existingGlobalMap.get(merchantNormForRule) : undefined;
      let ruleOverride: string | null = userRuleCategory;
      if (!ruleOverride && activeRule?.status === "active" && activeRule.confidence >= THRESHOLD_AI && activeRule.category_key) {
        const ruleCatIsIncome = categoryIsIncomeMap.get(normCategoryText(activeRule.category_key));
        if (ruleCatIsIncome === undefined || ruleCatIsIncome === isMoneyIn) {
          ruleOverride = activeRule.category_key;
        }
      }

      const aiCategoryRaw = normalizeAiCategory(ai?.category, allowedCategories);
      const aiAlternateCategoryRaw = normalizeAiCategory(ai?.alternateCategory, allowedCategories);
      const aiFailureFallbackStage = aiFailureFallbackStageByRowId.get(queueRow.id) ?? null;
      const deterministicEnabledForUser = observation.deterministicEnabledForUser;
      if (observation.deterministicKillSwitch) {
        stats.deterministicSkippedByOverride += 1;
      }
      const deterministicMatch = observation.deterministicMatch;
      let aiValidationError = ai?.validationError ?? null;
      if (ai?.promptVersion === PHASE4_PROMPT_VERSION && ai?.rawCategory && !aiCategoryRaw) {
        aiValidationError = appendValidationError(aiValidationError, "category_not_in_ontology");
      }
      if (ai?.promptVersion === PHASE4_PROMPT_VERSION && ai?.alternateCategory && !aiAlternateCategoryRaw) {
        aiValidationError = appendValidationError(aiValidationError, "alternate_category_not_in_ontology");
      }
      const phase4ValidationFallback = ai?.promptVersion === PHASE4_PROMPT_VERSION && hasFatalPhase4ValidationError(aiValidationError);

      let rawCategoryKey = ruleOverride ?? aiCategoryRaw;
      let confidence = ruleOverride ? Number(activeRule?.confidence ?? 1) : clamp01(ai?.confidence ?? 0);
      let deterministicApplied = false;
      let semanticResolverApplied = false;
      let semanticResolverSuggested = false;
      let semanticResolverReason: string | null = null;
      let moneyMovementGuardApplied = false;
      let moneyMovementGuardReason: string | null = null;
      let aiAlternateSuggested = false;
      let aiNeedsReview = ai?.needsReview ?? false;
      let resultSource = userRuleCategory
        ? "user_rule"
        : (ruleOverride ? "global_rule" : "ai");
      const aiResolvedCategory = enforceTypeCheck(
        aiCategoryRaw,
        isMoneyIn,
        categoryIsIncomeMap,
        incomeCats,
        expenseCats
      );
      if (
        !ruleOverride &&
        normCategoryText(aiResolvedCategory) === normCategoryText(UNCATEGORIZED_KEY) &&
        aiAlternateCategoryRaw &&
        normCategoryText(aiAlternateCategoryRaw) !== normCategoryText(UNCATEGORIZED_KEY)
      ) {
        const alternateResolvedCategory = enforceTypeCheck(
          aiAlternateCategoryRaw,
          isMoneyIn,
          categoryIsIncomeMap,
          incomeCats,
          expenseCats
        );
        if (normCategoryText(alternateResolvedCategory) !== normCategoryText(UNCATEGORIZED_KEY)) {
          rawCategoryKey = alternateResolvedCategory;
          resultSource = "ai_alternate";
          aiAlternateSuggested = true;
          aiNeedsReview = true;
        } else if (isMoneyIn && /refund/i.test(String(ai?.reasoning ?? ""))) {
          const refundResolvedCategory = pickFirstAllowed(incomeCats, ["Refund"]);
          if (refundResolvedCategory) {
            rawCategoryKey = refundResolvedCategory;
            resultSource = "ai_alternate";
            aiAlternateSuggested = true;
            aiNeedsReview = true;
          }
        }
      }
      const aiEffectiveCategory = enforceTypeCheck(
        rawCategoryKey,
        isMoneyIn,
        categoryIsIncomeMap,
        incomeCats,
        expenseCats
      );
      const aiMissingOrTransientFailure =
        RETRYABLE_AI_FAILURE_STAGES.includes(aiFailureFallbackStage ?? "");
      const aiWouldFallback =
        normCategoryText(aiEffectiveCategory) === normCategoryText(UNCATEGORIZED_KEY) || phase4ValidationFallback;
      if (
        !ruleOverride &&
        deterministicMatch &&
        aiMissingOrTransientFailure
      ) {
        rawCategoryKey = deterministicMatch.categoryKey;
        confidence = deterministicMatch.confidence;
        deterministicApplied = true;
        resultSource = "deterministic";
        aiNeedsReview = false;
      }
      const semanticResolverDecision = !ruleOverride && !aiAlternateSuggested
        ? maybeResolveSemanticCategory(
            ai,
            merchantNormForRule,
            queueRow.merchant_raw,
            isMoneyIn ? incomeCats : expenseCats,
            aiEffectiveCategory,
            UNCATEGORIZED_KEY,
            phase4ValidationFallback
          )
        : null;
      if (semanticResolverDecision) {
        rawCategoryKey = semanticResolverDecision.categoryKey;
        confidence = semanticResolverDecision.confidence;
        semanticResolverApplied = true;
        semanticResolverSuggested = confidence < THRESHOLD_AI;
        semanticResolverReason = semanticResolverDecision.reason;
        resultSource = semanticResolverDecision.source;
        if (semanticResolverSuggested) {
          stats.semanticResolverSuggested += 1;
        } else {
          stats.semanticResolverApplied += 1;
        }
      } else if (!ruleOverride && aiWouldFallback) {
        stats.semanticResolverDeclined += 1;
      }
      if (deterministicMatch && !ruleOverride && aiWouldFallback) {
        stats.deterministicShadowMatches += 1;
        if (!semanticResolverApplied && deterministicEnabledForUser) {
          rawCategoryKey = deterministicMatch.categoryKey;
          confidence = deterministicMatch.confidence;
          deterministicApplied = true;
          resultSource = "deterministic";
        }
      }
      if (
        !ruleOverride &&
        !semanticResolverApplied &&
        !deterministicApplied &&
        deterministicMatch &&
        aiMissingOrTransientFailure
      ) {
        rawCategoryKey = deterministicMatch.categoryKey;
        confidence = deterministicMatch.confidence;
        deterministicApplied = true;
        resultSource = "deterministic";
        aiNeedsReview = false;
      }

      const preGuardCategory = enforceTypeCheck(rawCategoryKey, isMoneyIn, categoryIsIncomeMap, incomeCats, expenseCats);
      const moneyMovementGuardDecision = maybeApplyMoneyMovementGuard({
        row: queueRow,
        txnMeta: txnMetaMap.get(key) ?? null,
        transferCandidatesByUser,
        categoryKey: preGuardCategory,
        confidence,
        isMoneyIn,
        incomeCategories: incomeCats,
        expenseCategories: expenseCats,
        allowUserOverride: Boolean(userRuleCategory)
      });
      if (moneyMovementGuardDecision) {
        rawCategoryKey = moneyMovementGuardDecision.categoryKey;
        confidence = moneyMovementGuardDecision.confidence;
        aiNeedsReview = moneyMovementGuardDecision.needsReview;
        aiAlternateSuggested = moneyMovementGuardDecision.isSuggested;
        resultSource = moneyMovementGuardDecision.resultSource;
        moneyMovementGuardApplied = true;
        moneyMovementGuardReason = moneyMovementGuardDecision.reason;
        stats.moneyMovementGuardApplied += 1;
        if (moneyMovementGuardDecision.transferMatched) {
          stats.moneyMovementTransferMatched += 1;
        }
        if (moneyMovementGuardDecision.transferBlocked) {
          stats.moneyMovementTransferBlocked += 1;
        }
      }

      let categoryKey = enforceTypeCheck(rawCategoryKey, isMoneyIn, categoryIsIncomeMap, incomeCats, expenseCats);
      if (deterministicApplied && deterministicMatch && normCategoryText(categoryKey) === normCategoryText(deterministicMatch.categoryKey)) {
        stats.deterministicApplied += 1;
      }

      // If a rule already resolved this row (user/global), do not keep AI transient
      // failure stages (e.g. missing_ai_result). The row is resolved and should be done.
      let finalFailureStage = (semanticResolverApplied || deterministicApplied || moneyMovementGuardApplied || Boolean(ruleOverride))
        ? null
        : (
            aiFailureFallbackStage ??
            (phase4ValidationFallback ? "phase4_validation_error" : null)
          );
      const shouldReviewMissingAiResult =
        finalFailureStage !== null &&
        ["missing_ai_result", "ai_result_shape_invalid"].includes(finalFailureStage) &&
        normCategoryText(categoryKey) === normCategoryText(UNCATEGORIZED_KEY);
      if (shouldReviewMissingAiResult) {
        const statementImportFallback = maybeApplyStatementImportGenericFallback({
          row: queueRow,
          txnMeta: txnMetaMap.get(key) ?? null,
          transferCandidatesByUser,
          isMoneyIn,
          incomeCategories: incomeCats,
          expenseCategories: expenseCats
        });
        if (statementImportFallback) {
          const fallbackCategory = enforceTypeCheck(
            statementImportFallback.categoryKey,
            isMoneyIn,
            categoryIsIncomeMap,
            incomeCats,
            expenseCats
          );
          if (!isUncategorizedCategory(fallbackCategory)) {
            categoryKey = fallbackCategory;
            confidence = Math.max(confidence, statementImportFallback.confidence);
            aiNeedsReview = statementImportFallback.needsReview;
            resultSource = statementImportFallback.resultSource;
            finalFailureStage = null;
          } else {
            aiNeedsReview = true;
            resultSource = "ai_missing_result_review";
            finalFailureStage = null;
          }
        } else {
          aiNeedsReview = true;
          resultSource = "ai_missing_result_review";
          finalFailureStage = null;
        }
      }

      if (finalFailureStage && !deterministicApplied && !moneyMovementGuardApplied) {
        stats.errors += 1;
        await markQueueRow(sb, queueRow.id, {
          status: "failed",
          deterministic_would_match: observation.wouldMatch,
          deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
          deterministic_did_apply: false,
          failure_stage: finalFailureStage,
          prompt_version: promptVersionForUser,
          ai_broad_concept: ai?.broadConcept ?? null,
          ai_language_detected: ai?.languageDetected ?? null,
          ai_merchant_clean: ai?.merchantClean ?? null,
          ai_reasoning: ai?.reasoning ?? null,
          ai_needs_review: aiNeedsReview,
          ai_alternate_category: aiAlternateCategoryRaw ?? ai?.alternateCategory ?? null,
          ai_validation_error: aiValidationError,
          ai_raw_category: ai?.rawCategory ?? null
        });
        continue;
      }

      // "Uncategorized" is a definitive fallback - always write it, skip confidence gate.
      const isFallback = normCategoryText(categoryKey) === normCategoryText(UNCATEGORIZED_KEY);
      const isApply = !aiAlternateSuggested && (isFallback || confidence >= THRESHOLD_AI);
      const isSuggest = aiAlternateSuggested || (!isApply && confidence >= THRESHOLD_AI_SUGGEST);

      if (!isApply && !isSuggest) {
        stats.skipped += 1;
        await markQueueRow(sb, queueRow.id, {
          status: "done",
          result_category_key: categoryKey,
          result_confidence: confidence,
          is_suggested: false,
          result_source: resultSource,
          deterministic_would_match: observation.wouldMatch,
          deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
          deterministic_did_apply: deterministicApplied,
          failure_stage: finalFailureStage,
          prompt_version: promptVersionForUser,
          ai_broad_concept: ai?.broadConcept ?? null,
          ai_language_detected: ai?.languageDetected ?? null,
          ai_merchant_clean: ai?.merchantClean ?? null,
          ai_reasoning: composeAiReasoning(
            ai?.reasoning,
            semanticResolverApplied ? semanticResolverReason : null,
            moneyMovementGuardApplied ? moneyMovementGuardReason : null
          ),
          ai_needs_review: aiNeedsReview,
          ai_alternate_category: aiAlternateCategoryRaw ?? ai?.alternateCategory ?? null,
          ai_validation_error: aiValidationError,
          ai_raw_category: ai?.rawCategory ?? null
        });
        continue;
      }

      const merchantNormalized = normalizeMerchant(
        queueRow.merchant_normalized || queueRow.merchant_raw || ""
      );
      const { data: guardedOk, error: guardedErr } = await sb.rpc(
        "upsert_txn_categorization_model_guarded",
        {
          p_user_id: queueRow.user_id,
          p_txn_id: queueRow.txn_id,
          p_category_model: categoryKey,
          p_category_confidence: confidence,
          p_is_suggested: isSuggest,
          p_merchant_normalized: merchantNormalized || null
        }
      );

      if (guardedErr) {
        stats.errors += 1;
        await markQueueRow(sb, queueRow.id, {
          status: "failed",
          deterministic_would_match: observation.wouldMatch,
          deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
          deterministic_did_apply: false,
          failure_stage: "apply_guard_failed",
          prompt_version: promptVersionForUser,
          ai_broad_concept: ai?.broadConcept ?? null,
          ai_language_detected: ai?.languageDetected ?? null,
          ai_merchant_clean: ai?.merchantClean ?? null,
          ai_reasoning: composeAiReasoning(
            ai?.reasoning,
            semanticResolverApplied ? semanticResolverReason : null,
            moneyMovementGuardApplied ? moneyMovementGuardReason : null
          ),
          ai_needs_review: aiNeedsReview,
          ai_alternate_category: aiAlternateCategoryRaw ?? ai?.alternateCategory ?? null,
          ai_validation_error: aiValidationError,
          ai_raw_category: ai?.rawCategory ?? null
        });
        continue;
      }

      if (!guardedOk) {
        stats.userOverridesPreserved += 1;
      } else if (isSuggest) {
        stats.suggested += 1;
      } else {
        stats.applied += 1;
      }

      if (guardedOk && confidence >= PROMOTE_TO_REVIEW_THRESHOLD && merchantNormalized) {
        const existingGlobal = existingGlobalMap.get(merchantNormalized);
        if (existingGlobal?.status !== "active") {
          const { error: promoteErr } = await sb
            .from("global_merchant_rules")
            .upsert(
              {
                merchant_normalized: merchantNormalized,
                category_key: categoryKey,
                confidence,
                country: "global",
                source: "ai_promoted",
                status: "pending_review",
                updated_at: new Date().toISOString()
              },
              { onConflict: "merchant_normalized,country" }
            );

          if (!promoteErr) {
            stats.promoted_to_review += 1;
            existingGlobalMap.set(merchantNormalized, { status: "pending_review", category_key: categoryKey, confidence });
          }
        }
      }

      // Keep app-facing wallet_transactions category in sync for applied AI results.
      // Match by provider_txn_id — exact, unambiguous. Falls back to title+date+amount
      // only if provider_txn_id is not set (legacy rows).
      if (guardedOk && isApply) {
        const categoryIdMap = categoryIdByUser.get(queueRow.user_id);
        const categoryId = categoryIdMap?.get(normCategoryText(categoryKey)) ?? null;
        const updatePayload = { category: categoryKey, category_id: categoryId, is_suggested: isSuggest };

        // Primary: exact match by provider_txn_id
        const { data: exactRows, error: exactErr } = await sb
          .from("wallet_transactions")
          .select("id")
          .eq("user_id", queueRow.user_id)
          .eq("provider_txn_id", queueRow.txn_id);

        if (exactErr) {
          console.error(`[${reqId}] wallet_transactions exact lookup failed for txn=${queueRow.txn_id}:`, exactErr);
        } else if (exactRows && exactRows.length > 0) {
          const ids = exactRows.map((r: any) => String(r.id)).filter((v: string) => v.length > 0);
          const { error: updateErr } = await sb.from("wallet_transactions").update(updatePayload).in("id", ids);
          if (updateErr) {
            console.error(`[${reqId}] wallet_transactions update failed for txn=${queueRow.txn_id}:`, updateErr);
          }
        } else {
          // Fallback: fuzzy match by title + day + amount for rows without provider_txn_id
          const txnMeta = txnMetaMap.get(key);
          const bounds = txnMeta?.txn_date ? utcDayBounds(txnMeta.txn_date) : null;
          if (txnMeta && bounds) {
            const targetAbsCents =
              typeof queueRow.amount_cents === "number" && Number.isFinite(queueRow.amount_cents)
                ? Math.abs(Math.round(queueRow.amount_cents))
                : (typeof txnMeta.amount_cents === "number" && Number.isFinite(txnMeta.amount_cents)
                  ? Math.abs(Math.round(txnMeta.amount_cents))
                  : null);
            const { data: fuzzyRows, error: fuzzyErr } = await sb
              .from("wallet_transactions")
              .select("id,amount")
              .eq("user_id", queueRow.user_id)
              .eq("title", txnMeta.name)
              .gte("date", bounds.startIso)
              .lt("date", bounds.endIso)
              .is("provider_txn_id", null);

            if (fuzzyErr) {
              console.error(`[${reqId}] wallet_transactions fuzzy lookup failed for txn=${queueRow.txn_id}:`, fuzzyErr);
            } else if (fuzzyRows && fuzzyRows.length > 0) {
              const filtered = targetAbsCents == null ? fuzzyRows : fuzzyRows.filter((r: any) => {
                const absCents = Math.abs(Math.round(Number(r?.amount) * 100));
                return Number.isFinite(absCents) && absCents === targetAbsCents;
              });
              const ids = filtered.map((r: any) => String(r.id)).filter((v: string) => v.length > 0);
              if (ids.length > 0) {
                const { error: updateErr } = await sb.from("wallet_transactions").update(updatePayload).in("id", ids);
                if (updateErr) {
                  console.error(`[${reqId}] wallet_transactions fuzzy update failed for txn=${queueRow.txn_id}:`, updateErr);
                }
              }
            }
          }
        }
      }

      await markQueueRow(sb, queueRow.id, {
        status: "done",
        result_category_key: categoryKey,
          result_confidence: confidence,
          is_suggested: isSuggest,
          result_source: resultSource,
        deterministic_would_match: observation.wouldMatch,
        deterministic_would_match_category_key: observation.wouldMatchCategoryKey,
        deterministic_did_apply: deterministicApplied,
        failure_stage: finalFailureStage,
        prompt_version: promptVersionForUser,
        ai_broad_concept: ai?.broadConcept ?? null,
        ai_language_detected: ai?.languageDetected ?? null,
          ai_merchant_clean: ai?.merchantClean ?? null,
          ai_reasoning: composeAiReasoning(
            ai?.reasoning,
            semanticResolverApplied ? semanticResolverReason : null,
            moneyMovementGuardApplied ? moneyMovementGuardReason : null
          ),
        ai_needs_review: aiNeedsReview,
        ai_alternate_category: aiAlternateCategoryRaw ?? ai?.alternateCategory ?? null,
        ai_validation_error: aiValidationError,
        ai_raw_category: ai?.rawCategory ?? null
      });
    }

    // Count remaining rows (pending + in-flight processing) for the active request.
    // We must include "processing" rows here because the server-side fire-and-forget
    // claims rows immediately (pending → processing) before Gemini finishes. If we
    // only count "pending", the app sees 0 and stops polling while Gemini is still
    // mid-flight — causing the post-AI Room sync to run before categories are written.
    let remainingQueued = 0;
    if (requestingUserId) {
      let remainingQuery = sb
        .from("ai_categorization_queue")
        .select("*", { count: "exact", head: true })
        .eq("user_id", requestingUserId)
        .in("status", ["pending", "processing"]);
      if (hasScopedTxnRequest) {
        remainingQuery = remainingQuery.in("txn_id", requestedTxnIds);
        if (requestedProvider) remainingQuery = remainingQuery.eq("provider", requestedProvider);
      }
      const { count } = await remainingQuery;

      let retryableFailedQuery = sb
        .from("ai_categorization_queue")
        .select("*", { count: "exact", head: true })
        .eq("user_id", requestingUserId)
        .eq("status", "failed")
        .in("failure_stage", RETRYABLE_AI_FAILURE_STAGES);
      if (hasScopedTxnRequest) {
        retryableFailedQuery = retryableFailedQuery.in("txn_id", requestedTxnIds);
        if (requestedProvider) retryableFailedQuery = retryableFailedQuery.eq("provider", requestedProvider);
      }
      const { count: retryableFailedCount } = await retryableFailedQuery;
      remainingQueued = (count ?? 0) + (retryableFailedCount ?? 0);
    }

    if (remainingQueued > 0 && hopCount < MAX_HOPS && requestingUserId) {
      fetch(`${SUPABASE_URL}/functions/v1/ai-categorize-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_ROLE}`,
          "apikey": SERVICE_ROLE
        },
        body: JSON.stringify({
          user_id: requestingUserId,
          limit: DEFAULT_BATCH_LIMIT,
          hop_count: hopCount + 1,
          provider: hasScopedTxnRequest ? requestedProvider : undefined,
          txn_ids: hasScopedTxnRequest ? requestedTxnIds : undefined,
          use_phase4_prompt: forcePhase4Prompt || undefined
        })
      }).catch(() => { });
    }

    return json({
      ok: true,
      model: GEMINI_MODEL,
      limit,
      hop_count: hopCount,
      phase3_deterministic_enabled: USE_PHASE3_DETERMINISTIC,
      phase3_deterministic_percent: PHASE3_DETERMINISTIC_PERCENT,
      phase4_prompt_enabled: USE_PHASE4_PROMPT,
      phase4_prompt_percent: PHASE4_PROMPT_PERCENT,
      phase4_prompt_forced: forcePhase4Prompt,
      phase5_semantic_resolver_enabled: USE_PHASE5_SEMANTIC_RESOLVER,
      deterministic_pattern_count: deterministicPatterns.length,
      ...stats,
      remaining_queued: remainingQueued
    });
  } catch (error) {
    console.error(`[${reqId}] ai-categorize-batch fatal:`, error);
    return json({
      ok: false,
      error: "ai_batch_failed",
      details: error instanceof Error ? error.message : String(error)
    }, 500);
  }
});
