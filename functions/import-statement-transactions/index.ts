// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PROVIDER = "statement_import";
const UNCATEGORIZED = "Uncategorized";
const MAX_ROWS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
} as const;

type JsonRecord = Record<string, unknown>;

type StatementRow = {
  transaction_id: string;
  date: string;
  title: string;
  description: string | null;
  amount: number;
  wallet_amount: number;
  category_id: string | null;
  category: string;
  fingerprint: string | null;
  source_page: number | null;
};

type ExistingTransaction = {
  txn_id: string;
  user_id: string | null;
  account_id: string | null;
  txn_date: string | null;
  amount: number | string | null;
  currency: string | null;
  provider: string | null;
  raw: any;
};

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRole) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceRole, { auth: { persistSession: false } });
}

function json(payload: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function log(event: string, meta: JsonRecord = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...meta }));
}

function logError(event: string, meta: JsonRecord = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event, ...meta }));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseUuid(value: unknown, fieldName: string): string {
  const raw = asString(value);
  if (!UUID_RE.test(raw)) throw new Error(`invalid_${fieldName}`);
  return raw;
}

function parseOptionalUuid(value: unknown, fieldName: string): string | null {
  if (value == null || value === "") return null;
  const raw = asString(value);
  if (!raw) return null;
  if (!UUID_RE.test(raw)) throw new Error(`invalid_${fieldName}`);
  return raw;
}

function parseCurrency(value: unknown, fallback: string): string {
  const raw = asString(value).toUpperCase() || fallback;
  return CURRENCY_RE.test(raw) ? raw : fallback;
}

function parseDate(value: unknown, fieldName: string): string {
  const raw = asString(value);
  if (!DATE_RE.test(raw)) throw new Error(`invalid_${fieldName}`);
  return raw;
}

