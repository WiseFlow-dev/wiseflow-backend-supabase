import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  normalizeTransactionsToMainCurrency,
  resolveMainCurrencyCode,
} from '../_shared/currencyReporting.ts'

// IDE hint only: Deno is a global in Supabase Edge Functions (Deno runtime)
// Declaring minimal shape to silence local TypeScript warnings.
declare const Deno: { env: { get(name: string): string | undefined } }

function normalizeCategoryWithRegistry(rawCategory: string | null, registry: CategoryRegistryItem[]): { key: string; label: string; shortLabel: string } {
  const raw = (rawCategory || 'Other').trim() || 'Other'
  const lower = raw.toLowerCase()
  // Try exact key
  const byKey = registry.find(r => r.key === lower)
  if (byKey) return { key: byKey.key, label: byKey.label, shortLabel: byKey.key }
  // Try synonyms
  for (const r of registry) {
    const syns = (r.synonyms || []).map(s => (s || '').toLowerCase())
    if (syns.some(s => lower.includes(s))) {
      return { key: r.key, label: r.label, shortLabel: r.key }
    }
  }
  // Fallback to previous heuristic
  return classifyCategoryForBenchmarks(rawCategory)
}

function computeTopCategoryInfoWithRegistry(expenses: TxnRow[], registry: CategoryRegistryItem[]): TopCategoryInfo | null {
  if (!expenses.length) return null
  const byKey = new Map<string, { amount: number; anyRaw: string; label: string }>()
  for (const t of expenses) {
    const raw = (t.category || 'Other').trim() || 'Other'
    const lower = raw.toLowerCase()
    if (lower === 'transfer') continue
    const cls = normalizeCategoryWithRegistry(raw, registry)
    const existing = byKey.get(cls.key) || { amount: 0, anyRaw: raw, label: cls.label }
    existing.amount += Math.abs(typeof t.amount === 'number' ? t.amount : Number(t.amount || 0))
    existing.anyRaw = raw
    existing.label = cls.label
    byKey.set(cls.key, existing)
  }
  if (!byKey.size) return null
  const entries = [...byKey.entries()].sort((a, b) => b[1].amount - a[1].amount)
  const [key, data] = entries[0]
  const cls = normalizeCategoryWithRegistry(data.anyRaw, registry)
  return { key, label: cls.label, shortLabel: cls.shortLabel, amount: data.amount }
}

// ---- Category Registry (fallback to local defaults) ----
type CategoryRegistryItem = {
  key: string
  label: string
  synonyms?: string[]
  essential?: boolean // true = gentle tone, false = flexible/coaching
}

async function fetchCategoryRegistry(supabase: any): Promise<CategoryRegistryItem[]> {
  try {
    const { data, error } = await supabase
      .from('category_registry')
      .select('key, label, synonyms, essential')
    if (!error && Array.isArray(data) && data.length) {
      return data as CategoryRegistryItem[]
    }
  } catch (_e) { }
  // Defaults if table not present
  return [
    { key: 'dining', label: 'dining and food', synonyms: ['food', 'restaurant', 'grocer'], essential: false },
    { key: 'groceries', label: 'groceries', synonyms: ['supermarket', 'grocery', 'market'], essential: true },
    { key: 'transport', label: 'transport and rides', synonyms: ['uber', 'lyft', 'gas', 'fuel', 'taxi'], essential: false },
    { key: 'subscriptions', label: 'subscriptions', synonyms: ['netflix', 'spotify', 'hulu', 'disney', 'prime'], essential: false },
    { key: 'shopping', label: 'shopping', synonyms: ['retail', 'store', 'amazon'], essential: false }
  ]
}

