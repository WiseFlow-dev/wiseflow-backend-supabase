import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4"
import { isStatementNoiseMerchant, normalizeMerchant } from "../_shared/normalize.ts"

const THRESHOLD_GLOBAL_EXACT = 0.80
const THRESHOLD_GLOBAL_SUGGEST = 0.65
const THRESHOLD_FUZZY_KEYWORD = 0.72
const THRESHOLD_FUZZY_SUGGEST = 0.60
const THRESHOLD_AI = 0.80
const THRESHOLD_AI_SUGGEST = 0.65

type GlobalMerchantRule = {
  merchant_normalized: string
  category_key: string
  confidence: number | null
  country: string | null
}

type UserMerchantRule = {
  merchant_normalized: string
  category_key: string
  confidence: number | null
}

type AiQueueCandidate = {
  txn_id: string
  name: string | null
  merchant_name: string | null
  amount: number | null
  account_subtype: string | null
  provider: string
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors() } })
}

type ConfidenceGateSource = "global" | "keyword" | "ai"

function gateBySource(source: ConfidenceGateSource, confidence: number): "apply" | "suggest" | "reject" {
  if (source === "global") {
    if (confidence >= THRESHOLD_GLOBAL_EXACT) return "apply"
    if (confidence >= THRESHOLD_GLOBAL_SUGGEST) return "suggest"
    return "reject"
  }
  if (source === "keyword") {
    if (confidence >= THRESHOLD_FUZZY_KEYWORD) return "apply"
    if (confidence >= THRESHOLD_FUZZY_SUGGEST) return "suggest"
    return "reject"
  }
  if (confidence >= THRESHOLD_AI) return "apply"
  if (confidence >= THRESHOLD_AI_SUGGEST) return "suggest"
  return "reject"
}

function findGlobalRule(
  title: string,
  merchant: string | null,
  rules: GlobalMerchantRule[]
): { cat: string; conf: number; mNorm: string | null } | null {
  const candidates = [
    normalizeMerchant(merchant || ""),
    normalizeMerchant(title || ""),
    normalizeMerchant(`${title || ""} ${merchant || ""}`)
  ].filter((value) => value.length > 0)

  let best: { cat: string; conf: number; mNorm: string | null; keyLen: number } | null = null

  for (const candidate of candidates) {
    for (const rule of rules) {
      const key = normalizeMerchant(rule.merchant_normalized || "")
      if (!key) continue
      const matches = candidate === key || candidate.includes(key) || key.includes(candidate)
      if (!matches) continue

      const conf = Number(rule.confidence ?? 0)
      if (
        !best ||
        conf > best.conf ||
        (conf === best.conf && key.length > best.keyLen)
      ) {
        best = { cat: rule.category_key, conf, mNorm: key, keyLen: key.length }
      }
    }
  }

  if (!best) return null
  return { cat: best.cat, conf: best.conf, mNorm: best.mNorm }
}