function parseNumber(value: unknown, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${fieldName}`);
  return Math.round(parsed * 100) / 100;
}

function parseOptionalInt(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function cleanText(value: unknown, fallback: string): string {
  const text = asString(value).replace(/\s+/g, " ");
  return text || fallback;
}

function normalizeMerchant(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cleanStatementMerchantForAi(value: string): string {
  const base = value
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/^(description|details|detail|memo|note|notes|reference|ref|transaction|narrative)\s*[:#-]+\s*/i, "")
    .trim()
    .replace(/^[\s|,;:-]+|[\s|,;:-]+$/g, "");
  const stripped = base
    .replace(/^(debit\s+card(?:\s+purchase)?|card\s+purchase|pos(?:\s+purchase)?|purchase|visa\s+debit|mastercard\s+debit|bank\s+card)\b[\s:;,#/\\-]*/i, "")
    .replace(/^[#*\d\s-]{3,}\s+/, "")
    .trim();
  return stripped.length >= 3 && /[\p{L}]/u.test(stripped) ? stripped : base;
}

function canonicalAmount(walletAmount: number): number {
  // WiseFlow wallet rows use income positive, expense negative.
  // The AI/bank pipeline expects the opposite sign convention.
  return Math.round(-walletAmount * 100) / 100;
}

function amountCents(amount: number): number {
  return Math.round(amount * 100);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function parseRows(value: unknown): StatementRow[] {
  if (!Array.isArray(value)) throw new Error("rows_required");
  if (value.length === 0) throw new Error("rows_empty");
  if (value.length > MAX_ROWS) throw new Error("rows_too_large");

  return value.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const transactionId = parseUuid(row.transaction_id, `rows_${index}_transaction_id`);
    const date = parseDate(row.date, `rows_${index}_date`);
    const title = cleanText(row.title ?? row.description, "Imported transaction");
    const description = cleanText(row.description ?? title, title);
    const walletAmount = parseNumber(row.wallet_amount ?? row.amount, `rows_${index}_wallet_amount`);
    if (walletAmount === 0) throw new Error(`invalid_rows_${index}_wallet_amount`);
    const categoryId = parseOptionalUuid(row.category_id, `rows_${index}_category_id`);
    const category = cleanText(row.category, UNCATEGORIZED);
    const fingerprint = asString(row.fingerprint) || null;
    const sourcePage = parseOptionalInt(row.source_page);

    return {
      transaction_id: transactionId,
      date,
      title,
      description,
      amount: parseNumber(row.amount ?? walletAmount, `rows_${index}_amount`),
      wallet_amount: walletAmount,
      category_id: categoryId,
      category,
      fingerprint,
      source_page: sourcePage,
    };
  });
}

function sameExistingPayload(
  existing: ExistingTransaction,
  accountId: string,
  row: StatementRow,
  statementCurrency: string,
): boolean {
  const amount = Number(existing.amount ?? 0);
  const raw = existing.raw ?? {};
  const existingAmountCents = Math.round(amount * 100);
  const statementAmountCents = amountCents(canonicalAmount(row.amount));
  const legacyWalletAmountCents = amountCents(canonicalAmount(row.wallet_amount));
  const hasStoredStatementAmount = Number.isFinite(Number(raw?.statement_import?.statement_amount));
  const amountMatches = existingAmountCents === statementAmountCents ||
    (!hasStoredStatementAmount && existingAmountCents === legacyWalletAmountCents);
  return existing.provider === PROVIDER &&
    existing.account_id === accountId &&
    existing.txn_date === row.date &&
    String(existing.currency ?? "").toUpperCase() === statementCurrency &&
    Number.isFinite(amount) &&
    amountMatches &&
    String(raw?.import_session_id ?? raw?.statement_import?.session_id ?? "") !== "";
}

async function getUserFromAuthHeader(sb: ReturnType<typeof getServiceClient>, req: Request) {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("missing_authorization");

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw new Error("invalid_authorization");
  return data.user;
}

async function loadAllowedCategories(sb: ReturnType<typeof getServiceClient>, userId: string) {
  const { data, error } = await sb
    .from("categories")
    .select("id,name,user_id,is_system")
    .or(`user_id.eq.${userId},is_system.eq.true`);

  if (error) throw new Error(`categories_load_failed:${error.message}`);
  const byId = new Map<string, string>();
  const byName = new Map<string, { id: string | null; name: string }>();
  for (const row of data ?? []) {
    const id = asString((row as any).id);
    const name = asString((row as any).name);
    if (!name) continue;
    if (id) byId.set(id, name);
    byName.set(name.toLowerCase(), { id: id || null, name });
  }
  return { byId, byName };
}

function resolveCategory(
  row: StatementRow,
  categories: Awaited<ReturnType<typeof loadAllowedCategories>>,
) {
  if (row.category_id) {
    const byId = categories.byId.get(row.category_id);
    if (byId) return { category: byId, category_id: row.category_id };
  }
  const byName = categories.byName.get(row.category.trim().toLowerCase());
  if (byName) return { category: byName.name, category_id: byName.id };

  const uncategorized = categories.byName.get("uncategorized");
  if (uncategorized) return { category: uncategorized.name, category_id: uncategorized.id };
  return { category: UNCATEGORIZED, category_id: null };
}

function isTrustedNormalCsvSourceApp(sourceApp: string | null): boolean {
  return sourceApp === "YNAB" ||
    sourceApp === "MONARCH" ||
    sourceApp === "SIMPLIFI" ||
    sourceApp === "BUDGE";
}

async function insertSyncEvent(
  sb: ReturnType<typeof getServiceClient>,
  userId: string,
  sessionId: string,
  eventName: "sync_started" | "sync_success" | "sync_failed",
  meta: JsonRecord = {},
) {
  const { error } = await sb.from("sync_event_logs").insert({
    user_id: userId,
    provider: PROVIDER,
    event_name: eventName,
    provider_ref: sessionId,
    source: "import-statement-transactions",
    latency_ms: typeof meta.latency_ms === "number" ? meta.latency_ms : null,
    error_code: typeof meta.error_code === "string" ? meta.error_code : null,
    error_message: typeof meta.error_message === "string" ? meta.error_message : null,
  });
  if (error) {
    console.warn(JSON.stringify({ event: "import_statement.sync_event_log_failed", error: error.message }));
  }
}

serve(async (req) => {
  const startedAt = Date.now();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const sb = getServiceClient();
  const callerAuthHeader = req.headers.get("Authorization") ?? "";
  let userId = "";
  let sessionId = "";

  try {
    const user = await getUserFromAuthHeader(sb, req);
    userId = user.id;

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    sessionId = parseUuid(body.session_id, "session_id");
    const walletId = parseUuid(body.wallet_id, "wallet_id");
    const statementCurrency = parseCurrency(body.statement_currency, "USD");
    const walletCurrency = parseCurrency(body.wallet_currency, statementCurrency);
    const importSourceType = asString(body.import_source_type).toUpperCase() || "CSV";
    const sourceApp = asString(body.source_app).toUpperCase() || null;
    // Mirror-only imports record transactions without them counting toward the wallet balance.
    const excludedFromBalance = body.excluded_from_balance === true;
    const rows = parseRows(body.rows);

    log("import_statement.start", {
      session_id: sessionId,
      user_id: userId,
      wallet_id: walletId,
      statement_currency: statementCurrency,
      wallet_currency: walletCurrency,
      import_source_type: importSourceType,
      source_app: sourceApp,
      rows: rows.length,
    });
    await insertSyncEvent(sb, userId, sessionId, "sync_started");

    const { data: wallet, error: walletErr } = await sb
      .from("wallets")
      .select("id,user_id,name,currency_code")
      .eq("id", walletId)
      .maybeSingle();

    if (walletErr) throw new Error(`wallet_lookup_failed:${walletErr.message}`);
    if (!wallet || String((wallet as any).user_id) !== userId) throw new Error("wallet_not_found");

    const accountId = `${PROVIDER}:${walletId}`;
    const txnIds = rows.map((row) => row.transaction_id);
    const existingById = new Map<string, ExistingTransaction>();
    for (const ids of chunk(txnIds, 100)) {
      const { data, error } = await sb
        .from("transactions")
        .select("txn_id,user_id,account_id,txn_date,amount,currency,provider,raw")
        .in("txn_id", ids);
      if (error) throw new Error(`existing_transactions_lookup_failed:${error.message}`);
      for (const row of (data ?? []) as ExistingTransaction[]) {
        existingById.set(row.txn_id, row);
      }
    }

    const rowsToWrite: StatementRow[] = [];
    let skippedExistingCount = 0;
    for (const row of rows) {
      const existing = existingById.get(row.transaction_id);
      if (!existing) {
        rowsToWrite.push(row);
        continue;
      }
      if (existing.user_id !== userId) throw new Error(`transaction_id_conflict:${row.transaction_id}`);
      if (!sameExistingPayload(existing, accountId, row, statementCurrency)) {
        throw new Error(`transaction_payload_conflict:${row.transaction_id}`);
      }
      skippedExistingCount += 1;
    }

    const categories = await loadAllowedCategories(sb, userId);
    const nowIso = new Date().toISOString();

    const transactionRows = rowsToWrite.map((row) => {
      const statementAmount = canonicalAmount(row.amount);
      const reportingAmount = canonicalAmount(row.wallet_amount);
      const merchant = row.description || row.title;
      return {
        txn_id: row.transaction_id,
        user_id: userId,
        account_id: accountId,
        txn_date: row.date,
        name: row.title,
        merchant,
        merchant_name: merchant,
        amount: statementAmount,
        currency: statementCurrency,
        category: null,
        pending: false,
        provider: PROVIDER,
        item_id: sessionId,
        authorized_date: row.date,
        is_removed: false,
        reporting_amount: walletCurrency === statementCurrency ? null : reportingAmount,
        reporting_currency: walletCurrency === statementCurrency ? null : walletCurrency,
        fx_requested_date: walletCurrency === statementCurrency ? null : row.date,
        fx_provider: walletCurrency === statementCurrency ? null : "android_app_rate",
        reporting_version: walletCurrency === statementCurrency ? 1 : 2,
        normalized_at: walletCurrency === statementCurrency ? null : nowIso,
        raw: {
          statement_import: {
            session_id: sessionId,
            wallet_id: walletId,
            statement_currency: statementCurrency,
            wallet_currency: walletCurrency,
            import_source_type: importSourceType,
            source_app: sourceApp,
            statement_amount: row.amount,
            wallet_amount: row.wallet_amount,
            source_page: row.source_page,
            fingerprint: row.fingerprint,
          },
        },
      };
    });

    log("import_statement.write_transactions", {
      session_id: sessionId,
      rows: transactionRows.length,
      skipped_existing: skippedExistingCount,
    });
    for (const batch of chunk(transactionRows, 100)) {
      const { error } = await sb.from("transactions").upsert(batch, { onConflict: "user_id,txn_id" });
      if (error) throw new Error(`transactions_upsert_failed:${error.message}`);
    }

    const resolvedRows = rows.map((row) => {
      const resolvedCategory = resolveCategory(row, categories);
      const trustSourceCategory = importSourceType === "NORMAL_CSV" &&
        isTrustedNormalCsvSourceApp(sourceApp) &&
        resolvedCategory.category_id != null &&
        resolvedCategory.category !== UNCATEGORIZED;
      return { row, resolvedCategory, trustSourceCategory };
    });

    const walletRows = resolvedRows.map(({ row, resolvedCategory }) => {
      const note = `${resolvedCategory.category}|${row.title}|Imported from statement`;
      return {
        id: row.transaction_id,
        user_id: userId,
        wallet_id: walletId,
        amount: row.wallet_amount,
        category: resolvedCategory.category,
        category_id: resolvedCategory.category_id,
        title: row.title,
        note,
        date: `${row.date}T12:00:00.000Z`,
        is_budget_rollover: false,
        is_opening_balance: false,
        is_manual_topup: false,
        excluded_from_balance: excludedFromBalance,
        import_session_id: sessionId,
        import_source_type: importSourceType,
        import_fingerprint: row.fingerprint ?? null,
        is_suggested: !resolvedCategory.category_id,
        source: "bank",
        provider: PROVIDER,
        provider_txn_id: row.transaction_id,
        sync_status: "posted",
      };
    });

    log("import_statement.write_wallet_transactions", { session_id: sessionId, rows: walletRows.length });
    for (const batch of chunk(walletRows, 100)) {
      const { error } = await sb.from("wallet_transactions").upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`wallet_transactions_upsert_failed:${error.message}`);
    }

    const seededCategoryRows = resolvedRows
      .filter(({ trustSourceCategory }) => trustSourceCategory)
      .map(({ row, resolvedCategory }) => {
        const merchantRaw = row.description || row.title;
        const merchantForAi = cleanStatementMerchantForAi(merchantRaw);
        return {
          user_id: userId,
          txn_id: row.transaction_id,
          category_model: resolvedCategory.category,
          category_confidence: 1,
          merchant_normalized: normalizeMerchant(merchantForAi || merchantRaw) || null,
          is_suggested: false,
          updated_at: nowIso,
        };
      });

    const queueRows = resolvedRows
      .filter(({ trustSourceCategory }) => !trustSourceCategory)
      .map(({ row }) => {
      const queueAmount = canonicalAmount(row.wallet_amount);
      const merchantRaw = row.description || row.title;
      const merchantForAi = cleanStatementMerchantForAi(merchantRaw);
      return {
        user_id: userId,
        txn_id: row.transaction_id,
        provider: PROVIDER,
        merchant_raw: merchantForAi || merchantRaw,
        merchant_normalized: normalizeMerchant(merchantForAi || merchantRaw) || null,
        amount_cents: amountCents(queueAmount),
        account_subtype: null,
        status: "pending",
        result_category_key: null,
        result_confidence: null,
        result_source: null,
        is_suggested: false,
        deterministic_would_match: null,
        deterministic_would_match_category_key: null,
        deterministic_did_apply: null,
        failure_stage: null,
        prompt_version: null,
        ai_broad_concept: null,
        ai_language_detected: null,
        ai_merchant_clean: null,
        ai_reasoning: null,
        ai_needs_review: null,
        ai_alternate_category: null,
        ai_validation_error: null,
        ai_raw_category: null,
        claimed_at: null,
        processed_at: null,
      };
    });

    if (seededCategoryRows.length > 0) {
      log("import_statement.seed_source_categories", {
        session_id: sessionId,
        rows: seededCategoryRows.length,
        source_app: sourceApp,
      });
      for (const row of seededCategoryRows) {
        const { error } = await sb.rpc("upsert_txn_categorization_model_guarded", {
          p_user_id: row.user_id,
          p_txn_id: row.txn_id,
          p_category_model: row.category_model,
          p_category_confidence: row.category_confidence,
          p_is_suggested: row.is_suggested,
          p_merchant_normalized: row.merchant_normalized,
        });
        if (error) throw new Error(`txn_categorization_seed_failed:${error.message}`);
      }

      const trustedQueueRows = seededCategoryRows.map((row) => ({
        user_id: row.user_id,
        txn_id: row.txn_id,
        provider: PROVIDER,
        status: "done",
        result_category_key: row.category_model,
        result_confidence: row.category_confidence,
        result_source: "source_csv_category",
        is_suggested: false,
        ai_needs_review: false,
        processed_at: nowIso,
      }));
      for (const batch of chunk(trustedQueueRows, 100)) {
        const { error } = await sb.from("ai_categorization_queue").upsert(batch, {
          onConflict: "user_id,txn_id,provider",
        });
        if (error) throw new Error(`ai_queue_trusted_seed_failed:${error.message}`);
      }
    }

    log("import_statement.queue_ai", { session_id: sessionId, rows: queueRows.length });
    for (const batch of chunk(queueRows, 100)) {
      const { error } = await sb.from("ai_categorization_queue").upsert(batch, {
        onConflict: "user_id,txn_id,provider",
      });
      if (error) throw new Error(`ai_queue_upsert_failed:${error.message}`);
    }

    for (const batch of chunk(queueRows, 100)) {
      const fallbackRows = batch.map((row) => ({
        user_id: row.user_id,
        txn_id: row.txn_id,
        category_model: UNCATEGORIZED,
        category_confidence: 0,
        merchant_normalized: row.merchant_normalized,
        is_suggested: false,
        updated_at: nowIso,
      }));
      const { error } = await sb
        .from("txn_categorization")
        .upsert(fallbackRows, { onConflict: "user_id,txn_id", ignoreDuplicates: true });
      if (error) throw new Error(`txn_categorization_fallback_failed:${error.message}`);
    }

    let batchKicked = false;
    let batchStatus = 0;
    if (queueRows.length > 0) {
      const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const limit = Math.min(200, Math.max(150, queueRows.length));
      log("import_statement.kick_ai_batch", { session_id: sessionId, limit });
      const response = await fetch(`${supabaseUrl}/functions/v1/ai-categorize-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: callerAuthHeader || `Bearer ${serviceRole}`,
          apikey: anonKey || serviceRole,
        },
        body: JSON.stringify({
          user_id: userId,
          limit,
          source: "import-statement-transactions",
          provider: PROVIDER,
          use_phase4_prompt: true,
          txn_ids: queueRows.map((row) => row.txn_id),
        }),
      });
      batchStatus = response.status;
      batchKicked = response.ok;
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(JSON.stringify({
          event: "import_statement.ai_batch_kick_failed",
          session_id: sessionId,
          status: response.status,
          body: text.slice(0, 500),
        }));
      }
    }

    const latencyMs = Date.now() - startedAt;
    await insertSyncEvent(sb, userId, sessionId, "sync_success", { latency_ms: latencyMs });
    log("import_statement.success", {
      session_id: sessionId,
      imported_count: rowsToWrite.length,
      queued_count: queueRows.length,
      skipped_existing_count: skippedExistingCount,
      batch_kicked: batchKicked,
      latency_ms: latencyMs,
    });

    return json({
      ok: true,
      session_id: sessionId,
      imported_count: rowsToWrite.length,
      queued_count: queueRows.length,
      skipped_existing_count: skippedExistingCount,
      txn_ids: rows.map((row) => row.transaction_id),
      batch_kicked: batchKicked,
      batch_status: batchStatus,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("import_statement.error", { session_id: sessionId, user_id: userId, error: message });
    if (userId && sessionId) {
      await insertSyncEvent(getServiceClient(), userId, sessionId, "sync_failed", {
        latency_ms: Date.now() - startedAt,
        error_code: message.split(":")[0] || "statement_import_error",
        error_message: message.slice(0, 500),
      });
    }
    const status = message.includes("authorization") ? 401 :
      message.includes("wallet_not_found") ? 404 :
      message.includes("conflict") ? 409 :
      400;
    return json({ ok: false, error: message }, status);
  }
});