// ---- Utils ----
function clampOneLine(s: string, max = 84): string {
  const one = (s || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function isWeekend(d: Date) {
  const day = d.getUTCDay()
  return day === 0 || day === 6
}

function hoursUTC(d: Date) { return d.getUTCHours() }

// ---- Vertex AI auth ----
// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[analytics-engine] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) return cachedAccessToken.token;
  const sa = GOOGLE_SA;
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
  cachedAccessToken = { token: tokenData.access_token, expiresAt: Date.now() + 3_300_000 };
  return tokenData.access_token;
}

// ---- Optional LLM title/subtitle generation (Vertex AI) ----
async function generateLLMTitleSubtitle(
  id: string,
  context: { gist: string; tone: 'gentle' | 'firm' }
): Promise<{ title: string; subtitle: string } | null> {
  if (!VERTEX_PROJECT) return null

  const prompt = `Write compact UI copy for a finance insight. Output ONLY JSON as {"title":"...","subtitle":"..."}. Title <= 38 chars. Subtitle <= 84 chars. Tone: ${context.tone}. Gist: ${context.gist}. No emojis.`

  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 5000)
  try {
    const accessToken = await getAccessToken()
    const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/gemini-2.5-flash-lite:generateContent`
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 120 }
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(t)
    if (!resp.ok) {
      log('analytics_engine.llm_used', { provider: 'none', id })
      return null
    }
    const j = await resp.json()
    const text: string = j?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || '').join('') || ''
    const match = (text || '').match(/\{[\s\S]*\}/)
    if (!match) {
      log('analytics_engine.llm_used', { provider: 'none', id })
      return null
    }
    const obj = JSON.parse(match[0]) as { title?: string; subtitle?: string }
    if (obj?.title && obj?.subtitle) {
      log('analytics_engine.llm_used', { provider: 'vertex_ai', id })
      return { title: clampOneLine(obj.title, 38), subtitle: clampOneLine(obj.subtitle, 84) }
    }
  } catch (_e) {
    // timeout or network error
  }
  log('analytics_engine.llm_used', { provider: 'none', id })
  return null
}

// ---- Dynamic, trigger-based insights ----
function analyzeWeekendSpike(expenses: TxnRow[]): { spikeRatio: number; weekendPerDay: number; weekdayPerDay: number } {
  if (!expenses.length) return { spikeRatio: 0, weekendPerDay: 0, weekdayPerDay: 0 }
  let weekend = 0, weekday = 0, weekendDays = new Set<number>(), weekdayDays = new Set<number>()
  for (const t of expenses) {
    const d = new Date(t.date)
    const amt = Math.abs(Number(t.amount || 0))
    if (isNaN(amt) || !(amt > 0)) continue
    if (isWeekend(d)) { weekend += amt; weekendDays.add(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) } else { weekday += amt; weekdayDays.add(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) }
  }
  const weekendPerDay = weekendDays.size ? weekend / weekendDays.size : 0
  const weekdayPerDay = weekdayDays.size ? weekday / weekdayDays.size : 0
  const ratio = weekdayPerDay > 0 ? weekendPerDay / weekdayPerDay : (weekendPerDay > 0 ? 2 : 0)
  return { spikeRatio: ratio, weekendPerDay, weekdayPerDay }
}

function analyzeMorningConvenience(expenses: TxnRow[]): { count: number; window: string | null } {
  let count = 0
  const hours: number[] = []
  for (const t of expenses) {
    const amt = Math.abs(Number(t.amount || 0))
    if (!(amt > 0) || amt > 20) continue // small buys
    const d = new Date(t.date)
    const h = hoursUTC(d)
    if (h >= 6 && h <= 10) { count++; hours.push(h) }
  }
  if (!count) return { count: 0, window: null }
  const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length)
  const start = Math.max(6, avg - 1), end = Math.min(11, avg + 1)
  return { count, window: `${start}:00–${end}:00` }
}

function analyzePaydaySpike(txns: TxnRow[]): { enabled: boolean; firstWeekShare: number } {
  if (!txns.length) return { enabled: false, firstWeekShare: 0 }
  let spentFirst7 = 0, spentRest = 0
  for (const t of txns) {
    const amt = Number(t.amount || 0)
    if (!(amt < 0)) continue
    const d = new Date(t.date)
    const day = d.getUTCDate()
    const absAmt = Math.abs(amt)
    if (day <= 7) { spentFirst7 += absAmt } else { spentRest += absAmt }
  }
  const total = spentFirst7 + spentRest
  const share = total > 0 ? spentFirst7 / total : 0
  return { enabled: share >= 0.45, firstWeekShare: share }
}

async function buildDeepInsightsDynamic(
  supabase: any,
  userId: string,
  monthTxns: TxnRow[],
  prevTxns: TxnRow[],
  rankings: Rankings
): Promise<DeepInsight[]> {
  // No transactions at all: do not show any deep insights yet
  if (!(monthTxns?.length) && !(prevTxns?.length)) {
    return []
  }
  const registry = await fetchCategoryRegistry(supabase)
  const expenses = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomes = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount > 0 && isIncomeCategoryName(t.category))
  const monthlyIncome = incomes.reduce((sum, t) => sum + (typeof t.amount === 'number' ? t.amount : Number(t.amount || 0)), 0)

  // Helpers to personalize suggestions
  const bracket = rankings?.income_bracket || null
  const bracketMid = ((): number => {
    switch (bracket) {
      case '<1.5k': return 1200
      case '1.5k–2.5k': return 2000
      case '2.5k–3.5k': return 3000
      case '3.5k–5k': return 4200
      case '5k+': return 6000
      default: return monthlyIncome > 0 ? monthlyIncome : 2500
    }
  })()

  const weekendCap = ((): number => {
    // Recommend ~1.5% of monthly income, clamped
    const raw = Math.round(bracketMid * 0.015)
    return Math.max(40, Math.min(160, raw))
  })()

  const coffeeWeekly = ((): number => {
    // Recommend weekly cap scaled by bracket
    if (bracketMid <= 1500) return 12
    if (bracketMid <= 2500) return 18
    if (bracketMid <= 3500) return 22
    if (bracketMid <= 5000) return 25
    return 30
  })()

  const paydayTransfer = ((): number => {
    // 10% of actual current month income if available, else of bracketMid
    const base = monthlyIncome > 0 ? monthlyIncome : bracketMid
    return Math.max(25, Math.round(base * 0.10))
  })()

  const weekend = analyzeWeekendSpike(expenses)
  const morning = analyzeMorningConvenience(expenses)
  const payday = analyzePaydaySpike(monthTxns)

  const out: DeepInsight[] = []

  // Weekend impulse
  if (weekend.spikeRatio >= 1.5 && out.length < 4) {
    const gist = `Weekend spending per-day is ${weekend.spikeRatio.toFixed(1)}× weekdays. Consider a weekend pocket & 24-hour rule.`
    const tone: 'gentle' | 'firm' = 'firm'
    const llm = await generateLLMTitleSubtitle('weekend_impulse', { gist, tone })
    out.push({
      id: 'weekend_impulse',
      emoji: '📊',
      title: llm?.title || variantTitle('Weekend Impulse Shopping', ['Weekend Reward Spending', 'Weekend Velocity Spike']),
      description: clampOneLine(llm?.subtitle || 'Weekend spend runs higher than weekdays. Try a weekend fun cap to control splurges.'),
      ai_conclusion: 'Weekends activate your reward mindset after a disciplined week. Set a weekend pocket and a 24‑hour rule for bigger buys.',
      suggestions: [
        `Weekend fun cap: ~$${money(weekendCap)} to keep it bounded`,
        'Add to cart, buy tomorrow (kills most impulses)',
        'Hide shopping icons from home screen on Fri–Sun'
      ]
    })
  }

  // Convenience pattern
  if (morning.count >= 5 && morning.window && out.length < 4) {
    const gist = `Frequent small morning buys (${morning.count}) around ${morning.window}.`
    const tone: 'gentle' | 'firm' = 'gentle'
    const llm = await generateLLMTitleSubtitle('convenience_pair', { gist, tone })
    out.push({
      id: 'convenience_pair',
      emoji: '☕',
      title: llm?.title || variantTitle('Convenience Spending Pattern', ['Routine Convenience Buys', 'Autopilot Convenience Pattern']),
      description: clampOneLine(llm?.subtitle || `Morning window ${morning.window}; swap a few for home-made to save.`),
      ai_conclusion: 'You are buying convenience more than the product itself. Swap a few with home alternatives to save without losing the ritual.',
      suggestions: [
        `3‑2 coffee rule: cap ~$${money(coffeeWeekly)} per week`,
        'Batch brew on Sunday + travel mug',
        'Swap 2 café days for home‑made this week'
      ]
    })
  }

  // Payday spike
  if (payday.enabled && out.length < 4) {
    const pct = Math.round(payday.firstWeekShare * 100)
    const gist = `~${pct}% of monthly spend lands in the first week after payday.`
    const tone: 'gentle' | 'firm' = 'firm'
    const llm = await generateLLMTitleSubtitle('payday_spike', { gist, tone })
    out.push({
      id: 'payday_spike',
      emoji: '💸',
      title: llm?.title || variantTitle('Payday Spending Spike', ['Payday Surge', 'Salary Week Spike', 'Fresh Income Spike']),
      description: clampOneLine(llm?.subtitle || 'A large share lands right after salary. Auto-transfer savings and bills on payday.'),
      ai_conclusion: 'Automate transfers to savings, goals, and bills on payday so less feels available to splurge in week one.',
      suggestions: [
        `Auto‑transfer on payday: ~$${money(paydayTransfer)} (≈10%)`,
        'Split into Savings and Goals automatically',
        'Pay fixed bills on payday so “fresh money” feels smaller'
      ]
    })
  }

  // Server-side 10-day cooldown filter
  try {
    const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000
    const cutoffISO = new Date(Date.now() - TEN_DAYS_MS).toISOString()
    const ids = out.map(o => o.id)
    if (ids.length) {
      const { data: readRows } = await supabase
        .from('analytics_deep_reads')
        .select('insight_id, read_at')
        .eq('user_id', userId)
        .gte('read_at', cutoffISO)
        .in('insight_id', ids)
      const blocked = new Set<string>((readRows || []).map((r: any) => String(r.insight_id)))
      if (blocked.size) {
        const filtered = out.filter(o => !blocked.has(o.id))
        if (filtered.length) return filtered
        // If all were blocked, fall back to static so UI isn't empty
        return buildStaticDeepInsights()
      }
    }
  } catch (_e) { }

  // Fallbacks if nothing triggered
  if (!out.length) return buildStaticDeepInsights()
  return out
}

function getServiceSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getUserFromAuthHeader(supabaseClient: any, req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw new Error('Missing Authorization header')
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabaseClient.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired token')
  return user
}

function log(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), event, ...meta }
  console.log(JSON.stringify(payload))
}

function logError(event: string, meta: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), level: 'error', event, ...meta }
  console.error(JSON.stringify(payload))
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-main-currency'
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  })
}

type TxnRow = {
  amount: number
  category: string | null
  date: string
}

async function normalizeTxnRowsForMainCurrency(
  supabase: any,
  userId: string,
  currencyCode: string,
  rows: Array<Record<string, unknown>>,
  label: string,
): Promise<TxnRow[]> {
  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    currencyCode,
    rows,
  )

  log('analytics_engine.currency_normalization_metrics', {
    userId,
    label,
    ...normalized.metrics,
  })

  return normalized.rows.map((row) => ({
    amount: Number(row.amount ?? 0),
    category: typeof row.category === 'string' ? row.category : null,
    date: String(row.date ?? ''),
  }))
}

type QuickStat = {
  label: string
  value: string
  change: string
  is_positive: boolean
}

type UnderstandingHighlight = {
  text: string
  type: 'PRIMARY' | 'SECONDARY' | 'SUCCESS'
}

type AIUnderstanding = {
  summary: string
  highlights: UnderstandingHighlight[]
}

type DeepInsight = {
  id: string
  emoji: string
  title: string
  description: string
  ai_conclusion: string
  suggestions?: string[]
}

type BehavioralPattern = {
  emoji: string
  name: string
  confidence: string
  context: string
}

type SmartRecommendation = {
  emoji: string
  title: string
  description: string
  impact: string
}

type Motivator = {
  title: string
  subtitle: string
  content: string
}

type Rankings = {
  income_bracket: string | null
  savings_percentile: number | null
  spending_control_percentile: number | null
  weekend_control_percentile: number | null
  goal_achievement_percentile: number | null
  // Self scores 0–10 based only on the user's own data
  savings_score: number | null
  spending_control_score: number | null
  goal_achievement_score: number | null
  // Extra metrics for detailed comparisons in the Wisey's Analytics dialog
  savings_rate_self: number | null
  savings_rate_peers_avg: number | null
  spent_monthly_self: number | null
  spent_monthly_peers_avg: number | null
  saved_monthly_self: number | null
  saved_monthly_peers_avg: number | null
  // Category-level overspend information (vs typical peers)
  overspend_category_key: string | null
  overspend_category_label: string | null
  overspend_category_short_label: string | null
  // Relative difference in share of spending vs peers, e.g. 0.74 = 74% more
  overspend_category_delta_ratio: number | null
  // How many real peer users were used to compute percentiles
  peer_sample_size: number | null
}

function monthBoundaries(monthKey: string) {
  const [yStr, mStr] = monthKey.split('-')
  const year = Number(yStr)
  const month = Number(mStr) - 1
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 0 || month > 11) {
    throw new Error(`Invalid month format: ${monthKey}. Expected YYYY-MM`)
  }

  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))

  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const prevStart = new Date(Date.UTC(prevYear, prevMonth, 1, 0, 0, 0, 0))
  const prevEnd = new Date(Date.UTC(prevYear, prevMonth + 1, 0, 23, 59, 59, 999))

  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    prevStartISO: prevStart.toISOString(),
    prevEndISO: prevEnd.toISOString()
  }
}

function savingsWindowStart(monthKey: string, monthsBack: number): string {
  const [yStr, mStr] = monthKey.split('-')
  let year = Number(yStr)
  let month = Number(mStr) - 1
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid month format for savingsWindowStart: ${monthKey}`)
  }

  const back = Math.max(1, Math.min(24, monthsBack))
  let startMonthIndex = month - (back - 1)
  let startYear = year
  while (startMonthIndex < 0) {
    startMonthIndex += 12
    startYear -= 1
  }

  const start = new Date(Date.UTC(startYear, startMonthIndex, 1, 0, 0, 0, 0))
  return start.toISOString()
}