async function enqueueAiCandidate(
  supabase: any,
  userId: string,
  candidate: AiQueueCandidate
) {
  const merchantRaw = (candidate.merchant_name || candidate.name || "").trim() || null
  const merchantNormalized = merchantRaw ? normalizeMerchant(merchantRaw) : ""
  if (merchantNormalized && isStatementNoiseMerchant(merchantNormalized)) {
    return false
  }
  const amount = Number(candidate.amount ?? 0)
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : null

  await supabase
    .from("ai_categorization_queue")
    .upsert(
      {
        user_id: userId,
        txn_id: candidate.txn_id,
        provider: candidate.provider || "plaid",
        merchant_raw: merchantRaw,
        merchant_normalized: merchantNormalized || null,
        amount_cents: amountCents,
        account_subtype: candidate.account_subtype || null,
        status: "pending"
      },
      {
        onConflict: "user_id,txn_id,provider",
        ignoreDuplicates: true
      }
    )
  return true
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors() })
  try {
    const authHeader = req.headers.get("Authorization") || ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : ""
    if (!token) return json({ error: "Unauthorized" }, 401)

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    )

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !user) return json({ error: "Unauthorized" }, 401)

    const { limit = 400, recategorize = false } = await req.json().catch(() => ({}))

    const { data: rulesData, error: rulesError } = await supabase
      .from("global_merchant_rules")
      .select("merchant_normalized,category_key,confidence,country")
      .eq("status", "active")
      .order("confidence", { ascending: false })

    if (rulesError) return json({ error: rulesError.message }, 500)
    const globalRules = (rulesData || []) as GlobalMerchantRule[]

    // Load valid category names for this user (own + system) — strict whitelist
    const { data: catData } = await supabase
      .from("categories")
      .select("name")
      .or(`user_id.eq.${user.id},is_system.eq.true`)
    const validCategoryNames = new Set<string>()
    for (const row of (catData || [])) {
      if (typeof row.name === "string") validCategoryNames.add(row.name.toLowerCase().trim())
    }

    const { data: userRulesData, error: userRulesErr } = await supabase
      .from("user_merchant_rules")
      .select("merchant_normalized,category_key,confidence")
      .eq("user_id", user.id)

    if (userRulesErr) return json({ error: userRulesErr.message }, 500)
    const userRuleMap = new Map<string, UserMerchantRule>()
    for (const row of ((userRulesData || []) as UserMerchantRule[])) {
      const key = normalizeMerchant(row.merchant_normalized || "")
      const category = row.category_key?.trim()
      if (!key || !category) continue
      const existing = userRuleMap.get(key)
      if (!existing || Number(row.confidence ?? 0) >= Number(existing.confidence ?? 0)) {
        userRuleMap.set(key, {
          merchant_normalized: key,
          category_key: category,
          confidence: Number(row.confidence ?? 1)
        })
      }
    }

    const { data, error } = await supabase
      .from("transactions")
      .select("txn_id,account_id,name,merchant_name,amount,txn_date")
      .eq("user_id", user.id)
      .order("txn_date", { ascending: false })
      .limit(limit)

    if (error) return json({ error: error.message }, 500)
    const txns = (data || []) as Array<{
      txn_id: string
      account_id: string | null
      name: string | null
      merchant_name: string | null
      amount: number | null
    }>
    if (txns.length === 0) {
      return json({
        ok: true,
        scanned: 0,
        autoApplied: 0,
        suggested: 0,
        aiQueued: 0,
        skippedAlreadyCategorized: 0,
        userOverridesPreserved: 0,
        errors: 0,
        rulesLoaded: globalRules.length,
        rulesApplied: 0
      })
    }

    const accountIds = Array.from(new Set(txns.map((t) => t.account_id).filter((v): v is string => !!v)))
    const accountSubtypeByAccountId = new Map<string, string>()
    if (accountIds.length > 0) {
      const { data: accountsData, error: accountsErr } = await supabase
        .from("accounts")
        .select("account_id,subtype")
        .eq("user_id", user.id)
        .in("account_id", accountIds)

      if (accountsErr) return json({ error: accountsErr.message }, 500)
      for (const row of (accountsData || [])) {
        if (typeof row?.account_id === "string" && typeof row?.subtype === "string") {
          accountSubtypeByAccountId.set(row.account_id, row.subtype)
        }
      }
    }

    // Fetch existing categorizations so we can respect category_user and skip already-categorized rows
    const txnIds = txns.map(t => t.txn_id)
    const { data: existingCats } = await supabase
      .from("txn_categorization")
      .select("txn_id,category_model,category_user")
      .eq("user_id", user.id)
      .in("txn_id", txnIds)

    const existingMap = new Map<string, { category_model: string | null; category_user: string | null }>()
    for (const row of (existingCats || [])) {
      existingMap.set(row.txn_id, row)
    }

    const stats = {
      scanned: txns.length,
      autoApplied: 0,
      suggested: 0,
      aiQueued: 0,
      skippedAlreadyCategorized: 0,
      userOverridesPreserved: 0,
      errors: 0,
      rulesLoaded: globalRules.length,
      rulesApplied: 0
    }

    for (const t of txns) {
      const existing = existingMap.get(t.txn_id)

      // Never overwrite a user-set category
      if (existing?.category_user) {
        stats.userOverridesPreserved++
        continue
      }

      // Skip already-categorized rows unless recategorize=true
      if (!recategorize && existing?.category_model) {
        stats.skippedAlreadyCategorized++
        continue
      }

      // Money-in guard: negative amount = income/refund/credit.
      // Global merchant rules are expense-oriented — skip them and let AI
      // choose from income-side categories instead.
      const isMoneyIn =
        typeof t.amount === "number" &&
        Number.isFinite(t.amount) &&
        t.amount < 0
      if (isMoneyIn) {
        let wasQueued = false
        try {
          wasQueued = await enqueueAiCandidate(supabase, user.id, {
            txn_id: t.txn_id,
            name: t.name,
            merchant_name: t.merchant_name,
            amount: Number(t.amount ?? 0),
            account_subtype: t.account_id ? accountSubtypeByAccountId.get(t.account_id) || null : null,
            provider: "plaid"
          })
        } catch (_queueErr) {
          stats.errors++
        }
        // Immediate placeholder — AI will overwrite with the correct income category.
        await supabase.rpc("upsert_txn_categorization_model_guarded", {
          p_user_id: user.id, p_txn_id: t.txn_id,
          p_category_model: "Uncategorized", p_category_confidence: 0.0,
          p_is_suggested: false,
          p_merchant_normalized: normalizeMerchant(t.merchant_name || t.name || "") || null
        }).catch(() => { /* non-fatal */ })
        if (wasQueued) stats.aiQueued++
        continue
      }

      const merchantNormalized = normalizeMerchant(t.merchant_name || t.name || "")
      const userRule = merchantNormalized ? userRuleMap.get(merchantNormalized) : undefined

      let selected: { cat: string; conf: number; mNorm: string | null; isSuggested: boolean } | null = null

      if (userRule?.category_key) {
        selected = {
          cat: userRule.category_key,
          conf: 1.0,
          mNorm: merchantNormalized,
          isSuggested: false
        }
      } else {
        const globalMatch = findGlobalRule(t.name || "Transaction", t.merchant_name, globalRules)
        if (globalMatch !== null) {
          const decision = gateBySource("global", Number(globalMatch.conf ?? 0))
          if (decision === "reject") {
            let wasQueued = false
            try {
              wasQueued = await enqueueAiCandidate(supabase, user.id, {
                txn_id: t.txn_id,
                name: t.name,
                merchant_name: t.merchant_name,
                amount: Number(t.amount ?? 0),
                account_subtype: t.account_id ? accountSubtypeByAccountId.get(t.account_id) || null : null,
                provider: "plaid"
              })
            } catch (_queueErr) {
              stats.errors++
            }
            await supabase.rpc("upsert_txn_categorization_model_guarded", {
              p_user_id: user.id, p_txn_id: t.txn_id,
              p_category_model: "Uncategorized", p_category_confidence: 0.0,
              p_is_suggested: false,
              p_merchant_normalized: normalizeMerchant(t.merchant_name || t.name || "") || null
            }).catch(() => { /* non-fatal */ })
            if (wasQueued) stats.aiQueued++
            continue
          }
          stats.rulesApplied++
          selected = {
            cat: globalMatch.cat,
            conf: globalMatch.conf,
            mNorm: globalMatch.mNorm || merchantNormalized,
            isSuggested: decision === "suggest"
          }
        } else {
          // No global rule matched — queue for AI; no keyword/hardcoded fallback
          let wasQueued = false
          try {
            wasQueued = await enqueueAiCandidate(supabase, user.id, {
              txn_id: t.txn_id,
              name: t.name,
              merchant_name: t.merchant_name,
              amount: Number(t.amount ?? 0),
              account_subtype: t.account_id ? accountSubtypeByAccountId.get(t.account_id) || null : null,
              provider: "plaid"
            })
          } catch (_queueErr) {
            stats.errors++
          }
          await supabase.rpc("upsert_txn_categorization_model_guarded", {
            p_user_id: user.id, p_txn_id: t.txn_id,
            p_category_model: "Uncategorized", p_category_confidence: 0.0,
            p_is_suggested: false,
            p_merchant_normalized: normalizeMerchant(t.merchant_name || t.name || "") || null
          }).catch(() => { /* non-fatal */ })
          if (wasQueued) stats.aiQueued++
          continue
        }
      }

      if (!selected) continue

      // Enforce whitelist: only write categories the user actually has
      const selectedNameLower = selected.cat.toLowerCase().trim()
      if (validCategoryNames.size === 0 || !validCategoryNames.has(selectedNameLower)) {
        let wasQueued = false
        try {
          wasQueued = await enqueueAiCandidate(supabase, user.id, {
            txn_id: t.txn_id,
            name: t.name,
            merchant_name: t.merchant_name,
            amount: Number(t.amount ?? 0),
            account_subtype: t.account_id ? accountSubtypeByAccountId.get(t.account_id) || null : null,
            provider: "plaid"
          })
        } catch (_queueErr) {
          stats.errors++
        }
        await supabase.rpc("upsert_txn_categorization_model_guarded", {
          p_user_id: user.id, p_txn_id: t.txn_id,
          p_category_model: "Uncategorized", p_category_confidence: 0.0,
          p_is_suggested: false,
          p_merchant_normalized: normalizeMerchant(t.merchant_name || t.name || "") || null
        }).catch(() => { /* non-fatal */ })
        if (wasQueued) stats.aiQueued++
        continue
      }

      // Use the atomic guarded RPC so a concurrent category_user write
      // is never silently overwritten (the RPC has WHERE category_user IS NULL).
      const { data: guardedOk, error: guardedErr } = await supabase.rpc(
        "upsert_txn_categorization_model_guarded",
        {
          p_user_id: user.id,
          p_txn_id: t.txn_id,
          p_category_model: selected.cat,
          p_category_confidence: selected.conf,
          p_is_suggested: selected.isSuggested,
          p_merchant_normalized: selected.mNorm || null
        }
      )
      if (guardedErr) { stats.errors++; continue }
      if (!guardedOk) {
        // category_user was set concurrently — honour it
        stats.userOverridesPreserved++
      } else if (selected.isSuggested) {
        stats.suggested++
      } else {
        stats.autoApplied++
      }
    }

    return json({ ok: true, ...stats })
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500)
  }
})