function money(amount: number): string {
  const v = Math.round(Math.abs(amount))
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function emojiForCategoryName(category: string | null): string {
  const c = (category || 'other').toLowerCase()
  if (c.includes('food') || c.includes('dining') || c.includes('restaurant') || c.includes('grocer')) return '🍔'
  if (c.includes('transport') || c.includes('uber') || c.includes('lyft') || c.includes('gas') || c.includes('fuel') || c.includes('taxi')) return '🚗'
  if (c.includes('shopping') || c.includes('retail') || c.includes('store') || c.includes('amazon')) return '🛒'
  if (c.includes('fun') || c.includes('entertainment') || c.includes('movie') || c.includes('cinema') || c.includes('game')) return '🎬'
  if (c.includes('subscription') || c.includes('netflix') || c.includes('spotify') || c.includes('hulu') || c.includes('disney') || c.includes('prime')) return '📺'
  return '💸'
}

function isIncomeCategoryName(category: string | null): boolean {
  if (!category) return false
  const c = category.trim().toLowerCase()
  if (!c) return false
  if (c === 'transfer') return false
  const incomeNames = [
    'salary',
    'freelance',
    'investment',
    'rewards',
    'reward',
    'gifts',
    'gift',
    'business',
    'refund',
    'bonus',
    'income',
    'opening balance',
    'opening_balance',
    // Treat wallet deposits/top-ups as income for analytics fairness
    'deposit',
    'deposit balance',
    'wallet deposit',
    'topup',
    'top up',
    'add money',
    'add funds',
    'cash in',
    // Treat manual balance edits as income when they increase balance
    'balance adjustment',
    'balance_adjustment'
  ]
  return incomeNames.includes(c)
}

function isTransferCategoryName(category: string | null): boolean {
  if (!category) return false
  const c = category.trim().toLowerCase()
  if (!c) return false
  return c === 'transfer'
}

function isOpeningBalanceCategoryName(category: string | null): boolean {
  if (!category) return false
  const c = category.trim().toLowerCase()
  if (!c) return false
  return c === '__opening_balance__' || c === 'opening balance' || c === 'opening_balance'
}

type TopCategoryInfo = {
  key: string
  label: string
  shortLabel: string
  amount: number
}

function classifyCategoryForBenchmarks(rawCategory: string | null): { key: string; label: string; shortLabel: string } {
  const raw = (rawCategory || 'Other').trim() || 'Other'
  const lower = raw.toLowerCase()

  if (
    lower.includes('food') ||
    lower.includes('dining') ||
    lower.includes('restaurant') ||
    lower.includes('grocer')
  ) {
    return { key: 'dining', label: 'dining and food', shortLabel: 'dining' }
  }

  if (
    lower.includes('subscription') ||
    lower.includes('netflix') ||
    lower.includes('spotify') ||
    lower.includes('hulu') ||
    lower.includes('disney') ||
    lower.includes('prime')
  ) {
    return { key: 'subscriptions', label: 'subscriptions', shortLabel: 'subscriptions' }
  }

  if (
    lower.includes('transport') ||
    lower.includes('uber') ||
    lower.includes('lyft') ||
    lower.includes('gas') ||
    lower.includes('fuel') ||
    lower.includes('taxi')
  ) {
    return { key: 'transport', label: 'transport and rides', shortLabel: 'transport' }
  }

  if (lower.includes('supermarket') || lower.includes('grocery') || lower.includes('market')) {
    return { key: 'groceries', label: 'groceries', shortLabel: 'groceries' }
  }

  if (lower.includes('shopping') || lower.includes('retail') || lower.includes('store') || lower.includes('amazon')) {
    return { key: 'shopping', label: 'shopping', shortLabel: 'shopping' }
  }

  return { key: 'other', label: `${raw} spending`, shortLabel: raw.toLowerCase() }
}

function computeTopCategoryInfo(expenses: TxnRow[]): TopCategoryInfo | null {
  if (!expenses.length) return null

  const byKey = new Map<string, { amount: number; anyRaw: string }>()

  for (const t of expenses) {
    const raw = (t.category || 'Other').trim() || 'Other'
    const lower = raw.toLowerCase()
    // Ignore transfers between wallets
    if (lower === 'transfer') continue

    const cls = classifyCategoryForBenchmarks(raw)
    const existing = byKey.get(cls.key) || { amount: 0, anyRaw: raw }
    existing.amount += Math.abs(typeof t.amount === 'number' ? t.amount : Number(t.amount || 0))
    existing.anyRaw = raw
    byKey.set(cls.key, existing)
  }

  if (!byKey.size) return null

  const entries = [...byKey.entries()].sort((a, b) => b[1].amount - a[1].amount)
  const [key, data] = entries[0]
  const cls = classifyCategoryForBenchmarks(data.anyRaw)

  return {
    key,
    label: cls.label,
    shortLabel: cls.shortLabel,
    amount: data.amount
  }
}

// Map user's savings to a self score (0–10) based on the user's highest amount for the month.
// If the user saves 10% of the highest amount, score is 10/10. Linear between 0%→0 and 10%→10.
// Anything above 10% is capped at 10.
function computeSavingsSelfScore(savedThis: number, highestAmount: number): number | null {
  if (!(highestAmount > 0)) return null
  const ratio = savedThis / highestAmount
  if (!Number.isFinite(ratio) || ratio < 0) return null
  const score = Math.min(10, Math.max(0, ratio * 100))
  return Number(score.toFixed(1))
}

// Map user's spending to a self score (0–10) based on a simple monthly budget.
// We treat 90% of income as the spendable budget after a 10% savings target.
// Spending up to this budget -> 10/10, and linearly down to 0/10 at 2x budget.
function computeSpendingControlSelfScore(
  spentThis: number,
  highestAmount: number
): number | null {
  const income = highestAmount
  if (!(income > 0) || !(spentThis >= 0)) return null

  const spendableBudget = income * 0.9
  if (!(spendableBudget > 0)) return null

  const ratio = spentThis / spendableBudget
  if (!Number.isFinite(ratio) || ratio < 0) return null

  if (ratio <= 1) {
    return 10
  }

  const cappedRatio = Math.min(2, ratio)
  const score = (2 - cappedRatio) * 10
  return Number(Math.max(0, Math.min(10, score)).toFixed(1))
}

function computeAiScoreFromComponents(
  savingsScore: number | null,
  spendingScore: number | null,
  goalScore: number | null
): number | null {
  const s =
    typeof savingsScore === 'number' && Number.isFinite(savingsScore)
      ? savingsScore
      : 5
  const c =
    typeof spendingScore === 'number' && Number.isFinite(spendingScore)
      ? spendingScore
      : 5
  const g =
    typeof goalScore === 'number' && Number.isFinite(goalScore)
      ? goalScore
      : null

  let raw: number
  if (g != null) {
    raw = 0.4 * s + 0.4 * c + 0.2 * g
  } else {
    raw = 0.5 * s + 0.5 * c
  }

  if (!Number.isFinite(raw)) return null
  const clamped = Math.max(0, Math.min(10, raw))
  return Number(clamped.toFixed(1))
}

function buildQuickStatsFromServer(monthTxns: TxnRow[], prevTxns: TxnRow[]): QuickStat[] {
  if (!monthTxns.length) {
    return [
      { label: 'SPENT', value: '$0', change: '', is_positive: true },
      { label: 'AI SCORE', value: '—', change: '', is_positive: true },
      { label: 'SAVED', value: '$0', change: '', is_positive: true }
    ]
  }

  const abs = (n: number) => Math.abs(n)

  const expensesThis = monthTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount < 0 &&
    !isTransferCategoryName(t.category)
  )
  const incomeThis = monthTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const expensesPrev = prevTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount < 0 &&
    !isTransferCategoryName(t.category)
  )
  const incomePrev = prevTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const totalSpentThis = abs(expensesThis.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomeThis = incomeThis.reduce((sum, t) => sum + t.amount, 0)
  const totalSpentPrev = abs(expensesPrev.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomePrev = incomePrev.reduce((sum, t) => sum + t.amount, 0)

  // SPENT
  const spentDiff = totalSpentThis - totalSpentPrev
  const spentChangeText = totalSpentPrev > 0
    ? `${spentDiff <= 0 ? '↓' : '↑'} $${money(Math.abs(spentDiff))} vs last month`
    : ''
  const spentIsPositive = totalSpentPrev > 0 && spentDiff <= 0

  const spentStat: QuickStat = {
    label: 'SPENT',
    value: `$${money(totalSpentThis)}`,
    change: spentChangeText,
    is_positive: spentIsPositive
  }

  // SAVED (income - expenses)
  const savedThis = Math.max(0, totalIncomeThis - totalSpentThis)
  const savedPrev = Math.max(0, totalIncomePrev - totalSpentPrev)
  const savedDiff = savedThis - savedPrev
  const savedChangeText = savedPrev > 0
    ? `${savedDiff >= 0 ? '↑' : '↓'} $${money(Math.abs(savedDiff))} vs last month`
    : ''
  const savedIsPositive = savedPrev > 0 && savedDiff >= 0

  const savedStat: QuickStat = {
    label: 'SAVED',
    value: `$${money(savedThis)}`,
    change: savedChangeText,
    is_positive: savedIsPositive
  }

  // AI SCORE is filled in later using self scores and goals; keep a neutral placeholder here.
  const aiStat: QuickStat = {
    label: 'AI SCORE',
    value: '—',
    change: '',
    is_positive: true
  }

  // Return only SPENT, AI SCORE placeholder, and SAVED
  return [spentStat, aiStat, savedStat]
}

function buildUnderstanding(
  monthTxns: TxnRow[],
  prevTxns: TxnRow[],
  rankings: Rankings
): AIUnderstanding {
  if (!monthTxns.length) {
    return buildStaticUnderstanding()
  }

  const abs = (n: number) => Math.abs(n)

  const expensesThis = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomeThis = monthTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const expensesPrev = prevTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomePrev = prevTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const totalSpentThis = abs(expensesThis.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomeThis = incomeThis.reduce((sum, t) => sum + t.amount, 0)
  const totalSpentPrev = abs(expensesPrev.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomePrev = incomePrev.reduce((sum, t) => sum + t.amount, 0)

  if (!(totalIncomeThis > 0 || totalSpentThis > 0)) {
    // Not enough signal yet; keep the static friendly message.
    return buildStaticUnderstanding()
  }

  // Savings signal: prefer savings_score (flows to Savings wallets) when available.
  // Fallback to simple income-spend approximation only when we have no better data.
  const savingsScore = typeof rankings.savings_score === 'number' && Number.isFinite(rankings.savings_score)
    ? rankings.savings_score
    : null

  const savedThisApprox = Math.max(0, totalIncomeThis - totalSpentThis)
  const savedPrevApprox = Math.max(0, totalIncomePrev - totalSpentPrev)
  const savingsRateApprox = totalIncomeThis > 0 ? savedThisApprox / totalIncomeThis : 0

  // Spending style: use both income share and spending_control_percentile when available.
  const shareSpent = totalIncomeThis > 0 ? totalSpentThis / totalIncomeThis : 0
  let spendingLabel = 'disciplined spender'
  if (shareSpent > 0.95) {
    spendingLabel = 'high-intensity spender'
  } else if (shareSpent > 0.8) {
    spendingLabel = 'flexible spender'
  } else if (shareSpent > 0.65) {
    spendingLabel = 'mindful spender'
  }

  if (rankings.spending_control_percentile != null) {
    const p = rankings.spending_control_percentile
    if (p >= 0.8) {
      spendingLabel = 'disciplined spender'
    } else if (p <= 0.4) {
      spendingLabel = 'spontaneous spender'
    }
  }

  // Income stability label from this vs previous month.
  let incomeLabel = 'stable income'
  if (!(totalIncomeThis > 0) && !(totalIncomePrev > 0)) {
    incomeLabel = 'no recent income data'
  } else if (totalIncomeThis > 0 && totalIncomePrev > 0) {
    const diff = Math.abs(totalIncomeThis - totalIncomePrev)
    const maxInc = Math.max(totalIncomeThis, totalIncomePrev)
    const volatility = maxInc > 0 ? diff / maxInc : 0
    if (volatility <= 0.2) {
      incomeLabel = 'stable income'
    } else if (volatility <= 0.5) {
      incomeLabel = 'somewhat variable income'
    } else {
      incomeLabel = 'irregular income'
    }
  } else {
    incomeLabel = 'irregular income'
  }

  // Savings behavior label from savings score + rate.
  let savingsLabel = 'saving consistently'
  const effectiveSavingsRate = savingsScore != null
    ? Math.max(0, Math.min(1, savingsScore / 10))
    : savingsRateApprox

  if (effectiveSavingsRate < 0.05) {
    savingsLabel = 'barely saving right now'
  } else if (effectiveSavingsRate < 0.15) {
    savingsLabel = 'building your savings'
  } else {
    savingsLabel = 'saving consistently'
  }

  // Dominant flexible spending area (top expense category).
  let categoryFragment = 'weekend splurges'
  if (expensesThis.length) {
    const byCat = new Map<string, number>()
    for (const t of expensesThis) {
      const raw = (t.category || 'Other').trim() || 'Other'
      const normalized = raw.toLowerCase() === 'transfer' ? 'Other' : raw
      byCat.set(normalized, (byCat.get(normalized) || 0) + Math.abs(t.amount))
    }
    const entries = [...byCat.entries()].sort((a, b) => b[1] - a[1])
    if (entries.length) {
      const [cat] = entries[0]
      const lower = cat.toLowerCase()
      if (
        lower.includes('food') ||
        lower.includes('dining') ||
        lower.includes('restaurant') ||
        lower.includes('grocer')
      ) {
        categoryFragment = 'dining and food'
      } else if (
        lower.includes('subscription') ||
        lower.includes('netflix') ||
        lower.includes('spotify') ||
        lower.includes('hulu') ||
        lower.includes('disney') ||
        lower.includes('prime')
      ) {
        categoryFragment = 'subscriptions'
      } else if (
        lower.includes('transport') ||
        lower.includes('uber') ||
        lower.includes('lyft') ||
        lower.includes('gas') ||
        lower.includes('fuel') ||
        lower.includes('taxi')
      ) {
        categoryFragment = 'transport and rides'
      } else {
        categoryFragment = `${cat} spending`
      }
    }
  }

  // Decide whether we actually have real peers in this income range.
  const peerN = typeof rankings.peer_sample_size === 'number' ? rankings.peer_sample_size : 0
  const hasRealPeers = peerN >= 2

  let summary: string
  if (hasRealPeers && rankings.savings_percentile != null && Number.isFinite(rankings.savings_percentile)) {
    // Peer comparison text for savings only when we truly have peers.
    let peerPhrase = 'many similar users'
    const pct = Math.round(rankings.savings_percentile * 100)
    if (pct >= 100) {
      peerPhrase = 'all similar users'
    } else if (pct >= 99) {
      peerPhrase = 'almost all similar users'
    } else if (pct <= 0) {
      peerPhrase = '0% of similar users'
    } else if (pct <= 1) {
      peerPhrase = 'only a small share of similar users'
    } else {
      peerPhrase = `${pct}% of similar users`
    }

    summary =
      `You're a ${spendingLabel} with most of your flexible spending going to ${categoryFragment}. ` +
      `Your income is ${incomeLabel}, and you're ${savingsLabel}—ahead of ${peerPhrase} ` +
      'when it comes to what you keep versus what you earn.'
  } else {
    // Self-focused story when peers are not reliable yet.
    summary =
      `You're a ${spendingLabel} with most of your flexible spending going to ${categoryFragment}. ` +
      `Your income is ${incomeLabel}, and you're ${savingsLabel} based on how much you move into savings versus what you spend.`
  }

  const highlights: UnderstandingHighlight[] = [
    { text: spendingLabel, type: 'PRIMARY' },
    { text: incomeLabel, type: 'SECONDARY' },
    { text: savingsLabel, type: 'SUCCESS' }
  ]

  return { summary, highlights }
}

function buildStaticUnderstanding(): AIUnderstanding {
  return {
    summary:
      "You're a disciplined spender with weekend splurges. Your income is stable, but you overspend on dining in the first week after payday. You're saving consistently—ahead of many similar users.",
    highlights: [
      { text: 'disciplined spender', type: 'PRIMARY' },
      { text: 'stable income', type: 'SECONDARY' },
      { text: 'saving consistently', type: 'SUCCESS' }
    ]
  }
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

function variantTitle(base: string, variants: string[]): string {
  const pool = [base, ...variants]
  return pick(pool)
}

function buildStaticDeepInsights(): DeepInsight[] {
  const paydayTitle = variantTitle('Payday Spending Spike', ['Payday Surge', 'Salary Week Spike', 'Fresh Income Spike'])
  const convenienceTitle = variantTitle('Convenience Spending Pattern', ['Routine Convenience Buys', 'Autopilot Convenience Pattern'])
  const weekendTitle = variantTitle('Weekend Impulse Shopping', ['Weekend Reward Spending', 'Weekend Velocity Spike'])

  return [
    {
      id: 'payday_spike',
      emoji: '💸',
      title: paydayTitle,
      description:
        'You tend to concentrate a large share of your monthly spending in the first few days after salary hits. This pattern has been consistent across recent months.',
      ai_conclusion:
        "This is classic mental accounting—fresh salary feels different from money you've had for a while. Wisey suggests automating transfers to savings and goals on payday so your brain never treats that money as \"free to spend\" in the first week."
    },
    {
      id: 'convenience_pair',
      emoji: '☕',
      title: convenienceTitle,
      description:
        'Workday coffee or similar small routines show up as regular, time-specific purchases. They almost never appear on weekends or days off.',
      ai_conclusion:
        'You are buying convenience more than the product itself. Shifting a few of these to home-made alternatives can free hundreds per year without cutting the ritual completely.'
    },
    {
      id: 'weekend_impulse',
      emoji: '📊',
      title: weekendTitle,
      description:
        'Weekend afternoons show a spending velocity several times higher than weekdays, with many purchases being unplanned or entertainment-driven.',
      ai_conclusion:
        'Weekends activate your reward mindset after a disciplined week. Wisey recommends a dedicated weekend fun budget and a simple 24-hour rule for bigger purchases to keep this pattern under control without killing the fun.'
    }
  ]
}

function buildStaticBehaviorPattern(): BehavioralPattern {
  return {
    emoji: '🎯',
    name: 'The "First Week Splurger"',
    confidence: "Wisey's confidence: High • based on recent months",
    context:
      "Wisey identified that your spending climbs sharply right after income arrives, then slows down later in the month. This is completely human—your brain experiences a short-lived \"wealth illusion\" after payday. The fix is to work with your psychology, not against it: automate transfers to savings, goals, and bills on payday so less \"feels\" available to splurge in that first week."
  }
}

function buildStaticSmartRecommendations(): SmartRecommendation[] {
  return [
    {
      emoji: '🎯',
      title: '3-2 Coffee Rule',
      description:
        'Keep café coffee as a treat, not a daily autopilot. Try buying coffee 3 days per week and making it at home the other 2. This keeps the ritual but quietly cuts the yearly cost.',
      impact: '💰 Save hundreds per year'
    },
    {
      emoji: '⚡',
      title: 'Payday Protection Strategy',
      description:
        'On payday, automatically move a slice of your income into savings and goals before you start spending. Your brain never misses what it never saw as \"spendable\" money.',
      impact: '🚀 Stronger savings and less regret spending'
    }
  ]
}

function buildStaticMotivator(): Motivator {
  return {
    title: "You're doing better than you think!",
    subtitle: 'Keep building momentum',
    content:
      "Your recent behavior shows real progress—there is a meaningful gap between your income and spending most months. Even small improvements in habits compound into big results over a year. Wisey's job is to help you protect that progress and direct it toward the goals that matter most to you."
  }
}

function buildSimulatedRankingsFromTxns(monthTxns: TxnRow[], prevTxns: TxnRow[]): Rankings {
  if (!monthTxns.length) {
    return {
      income_bracket: null,
      savings_percentile: null,
      spending_control_percentile: null,
      weekend_control_percentile: null,
      goal_achievement_percentile: null,
      savings_score: null,
      spending_control_score: null,
      goal_achievement_score: null,
      savings_rate_self: null,
      savings_rate_peers_avg: null,
      spent_monthly_self: null,
      spent_monthly_peers_avg: null,
      saved_monthly_self: null,
      saved_monthly_peers_avg: null,
      overspend_category_key: null,
      overspend_category_label: null,
      overspend_category_short_label: null,
      overspend_category_delta_ratio: null,
      peer_sample_size: null
    }
  }

  const abs = (n: number) => Math.abs(n)

  const expensesThis = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomeThis = monthTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const expensesPrev = prevTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomePrev = prevTxns.filter((t) =>
    typeof t.amount === 'number' &&
    t.amount > 0 &&
    isIncomeCategoryName(t.category)
  )

  const totalSpentThis = abs(expensesThis.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomeThis = incomeThis.reduce((sum, t) => sum + t.amount, 0)
  const totalSpentPrev = abs(expensesPrev.reduce((sum, t) => sum + t.amount, 0))
  const totalIncomePrev = incomePrev.reduce((sum, t) => sum + t.amount, 0)

  const savedThis = Math.max(0, totalIncomeThis - totalSpentThis)
  const savedPrev = Math.max(0, totalIncomePrev - totalSpentPrev)

  const highestSim = totalIncomeThis
  const savingsScore = computeSavingsSelfScore(savedThis, highestSim)
  const spendingScore = computeSpendingControlSelfScore(totalSpentThis, highestSim)

  const share = totalIncomeThis > 0 ? (totalSpentThis / totalIncomeThis) * 100 : null

  // Top category overspend info (simulated peer baseline)
  let overspend: TopCategoryInfo | null = null
  let overspendDeltaRatio: number | null = null
  if (totalSpentThis > 0) {
    const topCat = computeTopCategoryInfo(expensesThis)
    if (topCat) {
      const shareThisCat = topCat.amount / totalSpentThis
      // Simulated typical peer share: assume peers spend a bit less share here
      const peerShareSim = Math.max(0.05, Math.min(0.5, shareThisCat * 0.7))
      if (peerShareSim > 0 && Number.isFinite(shareThisCat)) {
        overspend = topCat
        overspendDeltaRatio = shareThisCat / peerShareSim - 1
      }
    }
  }

  // Simulated comparison metrics for the Wisey's Analytics dialog
  const savingsRateThis = totalIncomeThis > 0 ? savedThis / totalIncomeThis : null
  const peerSavingsRateAvg = savingsRateThis != null ? Math.max(0, Math.min(1, savingsRateThis * 0.8)) : null
  const spentMonthlySelf = totalSpentThis
  const spentMonthlyPeersAvg = totalSpentThis > 0 ? totalSpentThis * 1.1 : null

  // Map income to a simple bracket label for now
  let incomeBracket: string | null = null
  if (totalIncomeThis > 0) {
    const monthlyIncome = totalIncomeThis
    if (monthlyIncome < 1500) incomeBracket = '<1.5k'
    else if (monthlyIncome < 2500) incomeBracket = '1.5k–2.5k'
    else if (monthlyIncome < 3500) incomeBracket = '2.5k–3.5k'
    else if (monthlyIncome < 5000) incomeBracket = '3.5k–5k'
    else incomeBracket = '5k+'
  }

  // Simulated savings percentile: higher when you save more of your income and trend is improving
  let savingsPercentile: number | null = null
  if (totalIncomeThis > 0) {
    const savingsRate = savedThis / totalIncomeThis // 0–1
    const trendBoost = savedThis >= savedPrev ? 0.1 : -0.1
    const base = Math.min(0.95, Math.max(0.2, savingsRate + trendBoost))
    savingsPercentile = Number(base.toFixed(2))
  }

  // Simulated spending control percentile: lower share of income spent is better
  let spendingControlPercentile: number | null = null
  if (share != null) {
    let pct: number
    if (share <= 50) pct = 0.9
    else if (share <= 60) pct = 0.8
    else if (share <= 70) pct = 0.7
    else if (share <= 80) pct = 0.6
    else if (share <= 90) pct = 0.5
    else if (share <= 100) pct = 0.4
    else if (share <= 120) pct = 0.3
    else pct = 0.2
    spendingControlPercentile = Number(pct.toFixed(2))
  }

  const weekendControlPercentile = spendingControlPercentile

  return {
    income_bracket: incomeBracket,
    savings_percentile: savingsPercentile,
    spending_control_percentile: spendingControlPercentile,
    weekend_control_percentile: weekendControlPercentile,
    goal_achievement_percentile: null,
    savings_score: savingsScore,
    spending_control_score: spendingScore,
    goal_achievement_score: null,
    savings_rate_self: savingsRateThis,
    savings_rate_peers_avg: peerSavingsRateAvg,
    spent_monthly_self: spentMonthlySelf,
    spent_monthly_peers_avg: spentMonthlyPeersAvg,
    saved_monthly_self: savedThis,
    saved_monthly_peers_avg: (peerSavingsRateAvg != null && totalIncomeThis > 0) ? peerSavingsRateAvg * totalIncomeThis : null,
    overspend_category_key: overspend ? overspend.key : null,
    overspend_category_label: overspend ? overspend.label : null,
    overspend_category_short_label: overspend ? overspend.shortLabel : null,
    overspend_category_delta_ratio: overspendDeltaRatio,
    peer_sample_size: null
  }
}

async function buildRankings(
  supabase: any,
  userId: string,
  month: string,
  monthTxns: TxnRow[],
  prevTxns: TxnRow[],
  monthsBack: number
): Promise<Rankings> {
  try {
    const hasCurrentMonthTxns = monthTxns.length > 0
    const hasPrevMonthTxns = prevTxns.length > 0

    if (!hasCurrentMonthTxns && !hasPrevMonthTxns) {
      // Absolutely no transaction history yet: return a neutral empty ranking.
      return buildSimulatedRankingsFromTxns(monthTxns, prevTxns)
    }

    // If the current reference month has no transactions yet, reuse the
    // previous month's behavior as the best available signal for rankings
    // and overspend, but still compute savings flows over the full window.
    const baseTxns: TxnRow[] = hasCurrentMonthTxns ? monthTxns : prevTxns

    const abs = (n: number) => Math.abs(n)

    // Savings window: boundaries for current and previous month.
    const { startISO, endISO, prevStartISO, prevEndISO } = monthBoundaries(month)

    const expensesThis = baseTxns.filter((t) =>
      typeof t.amount === 'number' &&
      t.amount < 0 &&
      !isTransferCategoryName(t.category)
    )
    const incomeThis = baseTxns.filter((t) =>
      typeof t.amount === 'number' &&
      t.amount > 0 &&
      isIncomeCategoryName(t.category)
    )

    const expensesPrev = prevTxns.filter((t) =>
      typeof t.amount === 'number' &&
      t.amount < 0 &&
      !isTransferCategoryName(t.category)
    )
    const incomePrev = prevTxns.filter((t) =>
      typeof t.amount === 'number' &&
      t.amount > 0 &&
      isIncomeCategoryName(t.category)
    )

    const totalSpentThis = abs(expensesThis.reduce((sum, t) => sum + t.amount, 0))
    const totalIncomeThis = incomeThis.reduce((sum, t) => sum + t.amount, 0)
    const totalSpentPrev = abs(expensesPrev.reduce((sum, t) => sum + t.amount, 0))
    const totalIncomePrev = incomePrev.reduce((sum, t) => sum + t.amount, 0)

    let savingsScore: number | null = null
    let spendingScore: number | null = null

    // Compute current total savings balance across Savings wallets
    let savingsBalanceTotal = 0
    const savingsWalletIds = new Set<string>()
    try {
      const { data: walletRows, error: walletsError } = await supabase
        .from('wallets')
        .select('id, type, balance')
        .eq('user_id', userId)

      if (!walletsError && walletRows) {
        type WalletRow = { id: string | null; type: string | null; balance: number | null }
        for (const w of walletRows as WalletRow[]) {
          const t = (w.type || '').toLowerCase()
          if (t === 'savings') {
            savingsBalanceTotal += Number(w.balance || 0)
            if (w.id) savingsWalletIds.add(w.id)
          }
        }
      }
    } catch (e) {
      logError('analytics_engine.wallets_error', { error: String(e) })
    }

    let monthlySavingsFlow = 0
    let prevMonthlySavingsFlow = 0
    if (savingsWalletIds.size > 0) {
      // Use the same period as baseTxns: if current month has no txns, use previous month window.
      const flowStart = hasCurrentMonthTxns ? startISO : prevStartISO
      const flowEnd = hasCurrentMonthTxns ? endISO : prevEndISO

      try {
        const { data: savingsRows, error: savingsError } = await supabase
          .from('wallet_transactions')
          .select('amount, wallet_id, category')
          .eq('user_id', userId)
          .gte('date', flowStart)
          .lte('date', flowEnd)
          .in('wallet_id', Array.from(savingsWalletIds))

        if (!savingsError && savingsRows) {
          type SavingsTxnRow = { amount: number | null; category?: string | null }
          monthlySavingsFlow = (savingsRows as SavingsTxnRow[]).reduce((sum, row) => {
            const amt = typeof row.amount === 'number' ? row.amount : Number(row.amount || 0)
            if (!Number.isFinite(amt)) return sum
            return sum + amt
          }, 0)
        }
      } catch (e) {
        logError('analytics_engine.savings_flow_error', { error: String(e) })
      }

      // Previous period is still the prior calendar month for trend
      try {
        const { data: prevSavingsRows, error: prevSavingsError } = await supabase
          .from('wallet_transactions')
          .select('amount, wallet_id, category')
          .eq('user_id', userId)
          .gte('date', prevStartISO)
          .lte('date', prevEndISO)
          .in('wallet_id', Array.from(savingsWalletIds))

        if (!prevSavingsError && prevSavingsRows) {
          type SavingsTxnRow = { amount: number | null; category?: string | null }
          prevMonthlySavingsFlow = (prevSavingsRows as SavingsTxnRow[]).reduce((sum, row) => {
            const amt = typeof row.amount === 'number' ? row.amount : Number(row.amount || 0)
            if (!Number.isFinite(amt)) return sum
            return sum + amt
          }, 0)
        }
      } catch (e) {
        logError('analytics_engine.prev_savings_flow_error', { error: String(e) })
      }
    }

    // Self scores (use highest monthly amount approximation)
    const highestAmount = totalIncomeThis
    spendingScore = computeSpendingControlSelfScore(totalSpentThis, highestAmount)
    // For savings, treat the savings wallet balance as the saved level
    const savedLevel = Math.max(0, monthlySavingsFlow)
    savingsScore = computeSavingsSelfScore(savedLevel, highestAmount)

    const share = totalIncomeThis > 0 ? (totalSpentThis / totalIncomeThis) * 100 : null

    // income bracket for this user this month
    let incomeBracket: string | null = null
    if (totalIncomeThis > 0) {
      const monthlyIncome = totalIncomeThis
      if (monthlyIncome < 1500) incomeBracket = '<1.5k'
      else if (monthlyIncome < 2500) incomeBracket = '1.5k–2.5k'
      else if (monthlyIncome < 3500) incomeBracket = '2.5k–3.5k'
      else if (monthlyIncome < 5000) incomeBracket = '3.5k–5k'
      else incomeBracket = '5k+'
    }

    // Upsert this user's monthly summary into analytics_user_monthly_stats
    await supabase
      .from('analytics_user_monthly_stats')
      .upsert({
        user_id: userId,
        month,
        income_total: totalIncomeThis,
        spent_total: totalSpentThis,
        saved_total: monthlySavingsFlow,
        savings_balance_total: savingsBalanceTotal,
        income_bracket: incomeBracket
      }, { onConflict: 'user_id,month' })

    if (!incomeBracket) {
      // Fallback to simulated rankings when we can't determine bracket
      const sim = buildSimulatedRankingsFromTxns(monthTxns, prevTxns)
      return {
        ...sim,
        saved_monthly_self: monthlySavingsFlow,
        saved_monthly_peers_avg: null
      }
    }

    const { data: peerRows, error: peerError } = await supabase
      .from('analytics_user_monthly_stats')
      .select('user_id, income_total, spent_total, saved_total, savings_balance_total')
      .eq('income_bracket', incomeBracket)
      .eq('month', month)

    if (peerError || !peerRows) {
      const sim = buildSimulatedRankingsFromTxns(monthTxns, prevTxns)
      return {
        ...sim,
        saved_monthly_self: monthlySavingsFlow,
        saved_monthly_peers_avg: null
      }
    }

    type PeerRow = { user_id: string; income_total: number | null; spent_total: number | null; saved_total: number | null; savings_balance_total: number | null }
    const peersAll = (peerRows as PeerRow[])

    // Exclude the current user; small-cohort logic keeps at least 1 peer if present
    const peersExcludingSelf = peersAll.filter((p) => p.user_id !== userId)
    if (!peersExcludingSelf.length) {
      // No peers at all for this month+bracket → simulate
      const sim = buildSimulatedRankingsFromTxns(monthTxns, prevTxns)
      return {
        ...sim,
        saved_monthly_self: monthlySavingsFlow,
        saved_monthly_peers_avg: null
      }
    }

    // Apply outlier filtering only when we have a reasonably sized cohort
    const useOutlierFilter = peersExcludingSelf.length >= 5
    const filteredPeers = useOutlierFilter
      ? peersExcludingSelf.filter((p) => {
        const inc = Number(p.income_total || 0)
        if (!(inc > 0)) return false
        const spent = Math.abs(Number(p.spent_total || 0))
        const saved = Number(p.saved_total || 0)
        const savingsRate = inc > 0 ? saved / inc : 0
        if (!Number.isFinite(savingsRate) || savingsRate < 0 || savingsRate > 0.8) return false
        if (Number.isFinite(spent) && spent > inc * 10) return false
        return true
      })
      : peersExcludingSelf

    // Never drop to simulation just because the only peer failed the filter.
    const cohortPeers = filteredPeers.length ? filteredPeers : peersExcludingSelf

    // Savings and spending comparisons: treat only dedicated Savings wallets
    // as "savings". Cash in other wallets is not counted as savings.
    const mySpendingShare = totalIncomeThis > 0 ? totalSpentThis / totalIncomeThis : 0
    const mySavingsBalance = savingsBalanceTotal

    const mySavingsRate: number = (() => {
      if (!(totalIncomeThis > 0)) return 0
      const r = monthlySavingsFlow / totalIncomeThis
      if (!Number.isFinite(r) || r <= 0) return 0
      return r
    })()

    const savingsRates = cohortPeers.map((p) => {
      const inc = Number(p.income_total || 0)
      const savedFlow = Number(p.saved_total || 0)
      if (!(inc > 0)) return 0
      const r = savedFlow / inc
      if (!Number.isFinite(r) || r <= 0) return 0
      return r
    })

    const spendingShares = cohortPeers.map((p) => (p.spent_total || 0) / (p.income_total || 1))
    const savingsBalances = cohortPeers.map((p) => p.savings_balance_total || 0)

    // Percentiles: for tiny cohorts (<5 peers), rank against peers only (exclude self)
    // so with two users you get 100%/0% intuitively. For larger cohorts, include self
    // for stability.
    const cohortSize = cohortPeers.length
    const allSavingsRates = [mySavingsRate, ...savingsRates]
    const allSpendingShares = [mySpendingShare, ...spendingShares]

    const savingsPercentile = (() => {
      if (cohortSize > 0 && cohortSize < 5) {
        const betterOrEqualPeers = savingsRates.filter((r) => r <= mySavingsRate).length
        return Number((betterOrEqualPeers / cohortSize).toFixed(2))
      }
      const betterOrEqualAll = allSavingsRates.filter((r) => r <= mySavingsRate).length
      return Number((betterOrEqualAll / allSavingsRates.length).toFixed(2))
    })()

    const spendingControlPercentile = (() => {
      if (cohortSize > 0 && cohortSize < 5) {
        const betterOrEqualPeers = spendingShares.filter((s) => s >= mySpendingShare).length
        return Number((betterOrEqualPeers / cohortSize).toFixed(2))
      }
      const betterOrEqualAll = allSpendingShares.filter((s) => s >= mySpendingShare).length
      return Number((betterOrEqualAll / allSpendingShares.length).toFixed(2))
    })()

    const peerAvgSavingsRate = savingsRates.length
      ? savingsRates.reduce((sum, r) => sum + r, 0) / savingsRates.length
      : null

    const peerAvgSpentMonthly = cohortPeers.length
      ? cohortPeers.reduce((sum, p) => sum + Math.abs(p.spent_total || 0), 0) / cohortPeers.length
      : null

    const peerAvgSavedMonthly = cohortPeers.length
      ? cohortPeers.reduce((sum, p) => sum + Math.max(0, Number(p.saved_total || 0)), 0) / cohortPeers.length
      : null

    // Category-level overspend vs peers using benchmarks_cache
    let overspend: TopCategoryInfo | null = null
    let overspendDeltaRatio: number | null = null

    if (totalSpentThis > 0) {
      const topCat = computeTopCategoryInfo(expensesThis)
      if (topCat) {
        const shareThisCat = topCat.amount / totalSpentThis
        let typicalShare: number | null = null

        try {
          const { data: benchRows, error: benchError } = await supabase
            .from('benchmarks_cache')
            .select('p10, p25, p50, p75, p90')
            .eq('income_bracket', incomeBracket)
            .eq('category', topCat.key)
            .limit(1)

          if (!benchError && benchRows && benchRows.length) {
            const row = benchRows[0] as any
            const rawTypical = row.p50 ?? row.p75 ?? row.p25 ?? null
            if (typeof rawTypical === 'number') {
              typicalShare = rawTypical > 1 ? rawTypical / 100 : rawTypical
            }
          }
        } catch (e) {
          logError('analytics_engine.benchmarks_error', { error: String(e) })
        }

        if (!(typeof typicalShare === 'number' && Number.isFinite(typicalShare) && typicalShare > 0)) {
          // Fallback synthetic baseline: peers spend a bit less share in this category
          typicalShare = Math.max(0.05, Math.min(0.5, shareThisCat * 0.7))
        }

        if (typicalShare > 0 && Number.isFinite(shareThisCat)) {
          overspend = topCat
          overspendDeltaRatio = shareThisCat / typicalShare - 1
        }
      }
    }

    let balancePercentile: number | null = null
    if (cohortSize > 0) {
      if (cohortSize < 5) {
        const betterOrEqualPeers = savingsBalances.filter((b) => b <= mySavingsBalance).length
        balancePercentile = Number((betterOrEqualPeers / cohortSize).toFixed(2))
      } else {
        const balancesAll = [mySavingsBalance, ...savingsBalances]
        const betterOrEqualAll = balancesAll.filter((b) => b <= mySavingsBalance).length
        balancePercentile = Number((betterOrEqualAll / balancesAll.length).toFixed(2))
      }
    }

    const baseSavingsPercentile = (cohortSize > 0 && cohortSize < 5)
      ? savingsPercentile
      : (balancePercentile != null ? (savingsPercentile + balancePercentile) / 2 : savingsPercentile)

    const adjustedSavingsPercentile = Math.max(0, Math.min(1, baseSavingsPercentile))

    const weekendControlPercentile = spendingControlPercentile

    // Goal achievement: self score (0–10) and peer percentile based on time-adjusted goal consistency
    let goalAchievementPercentile: number | null = null
    let goalAchievementScore: number | null = null
    try {
      // Peers with valid income in the same bracket, EXCLUDING the current user
      const peerUserIds = Array.from(
        new Set(
          cohortPeers
            .map((p) => p.user_id)
            .filter((id) => id && id !== userId)
        )
      )
      const userIds = [userId, ...peerUserIds]

      const { data: goalRows, error: goalError } = await supabase
        .from('goals')
        .select('user_id, is_wish, target_amount_cents, current_amount_cents, target_date_millis, created_at_millis, created_at')
        .in('user_id', userIds)

      if (!goalError && goalRows && goalRows.length) {
        type GoalRow = {
          user_id: string
          is_wish: boolean | null
          target_amount_cents: number | null
          current_amount_cents: number | null
          target_date_millis: number | null
          created_at_millis: number | null
          created_at: string | null
        }
        const rowsByUser = new Map<string, GoalRow[]>()
        for (const row of goalRows as GoalRow[]) {
          const uid = row.user_id
          if (!uid) continue
          if (!rowsByUser.has(uid)) rowsByUser.set(uid, [])
          rowsByUser.get(uid)!.push(row)
        }

        const nowMs = Date.now()

        const computeUserGoalConsistency = (rows: GoalRow[]): number | null => {
          // Multiple syncs can create several snapshots of the same logical goal
          // (same user, target, time window) with different current_amount_cents.
          // Deduplicate by keeping a single "best" row per goal key so that
          // analytics uses the latest progress instead of averaging snapshots.

          const byKey = new Map<string, GoalRow>()

          for (const r of rows) {
            if (r.is_wish === true) continue
            const target = Number(r.target_amount_cents ?? 0)
            const targetMsKey = Number(r.target_date_millis ?? 0)
            const createdMsKey =
              r.created_at_millis != null
                ? Number(r.created_at_millis)
                : r.created_at
                  ? Date.parse(r.created_at)
                  : NaN

            if (!(target > 0)) continue
            if (!Number.isFinite(targetMsKey) || targetMsKey <= 0) continue
            if (!Number.isFinite(createdMsKey) || createdMsKey <= 0) continue

            const key = `${r.user_id}::${target}::${targetMsKey}::${createdMsKey}`
            const existing = byKey.get(key)
            if (!existing) {
              byKey.set(key, r)
            } else {
              const existingCurrent = Number(existing.current_amount_cents ?? 0)
              const current = Number(r.current_amount_cents ?? 0)
              if (current >= existingCurrent) {
                byKey.set(key, r)
              }
            }
          }

          const rowsToUse = byKey.size ? Array.from(byKey.values()) : rows

          const items: { score: number; weight: number }[] = []

          for (const r of rowsToUse) {
            if (r.is_wish === true) continue
            const target = Number(r.target_amount_cents ?? 0)
            const current = Number(r.current_amount_cents ?? 0)
            const targetMs = Number(r.target_date_millis ?? 0)
            const createdMsRaw =
              r.created_at_millis != null
                ? Number(r.created_at_millis)
                : r.created_at
                  ? Date.parse(r.created_at)
                  : NaN

            if (!(target > 0)) continue
            if (!Number.isFinite(targetMs) || targetMs <= 0) continue
            if (!Number.isFinite(createdMsRaw) || createdMsRaw <= 0) continue

            const totalDuration = targetMs - createdMsRaw
            if (!Number.isFinite(totalDuration) || totalDuration <= 0) continue

            const clampedNow = Math.min(nowMs, targetMs)
            const elapsed = clampedNow - createdMsRaw
            if (elapsed <= 0) continue

            let timeProgress = elapsed / totalDuration
            if (!Number.isFinite(timeProgress) || timeProgress <= 0) continue

            let amountProgress = target > 0 ? current / target : 0
            if (!Number.isFinite(amountProgress) || amountProgress < 0) amountProgress = 0

            // On-track ratio: how your money progress compares to how much time has passed
            const onTrackRatio = amountProgress / timeProgress
            let score: number
            if (!Number.isFinite(onTrackRatio) || onTrackRatio <= 0) {
              score = 0
            } else if (onTrackRatio >= 1) {
              // Being ahead of schedule or finishing early is great,
              // but we cap at "perfect" instead of giving extra advantage
              score = 1
            } else {
              // Behind schedule: proportional score (e.g. 0.6 means 60% of ideal pace)
              score = onTrackRatio
            }

            if (!Number.isFinite(score)) continue
            score = Math.max(0, Math.min(1, score))

            const weight = target
            if (weight > 0) {
              items.push({ score, weight })
            }
          }

          if (!items.length) return null
          const totalWeight = items.reduce((sum, it) => sum + it.weight, 0)
          if (!(totalWeight > 0)) return null

          const weightedScore = items.reduce((sum, it) => sum + it.score * it.weight, 0) / totalWeight
          if (!Number.isFinite(weightedScore)) return null
          return Math.max(0, Math.min(1, Number(weightedScore.toFixed(2))))
        }

        const myConsistency = computeUserGoalConsistency(rowsByUser.get(userId) || [])
        if (myConsistency != null) {
          // Self score is purely based on the user's own consistency (0–1 → 0–10)
          goalAchievementScore = Number(Math.min(10, Math.max(0, myConsistency * 10)).toFixed(1))

          const peerScores: number[] = []
          for (const uid of peerUserIds) {
            const s = computeUserGoalConsistency(rowsByUser.get(uid) || [])
            if (s != null) peerScores.push(s)
          }
          if (peerScores.length > 0) {
            const betterOrEqual = peerScores.filter((s) => s <= myConsistency).length
            goalAchievementPercentile = Number((betterOrEqual / peerScores.length).toFixed(2))
          }
        }
      }
    } catch (e) {
      logError('analytics_engine.goal_rank_error', { error: String(e) })
    }

    const savingsRateSelfClamped: number | null = (() => {
      if (mySavingsRate == null) return null
      const r = Math.max(0, mySavingsRate)
      return Number(r.toFixed(2))
    })()

    const savingsRatePeersClamped: number | null = (() => {
      if (peerAvgSavingsRate == null) return null
      const r = Math.max(0, peerAvgSavingsRate)
      return Number(r.toFixed(2))
    })()

    // peer_sample_size counts total users in this income bracket that
    // participate in comparisons: the current user + valid peer users.
    // This means as soon as there are 2 users in a bracket, peer
    // comparisons are considered "real" for wording on the client.
    const totalUsersInBracket = 1 + cohortPeers.length

    return {
      income_bracket: incomeBracket,
      savings_percentile: adjustedSavingsPercentile,
      spending_control_percentile: spendingControlPercentile,
      weekend_control_percentile: weekendControlPercentile,
      goal_achievement_percentile: goalAchievementPercentile,
      savings_score: savingsScore,
      spending_control_score: spendingScore,
      goal_achievement_score: goalAchievementScore,
      savings_rate_self: savingsRateSelfClamped,
      savings_rate_peers_avg: savingsRatePeersClamped,
      spent_monthly_self: totalSpentThis,
      spent_monthly_peers_avg: peerAvgSpentMonthly,
      saved_monthly_self: monthlySavingsFlow,
      saved_monthly_peers_avg: peerAvgSavedMonthly,
      overspend_category_key: overspend ? overspend.key : null,
      overspend_category_label: overspend ? overspend.label : null,
      overspend_category_short_label: overspend ? overspend.shortLabel : null,
      overspend_category_delta_ratio: overspendDeltaRatio,
      peer_sample_size: totalUsersInBracket
    }
  } catch (e) {
    logError('analytics_engine.rankings_error', { error: String(e) })
    return buildSimulatedRankingsFromTxns(monthTxns, prevTxns)
  }
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const body = await req.json().catch(() => ({}))
    const currencyResolution = await resolveMainCurrencyCode(supabase, userId, {
      headerCurrency: req.headers.get('x-main-currency'),
      bodyCurrency: (body as any).currencyCode,
    })
    const currencyCode = currencyResolution.currency
    const action = (body as any).action
    if (action === 'mark_deep_read') {
      const insightKey = String((body as any).insight_key || '').trim()
      if (!insightKey) {
        return json({ ok: false, error: 'missing insight_key' }, 400)
      }
      try {
        const { error: upsertError } = await supabase
          .from('analytics_deep_reads')
          .upsert({ user_id: userId, insight_id: insightKey, read_at: new Date().toISOString() }, { onConflict: 'user_id,insight_id' })
        if (upsertError) {
          logError('analytics_engine.mark_deep_read_error', { userId, error: upsertError.message })
          return json({ ok: true, note: 'persist skipped' })
        }
        log('analytics_engine.mark_deep_read', { userId, insightKey })
        return json({ ok: true })
      } catch (e) {
        // If the table is not present yet, just return ok so the client isn't blocked.
        logError('analytics_engine.mark_deep_read_error', { userId, error: String(e) })
        return json({ ok: true, note: 'persist skipped' })
      }
    }
    const monthsBackRaw = (body as any).months_back
    const referenceMonthRaw = (body as any).reference_month

    const now = new Date()
    const yyyy = now.getUTCFullYear()
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
    const fallbackMonth = `${yyyy}-${mm}`

    const month = (typeof referenceMonthRaw === 'string' && referenceMonthRaw.trim().length > 0)
      ? referenceMonthRaw.trim()
      : fallbackMonth

    const monthsBack = Number.isFinite(Number(monthsBackRaw))
      ? Math.max(1, Math.min(24, Number(monthsBackRaw)))
      : 6

    const { startISO, endISO, prevStartISO, prevEndISO } = monthBoundaries(month)

    // Current month txns
    const { data: monthRows, error: monthError } = await supabase
      .from('wallet_transactions')
      .select('wallet_id, amount, reporting_amount, reporting_currency, category, date')
      .eq('user_id', userId)
      .gte('date', startISO)
      .lte('date', endISO)

    if (monthError) {
      logError('analytics_engine.txn_error', { userId, error: monthError.message })
      return json({ ok: false, error: 'Failed to load transactions' }, 500)
    }

    const monthTxns = await normalizeTxnRowsForMainCurrency(
      supabase,
      userId,
      currencyCode,
      (monthRows || []) as Array<Record<string, unknown>>,
      'current_period',
    )

    // Previous month txns for comparison
    const { data: prevRows, error: prevError } = await supabase
      .from('wallet_transactions')
      .select('wallet_id, amount, reporting_amount, reporting_currency, category, date')
      .eq('user_id', userId)
      .gte('date', prevStartISO)
      .lte('date', prevEndISO)

    if (prevError) {
      logError('analytics_engine.prev_txn_error', { userId, error: prevError.message })
    }

    const prevTxns = await normalizeTxnRowsForMainCurrency(
      supabase,
      userId,
      currencyCode,
      (prevRows || []) as Array<Record<string, unknown>>,
      'previous_period',
    )

    let quickStats = buildQuickStatsFromServer(monthTxns, prevTxns)
    const rankings = await buildRankings(supabase, userId, month, monthTxns, prevTxns, monthsBack)

    // Fill AI SCORE quick stat using the self scores from rankings so it
    // reflects a fair combination of savings consistency, spending control,
    // and (when available) goal achievement.
    const savingsEff = ((): number | null => {
      if (typeof rankings.savings_score === 'number') return rankings.savings_score
      if (typeof rankings.savings_percentile === 'number') return Number((rankings.savings_percentile * 10).toFixed(1))
      return null
    })()

    const spendingEff = ((): number | null => {
      if (typeof rankings.spending_control_score === 'number') return rankings.spending_control_score
      if (typeof rankings.spending_control_percentile === 'number') return Number((rankings.spending_control_percentile * 10).toFixed(1))
      return null
    })()

    const goalEff = ((): number | null => {
      if (typeof rankings.goal_achievement_score === 'number') return rankings.goal_achievement_score
      if (typeof rankings.goal_achievement_percentile === 'number') return Number((rankings.goal_achievement_percentile * 10).toFixed(1))
      return null
    })()

    const hasAny = savingsEff != null || spendingEff != null || goalEff != null
    const aiScoreValue = hasAny ? computeAiScoreFromComponents(savingsEff, spendingEff, goalEff) : null

    if (aiScoreValue != null) {
      const aiLabel = 'AI SCORE'
      const aiText = `${aiScoreValue.toFixed(1)}/10`
      const aiChange = 'Based on your saving, spending, and goals'
      const aiIsPositive = aiScoreValue >= 7

      quickStats = quickStats.map((stat) =>
        stat.label === aiLabel
          ? { ...stat, value: aiText, change: aiChange, is_positive: aiIsPositive }
          : stat
      )
    }

    const understanding = buildUnderstanding(monthTxns, prevTxns, rankings)
    const deepInsights = await buildDeepInsightsDynamic(supabase, userId, monthTxns, prevTxns, rankings)
    const behaviorPattern = buildStaticBehaviorPattern()
    const smartRecommendations = buildStaticSmartRecommendations()
    const motivator = buildStaticMotivator()

    const responseBody = {
      ok: true,
      quick_stats: quickStats,
      understanding,
      deep_insights: deepInsights,
      behavior_pattern: behaviorPattern,
      smart_recommendations: smartRecommendations,
      motivator,
      rankings,
      meta: {
        generated_at: new Date().toISOString(),
        months_analyzed: monthsBack,
        reference_month: month
      }
    }

    log('analytics_engine.generated', {
      userId,
      month,
      monthsBack,
      txn_count: monthTxns.length,
      prev_txn_count: prevTxns.length
    })

    return json(responseBody, 200)
  } catch (e) {
    logError('analytics_engine.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})
