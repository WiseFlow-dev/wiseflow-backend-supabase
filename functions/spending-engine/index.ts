import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  normalizeTransactionsToMainCurrency,
  resolveMainCurrencyCode,
} from '../_shared/currencyReporting.ts'

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[spending-engine] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";
const GEMINI_KEYS: string[] = VERTEX_PROJECT ? ['vertex_sa'] : [];
const GEMINI_API_KEY = VERTEX_PROJECT ? 'vertex_sa' : '';

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

async function fetchGeminiWithKeyFallback(model: string, body: Record<string, unknown>): Promise<Response | null> {
  const accessToken = await getAccessToken();
  const url = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${model}:generateContent`;
  const vertexBody = { ...body } as any;
  if (vertexBody.contents && Array.isArray(vertexBody.contents)) {
    vertexBody.contents = vertexBody.contents.map((c: any) => ({ ...c, role: c.role || 'user' }));
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(vertexBody)
    })
    if (res.ok) return res
  } catch (_e) { /* network error */ }
  return null
}

// ONE BRAIN Strategy B feature flag
const ONE_BRAIN_STRATEGY_B_ENABLED = (Deno.env.get('ONE_BRAIN_STRATEGY_B_ENABLED') || 'false').toLowerCase() === 'true'

// Log Strategy B flag state at startup for debugging
log('spending_engine.init', {
  strategy_b_enabled: ONE_BRAIN_STRATEGY_B_ENABLED,
  env_var_value: Deno.env.get('ONE_BRAIN_STRATEGY_B_ENABLED') || 'undefined'
})

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
  category_id?: string | null  // Phase 2: UUID reference to categories table
  date: string
  title?: string | null
  note?: string | null
}

type RawInsight = {
  id: string
  type: string
  title: string
  short: string
  // recommendation: string // REMOVED - not shown in UI
  metadata?: Record<string, any>  // For stable identifiers (categoryId, etc.)
  // Quick Win Action fields (optional; used for dialog reuse)
  quickWinLabel?: string
  quickWinActionType?: string
  quickWinPayload?: Record<string, any>
}

type UiChip = { label: string; value: string }
type UiAction = {
  kind: 'primary' | 'secondary'
  label: string
  action_type: string
  payload: Record<string, unknown>
}

type V2InsightCard = {
  id: string
  scope: 'monthly' | 'weekly'
  period_key: string
  insight_type: string
  insight_key: string
  badge: { label: string; tone: 'warn' | 'purple' | 'green' | 'cyan' }
  card: { title: string; subtitle: string }
  detail: { title: string; body: string; proof: UiChip[]; actions: UiAction[] }
  snooze: { days: number; scope: 'monthly' | 'weekly'; insight_type: string; insight_key: string }
  // Quick Win Action fields (for actionable insights)
  quickWinLabel?: string
  quickWinActionType?: string
  quickWinPayload?: Record<string, any>
}

type CandidateInsight = {
  insight_type: string
  insight_key: string
  score: number
  badge: { label: string; tone: 'warn' | 'purple' | 'green' | 'cyan' }
  cardTitle: string
  cardSubtitle: string
  body: string
  proof: UiChip[]
  actions: UiAction[]
  metadata?: Record<string, any>
}

async function normalizeTxnRowsForMainCurrency(
  supabase: any,
  userId: string,
  currencyCode: string,
  rows: Array<Record<string, unknown>>,
  logLabel: string,
): Promise<TxnRow[]> {
  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    currencyCode,
    rows,
  )

  log('spending_engine.currency_normalization_metrics', {
    userToken: getAnonymousUserToken(userId),
    label: logLabel,
    ...normalized.metrics,
  })

  return normalized.rows.map((row) => ({
    amount: Number(row.amount ?? 0),
    category: typeof row.category === 'string' ? row.category : null,
    category_id: typeof row.category_id === 'string' ? row.category_id : null,
    date: String(row.date ?? ''),
    title: typeof row.title === 'string' ? row.title : null,
    note: typeof row.note === 'string' ? row.note : null,
  }))
}

function monthBoundaries(monthKey: string) {
  const [yStr, mStr] = monthKey.split('-')
  const year = Number(yStr)
  const month = Number(mStr) - 1 // JS month index
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

function money(amount: number, locale: string = 'en-US'): string {
  const v = Math.round(Math.abs(amount))
  return v.toLocaleString(locale, { maximumFractionDigits: 0 })
}

function formatCents(cents: number, currencySymbol: string, locale: string = 'en-US'): string {
  const v = Math.round(Math.abs(cents) / 100)
  return `${currencySymbol} ${v.toLocaleString(locale, { maximumFractionDigits: 0 })}`
}

function formatMoney(amountDollars: number, currencySymbol: string, locale: string = 'en-US'): string {
  const v = Math.round(Math.abs(amountDollars))
  return `${currencySymbol} ${v.toLocaleString(locale, { maximumFractionDigits: 0 })}`
}

function getPreviousMonthKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)

  if (month === 1) {
    return `${year - 1}-12`
  } else {
    return `${year}-${String(month - 1).padStart(2, '0')}`
  }
}

function normalizeKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-]/g, '')
}

// Localization helper for insight strings
function getLocalizedStrings(locale: string) {
  const strings: Record<string, Record<string, string>> = {
    en: {
      velocity_higher: 'Spending is higher than last month',
      velocity_lower: 'Spending is lower than last month',
      velocity_higher_short: 'So far this month you\'ve spent about {pct}% more than last month (~{current} vs ~{prev}).',
      velocity_lower_short: 'So far this month you\'re about {pct}% below last month (~{current} vs ~{prev}).',
      velocity_higher_rec: 'Try to adjust your budgets for the highest categories so this month does not feel too tight. Even a small budget adjustment can free money for goals or debt.',
      velocity_lower_rec: 'You are using less than before. You could move part of this gap into savings or an extra debt payment.',
      weekend_spike: 'Weekend spending spike',
      weekend_spike_short: 'On average weekends cost around {weekend} versus ~{weekday} on weekdays.',
      weekend_spike_rec: 'Weekends are your most expensive days. Setting a weekend budget could free up money for savings or goals.',
      current_spending: 'Current spending',
      avg_per_day: 'Avg per day',
      vs_last_month: 'vs last month',
      projected_month_end: 'Projected month-end',
      weekend_avg: 'Weekend avg',
      weekday_avg: 'Weekday avg',
      factor: 'Factor',
      // Spike Day
      spike_day: 'Unusual spending spike',
      spike_day_short: 'You spent {amount} on {date}, roughly {factor}x your typical day this month.',
      spike_day_rec: 'Review that day\'s transactions. If it was one big planned payment, treat it as a special case. If it was many small spends, consider setting a budget to prevent similar days.',
      spike_amount: 'Spike amount',
      spike_date: 'Date',
      typical_day: 'Typical day',
      // Top Merchant
      top_merchant: '{merchant} was your top merchant',
      top_merchant_short: '{merchant}: {amount} across {count} purchases, about {pct}% of your spending.',
      top_merchant_rec: 'This place takes a noticeable share of your month. A budget or pause here could quickly free money for goals or debt.',
      merchant_name: 'Merchant',
      merchant_total: 'Total spent',
      merchant_count: 'Purchases',
      merchant_share: 'Share of spending',
      // Top Category
      top_category: '{category} was your top category',
      top_category_short: '{category}: {amount}, about {pct}% of your spending.',
      top_category_rec: 'This category takes a noticeable share of your month. A budget here could quickly free money for goals or debt.',
      category_total: 'Total spent',
      category_share: 'Share of spending',
      // Small Leaks
      small_leaks: 'Small purchases are adding up',
      small_leaks_short: 'You made {count} purchases under {threshold}, totaling {total} this month, about {pct}% of spending.',
      small_leaks_rec: 'These small spends add up over time. Skipping just a few each week could free up extra money for savings or a goal.',
      small_leaks_count: 'Small purchases',
      small_leaks_threshold: 'Threshold',
      small_leaks_total: 'Total small spends',
      small_leaks_share: 'Share of spending',
      // Subscriptions
      subscriptions: 'Recurring charges detected',
      subscriptions_short: 'Found {count} likely subscriptions totaling {total}, about {pct}% of your spending.',
      subscriptions_rec: 'Review your active subscriptions and cancel any you no longer use. Even removing one or two could free room for goals each month.',
      subscriptions_count: 'Subscriptions found',
      subscriptions_total: 'Total subscription cost',
      subscriptions_share: 'Share of spending',
      // Income Share
      income_share_high: 'Spending is high relative to income',
      income_share_moderate: 'Spending is moderate relative to income',
      income_share_low: 'Spending is low relative to income',
      income_share_high_short: 'You spent {spent} against {income} income this month ({pct}% of income).',
      income_share_moderate_short: 'You spent {spent} against {income} income this month ({pct}% of income).',
      income_share_low_short: 'You spent {spent} against {income} income this month ({pct}% of income).',
      income_share_high_rec: 'Your spending is taking most of your income. Consider trimming non-essential categories to build savings or pay down debt.',
      income_share_moderate_rec: 'You have a healthy balance. Consider allocating more to savings or goals if possible.',
      income_share_low_rec: 'Great job keeping spending low. Consider moving extra income into savings or investments.',
      total_income: 'Total income',
      total_spending: 'Total spending',
      income_ratio: 'Spending ratio',
      // Time of Day
      time_of_day: 'Peak spending time: {period}',
      time_of_day_short: 'Most of your spending happens during {period} ({pct}% of transactions).',
      time_of_day_rec: 'If you want to trim spending, focusing on this time window will have the biggest impact.',
      peak_period: 'Peak period',
      peak_amount: 'Amount in period',
      peak_transactions: 'Transactions',
      // Goal Contribution
      goal_contrib_up: 'You boosted goal contributions',
      goal_contrib_down: 'Goal contributions slowed down',
      goal_contrib_up_short: 'You moved {current} into goals, up from {prev} last month.',
      goal_contrib_down_short: 'You moved {current} into goals this month, down from {prev} last month.',
      goal_contrib_up_rec: 'Nice progress toward your goals. Keep this momentum going.',
      goal_contrib_down_rec: 'If goals are still a priority, consider adjusting budgets to free up more for contributions.',
      current_contrib: 'This month',
      previous_contrib: 'Last month',
      contrib_change: 'Change',
      // Category Change
      category_jump: '{category} spending jumped',
      category_drop: '{category} spending dropped',
      category_jump_short: '{category} is {current} this month ({pct}% of spending), up from {prev} last month.',
      category_drop_short: '{category} dropped from {prev} last month to {current} this month.',
      category_jump_rec: 'If this jump was not intentional, setting a budget on this category could free money for goals or debt.',
      category_drop_rec: 'Nice progress. If this feels comfortable, you could redirect part of this saved amount into goals or extra debt payments.',
      category_name: 'Category',
      category_current: 'This month',
      category_previous: 'Last month',
      category_change: 'Change',
      // Time period names
      period_morning: 'morning',
      period_afternoon: 'afternoon',
      period_evening: 'evening',
      period_late_night: 'late night',
      // Evidence row labels
      top_transaction: 'Top transaction',
      largest_purchase: 'Largest purchase',
      biggest_weekend_day: 'Biggest weekend day',
      example_transaction: 'Example',
      generic_transaction: 'Transaction',
      largest_expense: 'Largest expense',
      top_subscription: 'Top subscription',
      largest_goal_transfer: 'Largest goal transfer',
      top_category_transaction: 'Top in category',
      frequent_merchant: 'Frequent merchant'
    },
    es: {
      velocity_higher: 'El gasto es mayor que el mes pasado',
      velocity_lower: 'El gasto es menor que el mes pasado',
      velocity_higher_short: 'Este mes has gastado aproximadamente {pct}% más que el mes pasado (~{current} vs ~{prev}).',
      velocity_lower_short: 'Este mes estás aproximadamente {pct}% por debajo del mes pasado (~{current} vs ~{prev}).',
      velocity_higher_rec: 'Intenta ajustar tus presupuestos para las categorías más altas para que este mes no se sienta muy ajustado. Incluso un pequeño ajuste de presupuesto puede liberar dinero para metas o deudas.',
      velocity_lower_rec: 'Estás usando menos que antes. Podrías mover parte de esta diferencia a ahorros o un pago extra de deuda.',
      weekend_spike: 'Pico de gasto en fin de semana',
      weekend_spike_short: 'En promedio los fines de semana cuestan alrededor de {weekend} versus ~{weekday} entre semana.',
      weekend_spike_rec: 'Los fines de semana son tus días más caros. Establecer un presupuesto de fin de semana podría liberar dinero para ahorros o metas.',
      current_spending: 'Gasto actual',
      avg_per_day: 'Promedio por día',
      vs_last_month: 'vs mes pasado',
      projected_month_end: 'Proyección fin de mes',
      weekend_avg: 'Promedio fin de semana',
      weekday_avg: 'Promedio entre semana',
      factor: 'Factor',
      // Spike Day
      spike_day: 'Pico de gasto inusual',
      spike_day_short: 'Gastaste {amount} el {date}, aproximadamente {factor}x tu día típico este mes.',
      spike_day_rec: 'Revisa las transacciones de ese día. Si fue un pago grande planificado, trátalo como un caso especial. Si fueron muchos gastos pequeños, considera establecer un presupuesto para prevenir días similares.',
      spike_amount: 'Monto del pico',
      spike_date: 'Fecha',
      typical_day: 'Día típico',
      // Top Merchant
      top_merchant: '{merchant} fue tu comercio principal',
      top_merchant_short: '{merchant}: {amount} en {count} compras, aproximadamente {pct}% de tu gasto.',
      top_merchant_rec: 'Este lugar toma una parte notable de tu mes. Un presupuesto o pausa aquí podría liberar rápidamente dinero para metas o deudas.',
      merchant_name: 'Comercio',
      merchant_total: 'Total gastado',
      merchant_count: 'Compras',
      merchant_share: 'Porcentaje del gasto',
      // Top Category
      top_category: '{category} fue tu categoría principal',
      top_category_short: '{category}: {amount}, aproximadamente {pct}% de tu gasto.',
      top_category_rec: 'Esta categoría toma una parte notable de tu mes. Un presupuesto aquí podría liberar rápidamente dinero para metas o deudas.',
      category_total: 'Total gastado',
      category_share: 'Porcentaje del gasto',
      // Small Leaks
      small_leaks: 'Los gastos pequeños se están acumulando',
      small_leaks_short: 'Hiciste {count} compras por debajo de {threshold}, totalizando {total} este mes, aproximadamente {pct}% del gasto.',
      small_leaks_rec: 'Estos pequeños gastos se acumulan con el tiempo. Omitir solo algunos cada semana podría liberar dinero extra para ahorros o una meta.',
      small_leaks_count: 'Compras pequeñas',
      small_leaks_threshold: 'Umbral',
      small_leaks_total: 'Total gastos pequeños',
      small_leaks_share: 'Porcentaje del gasto',
      // Subscriptions
      subscriptions: 'Cargos recurrentes detectados',
      subscriptions_short: 'Se encontraron {count} posibles suscripciones que totalizan {total}, aproximadamente {pct}% de tu gasto.',
      subscriptions_rec: 'Revisa tus suscripciones activas y cancela las que ya no uses. Incluso eliminar una o dos podría liberar espacio para metas cada mes.',
      subscriptions_count: 'Suscripciones encontradas',
      subscriptions_total: 'Costo total de suscripciones',
      subscriptions_share: 'Porcentaje del gasto',
      // Income Share
      income_share_high: 'El gasto es alto en relación con los ingresos',
      income_share_moderate: 'El gasto es moderado en relación con los ingresos',
      income_share_low: 'El gasto es bajo en relación con los ingresos',
      income_share_high_short: 'Gastaste {spent} contra {income} de ingresos este mes ({pct}% de los ingresos).',
      income_share_moderate_short: 'Gastaste {spent} contra {income} de ingresos este mes ({pct}% de los ingresos).',
      income_share_low_short: 'Gastaste {spent} contra {income} de ingresos este mes ({pct}% de los ingresos).',
      income_share_high_rec: 'Tu gasto está tomando la mayor parte de tus ingresos. Considera recortar categorías no esenciales para construir ahorros o pagar deudas.',
      income_share_moderate_rec: 'Tienes un equilibrio saludable. Considera asignar más a ahorros o metas si es posible.',
      income_share_low_rec: 'Buen trabajo manteniendo el gasto bajo. Considera mover ingresos extra a ahorros o inversiones.',
      total_income: 'Ingresos totales',
      total_spending: 'Gasto total',
      income_ratio: 'Ratio de gasto',
      // Time of Day
      time_of_day: 'Hora pico de gasto: {period}',
      time_of_day_short: 'La mayor parte de tu gasto ocurre durante {period} ({pct}% de transacciones).',
      time_of_day_rec: 'Si quieres reducir el gasto, enfocarte en esta ventana de tiempo tendrá el mayor impacto.',
      peak_period: 'Período pico',
      peak_amount: 'Monto en período',
      peak_transactions: 'Transacciones',
      // Goal Contribution
      goal_contrib_up: 'Aumentaste las contribuciones a metas',
      goal_contrib_down: 'Las contribuciones a metas disminuyeron',
      goal_contrib_up_short: 'Moviste {current} a metas, más que {prev} el mes pasado.',
      goal_contrib_down_short: 'Moviste {current} a metas este mes, menos que {prev} el mes pasado.',
      goal_contrib_up_rec: 'Buen progreso hacia tus metas. Mantén este impulso.',
      goal_contrib_down_rec: 'Si las metas siguen siendo una prioridad, considera ajustar presupuestos para liberar más para contribuciones.',
      current_contrib: 'Este mes',
      previous_contrib: 'Mes pasado',
      contrib_change: 'Cambio',
      // Category Change
      category_jump: 'El gasto en {category} aumentó',
      category_drop: 'El gasto en {category} disminuyó',
      category_jump_short: '{category} es {current} este mes ({pct}% del gasto), más que {prev} el mes pasado.',
      category_drop_short: '{category} bajó de {prev} el mes pasado a {current} este mes.',
      category_jump_rec: 'Si este aumento no fue intencional, establecer un presupuesto en esta categoría podría liberar dinero para metas o deudas.',
      category_drop_rec: 'Buen progreso. Si esto se siente cómodo, podrías redirigir parte de esta cantidad ahorrada a metas o pagos extra de deudas.',
      category_name: 'Categoría',
      category_current: 'Este mes',
      category_previous: 'Mes pasado',
      category_change: 'Cambio',
      // Time period names
      period_morning: 'mañana',
      period_afternoon: 'tarde',
      period_evening: 'noche',
      period_late_night: 'madrugada',
      // Evidence row labels
      top_transaction: 'Transacción principal',
      largest_purchase: 'Compra más grande',
      biggest_weekend_day: 'Día de fin de semana más caro',
      example_transaction: 'Ejemplo',
      generic_transaction: 'Transacción',
      largest_expense: 'Mayor gasto',
      top_subscription: 'Suscripción principal',
      largest_goal_transfer: 'Mayor transferencia a meta',
      top_category_transaction: 'Principal en categoría',
      frequent_merchant: 'Comercio frecuente'
    },
    ru: {
      velocity_higher: 'Расходы выше, чем в прошлом месяце',
      velocity_lower: 'Расходы ниже, чем в прошлом месяце',
      velocity_higher_short: 'В этом месяце вы потратили примерно на {pct}% больше, чем в прошлом месяце (~{current} против ~{prev}).',
      velocity_lower_short: 'В этом месяце вы примерно на {pct}% ниже прошлого месяца (~{current} против ~{prev}).',
      velocity_higher_rec: 'Попробуйте скорректировать бюджеты для самых больших категорий, чтобы этот месяц не был слишком напряженным. Даже небольшая корректировка бюджета может освободить деньги для целей или долгов.',
      velocity_lower_rec: 'Вы тратите меньше, чем раньше. Вы можете направить часть этой разницы на сбережения или дополнительный платеж по долгу.',
      weekend_spike: 'Всплеск расходов в выходные',
      weekend_spike_short: 'В среднем выходные обходятся примерно в {weekend} против ~{weekday} в будни.',
      weekend_spike_rec: 'Выходные — ваши самые дорогие дни. Установка бюджета на выходные может освободить деньги для сбережений или целей.',
      current_spending: 'Текущие расходы',
      avg_per_day: 'Среднее в день',
      vs_last_month: 'против прошлого месяца',
      projected_month_end: 'Прогноз на конец месяца',
      weekend_avg: 'Среднее в выходные',
      weekday_avg: 'Среднее в будни',
      factor: 'Фактор',
      // Spike Day
      spike_day: 'Необычный всплеск расходов',
      spike_day_short: 'Вы потратили {amount} {date}, примерно в {factor}x раз больше вашего обычного дня в этом месяце.',
      spike_day_rec: 'Просмотрите транзакции за этот день. Если это был один большой запланированный платеж, рассматривайте его как особый случай. Если это было много мелких трат, рассмотрите установку бюджета для предотвращения подобных дней.',
      spike_amount: 'Сумма всплеска',
      spike_date: 'Дата',
      typical_day: 'Обычный день',
      // Top Merchant
      top_merchant: '{merchant} был вашим главным продавцом',
      top_merchant_short: '{merchant}: {amount} за {count} покупок, около {pct}% ваших расходов.',
      top_merchant_rec: 'Это место занимает заметную долю вашего месяца. Бюджет или пауза здесь могут быстро освободить деньги для целей или долгов.',
      merchant_name: 'Продавец',
      merchant_total: 'Всего потрачено',
      merchant_count: 'Покупки',
      merchant_share: 'Доля расходов',
      // Top Category
      top_category: '{category} была вашей главной категорией',
      top_category_short: '{category}: {amount}, около {pct}% ваших расходов.',
      top_category_rec: 'Эта категория занимает заметную долю вашего месяца. Бюджет здесь может быстро освободить деньги для целей или долгов.',
      category_total: 'Всего потрачено',
      category_share: 'Доля расходов',
      // Small Leaks
      small_leaks: 'Мелкие покупки накапливаются',
      small_leaks_short: 'Вы совершили {count} покупок на сумму менее {threshold}, всего {total} в этом месяце, около {pct}% расходов.',
      small_leaks_rec: 'Эти мелкие траты накапливаются со временем. Пропуск всего нескольких каждую неделю может освободить дополнительные деньги для сбережений или цели.',
      small_leaks_count: 'Мелкие покупки',
      small_leaks_threshold: 'Порог',
      small_leaks_total: 'Всего мелких трат',
      small_leaks_share: 'Доля расходов',
      // Subscriptions
      subscriptions: 'Обнаружены регулярные платежи',
      subscriptions_short: 'Найдено {count} возможных подписок на общую сумму {total}, около {pct}% ваших расходов.',
      subscriptions_rec: 'Просмотрите свои активные подписки и отмените те, которые больше не используете. Даже удаление одной или двух может освободить место для целей каждый месяц.',
      subscriptions_count: 'Найдено подписок',
      subscriptions_total: 'Общая стоимость подписок',
      subscriptions_share: 'Доля расходов',
      // Income Share
      income_share_high: 'Расходы высоки относительно дохода',
      income_share_moderate: 'Расходы умеренны относительно дохода',
      income_share_low: 'Расходы низки относительно дохода',
      income_share_high_short: 'Вы потратили {spent} при доходе {income} в этом месяце ({pct}% дохода).',
      income_share_moderate_short: 'Вы потратили {spent} при доходе {income} в этом месяце ({pct}% дохода).',
      income_share_low_short: 'Вы потратили {spent} при доходе {income} в этом месяце ({pct}% дохода).',
      income_share_high_rec: 'Ваши расходы забирают большую часть дохода. Рассмотрите сокращение несущественных категорий для накопления сбережений или погашения долгов.',
      income_share_moderate_rec: 'У вас здоровый баланс. Рассмотрите выделение большего на сбережения или цели, если возможно.',
      income_share_low_rec: 'Отличная работа по сдерживанию расходов. Рассмотрите перевод дополнительного дохода в сбережения или инвестиции.',
      total_income: 'Общий доход',
      total_spending: 'Общие расходы',
      income_ratio: 'Коэффициент расходов',
      // Time of Day
      time_of_day: 'Пиковое время расходов: {period}',
      time_of_day_short: 'Большая часть ваших расходов происходит в {period} ({pct}% транзакций).',
      time_of_day_rec: 'Если вы хотите сократить расходы, фокус на этом временном окне будет иметь наибольшее влияние.',
      peak_period: 'Пиковый период',
      peak_amount: 'Сумма в периоде',
      peak_transactions: 'Транзакции',
      // Goal Contribution
      goal_contrib_up: 'Вы увеличили вклады в цели',
      goal_contrib_down: 'Вклады в цели замедлились',
      goal_contrib_up_short: 'Вы перевели {current} в цели, больше чем {prev} в прошлом месяце.',
      goal_contrib_down_short: 'Вы перевели {current} в цели в этом месяце, меньше чем {prev} в прошлом месяце.',
      goal_contrib_up_rec: 'Хороший прогресс к вашим целям. Продолжайте в том же духе.',
      goal_contrib_down_rec: 'Если цели все еще в приоритете, рассмотрите корректировку бюджетов для освобождения большего для вкладов.',
      current_contrib: 'Этот месяц',
      previous_contrib: 'Прошлый месяц',
      contrib_change: 'Изменение',
      // Category Change
      category_jump: 'Расходы на {category} выросли',
      category_drop: 'Расходы на {category} упали',
      category_jump_short: '{category} составляет {current} в этом месяце ({pct}% расходов), больше чем {prev} в прошлом месяце.',
      category_drop_short: '{category} упала с {prev} в прошлом месяце до {current} в этом месяце.',
      category_jump_rec: 'Если этот рост не был намеренным, установка бюджета на эту категорию может освободить деньги для целей или долгов.',
      category_drop_rec: 'Хороший прогресс. Если это комфортно, вы можете перенаправить часть этой сэкономленной суммы в цели или дополнительные платежи по долгам.',
      category_name: 'Категория',
      category_current: 'Этот месяц',
      category_previous: 'Прошлый месяц',
      category_change: 'Изменение',
      // Time period names
      period_morning: 'утро',
      period_afternoon: 'день',
      period_evening: 'вечер',
      period_late_night: 'ночь',
      // Evidence row labels
      top_transaction: 'Главная транзакция',
      largest_purchase: 'Крупнейшая покупка',
      biggest_weekend_day: 'Самый дорогой день выходных',
      example_transaction: 'Пример',
      generic_transaction: 'Транзакция',
      largest_expense: 'Крупнейший расход',
      top_subscription: 'Главная подписка',
      largest_goal_transfer: 'Крупнейший перевод в цель',
      top_category_transaction: 'Главная в категории',
      frequent_merchant: 'Частый продавец'
    },
    fr: {
      velocity_higher: 'Les dépenses sont plus élevées que le mois dernier',
      velocity_lower: 'Les dépenses sont inférieures au mois dernier',
      velocity_higher_short: 'Ce mois-ci, vous avez dépensé environ {pct}% de plus que le mois dernier (~{current} vs ~{prev}).',
      velocity_lower_short: 'Ce mois-ci, vous êtes environ {pct}% en dessous du mois dernier (~{current} vs ~{prev}).',
      velocity_higher_rec: 'Essayez d\'ajuster vos budgets pour les catégories les plus élevées pour que ce mois ne soit pas trop serré. Même un petit ajustement de budget peut libérer de l\'argent pour les objectifs ou les dettes.',
      velocity_lower_rec: 'Vous utilisez moins qu\'avant. Vous pourriez déplacer une partie de cet écart vers l\'épargne ou un paiement de dette supplémentaire.',
      weekend_spike: 'Pic de dépenses le week-end',
      weekend_spike_short: 'En moyenne, les week-ends coûtent environ {weekend} contre ~{weekday} en semaine.',
      weekend_spike_rec: 'Les week-ends sont vos jours les plus chers. Fixer un budget de week-end pourrait libérer de l\'argent pour l\'épargne ou les objectifs.',
      current_spending: 'Dépenses actuelles',
      avg_per_day: 'Moyenne par jour',
      vs_last_month: 'vs mois dernier',
      projected_month_end: 'Projection fin de mois',
      weekend_avg: 'Moyenne week-end',
      weekday_avg: 'Moyenne semaine',
      factor: 'Facteur',
      // Spike Day
      spike_day: 'Pic de dépenses inhabituel',
      spike_day_short: 'Vous avez dépensé {amount} le {date}, environ {factor}x votre jour typique ce mois-ci.',
      spike_day_rec: 'Examinez les transactions de ce jour. Si c\'était un gros paiement prévu, traitez-le comme un cas spécial. Si c\'étaient de nombreuses petites dépenses, envisagez de fixer un budget pour éviter des jours similaires.',
      spike_amount: 'Montant du pic',
      spike_date: 'Date',
      typical_day: 'Jour typique',
      // Top Merchant
      top_merchant: '{merchant} était votre principal commerçant',
      top_merchant_short: '{merchant}: {amount} sur {count} achats, environ {pct}% de vos dépenses.',
      top_merchant_rec: 'Cet endroit prend une part notable de votre mois. Un budget ou une pause ici pourrait rapidement libérer de l\'argent pour les objectifs ou les dettes.',
      merchant_name: 'Commerçant',
      merchant_total: 'Total dépensé',
      merchant_count: 'Achats',
      merchant_share: 'Part des dépenses',
      // Top Category
      top_category: '{category} était votre catégorie principale',
      top_category_short: '{category}: {amount}, environ {pct}% de vos dépenses.',
      top_category_rec: 'Cette catégorie prend une part notable de votre mois. Un budget ici pourrait rapidement libérer de l\'argent pour les objectifs ou les dettes.',
      category_total: 'Total dépensé',
      category_share: 'Part des dépenses',
      // Small Leaks
      small_leaks: 'Les petits achats s\'accumulent',
      small_leaks_short: 'Vous avez effectué {count} achats de moins de {threshold}, totalisant {total} ce mois-ci, environ {pct}% des dépenses.',
      small_leaks_rec: 'Ces petites dépenses s\'accumulent avec le temps. Sauter quelques-unes chaque semaine pourrait libérer de l\'argent supplémentaire pour l\'épargne ou un objectif.',
      small_leaks_count: 'Petits achats',
      small_leaks_threshold: 'Seuil',
      small_leaks_total: 'Total petites dépenses',
      small_leaks_share: 'Part des dépenses',
      // Subscriptions
      subscriptions: 'Frais récurrents détectés',
      subscriptions_short: 'Trouvé {count} abonnements probables totalisant {total}, environ {pct}% de vos dépenses.',
      subscriptions_rec: 'Examinez vos abonnements actifs et annulez ceux que vous n\'utilisez plus. Même en supprimer un ou deux pourrait libérer de la place pour les objectifs chaque mois.',
      subscriptions_count: 'Abonnements trouvés',
      subscriptions_total: 'Coût total des abonnements',
      subscriptions_share: 'Part des dépenses',
      // Income Share
      income_share_high: 'Les dépenses sont élevées par rapport aux revenus',
      income_share_moderate: 'Les dépenses sont modérées par rapport aux revenus',
      income_share_low: 'Les dépenses sont faibles par rapport aux revenus',
      income_share_high_short: 'Vous avez dépensé {spent} contre {income} de revenus ce mois-ci ({pct}% des revenus).',
      income_share_moderate_short: 'Vous avez dépensé {spent} contre {income} de revenus ce mois-ci ({pct}% des revenus).',
      income_share_low_short: 'Vous avez dépensé {spent} contre {income} de revenus ce mois-ci ({pct}% des revenus).',
      income_share_high_rec: 'Vos dépenses prennent la plupart de vos revenus. Envisagez de réduire les catégories non essentielles pour constituer une épargne ou rembourser des dettes.',
      income_share_moderate_rec: 'Vous avez un équilibre sain. Envisagez d\'allouer plus à l\'épargne ou aux objectifs si possible.',
      income_share_low_rec: 'Excellent travail pour maintenir les dépenses basses. Envisagez de déplacer les revenus supplémentaires vers l\'épargne ou les investissements.',
      total_income: 'Revenu total',
      total_spending: 'Dépenses totales',
      income_ratio: 'Ratio de dépenses',
      // Time of Day
      time_of_day: 'Heure de pointe des dépenses: {period}',
      time_of_day_short: 'La plupart de vos dépenses se produisent pendant {period} ({pct}% des transactions).',
      time_of_day_rec: 'Si vous voulez réduire les dépenses, vous concentrer sur cette fenêtre horaire aura le plus grand impact.',
      peak_period: 'Période de pointe',
      peak_amount: 'Montant dans la période',
      peak_transactions: 'Transactions',
      // Goal Contribution
      goal_contrib_up: 'Vous avez augmenté les contributions aux objectifs',
      goal_contrib_down: 'Les contributions aux objectifs ont ralenti',
      goal_contrib_up_short: 'Vous avez déplacé {current} vers les objectifs, plus que {prev} le mois dernier.',
      goal_contrib_down_short: 'Vous avez déplacé {current} vers les objectifs ce mois-ci, moins que {prev} le mois dernier.',
      goal_contrib_up_rec: 'Beau progrès vers vos objectifs. Continuez sur cette lancée.',
      goal_contrib_down_rec: 'Si les objectifs sont toujours une priorité, envisagez d\'ajuster les budgets pour libérer plus pour les contributions.',
      current_contrib: 'Ce mois-ci',
      previous_contrib: 'Mois dernier',
      contrib_change: 'Changement',
      // Category Change
      category_jump: 'Les dépenses {category} ont augmenté',
      category_drop: 'Les dépenses {category} ont diminué',
      category_jump_short: '{category} est {current} ce mois-ci ({pct}% des dépenses), plus que {prev} le mois dernier.',
      category_drop_short: '{category} est passé de {prev} le mois dernier à {current} ce mois-ci.',
      category_jump_rec: 'Si cette augmentation n\'était pas intentionnelle, fixer un budget sur cette catégorie pourrait libérer de l\'argent pour les objectifs ou les dettes.',
      category_drop_rec: 'Beau progrès. Si cela vous convient, vous pourriez rediriger une partie de ce montant économisé vers les objectifs ou des paiements de dettes supplémentaires.',
      category_name: 'Catégorie',
      category_current: 'Ce mois-ci',
      category_previous: 'Mois dernier',
      category_change: 'Changement',
      // Time period names
      period_morning: 'matin',
      period_afternoon: 'après-midi',
      period_evening: 'soir',
      period_late_night: 'nuit',
      // Evidence row labels
      top_transaction: 'Transaction principale',
      largest_purchase: 'Plus gros achat',
      biggest_weekend_day: 'Jour de week-end le plus cher',
      example_transaction: 'Exemple',
      generic_transaction: 'Transaction',
      largest_expense: 'Plus grosse dépense',
      top_subscription: 'Abonnement principal',
      largest_goal_transfer: 'Plus gros transfert vers objectif',
      top_category_transaction: 'Principal dans catégorie',
      frequent_merchant: 'Commerçant fréquent'
    },
    de: {
      velocity_higher: 'Ausgaben sind höher als im letzten Monat',
      velocity_lower: 'Ausgaben sind niedriger als im letzten Monat',
      velocity_higher_short: 'Diesen Monat haben Sie etwa {pct}% mehr ausgegeben als im letzten Monat (~{current} vs ~{prev}).',
      velocity_lower_short: 'Diesen Monat liegen Sie etwa {pct}% unter dem letzten Monat (~{current} vs ~{prev}).',
      velocity_higher_rec: 'Versuchen Sie, Ihre Budgets für die höchsten Kategorien anzupassen, damit dieser Monat nicht zu eng wird. Selbst eine kleine Budgetanpassung kann Geld für Ziele oder Schulden freimachen.',
      velocity_lower_rec: 'Sie verwenden weniger als zuvor. Sie könnten einen Teil dieser Lücke in Ersparnisse oder eine zusätzliche Schuldenzahlung verschieben.',
      weekend_spike: 'Wochenend-Ausgabenspitze',
      weekend_spike_short: 'Im Durchschnitt kosten Wochenenden etwa {weekend} gegenüber ~{weekday} an Wochentagen.',
      weekend_spike_rec: 'Wochenenden sind Ihre teuersten Tage. Ein Wochenendbudget könnte Geld für Ersparnisse oder Ziele freimachen.',
      current_spending: 'Aktuelle Ausgaben',
      avg_per_day: 'Durchschnitt pro Tag',
      vs_last_month: 'vs letzter Monat',
      projected_month_end: 'Prognose Monatsende',
      weekend_avg: 'Wochenend-Durchschnitt',
      weekday_avg: 'Wochentags-Durchschnitt',
      factor: 'Faktor',
      // Spike Day
      spike_day: 'Ungewöhnliche Ausgabenspitze',
      spike_day_short: 'Sie haben am {date} {amount} ausgegeben, etwa {factor}x Ihren typischen Tag in diesem Monat.',
      spike_day_rec: 'Überprüfen Sie die Transaktionen dieses Tages. Wenn es eine große geplante Zahlung war, behandeln Sie es als Sonderfall. Wenn es viele kleine Ausgaben waren, erwägen Sie ein Budget, um ähnliche Tage zu verhindern.',
      spike_amount: 'Spitzenbetrag',
      spike_date: 'Datum',
      typical_day: 'Typischer Tag',
      // Top Merchant
      top_merchant: '{merchant} war Ihr Haupthändler',
      top_merchant_short: '{merchant}: {amount} über {count} Käufe, etwa {pct}% Ihrer Ausgaben.',
      top_merchant_rec: 'Dieser Ort nimmt einen bemerkenswerten Anteil Ihres Monats ein. Ein Budget oder eine Pause hier könnte schnell Geld für Ziele oder Schulden freimachen.',
      merchant_name: 'Händler',
      merchant_total: 'Gesamt ausgegeben',
      merchant_count: 'Käufe',
      merchant_share: 'Anteil der Ausgaben',
      // Top Category
      top_category: '{category} war Ihre Hauptkategorie',
      top_category_short: '{category}: {amount}, etwa {pct}% Ihrer Ausgaben.',
      top_category_rec: 'Diese Kategorie nimmt einen bemerkenswerten Anteil Ihres Monats ein. Ein Budget hier könnte schnell Geld für Ziele oder Schulden freimachen.',
      category_total: 'Gesamt ausgegeben',
      category_share: 'Anteil der Ausgaben',
      // Small Leaks
      small_leaks: 'Kleine Käufe summieren sich',
      small_leaks_short: 'Sie haben {count} Käufe unter {threshold} getätigt, insgesamt {total} in diesem Monat, etwa {pct}% der Ausgaben.',
      small_leaks_rec: 'Diese kleinen Ausgaben summieren sich im Laufe der Zeit. Nur ein paar pro Woche zu überspringen könnte zusätzliches Geld für Ersparnisse oder ein Ziel freimachen.',
      small_leaks_count: 'Kleine Käufe',
      small_leaks_threshold: 'Schwelle',
      small_leaks_total: 'Gesamt kleine Ausgaben',
      small_leaks_share: 'Anteil der Ausgaben',
      // Subscriptions
      subscriptions: 'Wiederkehrende Gebühren erkannt',
      subscriptions_short: '{count} wahrscheinliche Abonnements gefunden, insgesamt {total}, etwa {pct}% Ihrer Ausgaben.',
      subscriptions_rec: 'Überprüfen Sie Ihre aktiven Abonnements und kündigen Sie diejenigen, die Sie nicht mehr nutzen. Selbst das Entfernen von ein oder zwei könnte jeden Monat Raum für Ziele schaffen.',
      subscriptions_count: 'Gefundene Abonnements',
      subscriptions_total: 'Gesamtkosten Abonnements',
      subscriptions_share: 'Anteil der Ausgaben',
      // Income Share
      income_share_high: 'Ausgaben sind hoch im Verhältnis zum Einkommen',
      income_share_moderate: 'Ausgaben sind moderat im Verhältnis zum Einkommen',
      income_share_low: 'Ausgaben sind niedrig im Verhältnis zum Einkommen',
      income_share_high_short: 'Sie haben {spent} bei {income} Einkommen in diesem Monat ausgegeben ({pct}% des Einkommens).',
      income_share_moderate_short: 'Sie haben {spent} bei {income} Einkommen in diesem Monat ausgegeben ({pct}% des Einkommens).',
      income_share_low_short: 'Sie haben {spent} bei {income} Einkommen in diesem Monat ausgegeben ({pct}% des Einkommens).',
      income_share_high_rec: 'Ihre Ausgaben nehmen den größten Teil Ihres Einkommens ein. Erwägen Sie, nicht wesentliche Kategorien zu kürzen, um Ersparnisse aufzubauen oder Schulden abzuzahlen.',
      income_share_moderate_rec: 'Sie haben ein gesundes Gleichgewicht. Erwägen Sie, mehr für Ersparnisse oder Ziele zuzuweisen, wenn möglich.',
      income_share_low_rec: 'Gute Arbeit, die Ausgaben niedrig zu halten. Erwägen Sie, zusätzliches Einkommen in Ersparnisse oder Investitionen zu verschieben.',
      total_income: 'Gesamteinkommen',
      total_spending: 'Gesamtausgaben',
      income_ratio: 'Ausgabenverhältnis',
      // Time of Day
      time_of_day: 'Spitzenzeit der Ausgaben: {period}',
      time_of_day_short: 'Die meisten Ihrer Ausgaben erfolgen während {period} ({pct}% der Transaktionen).',
      time_of_day_rec: 'Wenn Sie Ausgaben reduzieren möchten, wird die Konzentration auf dieses Zeitfenster den größten Einfluss haben.',
      peak_period: 'Spitzenperiode',
      peak_amount: 'Betrag in Periode',
      peak_transactions: 'Transaktionen',
      // Goal Contribution
      goal_contrib_up: 'Sie haben Zielbeiträge erhöht',
      goal_contrib_down: 'Zielbeiträge haben sich verlangsamt',
      goal_contrib_up_short: 'Sie haben {current} in Ziele verschoben, mehr als {prev} im letzten Monat.',
      goal_contrib_down_short: 'Sie haben {current} in Ziele in diesem Monat verschoben, weniger als {prev} im letzten Monat.',
      goal_contrib_up_rec: 'Guter Fortschritt zu Ihren Zielen. Halten Sie diesen Schwung aufrecht.',
      goal_contrib_down_rec: 'Wenn Ziele immer noch eine Priorität sind, erwägen Sie, Budgets anzupassen, um mehr für Beiträge freizumachen.',
      current_contrib: 'Dieser Monat',
      previous_contrib: 'Letzter Monat',
      contrib_change: 'Änderung',
      // Category Change
      category_jump: '{category}-Ausgaben sind gestiegen',
      category_drop: '{category}-Ausgaben sind gesunken',
      category_jump_short: '{category} beträgt {current} in diesem Monat ({pct}% der Ausgaben), mehr als {prev} im letzten Monat.',
      category_drop_short: '{category} ist von {prev} im letzten Monat auf {current} in diesem Monat gesunken.',
      category_jump_rec: 'Wenn dieser Anstieg nicht beabsichtigt war, könnte die Festlegung eines Budgets für diese Kategorie Geld für Ziele oder Schulden freimachen.',
      category_drop_rec: 'Guter Fortschritt. Wenn sich das angenehm anfühlt, könnten Sie einen Teil dieses gesparten Betrags in Ziele oder zusätzliche Schuldenzahlungen umleiten.',
      category_name: 'Kategorie',
      category_current: 'Dieser Monat',
      category_previous: 'Letzter Monat',
      category_change: 'Änderung',
      // Time period names
      period_morning: 'Morgen',
      period_afternoon: 'Nachmittag',
      period_evening: 'Abend',
      period_late_night: 'Nacht',
      // Evidence row labels
      top_transaction: 'Größte Transaktion',
      largest_purchase: 'Größter Kauf',
      biggest_weekend_day: 'Teuerster Wochenendtag',
      example_transaction: 'Beispiel',
      generic_transaction: 'Transaktion',
      largest_expense: 'Größte Ausgabe',
      top_subscription: 'Hauptabonnement',
      largest_goal_transfer: 'Größte Zielüberweisung',
      top_category_transaction: 'Größte in Kategorie',
      frequent_merchant: 'Häufiger Händler'
    }
  }

  return strings[locale] || strings['en']
}

/**
 * Get currency symbol from currency code.
 * Supports 100+ currencies for international users.
 */
function getCurrencySymbol(currencyCode: string): string {
  const symbols: Record<string, string> = {
    'USD': '$', 'EUR': '€', 'GBP': '£', 'TRY': '₺', 'RUB': '₽', 'JPY': '¥', 'CNY': '¥',
    'INR': '₹', 'AUD': 'A$', 'CAD': 'C$', 'CHF': 'CHF', 'SEK': 'kr', 'NOK': 'kr', 'DKK': 'kr',
    'PLN': 'zł', 'CZK': 'Kč', 'HUF': 'Ft', 'RON': 'lei', 'BGN': 'лв', 'HRK': 'kn', 'MXN': '$',
    'BRL': 'R$', 'ARS': '$', 'CLP': '$', 'COP': '$', 'PEN': 'S/', 'ZAR': 'R', 'NGN': '₦',
    'EGP': 'E£', 'KES': 'KSh', 'GHS': 'GH₵', 'THB': '฿', 'VND': '₫', 'IDR': 'Rp', 'MYR': 'RM',
    'SGD': 'S$', 'PHP': '₱', 'KRW': '₩', 'TWD': 'NT$', 'HKD': 'HK$', 'NZD': 'NZ$', 'ILS': '₪',
    'SAR': 'SR', 'AED': 'د.إ', 'QAR': 'QR', 'KWD': 'KD', 'BHD': 'BD', 'OMR': 'OMR', 'JOD': 'JD',
    'PKR': 'Rs', 'BDT': '৳', 'LKR': 'Rs', 'NPR': 'Rs', 'KZT': '₸', 'GEL': '₾', 'AMD': '֏',
    'AZN': '₼', 'BYN': 'Br', 'UAH': '₴', 'MDL': 'L', 'RSD': 'дин', 'MKD': 'ден', 'ALL': 'L',
    'BAM': 'KM', 'ISK': 'kr', 'DOP': 'RD$', 'GTQ': 'Q', 'HNL': 'L', 'NIO': 'C$', 'CRC': '₡',
    'BOB': 'Bs', 'PYG': '₲', 'UYU': '$U', 'VES': 'Bs.S', 'TTD': 'TT$', 'JMD': 'J$', 'BBD': 'Bds$',
    'XCD': 'EC$', 'FJD': 'FJ$', 'PGK': 'K', 'WST': 'WS$', 'MGA': 'Ar', 'MUR': 'Rs', 'SCR': 'Rs',
    'MWK': 'MK', 'ZMW': 'ZK', 'BWP': 'P', 'NAD': 'N$', 'SZL': 'E', 'LSL': 'L', 'AOA': 'Kz',
    'MZN': 'MT', 'TZS': 'TSh', 'UGX': 'USh', 'RWF': 'FRw', 'BIF': 'FBu', 'ETB': 'Br', 'SOS': 'Sh',
    'SDG': 'SDG', 'LRD': 'L$', 'SLL': 'Le', 'GMD': 'D', 'GNF': 'FG', 'CDF': 'FC', 'XOF': 'CFA',
    'XAF': 'FCFA', 'CVE': '$', 'STN': 'Db', 'TND': 'DT', 'DZD': 'DA', 'MAD': 'DH', 'LYD': 'LD',
    'KMF': 'CF', 'SYP': '£S', 'IQD': 'ID', 'YER': 'YR', 'AFN': '؋', 'IRR': '﷼', 'TMT': 'm',
    'TJS': 'SM', 'KGS': 'som', 'MNT': '₮', 'BTN': 'Nu', 'MVR': 'Rf', 'BND': 'B$'
  }
  return symbols[currencyCode] || currencyCode
}

/**
 * Phase 1A.1: Currency-aware minimum floor calculation
 * Computes "10 units" in minor currency units (cents) respecting fraction digits
 */
function getCurrencyAwareMinFloor(currencyCode: string): number {
  // Get fraction digits for this currency
  let fractionDigits: number
  try {
    // Use Intl.NumberFormat to get standard fraction digits
    const formatter = new Intl.NumberFormat('en-US', { 
      style: 'currency', 
      currency: currencyCode 
    })
    const parts = formatter.formatToParts(1)
    const fractionPart = parts.find(part => part.type === 'fraction')
    fractionDigits = fractionPart ? fractionPart.value.length : 2
  } catch (e) {
    // Fallback for unsupported currencies
    const knownFractionDigits: Record<string, number> = {
      'JPY': 0, 'KRW': 0, 'VND': 0, 'CLP': 0, 'ISK': 0, 'PYG': 0, 'UGX': 0, 'RWF': 0,
      'TND': 3, 'BHD': 3, 'JOD': 3, 'KWD': 3, 'OMR': 3
    }
    fractionDigits = knownFractionDigits[currencyCode] ?? 2 // Default to 2 for most currencies
  }
  
  // Calculate 10 units in minor currency units
  // 10 * (10 ^ fractionDigits)
  const minFloorMinorUnits = 10 * Math.pow(10, fractionDigits)
  
  return minFloorMinorUnits
}

/**
 * Phase 1A.2: Shared Budget Cap calculation logic
 * Prevents drift between multiple calculation sites
 */
function calculateBudgetCapLimit(
  ratioPercent: number,
  totalIncomeCents: number,
  durationDays: number,
  currencyCode: string
): number {
  // Determine target discretionary percentage by spending tier
  const ratio = ratioPercent / 100
  let targetDiscretionaryPct: number
  if (ratio >= 0.90) {
    targetDiscretionaryPct = 0.125 // 12.5% for high spenders (≥90%)
  } else if (ratio >= 0.80) {
    targetDiscretionaryPct = 0.18  // 18% for moderate-high spenders (80-90%)
  } else if (ratio >= 0.70) {
    targetDiscretionaryPct = 0.22  // 22% for moderate spenders (70-80%)
  } else {
    targetDiscretionaryPct = 0.27  // 27% for low spenders (<70%)
  }
  
  // Calculate monthly cap based on income
  const monthlyCap = totalIncomeCents * targetDiscretionaryPct
  
  // Get days in current month for proportional calculation
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  
  // Calculate period cap proportional to duration
  const periodCap = monthlyCap * (durationDays / daysInMonth)
  
  // Apply challenge squeeze (make it slightly ambitious)
  const challengeSqueeze = 0.90
  const suggestedCapCentsRaw = Math.round(periodCap * challengeSqueeze)
  
  // Apply currency-aware minimum floor
  const minFloorCents = getCurrencyAwareMinFloor(currencyCode)
  const limitCents = Math.max(suggestedCapCentsRaw, minFloorCents)
  
  return limitCents
}

// Phase 1: Pinned copy system for stable insights within month
async function getPinnedInsightCopy(
  supabase: any,
  userId: string,
  monthKey: string,
  persona: string
): Promise<Array<{
  id: string;
  title: string;
  short: string;
  // recommendation: string; // REMOVED
  notification_title: string;
  notification_body: string;
  // ONE BRAIN Strategy B fields
  summaryLine?: string;
  whyItMatters?: string;
  quickWin?: string;
}> | null> {
  try {
    const { data, error } = await supabase
      .from('insight_pinned_copy')
      .select('insight_id, title, subtitle, soft_note, summary_line, why_it_matters, quick_win')
      .eq('user_id', userId)
      .eq('month_key', monthKey)
      .eq('persona', persona)
      .eq('model_version', 'v7')  // v7 = post type-extraction-fix
      .order('created_at', { ascending: true })

    if (error) {
      logError('spending_engine.pinned_copy_error', { userToken: getAnonymousUserToken(userId), monthKey, persona, error: error.message })
      return null
    }

    if (!data || data.length === 0) {
      return null
    }

    return data.map((row: any) => ({
      id: row.insight_id,
      title: row.title || '',
      short: row.subtitle || '',
      // recommendation: row.soft_note // REMOVED
      notification_title: row.title || '',
      notification_subtitle: row.subtitle || '', // Fix #4: Map subtitle to notification_subtitle
      notification_body: row.subtitle || '', // Keep for backward compatibility
      // ONE BRAIN Strategy B fields (nullable)
      summaryLine: row.summary_line || undefined,
      whyItMatters: row.why_it_matters || undefined,
      quickWin: row.quick_win || undefined
    }))
  } catch (e) {
    logError('spending_engine.pinned_copy_exception', { userToken: getAnonymousUserToken(userId), monthKey, persona, error: String(e) })
    return null
  }
}

async function storePinnedInsightCopy(
  supabase: any,
  userId: string,
  monthKey: string,
  persona: string,
  insights: Array<{
    id: string;
    title: string;
    short: string;

    // ONE BRAIN Strategy B fields (optional)
    summaryLine?: string;
    whyItMatters?: string;
    quickWin?: string;
  }>
): Promise<void> {
  try {
    const rows = insights.map(insight => ({
      user_id: userId,
      month_key: monthKey,
      insight_id: insight.id,
      persona: persona,
      variant_slot: generateVariantSlot(userId, monthKey, insight.id, persona),
      title: insight.title.slice(0, 42), // Enforce length limits
      subtitle: insight.short.slice(0, 90),
      soft_note: '', // REMOVED: insight.recommendation (not shown in UI)
      // ONE BRAIN Strategy B fields with length enforcement
      summary_line: insight.summaryLine ? insight.summaryLine.slice(0, 70) : null,
      why_it_matters: insight.whyItMatters ? insight.whyItMatters.slice(0, 140) : null,
      quick_win: insight.quickWin ? insight.quickWin.slice(0, 70) : null,
      model_version: 'v7',  // v7 = clean with correct type extraction
      created_at: new Date().toISOString()
    }))

    const { error } = await supabase
      .from('insight_pinned_copy')
      .upsert(rows, {
        onConflict: 'user_id,month_key,insight_id,persona',
        ignoreDuplicates: false
      })

    if (error) {
      logError('spending_engine.store_pinned_copy_error', { userToken: getAnonymousUserToken(userId), monthKey, persona, error: error.message })
    } else {
      log('spending_engine.pinned_copy_stored', { userToken: getAnonymousUserToken(userId), monthKey, persona, count: rows.length })
    }
  } catch (e) {
    logError('spending_engine.store_pinned_copy_exception', { userToken: getAnonymousUserToken(userId), monthKey, persona, error: String(e) })
  }
}

function generateVariantSlot(userId: string, monthKey: string, insightId: string, persona: string): number {
  // Deterministic variant selection based on stable inputs
  const input = `${userId}_${monthKey}_${insightId}_${persona}`
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash) % 10 // 10 variants (0-9)
}

// Helper function to create anonymous user token for logging (no PII leakage)
function getAnonymousUserToken(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `user_${Math.abs(hash).toString(36).slice(0, 8)}`
}

function generateStableInsightId(userId: string, monthKey: string, insightType: string, insightKey: string = ''): string {
  // Generate deterministic hash from userId to avoid leaking raw userId in insight_id
  // This keeps insight_id stable per user without exposing identity
  let userHash = 0
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i)
    userHash = ((userHash << 5) - userHash) + char
    userHash = userHash & userHash // Convert to 32-bit integer
  }
  const userSalt = Math.abs(userHash).toString(36).slice(0, 8) // 8-char hash

  const baseId = `${userSalt}_${monthKey}_${insightType.toLowerCase()}`
  return insightKey ? `${baseId}_${insightKey}` : baseId
}

// ONE BRAIN Strategy B Content Generation
async function generateStrategyBContent(
  insight: any,
  persona: string,
  detailStats: any[],
  traditionalFields?: { title: string; short: string } // recommendation field REMOVED
): Promise<{ summaryLine: string; whyItMatters: string; quickWin: string }> {
  // Trust gate: Validate against contradictions with proof stats
  const validatedStats = validateStatsConsistency(detailStats)

  // Try LLM generation first if available
  if (GEMINI_API_KEY) {
    try {
      const llmContent = await generateStrategyBWithLLM(insight, persona, validatedStats)
      if (llmContent) {
        // Apply persona filtering (emoji rules) with traditional fields coordination
        return applyPersonaFiltering(llmContent, persona, traditionalFields)
      }
    } catch (e) {
      logError('spending_engine.strategy_b_llm_error', { error: String(e) })
    }
  }

  // Fallback to deterministic templates
  const fallbackContent = generateStrategyBFallback(insight, persona, validatedStats)
  // Apply persona filtering to fallback content too
  return applyPersonaFiltering(fallbackContent, persona, traditionalFields)
}

async function generateStrategyBWithLLM(
  insight: any,
  persona: string,
  validatedStats: any[]
): Promise<{ summaryLine: string; whyItMatters: string; quickWin: string } | null> {
  // Define allowed emojis that won't be filtered out
  const allowedEmojis = ['✨', '📊', '🎯', '🔍', '💡', '📈', '📉', '💳', '🏦', '💰', '🍳', '🏠', '🚗', '🛒', '☕', '🎬', '💪', '🎉', '🌟', '💝', '⏰']
  const emojiList = allowedEmojis.join(' ')

  const personaPrompt = persona === 'coach'
    ? 'You are a financial coach. Be direct, crisp, and professional. NO emojis anywhere.'
    : `You are a friendly financial companion. Be warm and supportive. Use max 2 emojis total, ONLY in the Quick Win line. Choose from these emojis: ${emojiList}`

  const statsContext = validatedStats.map(stat => `${stat.label}: ${stat.value}`).join(', ')

  // Build action context if available
  const actionContext = insight.quickWinActionType
    ? `\nQuick Win Action: ${insight.quickWinActionType}${insight.quickWinLabel ? ` - "${insight.quickWinLabel}"` : ''}`
    : ''

  const prompt = `${personaPrompt}

Generate 3 distinct content blocks for this spending insight:

Title: ${insight.title}
Description: ${insight.short}
Stats: ${statsContext}${actionContext}

Generate exactly 3 lines:
1. Summary line (max 70 chars): A single, clear headline of the finding.
2. Why it matters (max 140 chars): Explain the REAL IMPACT on their financial life. Focus on LONGER-TERM CONSEQUENCES or MOTIVATION. Why should they care emotionally or financially? Use the provided stats for proof. (e.g., "This pattern is quietly draining your vacation fund by $X per month.")
3. Quick win (max 70 chars): ${insight.quickWinActionType ? `A CLEAR ACTION that MATCHES the Quick Win Action type. MUST reference the specific action (freeze/cap/push). NEVER use generic phrases like "review details", "take a closer look", or "check the breakdown".` : `A CLEAR, TANGIBLE ACTION they can take right now. This is the "DO" step.`}

CRITICAL RULES:
- NO OVERLAP: "Why it matters" is about the future impact. "Quick win" is about the immediate action.
- "Why it matters" MUST NOT suggest the action.
- "Quick win" MUST NOT explain the impact.
${insight.quickWinActionType ? `- "Quick win" MUST align with the action type (${insight.quickWinActionType}). Use action-specific language (freeze/cap/push/skip).` : ''}
- Be consistent with the provided stats.
- No uncertain money amounts.
- ${persona === 'coach' ? 'Tone: Sharp, professional, authoritative. No fluff, no emojis.' : 'Tone: Warm, supportive, empathetic companion. Use ONLY 1 emoji total, at the end of the Quick Win line.'}
- Stay within character limits.

${insight.quickWinActionType ? `Example for action type ${insight.quickWinActionType}:
- Why it matters: "These small purchases are delaying your emergency fund progress by 2-3 months."
- Quick win: "${persona === 'coach' ? getActionQuickWinExample(insight.quickWinActionType, false) : getActionQuickWinExample(insight.quickWinActionType, true)}"` : `Example of GOOD separation:
- Why it matters: "Frequent small splurges like this can quietly delay your emergency fund progress by several months."
- Quick win: "Skip the non-essential buys for the next 4 days${persona === 'companion' ? ' 🎯' : ''}"`}

Example of BAD (generic quick win):
- Quick win: "Take a closer look at the details" ← THIS IS BAD. Must be a specific action.`

  // Helper function to generate action-specific examples
  function getActionQuickWinExample(actionType: string, withEmoji: boolean): string {
    const emoji = withEmoji ? ' 🎯' : ''
    switch (actionType) {
      case 'NO_SPEND_CATEGORY':
      case 'NO_SPEND_MERCHANT':
        return `Try a 7-day freeze${emoji}`
      case 'BUDGET_CAP':
        return `Set a spending cap for this week${emoji}`
      case 'SAVINGS_PUSH':
        return `Move $X to savings today${emoji}`
      case 'NO_SPEND_MULTI_CATEGORY':
        return `Skip non-essentials for 3 days${emoji}`
      default:
        return `Take action now${emoji}`
    }
  }

  try {
    const response = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 200
      }
    })

    if (!response) return null

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null

    // Parse the 3 lines
    const lines = text.trim().split('\n').filter((line: string) => line.trim())
    if (lines.length < 3) return null

    return {
      summaryLine: lines[0].replace(/^\d+\.\s*/, '').slice(0, 70),
      whyItMatters: lines[1].replace(/^\d+\.\s*/, '').slice(0, 140),
      quickWin: lines[2].replace(/^\d+\.\s*/, '').slice(0, 70)
    }
  } catch (e) {
    return null
  }
}

function generateStrategyBFallback(
  insight: any,
  persona: string,
  validatedStats: any[]
): { summaryLine: string; whyItMatters: string; quickWin: string } {
  // Extract insight type from ID
  // Backend IDs: "userHash_YYYY-MM_type_..." → extract "type"
  // Example: "ps5na8_2026-01_top_category_uuid" → "top_category"
  let insightType = insight.typeName

  if (!insightType && insight.id) {
    const parts = insight.id.split('_')
    // Find the month part (YYYY-MM format)
    const monthIndex = parts.findIndex((part: string) => part.match(/^\d{4}-\d{2}$/))

    if (monthIndex >= 0) {
      // Extract all parts after month, excluding UUID (last part if it's a UUID)
      const remainingParts = parts.slice(monthIndex + 1)

      // Remove UUID part if present (looks like: 73cea1ce-b698-4c5e-9d8e-d047be2dc7ac)
      const lastPart = remainingParts[remainingParts.length - 1]
      if (lastPart && lastPart.match(/^[a-f0-9]{8}-[a-f0-9]{4}-/)) {
        remainingParts.pop()
      }

      // Join remaining parts with underscore to reconstruct multi-word types
      // e.g., ['top', 'category'] → 'top_category'
      insightType = remainingParts.join('_')
    } else {
      // Fallback: try position 2 (legacy format)
      insightType = parts[2] || parts[0]
    }
  }

  // Helper function to generate action-specific Quick Win text
  function getActionBasedQuickWin(actionType: string, actionLabel: string, isCompanion: boolean): string {
    const emoji = isCompanion ? ' 🎯' : ''

    switch (actionType) {
      case 'NO_SPEND_CATEGORY':
        return isCompanion
          ? `Try a 7-day freeze on this category${emoji}`
          : 'Freeze this category for 7 days'
      case 'NO_SPEND_MERCHANT':
        return isCompanion
          ? `Take a week off from this spot${emoji}`
          : 'Pause purchases at this merchant for one week'
      case 'BUDGET_CAP':
        return isCompanion
          ? `Set a spending cap for this week${emoji}`
          : 'Set a budget cap at 90% of last month'
      case 'SAVINGS_PUSH':
        return isCompanion
          ? `Move the extra to savings today${emoji}`
          : 'Allocate the difference to your highest-priority goal'
      case 'NO_SPEND_MULTI_CATEGORY':
      case 'NO_SPEND_KEYWORDS':
        return isCompanion
          ? `Skip these purchases for 3-7 days${emoji}`
          : 'Implement a temporary freeze on these categories'
      default:
        // Generic fallback if action type not recognized
        return isCompanion
          ? `Take action on this today${emoji}`
          : 'Review and implement a spending limit'
    }
  }

  // Companion templates: warm, friendly tone + 0-1 emoji in Quick Win only
  const companionTemplates: Record<string, { summaryLine: string; whyItMatters: string; quickWin: string }> = {
    velocity_higher: {
      summaryLine: 'Your spending picked up pace this month',
      whyItMatters: 'When spending speeds up, it can quietly eat into your savings buffer and make your goals feel further away.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Check your top 3 categories for easy saves 📊'
    },
    velocity_lower: {
      summaryLine: 'You slowed down your spending — nice work!',
      whyItMatters: 'This breathing room is a real win! It means more flexibility for savings, goals, or just peace of mind.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Celebrate by moving some extra to your goals ✨'
    },
    weekend_spike: {
      summaryLine: 'Weekends are your pricier days',
      whyItMatters: 'Weekend splurges can silently derail your weekly budget before Monday even arrives.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Try a fun weekend spending cap challenge 🎯'
    },
    top_merchant: {
      summaryLine: 'One spot is getting a lot of your money',
      whyItMatters: 'Repeat visits to one place can become autopilot spending — you might be spending more than you realize.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Try a 7-day break from this spot 🎯'
    },
    top_category: {
      summaryLine: 'One category is taking the biggest slice',
      whyItMatters: 'When one area dominates, other priorities can get squeezed out — including your savings goals.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Try a 7-day freeze on this category 🎯'
    },
    small_leaks: {
      summaryLine: 'Small purchases are quietly adding up',
      whyItMatters: 'These little buys feel harmless, but together they can drain hundreds each month without you noticing.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Skip 2-3 small buys this week 🎯'
    },
    spike_day: {
      summaryLine: 'One day had a big spending spike',
      whyItMatters: 'Unusual spikes can throw off your whole month if they become a pattern.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Review that day to spot any impulse buys 📈'
    },
    subscriptions: {
      summaryLine: 'Recurring charges are stacking up',
      whyItMatters: 'Subscriptions run quietly in the background - easy to forget, but they add up fast.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Cancel one subscription you forgot about 🎯'
    },
    income_share_high: {
      summaryLine: 'Spending is taking most of your income',
      whyItMatters: 'When expenses crowd out your paycheck, there is less room for savings or unexpected costs.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Find one category to trim by 10% 🎯'
    },
    income_share_moderate: {
      summaryLine: 'You are keeping a healthy balance',
      whyItMatters: 'This is a solid position! A little extra saved now compounds into real security later.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Consider boosting your savings by a small amount 🎯'
    },
    income_share_low: {
      summaryLine: 'You are spending well below your income',
      whyItMatters: 'Amazing discipline! This surplus is your ticket to faster goal progress or building a safety net.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Put extra toward your top goal 🎯'
    },
    income_share: {  // Base template for income_share_2026-01 (without suffix)
      summaryLine: 'Spending vs income balance',
      whyItMatters: 'Your spending ratio impacts how much room you have for savings and unexpected costs.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Review your biggest category 🎯'
    },
    time_of_day: {
      summaryLine: 'Most spending happens at one time of day',
      whyItMatters: 'Time patterns reveal when you are most likely to spend impulsively - awareness is power.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Be extra mindful during your peak spending hours ⏰'
    },
    goal_contrib_up: {
      summaryLine: 'You boosted your goal contributions!',
      whyItMatters: 'Every extra dollar toward your goals is future-you saying thank you. This momentum matters!',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Keep it rolling - can you match this next month? 🎯'
    },
    goal_contrib_down: {
      summaryLine: 'Goal contributions dipped this month',
      whyItMatters: 'Life happens, but getting back on track keeps your goals within reach.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Set a small automatic transfer to get momentum back 🎯'
    },
    category_jump: {
      summaryLine: 'One category spiked up this month',
      whyItMatters: 'Unexpected increases can signal a new habit forming — better to catch it early.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Set a budget cap before it becomes the new normal 🎯'
    },
    category_drop: {
      summaryLine: 'You cut back in one category — well done!',
      whyItMatters: 'This kind of progress builds real momentum. The money you saved can do more for you elsewhere.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
        : 'Redirect some savings to your top goal 🎯'
    }
  }

  // Coach templates: direct, practical tone + no emojis
  const coachTemplates: Record<string, { summaryLine: string; whyItMatters: string; quickWin: string }> = {
    velocity_higher: {
      summaryLine: 'Spending pace increased this month',
      whyItMatters: 'Higher velocity reduces your savings rate and increases the risk of month-end shortfalls.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Cap your top 2 discretionary categories immediately'
    },
    velocity_lower: {
      summaryLine: 'Spending pace decreased this month',
      whyItMatters: 'Lower spending creates capacity for accelerated debt repayment or additional savings contributions.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Allocate the difference to your highest-priority goal'
    },
    weekend_spike: {
      summaryLine: 'Weekend spending exceeds weekday average',
      whyItMatters: 'Weekend patterns significantly impact monthly totals and can derail budget discipline.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Implement a fixed weekend spending limit'
    },
    top_merchant: {
      summaryLine: 'Single merchant dominates spending',
      whyItMatters: 'Merchant concentration creates vulnerability to habit-driven overspending.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Pause purchases at this merchant for one week'
    },
    top_category: {
      summaryLine: 'One category represents largest expense share',
      whyItMatters: 'Category concentration limits resource allocation across financial priorities.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Implement a 7-day spending freeze for this category'
    },
    small_leaks: {
      summaryLine: 'High volume of small transactions detected',
      whyItMatters: 'Micro-transactions accumulate into significant monthly totals that erode savings capacity.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Eliminate 3 recurring small purchases this week'
    },
    spike_day: {
      summaryLine: 'Significant single-day spending anomaly',
      whyItMatters: 'Spending spikes indicate potential impulse behavior that impacts budget stability.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Review spike transactions and identify preventable expenses'
    },
    subscriptions: {
      summaryLine: 'Recurring subscription charges accumulating',
      whyItMatters: 'Subscription creep consumes fixed income without active decision-making.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Audit and cancel at least one unused subscription'
    },
    income_share_high: {
      summaryLine: 'Expense-to-income ratio exceeds target',
      whyItMatters: 'High spending ratio leaves insufficient margin for savings and emergencies.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Reduce top discretionary category by 10-15%'
    },
    income_share_moderate: {
      summaryLine: 'Expense-to-income ratio within acceptable range',
      whyItMatters: 'Moderate ratio provides opportunity to optimize savings allocation.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Increase savings rate by redirecting discretionary spending'
    },
    income_share_low: {
      summaryLine: 'Expense-to-income ratio is favorable',
      whyItMatters: 'Low spending ratio enables aggressive goal funding and wealth building.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Maximize contribution to highest-yield savings vehicle'
    },
    income_share: {  // Base template for income_share_2026-01 (without suffix)
      summaryLine: 'Expense-to-income ratio status',
      whyItMatters: 'Spending ratio determines margin available for savings and emergencies.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Review top discretionary category and set reduction target'
    },
    time_of_day: {
      summaryLine: 'Spending concentrated in specific time window',
      whyItMatters: 'Time-based patterns indicate behavioral triggers that drive unnecessary spending.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Implement spending pause during peak hours'
    },
    goal_contrib_up: {
      summaryLine: 'Goal contribution rate increased',
      whyItMatters: 'Increased contributions accelerate goal completion timeline.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Lock in this rate as new baseline minimum'
    },
    goal_contrib_down: {
      summaryLine: 'Goal contribution rate decreased',
      whyItMatters: 'Reduced contributions extend goal timelines and reduce compound growth.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Restore previous contribution level this week'
    },
    category_jump: {
      summaryLine: 'Category spending increased significantly',
      whyItMatters: 'Unplanned category increases indicate budget drift requiring correction.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Set hard budget cap at previous month level'
    },
    category_drop: {
      summaryLine: 'Category spending decreased',
      whyItMatters: 'Reduced category spending creates reallocation opportunity.',
      quickWin: insight.quickWinActionType
        ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
        : 'Redirect savings to highest-priority financial goal'
    }
  }

  // Default templates for unknown insight types
  const defaultCompanion = {
    summaryLine: 'We noticed something worth sharing',
    whyItMatters: 'Understanding your patterns helps you make choices that feel right for your goals.',
    quickWin: insight.quickWinActionType
      ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, true)
      : 'Review the details and find your next step 🎯'
  }

  const defaultCoach = {
    summaryLine: 'Notable spending pattern detected',
    whyItMatters: 'Pattern analysis reveals optimization opportunities for financial efficiency.',
    quickWin: insight.quickWinActionType
      ? getActionBasedQuickWin(insight.quickWinActionType, insight.quickWinLabel, false)
      : 'Review breakdown and identify actionable changes'
  }

  // Select appropriate template set based on persona
  const templates = persona === 'coach' ? coachTemplates : companionTemplates
  const defaultTemplate = persona === 'coach' ? defaultCoach : defaultCompanion

  const template = templates[insightType as keyof typeof templates] || defaultTemplate

  return {
    summaryLine: template.summaryLine,
    whyItMatters: template.whyItMatters,
    quickWin: template.quickWin
  }
}

function applyPersonaFiltering(
  content: { summaryLine: string; whyItMatters: string; quickWin: string },
  persona: string,
  traditionalFieldsContent?: { title: string; short: string }
): { summaryLine: string; whyItMatters: string; quickWin: string } {
  const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu

  if (persona === 'coach') {
    // Coach: Remove all emojis from all Strategy B fields (0 emojis total)
    return {
      summaryLine: content.summaryLine.replace(emojiRegex, '').trim(),
      whyItMatters: content.whyItMatters.replace(emojiRegex, '').trim(),
      quickWin: content.quickWin.replace(emojiRegex, '').trim()
    }
  } else {
    // Companion: max 1 allowed emoji TOTAL, Quick Win line only
    const allowedEmojis = ['✨', '📊', '🎯', '🔍', '💡', '📈', '📉', '💳', '🏦', '💰', '🍳', '🏠', '🚗', '🛒', '☕', '🎬', '💪', '🎉', '🌟', '💝', '⏰']

    // Strategy B fields: always strip emojis from summaryLine and whyItMatters
    const cleanSummaryLine = content.summaryLine.replace(emojiRegex, '').trim()
    const cleanWhyItMatters = content.whyItMatters.replace(emojiRegex, '').trim()

    // For quickWin: extract up to 1 allowed emoji and add it to the end
    let cleanQuickWin = content.quickWin.replace(emojiRegex, '').trim()

    // Extract emojis from the original quickWin text
    const quickWinEmojis = content.quickWin.match(emojiRegex) || []
    const allowedQuickWinEmojis = quickWinEmojis.filter(emoji => allowedEmojis.includes(emoji))

    // Take up to 1 emoji for Companion mode
    const emojisToAdd = allowedQuickWinEmojis.slice(0, 1)

    if (emojisToAdd.length > 0) {
      cleanQuickWin = cleanQuickWin + ' ' + emojisToAdd.join(' ')
    }

    return {
      summaryLine: cleanSummaryLine,
      whyItMatters: cleanWhyItMatters,
      quickWin: cleanQuickWin.trim()
    }
  }
}

function validateStatsConsistency(detailStats: any[]): any[] {
  // Trust gate: Remove or sanitize stats that might contain uncertain money numbers
  return detailStats.map(stat => {
    // If stat value contains uncertain money patterns, sanitize it
    if (typeof stat.value === 'string' && stat.value.match(/\$[\d,]+\??|\~\$[\d,]+|about \$[\d,]+/i)) {
      // Strip uncertain money amounts, keep only the concept
      return {
        ...stat,
        value: stat.value.replace(/\$[\d,]+\??|\~\$[\d,]+|about \$[\d,]+/gi, '[amount]')
      }
    }
    return stat
  })
}

// Handle partial pinned rows - fill missing Strategy B fields ONCE
async function fillMissingStrategyBFields(
  supabase: any,
  userId: string,
  monthKey: string,
  persona: string,
  insights: any[]
): Promise<void> {
  if (!ONE_BRAIN_STRATEGY_B_ENABLED) return

  try {
    // Get existing pinned rows
    const { data: existingRows, error } = await supabase
      .from('insight_pinned_copy')
      .select('insight_id, title, subtitle, soft_note, summary_line, why_it_matters, quick_win')
      .eq('user_id', userId)
      .eq('month_key', monthKey)
      .eq('persona', persona)
      .eq('model_version', 'v7')  // Only process v7 rows

    if (error || !existingRows) return

    // Find rows with missing Strategy B fields
    const rowsNeedingUpdate = existingRows.filter((row: any) =>
      !row.summary_line || !row.why_it_matters || !row.quick_win
    )

    if (rowsNeedingUpdate.length === 0) return

    // Generate Strategy B content for missing fields and UPDATE only those fields
    for (const row of rowsNeedingUpdate) {
      let insight = insights.find(i => i.id === row.insight_id)

      // CRITICAL FIX: If insight not found in rawInsights, create a synthetic one from pinned row
      // This prevents silent skip that leaves Strategy B empty forever
      if (!insight) {
        log('spending_engine.strategy_b_synthetic_insight', {
          userToken: getAnonymousUserToken(userId),
          monthKey,
          persona,
          insightId: row.insight_id
        })

        insight = {
          id: row.insight_id,
          title: row.title || '',
          short: row.subtitle || '',
          // recommendation: row.soft_note // REMOVED
          detailStats: []
        }
      }

      const strategyBContent = await generateStrategyBContent(
        insight,
        persona,
        insight.detailStats || [],
        // For existing pinned rows, pass the existing traditional fields from the row
        // recommendation: row.soft_note // REMOVED
        { title: row.title || '', short: row.subtitle || '' }
      )

      // UPDATE-only logic: only update the Strategy B fields, leave existing pinned copy untouched
      const updateFields: any = {}
      if (!row.summary_line) {
        updateFields.summary_line = strategyBContent.summaryLine.slice(0, 70)
      }
      if (!row.why_it_matters) {
        updateFields.why_it_matters = strategyBContent.whyItMatters.slice(0, 140)
      }
      if (!row.quick_win) {
        updateFields.quick_win = strategyBContent.quickWin.slice(0, 70)
      }

      // Only update if there are fields to update
      if (Object.keys(updateFields).length > 0) {
        const { error: updateError } = await supabase
          .from('insight_pinned_copy')
          .update(updateFields)
          .eq('user_id', userId)
          .eq('month_key', monthKey)
          .eq('insight_id', row.insight_id)
          .eq('persona', persona)

        if (updateError) {
          logError('spending_engine.fill_strategy_b_update_error', {
            userToken: getAnonymousUserToken(userId),
            monthKey,
            persona,
            insightId: row.insight_id,
            error: updateError.message
          })
        } else {
          log('spending_engine.strategy_b_field_updated', {
            userToken: getAnonymousUserToken(userId),
            monthKey,
            persona,
            insightId: row.insight_id,
            updatedFields: Object.keys(updateFields)
          })
        }
      }
    }

    if (rowsNeedingUpdate.length > 0) {
      log('spending_engine.strategy_b_filled', {
        userToken: getAnonymousUserToken(userId),
        monthKey,
        persona,
        count: rowsNeedingUpdate.length
      })
    }
  } catch (e) {
    logError('spending_engine.fill_strategy_b_exception', {
      userToken: getAnonymousUserToken(userId),
      monthKey,
      persona,
      error: String(e)
    })
  }
}

/**
 * Map English period bucket names to localized strings.
 */
function getLocalizedPeriod(bucket: string, strings: any): string {
  const map: Record<string, string> = {
    'Morning': strings.period_morning || 'morning',
    'Afternoon': strings.period_afternoon || 'afternoon',
    'Evening': strings.period_evening || 'evening',
    'Late night': strings.period_late_night || 'late night'
  }
  return map[bucket] || bucket.toLowerCase()
}

/**
 * Extract the best available transaction name from a TxnRow.
 * Priority: title > note (first line or merchant) > fallback
 */
function getTxnDisplayName(t: TxnRow, fallback: string): string {
  // Try title first
  const title = (t.title || '').trim()
  if (title) return title

  // Try to extract merchant from note (often contains "Merchant: X" or first line is merchant)
  const note = (t.note || '').trim()
  if (note) {
    // Check for "Merchant: X" pattern
    const merchantMatch = note.match(/merchant[:\s]+([^\n,]+)/i)
    if (merchantMatch && merchantMatch[1].trim()) {
      return merchantMatch[1].trim()
    }
    // Use first line of note as fallback
    const firstLine = note.split('\n')[0].trim()
    if (firstLine && firstLine.length <= 50) {
      return firstLine
    }
  }

  return fallback
}

/**
 * Convert a category to a normalized key for matching/grouping.
 * Matches Android CategoryHelper.toCategoryKey() logic.
 * 
 * Rules:
 * - Lowercase
 * - Collapse whitespace
 * - Remove special characters (keep hyphens)
 * - Returns "other" for null/empty
 * 
 * Examples:
 *   "Groceries" → "groceries"
 *   "Food &  Dining" → "food-dining"
 *   " TRANSFER " → "transfer"
 */
function toCategoryKey(raw: string | null): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return 'other'

  return trimmed
    .toLowerCase()
    .replace(/\s+/g, ' ')  // Collapse whitespace
    .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars
    .replace(/\s+/g, '-')  // Spaces to hyphens
    .replace(/^-+|-+$/g, '')  // Trim hyphens
    || 'other'
}

/**
 * Check if a category represents a transfer between wallets.
 * Matches Android CategoryHelper.isTransferLikeCategory() logic.
 */
function isTransferLikeCategory(categoryKey: string): boolean {
  return (
    categoryKey === 'transfer' ||
    categoryKey === 'internal-transfer' ||
    categoryKey === 'wallet-transfer' ||
    categoryKey === 'money-transfer'
  )
}

/**
 * Check if a category represents an essential expense that should be excluded
 * from discretionary spending actions like freezes.
 * 
 * Essential categories:
 * - Rent/Mortgage, Utilities, Groceries, Healthcare, Insurance
 * - Education, Childcare, Commute, Debt payments, Taxes
 * 
 * Matches Android CategoryHelper.isEssentialCategory() logic.
 */
function isEssentialCategory(categoryKey: string): boolean {
  const normalizedKey = toCategoryKey(categoryKey)

  return (
    // Housing
    normalizedKey === 'rent' || normalizedKey === 'mortgage' ||
    normalizedKey === 'housing' || normalizedKey === 'home-loan' ||
    // Utilities
    normalizedKey === 'utilities' || normalizedKey === 'electricity' ||
    normalizedKey === 'water' || normalizedKey === 'gas' ||
    normalizedKey === 'heating' || normalizedKey === 'internet' ||
    normalizedKey === 'phone-bill' || normalizedKey === 'mobile-bill' ||
    // Core groceries
    normalizedKey === 'groceries' || normalizedKey === 'supermarket' ||
    normalizedKey === 'food-shopping' ||
    // Healthcare
    normalizedKey === 'healthcare' || normalizedKey === 'medical' ||
    normalizedKey === 'doctor' || normalizedKey === 'hospital' ||
    normalizedKey === 'pharmacy' || normalizedKey === 'medicine' ||
    normalizedKey === 'health-insurance' ||
    // Insurance
    normalizedKey === 'insurance' || normalizedKey === 'car-insurance' ||
    normalizedKey === 'home-insurance' || normalizedKey === 'life-insurance' ||
    // Education
    normalizedKey === 'education' || normalizedKey === 'tuition' ||
    normalizedKey === 'school' || normalizedKey === 'university' ||
    normalizedKey === 'school-fees' ||
    // Childcare
    normalizedKey === 'childcare' || normalizedKey === 'daycare' ||
    normalizedKey === 'babysitter' || normalizedKey === 'nanny' ||
    // Commute
    normalizedKey === 'commute' || normalizedKey === 'public-transport' ||
    normalizedKey === 'transit' || normalizedKey === 'metro' ||
    normalizedKey === 'bus-pass' || normalizedKey === 'train-pass' ||
    normalizedKey === 'work-gas' ||
    // Debt
    normalizedKey === 'debt-payment' || normalizedKey === 'loan-payment' ||
    normalizedKey === 'credit-card-payment' || normalizedKey === 'mortgage-payment' ||
    // Taxes
    normalizedKey === 'taxes' || normalizedKey === 'tax' ||
    normalizedKey === 'government-fee' || normalizedKey === 'license-fee' ||
    normalizedKey === 'registration'
  )
}

function isFixedCostCategory(categoryKey: string): boolean {
  const normalizedKey = toCategoryKey(categoryKey)

  return (
    normalizedKey === 'rent' ||
    normalizedKey === 'mortgage' ||
    normalizedKey === 'mortgage-payment' ||
    normalizedKey === 'tax' ||
    normalizedKey === 'taxes' ||
    normalizedKey === 'government-fee' ||
    normalizedKey === 'license-fee' ||
    normalizedKey === 'registration' ||
    normalizedKey === 'debt-payment' ||
    normalizedKey === 'loan-payment' ||
    normalizedKey === 'credit-card-payment'
  )
}

/**
 * Check if a string looks like a UUID (8-4-4-4-12 format).
 * Used to prevent passing UUIDs to functions expecting human-readable category names.
 */
function looksLikeUuid(str: string): boolean {
  if (!str || str.length !== 36) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)
}


function parseYmdToUtcStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((s) => Number(s))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) throw new Error('Invalid YYYY-MM-DD')
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0))
}

function toYmdUTC(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function weekBoundariesFromStartYmd(weekStartYmd: string) {
  const start = parseYmdToUtcStart(weekStartYmd)
  const end = new Date(addDaysUTC(start, 6).getTime() + (24 * 60 * 60 * 1000 - 1))
  const prevStart = addDaysUTC(start, -7)
  const prevEnd = new Date(addDaysUTC(prevStart, 6).getTime() + (24 * 60 * 60 * 1000 - 1))
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    prevStartISO: prevStart.toISOString(),
    prevEndISO: prevEnd.toISOString(),
    periodKey: weekStartYmd
  }
}

async function getCurrencySymbolForUser(supabase: any, userId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('user_preferences')
      .select('currency')
      .eq('user_id', userId)
      .maybeSingle()

    const currency = String((data as any)?.currency || '').trim().toUpperCase()
    if (!currency) return '₺'
    if (currency === 'USD') return '$'
    if (currency === 'EUR') return '€'
    if (currency === 'GBP') return '£'
    if (currency === 'TRY') return '₺'
    return '₺'
  } catch (_) {
    return '₺'
  }
}

async function getMonthlyIncomeCents(supabase: any, userId: string, monthKey: string): Promise<number | null> {
  try {
    const { data } = await supabase
      .from('analytics_user_monthly_stats')
      .select('income_total')
      .eq('user_id', userId)
      .eq('month', monthKey)
      .maybeSingle()
    const v = (data as any)?.income_total
    if (v == null) return null
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n * 100)
  } catch (_) {
    return null
  }
}

async function loadActiveSnoozes(supabase: any, userId: string, scope: 'monthly' | 'weekly') {
  const nowIso = new Date().toISOString()
  const { data } = await supabase
    .from('spending_insight_snoozes')
    .select('insight_type, insight_key, snoozed_until')
    .eq('user_id', userId)
    .eq('scope', scope)
    .gt('snoozed_until', nowIso)
  return (data || []) as Array<{ insight_type: string; insight_key: string; snoozed_until: string }>
}

async function loadFeedbackForPeriod(
  supabase: any,
  userId: string,
  scope: 'monthly' | 'weekly',
  periodKey: string
): Promise<Array<{ insight_type: string; insight_key: string; helpful: boolean }>> {
  const { data } = await supabase
    .from('spending_insight_feedback')
    .select('insight_type, insight_key, helpful')
    .eq('user_id', userId)
    .eq('scope', scope)
    .eq('period_key', periodKey)
  return (data || []) as Array<{ insight_type: string; insight_key: string; helpful: boolean }>
}

function isSnoozed(
  snoozes: Array<{ insight_type: string; insight_key: string }>,
  insightType: string,
  insightKey: string
): boolean {
  const key = insightKey || ''
  return snoozes.some((s) => {
    if (String(s.insight_type || '') !== insightType) return false
    const sk = String(s.insight_key || '')
    return sk === '' || sk === key
  })
}

function feedbackPenalty(
  feedback: Array<{ insight_type: string; insight_key: string; helpful: boolean }>,
  insightType: string,
  insightKey: string
): number {
  const key = insightKey || ''
  const match = feedback.find((f) => f.insight_type === insightType && (f.insight_key || '') === key)
  if (!match) return 0
  return match.helpful ? 0 : 1000
}

function dedupeByType(candidates: CandidateInsight[]): CandidateInsight[] {
  const best = new Map<string, CandidateInsight>()
  for (const c of candidates) {
    const existing = best.get(c.insight_type)
    if (!existing || c.score > existing.score) best.set(c.insight_type, c)
  }
  return [...best.values()]
}

function toV2Card(
  scope: 'monthly' | 'weekly',
  periodKey: string,
  candidate: CandidateInsight,
  currencyCode: string = 'USD'
): V2InsightCard {
  const id = `${scope}:${periodKey}:${candidate.insight_type}:${candidate.insight_key || ''}`

  // Determine quickWin fields based on insight type according to the mapping plan
  let quickWinLabel: string | undefined
  let quickWinActionType: string | undefined
  let quickWinPayload: Record<string, any> | undefined

  // Extract category name from candidate data if available - avoid using cardTitle first word which is unreliable
  const categoryName = candidate.insight_key || 'Category'

  switch (candidate.insight_type) {
    // A) Insights that MUST show Budget Cap action
    case 'INCOME_SHARE':
    case 'SPENDING_VELOCITY':
      // Phase 1A: Use REAL data only, no fallback defaults
      // If we don't have real aggregates, omit the uncertain values and let Android handle safely
      
      const durationDays = 7 // Default duration is safe
      
      // Only include ratio/income/expense data if we have real values from candidate metadata
      let budgetPayload: any = {
        scope: 'discretionary',
        durationDays: durationDays
      }
      
      // Check if we have real aggregate data from the candidate
      if (candidate.metadata?.ratioPercent && 
          candidate.metadata?.totalIncome && 
          candidate.metadata?.totalExpense) {
        
        const ratioPercent = parseInt(candidate.metadata.ratioPercent)
        const totalIncome = parseFloat(candidate.metadata.totalIncome)
        const totalExpense = parseFloat(candidate.metadata.totalExpense)
        
        // Validate the data makes sense (basic sanity checks)
        if (ratioPercent > 0 && ratioPercent <= 200 && 
            totalIncome > 0 && totalExpense > 0) {
          
          const totalIncomeCents = Math.round(totalIncome * 100)
          const totalExpenseCents = Math.round(totalExpense * 100)
          
          // Phase 1A.2: Use shared Budget Cap calculation logic
          const limitCents = calculateBudgetCapLimit(
            ratioPercent,
            totalIncomeCents,
            durationDays,
            currencyCode
          )
          
          // Include computed values in payload
          budgetPayload = {
            ...budgetPayload,
            limitCents: limitCents,
            ratioPercent: ratioPercent,
            totalIncomeCents: totalIncomeCents,
            totalExpenseCents: totalExpenseCents
          }
          
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: 'budget_cap.real_computation',
            insight_type: candidate.insight_type,
            ratioPercent,
            limitCents,
            source: 'real_aggregates'
          }))
        } else {
          // Data failed sanity checks - log and omit uncertain values
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: 'budget_cap.invalid_data',
            insight_type: candidate.insight_type,
            ratioPercent,
            totalIncome,
            totalExpense,
            source: 'failed_validation'
          }))
        }
      } else {
        // No real aggregate data available - safely omit uncertain values
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'budget_cap.missing_aggregates',
          insight_type: candidate.insight_type,
          available_metadata: Object.keys(candidate.metadata || {}),
          source: 'no_real_data'
        }))
      }
      
      quickWinActionType = 'BUDGET_CAP'
      quickWinLabel = 'Cap discretionary spending'
      quickWinPayload = budgetPayload
      break

    // B) Insights that MUST show Freeze Category action
    case 'TOP_CATEGORY':
      quickWinActionType = 'NO_SPEND_CATEGORY'
      quickWinLabel = `Freeze ${categoryName}`
      quickWinPayload = {
        categoryName: categoryName,
        durationDays: 7  // Recommended default
      }
      break
      
    case 'TOP_MERCHANT':
      // Phase 1B: Safety rule - only emit Quick Win if we can confidently determine a real category
      const merchantName = candidate.insight_key || 'Unknown Merchant'
      
      // Check if we have confident category mapping from metadata
      const primaryCategory = candidate.metadata?.primaryCategory
      const categoryId = candidate.metadata?.categoryId
      const categoryCount = candidate.metadata?.categoryCount || 0
      
      // Safety rule: Only emit Quick Win if we have confident category mapping
      if (!primaryCategory || categoryCount === 0) {
        // No confident category mapping - omit Quick Win action entirely
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'top_merchant.no_action',
          merchantName,
          reason: 'no_confident_category_mapping',
          categoryCount,
          source: 'safety_rule'
        }))
        // Don't set quickWinActionType - this will hide Quick Win UI
        break
      }
      
      // Additional safety: Reject generic/uncertain categories
      const uncertainCategories = ['other', 'unknown', 'uncategorized', '']
      if (uncertainCategories.includes(primaryCategory.toLowerCase())) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'top_merchant.no_action',
          merchantName,
          primaryCategory,
          reason: 'uncertain_category',
          source: 'safety_rule'
        }))
        // Don't set quickWinActionType - this will hide Quick Win UI
        break
      }
      
      // We have confident category mapping - emit Quick Win action
      quickWinActionType = 'NO_SPEND_CATEGORY'
      quickWinLabel = `Freeze ${primaryCategory}`
      quickWinPayload = {
        categoryName: primaryCategory,
        merchantName: merchantName,
        durationDays: 7,
        // Include stable identifier if available
        ...(categoryId && { categoryId: categoryId })
      }
      
      // Phase 1C: Log successful mapping for monitoring
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'top_merchant.action_created',
        merchantName,
        primaryCategory,
        categoryId: categoryId || 'none',
        categoryCount,
        source: 'confident_mapping'
      }))
      break
      
    case 'CATEGORY_CHANGE_UP':
      quickWinActionType = 'NO_SPEND_CATEGORY'
      quickWinLabel = `Freeze ${categoryName}`
      quickWinPayload = {
        categoryName: categoryName,
        durationDays: 7  // Recommended default
      }
      break

    // C) Insights that MUST be informational-only (hide Quick Win section)
    case 'SPIKE_DAY':
    case 'CATEGORY_CHANGE_DOWN':
    case 'SMALL_LEAKS':
    case 'WEEKEND_SPIKE':
    case 'SUBSCRIPTIONS':
    case 'GOAL_CONTRIB':
    case 'TIME_OF_DAY':
      // For non-actionable insights, don't set quickWin fields
      quickWinActionType = undefined
      quickWinLabel = undefined
      quickWinPayload = undefined
      break

    default:
      // For unrecognized insight types, default to no action
      quickWinActionType = undefined
      quickWinLabel = undefined
      quickWinPayload = undefined
  }

  return {
    id,
    scope,
    period_key: periodKey,
    insight_type: candidate.insight_type,
    insight_key: candidate.insight_key || '',
    badge: candidate.badge,
    card: {
      title: candidate.cardTitle,
      subtitle: candidate.cardSubtitle
    },
    detail: {
      title: candidate.cardTitle,
      body: candidate.body,
      proof: candidate.proof,
      actions: candidate.actions
    },
    snooze: {
      days: 10,
      scope,
      insight_type: candidate.insight_type,
      insight_key: candidate.insight_key || ''
    },
    // Add quickWin fields if they exist
    ...(quickWinActionType && quickWinLabel && {
      quickWinActionType,
      quickWinLabel,
      quickWinPayload
    })
  }
}

function sumExpenseCents(rows: TxnRow[]): number {
  let total = 0
  for (const r of rows) {
    const amt = Number(r.amount)
    if (!Number.isFinite(amt)) continue
    if (amt < 0) total += Math.round(Math.abs(amt) * 100)
  }
  return total
}

function sumExpenseCentsByCategory(rows: TxnRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const amt = Number(r.amount)
    if (!Number.isFinite(amt) || amt >= 0) continue

    // Phase 2: Prefer category_id (UUID), fallback to category string
    const categoryKey = r.category_id
      ? r.category_id  // Use UUID directly as key
      : toCategoryKey(r.category)  // Fallback: normalize category string

    const next = (out.get(categoryKey) || 0) + Math.round(Math.abs(amt) * 100)
    out.set(categoryKey, next)
  }
  return out
}

function expenseAmountsCents(rows: TxnRow[]): number[] {
  const out: number[] = []
  for (const r of rows) {
    const amt = Number(r.amount)
    if (!Number.isFinite(amt) || amt >= 0) continue
    out.push(Math.round(Math.abs(amt) * 100))
  }
  return out
}

function median(values: number[]): number {
  if (!values.length) return 0
  const arr = [...values].sort((a, b) => a - b)
  const mid = Math.floor(arr.length / 2)
  if (arr.length % 2 === 0) {
    return Math.round((arr[mid - 1] + arr[mid]) / 2)
  }
  return arr[mid]
}

function normalizeTitleForRecurring(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[0-9]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z\s]/g, '')
    .trim()
}

function findBudgetForCategoryName(budgets: any[], categoryName: string): any | null {
  const key = categoryName.trim().toLowerCase()
  if (!key) return null
  return budgets.find((b: any) => {
    const name = String(b?.name || '').trim().toLowerCase()
    return name === key
  }) || null
}

async function isBudgetableCategory(
  supabase: any,
  userId: string,
  categoryName: string
): Promise<boolean> {
  const key = normalizeKey(categoryName)
  try {
    const { data } = await supabase
      .from('category_budget_policy')
      .select('is_budgetable')
      .or(`user_id.eq.${userId},user_id.is.null`)
      .eq('category_key', key)
      .order('user_id', { ascending: false })
      .limit(1)

    const row = (data || [])[0] as any
    if (row == null) return true
    return row.is_budgetable !== false
  } catch (_) {
    return true
  }
}

async function loadBudgetsForRange(
  supabase: any,
  userId: string,
  startYmd: string,
  endYmd: string
): Promise<Array<{ id: string; name: string; amount_cents: number; category_id: string | null; start_date: string; end_date: string | null; period: string }>> {
  const { data } = await supabase
    .from('budgets')
    .select('id,name,amount_cents,category_id,start_date,end_date,period,is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .lte('start_date', endYmd)
    .or(`end_date.is.null,end_date.gte.${startYmd}`)

  return (data || []) as any
}

async function loadCategoryNameMap(supabase: any, userId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('id,name')
      .eq('user_id', userId)
      .limit(500)

    if (error) {
      logError('spending_engine.load_category_map_error', { userToken: getAnonymousUserToken(userId), error: error.message })
      return out
    }

    for (const row of (data || []) as any[]) {
      if (row?.id && row?.name) out.set(String(row.id), String(row.name))
    }
  } catch (e) {
    logError('spending_engine.load_category_map_exception', { userToken: getAnonymousUserToken(userId), error: String(e) })
  }
  return out
}

async function handleV2(body: any, supabase: any, userId: string) {
  // Version log to verify deployment
  log('spending_engine.version', { v: '2026-01-23-hotfix' })
  
  // Confirm v2 handler is being hit
  log('spending_engine.handle_v2_entry', {
    userToken: getAnonymousUserToken(userId),
    scope: body.scope || 'monthly',
    persona: body.persona || 'unknown'
  })

  // Body is already parsed, no need to call req.json() again
  const scope = String((body as any).scope || 'monthly').trim().toLowerCase() as 'monthly' | 'weekly'
  
  // Parse currencyCode from request body with safe default
  const currencyCode = String((body as any).currencyCode || 'USD').trim().toUpperCase()

  const currencySymbol = getCurrencySymbol(currencyCode)

  let startISO = ''
  let endISO = ''
  let prevStartISO = ''
  let prevEndISO = ''
  let periodKey = ''
  let monthKeyForIncome: string | null = null

  if (scope === 'weekly') {
    const weekStart = String((body as any).week_start || '').trim()
    const weekStartYmd = weekStart || toYmdUTC(new Date())
    const wb = weekBoundariesFromStartYmd(weekStartYmd)
    startISO = wb.startISO
    endISO = wb.endISO
    prevStartISO = wb.prevStartISO
    prevEndISO = wb.prevEndISO
    periodKey = wb.periodKey
  } else {
    const month = String((body as any).month || '').trim()
    if (!month) {
      return json({ ok: false, error: 'month is required (e.g. 2025-11)' }, 400)
    }
    const mb = monthBoundaries(month)
    startISO = mb.startISO
    endISO = mb.endISO
    prevStartISO = mb.prevStartISO
    prevEndISO = mb.prevEndISO
    periodKey = month
    monthKeyForIncome = month
  }

  const { data: txnRows, error: txnError } = await supabase
    .from('wallet_transactions')
    .select('wallet_id, amount, reporting_amount, reporting_currency, category, category_id, date, title, note')
    .eq('user_id', userId)
    .gte('date', startISO)
    .lte('date', endISO)

  if (txnError) {
    logError('spending_engine.v2.txn_error', { userToken: getAnonymousUserToken(userId), error: txnError.message })
    return json({ ok: false, error: 'Failed to load transactions' }, 500)
  }

  const currentTxns = await normalizeTxnRowsForMainCurrency(
    supabase,
    userId,
    currencyCode,
    (txnRows || []) as Array<Record<string, unknown>>,
    'v2_current_period',
  )
  if (!currentTxns.length) {
    return json({ ok: true, scope, period_key: periodKey, cards: [] })
  }

  const { data: prevRows } = await supabase
    .from('wallet_transactions')
    .select('wallet_id, amount, reporting_amount, reporting_currency, category, category_id, date, title, note')
    .eq('user_id', userId)
    .gte('date', prevStartISO)
    .lte('date', prevEndISO)

  const prevTxns = await normalizeTxnRowsForMainCurrency(
    supabase,
    userId,
    currencyCode,
    (prevRows || []) as Array<Record<string, unknown>>,
    'v2_previous_period',
  )

  const currentExpenseCents = sumExpenseCents(currentTxns)
  const prevExpenseCents = sumExpenseCents(prevTxns)

  const currentByCat = sumExpenseCentsByCategory(currentTxns)
  const prevByCat = sumExpenseCentsByCategory(prevTxns)

  const startYmd = startISO.slice(0, 10)
  const endYmd = endISO.slice(0, 10)

  const budgets = await loadBudgetsForRange(supabase, userId, startYmd, endYmd)
  const categoryNameById = await loadCategoryNameMap(supabase, userId)

  const budgetedCats = new Set<string>()
  const candidates: CandidateInsight[] = []

  // 1) Budget overrun (only if budgets exist in cloud)
  for (const b of budgets) {
    const amountCents = Number((b as any).amount_cents)
    if (!Number.isFinite(amountCents) || amountCents <= 0) continue

    const rawCatName = (b.category_id && categoryNameById.get(String(b.category_id)))
      ? String(categoryNameById.get(String(b.category_id)))
      : String((b as any).name || '').trim()

    if (!rawCatName) continue

    // Normalize to category key for fallback
    const catKey = toCategoryKey(rawCatName)
    budgetedCats.add(catKey)

    // Phase 2: Also add UUID to budgetedCats if available
    if (b.category_id) {
      budgetedCats.add(String(b.category_id))
    }

    // Phase 2: Check UUID first, then fall back to string key
    // This ensures new transactions (with category_id) match budgets correctly
    const uuidKey = b.category_id ? String(b.category_id) : null
    const spentValue = (uuidKey && currentByCat.get(uuidKey)) ?? currentByCat.get(catKey) ?? 0
    const spent = Number(spentValue)

    if (spent <= 0) continue

    const ratio = spent / amountCents
    if (ratio < 1.0) continue

    const overBy = spent - amountCents
    const share = currentExpenseCents > 0 ? (spent / currentExpenseCents) * 100 : 0
    const score = (ratio - 1.0) * 1000 + share * 10 + Math.min(spent / 1000, 800)

    candidates.push({
      insight_type: 'BUDGET_OVER',
      insight_key: catKey,  // Use category key
      score,
      badge: { label: 'Biggest opportunity', tone: 'warn' },
      cardTitle: `${rawCatName} is over budget`,  // Display original name
      cardSubtitle: `Over by ${formatCents(overBy, currencySymbol)}.`,
      body: `You're over your ${rawCatName} budget. Adjusting it now (or slowing down this category) can keep the rest of the period comfortable.`,
      proof: [
        { label: 'Spent', value: `${formatCents(spent, currencySymbol)} / ${formatCents(amountCents, currencySymbol)}` },
        { label: 'Over by', value: formatCents(overBy, currencySymbol) },
        { label: 'Share', value: `${share.toFixed(0)}% of spending` }
      ],
      actions: [
        { kind: 'primary', label: `Edit ${rawCatName} Budget`, action_type: 'edit_budget', payload: { budget_id: (b as any).id, category_id: b.category_id } },
        { kind: 'secondary', label: `View ${rawCatName} Transactions`, action_type: 'view_transactions', payload: { category: rawCatName, category_id: b.category_id, scope, period_key: periodKey } }
      ]
    })
  }

  // 1b) Focus category (works even if budgets are missing)
  if (currentExpenseCents > 0) {
    let topCat: { cat: string; spent: number } | null = null
    for (const [cat, spent] of currentByCat.entries()) {
      if (!cat || spent <= 0) continue
      if (!topCat || spent > topCat.spent) topCat = { cat, spent }
    }

    if (topCat) {
      const share = (topCat.spent / currentExpenseCents) * 100
      if (share >= 30) {
        // Phase 2: cat may be UUID or string key
        // Resolve display name: if cat is a UUID, look it up; otherwise use as-is
        const displayName = categoryNameById.get(topCat.cat) || topCat.cat
        const score = share * 18 + Math.min(topCat.spent / 2000, 700)
        // Use key as-is for budget check (budgetedCats has both UUIDs and string keys)
        const hasBudget = budgetedCats.has(topCat.cat)

        candidates.push({
          insight_type: scope === 'weekly' ? 'WEEKLY_FOCUS_CATEGORY' : 'FOCUS_CATEGORY',
          insight_key: topCat.cat,  // Use actual key (UUID or string)
          score,
          badge: { label: scope === 'weekly' ? 'Focus area' : 'Focus area', tone: 'warn' },
          cardTitle: `${displayName} is driving your spending`,
          cardSubtitle: `${share.toFixed(0)}% of ${scope === 'weekly' ? 'this week' : 'this month'}.`,
          body: `${displayName} is the biggest part of your spending right now. A ${scope === 'weekly' ? 'weekly' : 'monthly'} budget can make it predictable.`,
          proof: [
            { label: displayName, value: formatCents(topCat.spent, currencySymbol) },
            { label: 'Share', value: `${share.toFixed(0)}% of spending` }
          ],
          actions: hasBudget
            ? [
              { kind: 'primary', label: `Edit ${displayName} Budget`, action_type: 'edit_budget', payload: { category: displayName, category_id: looksLikeUuid(topCat.cat) ? topCat.cat : null } },
              { kind: 'secondary', label: `View ${displayName} Transactions`, action_type: 'view_transactions', payload: { category: displayName, category_id: looksLikeUuid(topCat.cat) ? topCat.cat : null, scope, period_key: periodKey } }
            ]
            : [
              { kind: 'primary', label: `Create ${displayName} Budget`, action_type: 'create_budget', payload: { category: displayName, category_id: looksLikeUuid(topCat.cat) ? topCat.cat : null, period: scope === 'weekly' ? 'WEEKLY' : 'MONTHLY' } },
              { kind: 'secondary', label: `View ${displayName} Transactions`, action_type: 'view_transactions', payload: { category: displayName, category_id: looksLikeUuid(topCat.cat) ? topCat.cat : null, scope, period_key: periodKey } }
            ]
        })
      }
    }
  }

  // 2) Missing budget for a large, budgetable category
  let topMissing: { cat: string; spent: number } | null = null
  for (const [cat, spent] of currentByCat.entries()) {
    if (!cat) continue
    if (spent <= 0) continue
    // Phase 2: cat may be UUID or string key - use as-is for budget check
    if (budgetedCats.has(cat)) continue

    // Phase 2: Resolve name for isBudgetableCategory (it expects a name, not UUID)
    const catNameForCheck = categoryNameById.get(cat)

    // Safety: If cat is a UUID but has no resolved name, skip this candidate
    // (prevents passing UUIDs to isBudgetableCategory which expects human-readable names)
    if (!catNameForCheck && looksLikeUuid(cat)) {
      log('spending_engine.missing_budget_skip_unknown_uuid', { userToken: getAnonymousUserToken(userId), categoryId: cat })
      continue
    }

    // Use resolved name or fall back to cat itself (for legacy string-based categories)
    const budgetable = await isBudgetableCategory(supabase, userId, catNameForCheck || cat)
    if (!budgetable) continue

    if (!topMissing || spent > topMissing.spent) topMissing = { cat, spent }
  }

  if (topMissing) {
    const incomeCents = monthKeyForIncome ? await getMonthlyIncomeCents(supabase, userId, monthKeyForIncome) : null
    const threshold = incomeCents && incomeCents > 0 ? Math.round(incomeCents * 0.10) : Math.round(currentExpenseCents * 0.12)
    if (topMissing.spent >= threshold) {
      const share = currentExpenseCents > 0 ? (topMissing.spent / currentExpenseCents) * 100 : 0
      const score = share * 20 + Math.min(topMissing.spent / 1200, 700)
      // Phase 2: Resolve display name for UI
      const displayName = categoryNameById.get(topMissing.cat) || topMissing.cat
      candidates.push({
        insight_type: 'BUDGET_MISSING',
        insight_key: topMissing.cat,  // Use actual key (UUID or string)
        score,
        badge: { label: 'Budget gap', tone: 'purple' },
        cardTitle: `${displayName} has no budget`,
        cardSubtitle: `${formatCents(topMissing.spent, currencySymbol)} this ${scope === 'weekly' ? 'week' : 'month'}.`,
        body: `${displayName} is one of your biggest categories right now, but there's no budget set for it. Creating a budget turns this into something you can control.`,
        proof: [
          { label: scope === 'weekly' ? 'This week' : 'This month', value: formatCents(topMissing.spent, currencySymbol) },
          { label: 'Share', value: `${share.toFixed(0)}% of spending` }
        ],
        actions: [
          { kind: 'primary', label: `Create ${displayName} Budget`, action_type: 'create_budget', payload: { category: displayName, category_id: looksLikeUuid(topMissing.cat) ? topMissing.cat : null, period: scope === 'weekly' ? 'WEEKLY' : 'MONTHLY' } },
          { kind: 'secondary', label: `View ${displayName} Transactions`, action_type: 'view_transactions', payload: { category: displayName, category_id: looksLikeUuid(topMissing.cat) ? topMissing.cat : null, scope, period_key: periodKey } }
        ]
      })
    }
  }

  // 2b) Category change vs previous period
  if (prevExpenseCents > 0 && currentExpenseCents > 0) {
    let bestChange: { cat: string; thisSpent: number; prevSpent: number; share: number; pct: number; score: number } | null = null

    for (const [cat, spent] of currentByCat.entries()) {
      if (!cat || spent <= 0) continue
      const prev = prevByCat.get(cat) || 0
      if (prev <= 0) continue

      const share = (spent / currentExpenseCents) * 100
      if (share < 8) continue

      const pct = ((spent - prev) / prev) * 100
      if (Math.abs(pct) < 25) continue

      const score = Math.abs(pct) * 10 + share * 10 + Math.min(spent / 2500, 600)
      if (!bestChange || score > bestChange.score) {
        bestChange = { cat, thisSpent: spent, prevSpent: prev, share, pct, score }
      }
    }

    if (bestChange) {
      const up = bestChange.pct > 0
      // Phase 2: Resolve display name for UUID keys
      const displayName = categoryNameById.get(bestChange.cat) || bestChange.cat
      // Use key as-is for budget check (budgetedCats has both UUIDs and string keys)
      const hasBudget = budgetedCats.has(bestChange.cat)

      candidates.push({
        insight_type: 'CATEGORY_CHANGE',
        insight_key: bestChange.cat,  // Use actual key (UUID or string)
        score: bestChange.score,
        badge: { label: 'Trend', tone: up ? 'warn' : 'green' },
        cardTitle: up ? `Spending jumped in ${displayName}` : `You cut ${displayName} spending`,
        cardSubtitle: `${bestChange.pct.toFixed(0)}% vs previous ${scope === 'weekly' ? 'week' : 'month'}.`,
        body: up
          ? `${displayName} increased a lot compared to the previous ${scope === 'weekly' ? 'week' : 'month'}. If this wasn't planned, setting a budget here is the fastest way to control it.`
          : `${displayName} dropped compared to the previous ${scope === 'weekly' ? 'week' : 'month'}. If it feels comfortable, keeping a budget here can help you stay consistent.`,
        proof: [
          { label: scope === 'weekly' ? 'This week' : 'This month', value: formatCents(bestChange.thisSpent, currencySymbol) },
          { label: scope === 'weekly' ? 'Last week' : 'Last month', value: formatCents(bestChange.prevSpent, currencySymbol) },
          { label: 'Share', value: `${bestChange.share.toFixed(0)}%` }
        ],
        actions: hasBudget
          ? [
            { kind: 'primary', label: `Edit ${displayName} Budget`, action_type: 'edit_budget', payload: { category: displayName, category_id: looksLikeUuid(bestChange.cat) ? bestChange.cat : null } },
            { kind: 'secondary', label: `View ${displayName} Transactions`, action_type: 'view_transactions', payload: { category: displayName, category_id: looksLikeUuid(bestChange.cat) ? bestChange.cat : null, scope, period_key: periodKey } }
          ]
          : [
            { kind: 'primary', label: `Create ${displayName} Budget`, action_type: 'create_budget', payload: { category: displayName, category_id: looksLikeUuid(bestChange.cat) ? bestChange.cat : null, period: scope === 'weekly' ? 'WEEKLY' : 'MONTHLY' } },
            { kind: 'secondary', label: `View ${displayName} Transactions`, action_type: 'view_transactions', payload: { category: displayName, category_id: looksLikeUuid(bestChange.cat) ? bestChange.cat : null, scope, period_key: periodKey } }
          ]
      })
    }
  }

  // 2c) Small purchases adding up (currency-aware)
  const expAmounts = expenseAmountsCents(currentTxns)
  if (expAmounts.length >= 10) {
    const med = median(expAmounts)
    const threshold = Math.max(3000, Math.round(med * 0.6))
    let count = 0
    let total = 0
    for (const c of expAmounts) {
      if (c > 0 && c <= threshold) {
        count++
        total += c
      }
    }
    const share = currentExpenseCents > 0 ? (total / currentExpenseCents) * 100 : 0
    if (count >= 10 && total > 0 && share >= 6) {
      const score = share * 18 + Math.min(total / 1800, 700)
      candidates.push({
        insight_type: 'SMALL_PURCHASES',
        insight_key: '',
        score,
        badge: { label: 'Pattern', tone: 'purple' },
        cardTitle: 'Small purchases are adding up',
        cardSubtitle: `${count} small spends • ${formatCents(total, currencySymbol)} total.`,
        body: `You made many smaller purchases in this period. A small budget for a flexible category can keep these under control without feeling strict.`,
        proof: [
          { label: 'Count', value: String(count) },
          { label: 'Total', value: formatCents(total, currencySymbol) },
          { label: 'Share', value: `${share.toFixed(0)}% of spending` }
        ],
        actions: [
          { kind: 'primary', label: 'Create a small-spends budget', action_type: 'create_budget', payload: { category: 'Small spends', period: scope === 'weekly' ? 'WEEKLY' : 'MONTHLY' } },
          { kind: 'secondary', label: 'View transactions', action_type: 'view_transactions', payload: { scope, period_key: periodKey } }
        ]
      })
    }
  }

  // 2d) Recurring payments (simple repeat detection by title)
  const recurringMap = new Map<string, { count: number; total: number }>()
  for (const t of currentTxns) {
    const amt = Number(t.amount)
    if (!Number.isFinite(amt) || amt >= 0) continue
    const title = String(t.title || '').trim()
    if (!title) continue
    const norm = normalizeTitleForRecurring(title)
    if (!norm || norm.length < 4) continue
    const cents = Math.round(Math.abs(amt) * 100)
    const curr = recurringMap.get(norm) || { count: 0, total: 0 }
    curr.count += 1
    curr.total += cents
    recurringMap.set(norm, curr)
  }

  if (recurringMap.size && currentExpenseCents > 0) {
    let best: { key: string; count: number; total: number; score: number } | null = null
    for (const [k, v] of recurringMap.entries()) {
      if (v.count < 2) continue
      const share = (v.total / currentExpenseCents) * 100
      if (share < 5) continue
      const score = share * 20 + v.count * 20 + Math.min(v.total / 2500, 650)
      if (!best || score > best.score) best = { key: k, count: v.count, total: v.total, score }
    }

    if (best) {
      candidates.push({
        insight_type: 'RECURRING_PAYMENTS',
        insight_key: best.key,
        score: best.score,
        badge: { label: 'Pattern', tone: 'purple' },
        cardTitle: 'Recurring costs are stacking up',
        cardSubtitle: `${best.count} repeats • ${formatCents(best.total, currencySymbol)} total.`,
        body: `Some payments repeat in this period. Putting recurring costs in a dedicated budget makes them predictable and easier to plan around.`,
        proof: [
          { label: 'Repeats', value: String(best.count) },
          { label: 'Total', value: formatCents(best.total, currencySymbol) }
        ],
        actions: [
          { kind: 'primary', label: 'Create Recurring Budget', action_type: 'create_budget', payload: { category: 'Subscriptions', period: scope === 'weekly' ? 'WEEKLY' : 'MONTHLY' } },
          { kind: 'secondary', label: 'View transactions', action_type: 'view_transactions', payload: { scope, period_key: periodKey } }
        ]
      })
    }
  }

  // 3) Spending change (simple, reliable)
  if (prevExpenseCents > 0 && currentExpenseCents > 0) {
    const diff = currentExpenseCents - prevExpenseCents
    const pct = (diff / prevExpenseCents) * 100
    if (Math.abs(pct) >= 10) {
      const higher = pct > 0
      const score = Math.abs(pct) * 15 + Math.min(currentExpenseCents / 2000, 600)
      candidates.push({
        insight_type: 'SPENDING_CHANGE',
        insight_key: '',
        score,
        badge: { label: higher ? 'Trend' : 'Trend', tone: higher ? 'warn' : 'green' },
        cardTitle: higher ? 'Spending is higher than before' : 'Spending is lower than before',
        cardSubtitle: `${pct.toFixed(0)}% vs previous ${scope === 'weekly' ? 'week' : 'month'}.`,
        body: higher
          ? `Compared to the previous ${scope === 'weekly' ? 'week' : 'month'}, your spending is higher. If this wasn’t planned, tightening one budget category can bring you back on pace.`
          : `Compared to the previous ${scope === 'weekly' ? 'week' : 'month'}, your spending is lower. If this feels comfortable, you could keep budgets steady and move the gap into goals.`,
        proof: [
          { label: 'Current', value: formatCents(currentExpenseCents, currencySymbol) },
          { label: 'Previous', value: formatCents(prevExpenseCents, currencySymbol) },
          { label: 'Change', value: `${pct.toFixed(1)}%` }
        ],
        actions: [
          { kind: 'primary', label: 'Review top categories', action_type: 'open_categories', payload: { scope, period_key: periodKey } },
          { kind: 'secondary', label: 'View transactions', action_type: 'view_transactions', payload: { scope, period_key: periodKey } }
        ]
      })
    }
  }

  // Dedupe, apply feedback and snooze, then select top 3
  const snoozes = await loadActiveSnoozes(supabase, userId, scope)
  const feedback = await loadFeedbackForPeriod(supabase, userId, scope, periodKey)

  const deduped = dedupeByType(candidates)
    .map((c) => ({ ...c, score: c.score - feedbackPenalty(feedback, c.insight_type, c.insight_key) }))
    .filter((c) => !isSnoozed(snoozes, c.insight_type, c.insight_key))
    .sort((a, b) => b.score - a.score)

  const top = deduped.slice(0, 3).map((c) => toV2Card(scope, periodKey, c, currencyCode))

  return json({
    ok: true,
    format: 'v2',
    scope,
    period_key: periodKey,
    cards: top
  })
}

// Shared function to apply pinned copy overlay and format final response
async function applyPinnedOverlayAndFormat(
  supabase: any,
  userId: string,
  month: string,
  persona: string,
  computedInsights: any[],
  shouldStorePinnedCopy: boolean = false
): Promise<any[]> {
  // Store pinned copy if this is a fresh computation (not when overlaying existing)
  if (shouldStorePinnedCopy) {
    await storePinnedInsightCopy(supabase, userId, month, persona, computedInsights)
  }

  // Apply pinned copy overlay
  let finalInsightsWithOverlay = computedInsights

  // Check for existing pinned copy to overlay
  const pinnedCopy = await getPinnedInsightCopy(supabase, userId, month, persona)
  if (pinnedCopy && pinnedCopy.length > 0) {
    log('spending_engine.applying_pinned_overlay', {
      userToken: getAnonymousUserToken(userId),
      month,
      persona,
      computed_count: computedInsights.length,
      pinned_count: pinnedCopy.length
    })

    // Create overlay map by insight ID
    const pinnedById = new Map(pinnedCopy.map(p => [p.id, p]))

    // Overlay pinned copy fields onto computed insights
    finalInsightsWithOverlay = computedInsights.map(computed => {
      const pinned = pinnedById.get(computed.id)
      if (pinned) {
        // Overlay pinned copy fields while preserving computed data
        return {
          ...computed, // Keep all computed fields (detailStats, quickWinLabel, etc.)
          // Overlay pinned copy fields
          title: pinned.title || computed.title,
          short: pinned.short || computed.short,
          // recommendation: pinned.recommendation || computed.recommendation, // REMOVED
          // Overlay Strategy B fields if available
          ...(pinned.summaryLine ? { summaryLine: pinned.summaryLine } : {}),
          ...(pinned.whyItMatters ? { whyItMatters: pinned.whyItMatters } : {}),
          ...(pinned.quickWin ? { quickWin: pinned.quickWin } : {})
        }
      }
      return computed // No pinned copy for this insight
    })

    log('spending_engine.pinned_overlay_applied', {
      userToken: getAnonymousUserToken(userId),
      month,
      persona,
      overlaid_count: finalInsightsWithOverlay.filter(i => pinnedById.has(i.id)).length
    })
  } else {
    log('spending_engine.no_pinned_overlay', { userToken: getAnonymousUserToken(userId), month, persona })
  }

  // Format final response with all required fields
  return finalInsightsWithOverlay.map((i) => ({
    id: i.id,
    ...(i.type ? { insight_type: i.type } : {}),
    title: i.title,
    short: i.short,

    detailStats: i.detailStats || [],
    // 3-word notification card copy (new)
    notification_title: i.notification_title || i.title,
    notification_subtitle: i.notification_subtitle || i.short,
    // Legacy notification fields (for backward compatibility)
    notification_body: i.short,
    // Quick Win Action fields (preserved from computation)
    ...(i.quickWinLabel ? { quickWinLabel: i.quickWinLabel } : {}),
    ...(i.quickWinActionType ? { quickWinActionType: i.quickWinActionType } : {}),
    ...(i.quickWinPayload ? { quickWinPayload: i.quickWinPayload } : {}),
    // ONE BRAIN Strategy B fields (only if feature enabled and content exists)
    ...(ONE_BRAIN_STRATEGY_B_ENABLED && i.summaryLine ? { summaryLine: i.summaryLine } : {}),
    ...(ONE_BRAIN_STRATEGY_B_ENABLED && i.whyItMatters ? { whyItMatters: i.whyItMatters } : {}),
    ...(ONE_BRAIN_STRATEGY_B_ENABLED && i.quickWin ? { quickWin: i.quickWin } : {})
  }))
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders() })
  }

  try {
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    const userId = user.id as string

    const body = await req.json().catch(() => ({}))
    const format = String((body as any).format || '').trim().toLowerCase()
    // EMERGENCY BYPASS: Disable V2 routing to restore insights immediately
    if (format === 'v2') {
      log('spending_engine.v2_bypass', { userToken: getAnonymousUserToken(userId), format, bypassed: true })
    }
    // if (format === 'v2') {
    //   return await handleV2(body, supabase, userId)
    // }

    const month = String((body as any).month || '').trim() // YYYY-MM
    const localeRaw = String((body as any).locale || 'en').trim().toLowerCase()
    const locale = localeRaw.split('-')[0] // Normalize "es-ES" → "es", "ru-RU" → "ru"
    const currencyResolution = await resolveMainCurrencyCode(supabase, userId, {
      headerCurrency: req.headers.get('x-main-currency'),
      bodyCurrency: (body as any).currencyCode,
    })
    const currencyCode = currencyResolution.currency // Main Currency support
    const rawInsights = Array.isArray((body as any).rawInsights) ? (body as any).rawInsights : []

    // Phase 1: Add persona parameter support
    const personaRaw = String((body as any).persona || 'companion').trim().toLowerCase()
    const persona = ['coach', 'companion'].includes(personaRaw) ? personaRaw : 'companion'

    if (!month) {
      return json({ ok: false, error: 'month is required (e.g. 2025-11)' }, 400)
    }

    // Log request parameters including new persona support
    log('spending_engine.request', { userToken: getAnonymousUserToken(userId), month, locale, currencyCode, persona, rawInsightsCount: rawInsights.length })

    // CRITICAL FIX: Always compute fresh insights first, then overlay pinned copy
    // This ensures new insights (like TOP_CATEGORY) can appear even when copy is pinned

    // Get currency symbol for formatting
    const currencySymbol = getCurrencySymbol(currencyCode)

    const { startISO, endISO, prevStartISO, prevEndISO } = monthBoundaries(month)

    // ========================================================================
    // PHASE 2B: CACHE HIT/MISS LOGIC (moved up to always run)
    // ========================================================================
    const cacheStartTime = Date.now()

    // 1. Check if aggregate exists and is fresh (currency-filtered)
    const { data: aggregateRow, error: aggError } = await supabase
      .from('user_monthly_spending_aggregates')
      .select('*')
      .eq('user_id', userId)
      .eq('month_key', month)
      .eq('currency_code', currencyCode)
      .maybeSingle()

    if (aggError) {
      logError('spending_engine.aggregate_check_error', { userToken: getAnonymousUserToken(userId), month, currency: currencyCode, error: aggError.message })
    }

    let aggregate = aggregateRow
    let cacheHit = false

    if (aggregate) {
      // Check if cache is fresh (currency-aware)
      const { data: isFresh, error: freshError } = await supabase
        .rpc('is_aggregate_cache_fresh', {
          p_user_id: userId,
          p_month_key: month,
          p_currency_code: currencyCode
        })

      if (freshError) {
        logError('spending_engine.cache_fresh_check_error', { userToken: getAnonymousUserToken(userId), month, error: freshError.message })
        // If freshness check fails, treat as cache miss (force recompute)
        aggregate = null
      } else if (isFresh) {
        cacheHit = true
        const cacheDuration = Date.now() - cacheStartTime
        log('spending_engine.cache_hit', { userToken: getAnonymousUserToken(userId), month, duration_ms: cacheDuration })
      } else {
        log('spending_engine.cache_stale', { userToken: getAnonymousUserToken(userId), month })
        aggregate = null // Force recompute
      }
    }

    // 2. Cache miss or stale - recompute aggregate (currency-aware)
    if (!aggregate) {
      log('spending_engine.cache_miss', { userToken: getAnonymousUserToken(userId), month, currency: currencyCode })

      const computeStartTime = Date.now()

      // Call upsert_monthly_aggregate to compute and save (with currency)
      const { error: upsertError } = await supabase
        .rpc('upsert_monthly_aggregate', {
          p_user_id: userId,
          p_month_key: month,
          p_currency_code: currencyCode
        })

      if (upsertError) {
        logError('spending_engine.aggregate_compute_error', { userToken: getAnonymousUserToken(userId), month, currency: currencyCode, error: upsertError.message })
        // Fall back to raw transaction queries
        log('spending_engine.fallback_to_raw_txns', { userToken: getAnonymousUserToken(userId), month, currency: currencyCode })
      } else {
        // Re-read the computed aggregate (currency-filtered)
        const { data: freshAggregate, error: readError } = await supabase
          .from('user_monthly_spending_aggregates')
          .select('*')
          .eq('user_id', userId)
          .eq('month_key', month)
          .eq('currency_code', currencyCode)
          .maybeSingle()

        if (readError) {
          logError('spending_engine.aggregate_read_error', { userToken: getAnonymousUserToken(userId), month, error: readError.message })
        } else {
          aggregate = freshAggregate
          const computeDuration = Date.now() - computeStartTime
          log('spending_engine.aggregate_computed', {
            userToken: getAnonymousUserToken(userId),
            month,
            duration_ms: computeDuration,
            expense_cents: aggregate?.total_expense_cents,
            income_cents: aggregate?.total_income_cents,
            txn_count: aggregate?.transaction_count
          })
        }
      }
    }

    // 3. Use aggregate if available, otherwise fall back to raw transactions
    let monthTxns: TxnRow[]
    let prevTxns: TxnRow[]
    let prevAggregate: any = null

    if (aggregate && aggregate.transaction_count > 0) {
      // PHASE 2C: Build insights directly from aggregate data (no raw transaction queries)
      
      // PRODUCT RELIABILITY GUARD: If aggregate exists but has no usable category breakdown,
      // fall back to raw transactions to ensure Mo sees insights.
        const categoryTotals = aggregate.category_totals || {}
        const usableCategoryCount = Object.entries(categoryTotals)
          .filter(([catId]) => {
            const norm = String(catId || "").trim().toLowerCase();
            return norm !== "other" && norm !== "uncategorized" && norm !== "";
          })
          .length

      if (usableCategoryCount === 0 && aggregate.transaction_count > 0) {
        log('spending_engine.aggregate_missing_category_totals_fallback', { 
          userToken: getAnonymousUserToken(userId), 
          month, 
          txn_count: aggregate.transaction_count,
          currency: currencyCode
        })
        // Set aggregate to null to trigger raw transaction fallback below
        aggregate = null
      } else {
        log('spending_engine.using_aggregate', { userToken: getAnonymousUserToken(userId), month, txn_count: aggregate.transaction_count })
      }
    }

    if (aggregate && aggregate.transaction_count > 0) {
      // Also get previous month aggregate for velocity comparisons (currency-filtered)
      const prevMonthKey = getPreviousMonthKey(month)
      const { data: prevAggRow, error: prevAggError } = await supabase
        .from('user_monthly_spending_aggregates')
        .select('*')
        .eq('user_id', userId)
        .eq('month_key', prevMonthKey)
        .eq('currency_code', currencyCode)
        .maybeSingle()

      if (prevAggError) {
        logError('spending_engine.prev_aggregate_error', { userToken: getAnonymousUserToken(userId), prevMonth: prevMonthKey, error: prevAggError.message })
      } else if (prevAggRow) {
        prevAggregate = prevAggRow
        log('spending_engine.prev_aggregate_found', { userToken: getAnonymousUserToken(userId), prevMonth: prevMonthKey })
      }

      // Build insights from aggregate data (no transaction queries)
      const goalsSummary = await buildGoalsAndChallengesSummary(supabase, userId)
      const categoryNameById = await loadCategoryNameMap(supabase, userId)
      // Use the currencySymbol from the request payload (Main Currency)
      // const currencySymbol = await getCurrencySymbolForUser(supabase, userId)

      const baseInsights = buildSpendingInsightsFromAggregates(
        aggregate,
        prevAggregate,
        month,
        categoryNameById,
        locale,
        currencySymbol,
        userId,
        persona,
        currencyCode
      )

      // Filter snoozed and non-localized insights
      const { data: snoozeRows, error: snoozeError } = await supabase
        .from('insight_snoozes')
        .select('insight_id')
        .eq('user_id', userId)
        .eq('month_key', month)

      if (snoozeError) {
        logError('spending_engine.snoozes_error', { userToken: getAnonymousUserToken(userId), error: snoozeError.message })
      }

      const snoozedIds = new Set(
        (snoozeRows || [])
          .map((r: any) => String(r.insight_id || ''))
          .filter((id: string) => id.length > 0)
      )

      const localizedTypes = locale === 'en'
        ? null
        : new Set(['SPENDING_VELOCITY', 'WEEKEND_SPIKE', 'SPIKE_DAY', 'TOP_CATEGORY', 'SMALL_LEAKS', 'SUBSCRIPTIONS', 'INCOME_SHARE', 'TIME_OF_DAY', 'GOAL_CONTRIB', 'CATEGORY_CHANGE_UP', 'CATEGORY_CHANGE_DOWN'])

      const filteredInsights = baseInsights.filter((i) => {
        if (snoozedIds.has(i.id)) return false
        if (localizedTypes && !localizedTypes.has(i.type)) return false
        return true
      })

      if (!filteredInsights.length) {
        log('spending_engine.no_insights', { userToken: getAnonymousUserToken(userId), month, locale })
        return json({ ok: true, insights: [] })
      }

      const rewritten = filteredInsights.map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        short: i.short,
        // recommendation: i.recommendation, // REMOVED
        detailStats: i.detailStats || [],
        notification_title: i.title,
        notification_body: i.short
      }))

      log('spending_engine.generated_from_aggregate', {
        userToken: getAnonymousUserToken(userId),
        month,
        locale,
        raw_count: filteredInsights.length,
        final_count: rewritten.length
      })

      // Queue LLM rewrite job (fire-and-forget, non-blocking)
      void (async () => {
        try {
          await supabase.rpc('enqueue_llm_rewrite', {
            p_user_id: userId,
            p_month_key: month,
            p_insights: filteredInsights,
            p_locale: locale,
            p_currency_code: currencyCode,
          })
          log('spending_engine.llm_job_queued', { userToken: getAnonymousUserToken(userId), month, locale })
        } catch (queueError) {
          logError('spending_engine.llm_queue_failed', {
            userToken: getAnonymousUserToken(userId),
            month,
            error: String(queueError),
          })
        }
      })()

      // ONE BRAIN Strategy B: Generate Strategy B content if feature enabled
      let insightsForOverlay = rewritten
      if (ONE_BRAIN_STRATEGY_B_ENABLED) {
        log('spending_engine.strategy_b_generation_start_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          count: rewritten.length
        })

        const strategyBPromises = rewritten.map(async (insight) => {
          const originalInsight = filteredInsights.find(orig => orig.id === insight.id)
          const detailStats = originalInsight?.detailStats || insight.detailStats || []

          try {
            const strategyBContent = await generateStrategyBContent(
              insight,
              persona,
              detailStats,
              // Pass traditional fields for emoji coordination
              // recommendation: insight.recommendation // REMOVED
              { title: insight.title, short: insight.short }
            )
            return {
              ...insight,
              ...(originalInsight?.type ? { type: originalInsight.type } : {}),
              detailStats,
              summaryLine: strategyBContent.summaryLine,
              whyItMatters: strategyBContent.whyItMatters,
              quickWin: strategyBContent.quickWin,
              // FIX: Preserve Quick Win action fields from original computed insight
              ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
              ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
              ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
            }
          } catch (e) {
            logError('spending_engine.strategy_b_insight_error_aggregate', {
              userToken: getAnonymousUserToken(userId),
              insightId: insight.id,
              error: String(e)
            })
            return {
              ...insight,
              ...(originalInsight?.type ? { type: originalInsight.type } : {}),
              detailStats,
              ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
              ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
              ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
            }
          }
        })

        insightsForOverlay = await Promise.all(strategyBPromises)

        log('spending_engine.strategy_b_generation_complete_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          count: insightsForOverlay.length
        })
      } else {
        // When Strategy B is disabled, we still need to map back to original insights with Quick Win fields
        insightsForOverlay = rewritten.map(insight => {
          const originalInsight = filteredInsights.find(orig => orig.id === insight.id)
          return {
            ...insight,
            ...(originalInsight?.type ? { type: originalInsight.type } : {}),
            detailStats: originalInsight?.detailStats || insight.detailStats || [],
            // Preserve Quick Win fields from original computation
            ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
            ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
            ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
          }
        })
      }

      // ALWAYS apply overlay and format final response (regardless of Strategy B flag)
      const existingPinnedCopy = await getPinnedInsightCopy(supabase, userId, month, persona)
      const shouldStore = !existingPinnedCopy || existingPinnedCopy.length === 0

      if (shouldStore) {
        log('spending_engine.storing_new_pinned_copy_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          count: insightsForOverlay.length
        })
      } else {
        log('spending_engine.skipping_pinned_overwrite_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          existing_count: existingPinnedCopy.length
        })
      }

      // Apply overlay and format final response (ALWAYS, regardless of Strategy B flag)
      const finalRewritten = await applyPinnedOverlayAndFormat(
        supabase,
        userId,
        month,
        persona,
        insightsForOverlay,
        shouldStore
      )

      // Phase 1.5: Generate 3-word notification card copy for aggregate path
      // OPTIMIZATION: Use deterministic fallback templates directly (no LLM - saves Gemini tokens)
      let finalWithNotificationCopy = finalRewritten
      try {
        log('spending_engine.3word_generation_start_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          count: finalRewritten.length,
          method: 'deterministic_fallback'
        })

        // Convert to RawInsight format for fallback generation
        const insightsAsRaw: RawInsight[] = finalRewritten.map(insight => ({
          id: insight.id,
          type: insight.type || 'DEFAULT',
          title: insight.title,
          short: insight.short,
          // recommendation: insight.recommendation // REMOVED,
          metadata: insight.metadata || {}
        }))

        // Use deterministic fallback templates directly (no LLM, saves tokens)
        const threeWordCopy = generateThreeWordFallbackCopy(insightsAsRaw)
        const copyById = new Map(threeWordCopy.map(c => [c.id, c]))

        finalWithNotificationCopy = finalRewritten.map(insight => {
          const copy = copyById.get(insight.id)
          if (copy) {
            return {
              ...insight,
              notification_title: copy.title,
              notification_subtitle: copy.subtitle
            }
          }
          return insight
        })

        log('spending_engine.3word_generation_complete_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          count: finalWithNotificationCopy.length,
          copy_count: threeWordCopy.length,
          method: 'deterministic_fallback'
        })

      } catch (e) {
        logError('spending_engine.3word_generation_error_aggregate', {
          userToken: getAnonymousUserToken(userId),
          month,
          error: String(e)
        })

        // Apply deterministic fallback
        try {
          const insightsAsRaw: RawInsight[] = finalRewritten.map(insight => ({
            id: insight.id,
            type: insight.type || 'DEFAULT',
            title: insight.title,
            short: insight.short,
            // recommendation: insight.recommendation // REMOVED,
            metadata: insight.metadata || {}
          }))

          const fallbackCopy = generateThreeWordFallbackCopy(insightsAsRaw)
          const fallbackById = new Map(fallbackCopy.map(c => [c.id, c]))

          finalWithNotificationCopy = finalRewritten.map(insight => {
            const copy = fallbackById.get(insight.id)
            if (copy) {
              return {
                ...insight,
                notification_title: copy.title,
                notification_subtitle: copy.subtitle
              }
            }
            return insight
          })

          log('spending_engine.3word_fallback_applied_aggregate', {
            userToken: getAnonymousUserToken(userId),
            month,
            persona,
            count: fallbackCopy.length
          })
        } catch (fallbackError) {
          logError('spending_engine.3word_fallback_error_aggregate', {
            userToken: getAnonymousUserToken(userId),
            month,
            error: String(fallbackError)
          })
        }
      }

      return json({ ok: true, insights: finalWithNotificationCopy })
    } else {
      // Fallback: No aggregate or empty month - use raw transactions
      log('spending_engine.using_raw_txns', { userToken: getAnonymousUserToken(userId), month })

      const { data: monthRows, error: monthError } = await supabase
        .from('wallet_transactions')
        .select('wallet_id, amount, reporting_amount, reporting_currency, category, category_id, date, title, note')
        .eq('user_id', userId)
        .gte('date', startISO)
        .lte('date', endISO)

      if (monthError) {
        logError('spending_engine.txn_error', { userToken: getAnonymousUserToken(userId), error: monthError.message })
        return json({ ok: false, error: 'Failed to load transactions' }, 500)
      }

      monthTxns = await normalizeTxnRowsForMainCurrency(
        supabase,
        userId,
        currencyCode,
        (monthRows || []) as Array<Record<string, unknown>>,
        'fallback_current_period',
      )
    }

    if (!monthTxns.length) {
      return json({ ok: true, insights: [] })
    }

    // ========================================================================
    // END CACHE LOGIC - Continue with existing flow (fallback path)
    // ========================================================================

    // Previous month for velocity / progress
    const { data: prevRows, error: prevError } = await supabase
      .from('wallet_transactions')
      .select('wallet_id, amount, reporting_amount, reporting_currency, category, category_id, date, title, note')
      .eq('user_id', userId)
      .gte('date', prevStartISO)
      .lte('date', prevEndISO)

    if (prevError) {
      logError('spending_engine.prev_txn_error', { userToken: getAnonymousUserToken(userId), error: prevError.message })
    }

    prevTxns = await normalizeTxnRowsForMainCurrency(
      supabase,
      userId,
      currencyCode,
      (prevRows || []) as Array<Record<string, unknown>>,
      'fallback_previous_period',
    )

    const { data: snoozeRows, error: snoozeError } = await supabase
      .from('insight_snoozes')
      .select('insight_id')
      .eq('user_id', userId)
      .eq('month_key', month)

    if (snoozeError) {
      logError('spending_engine.snoozes_error', { userToken: getAnonymousUserToken(userId), error: snoozeError.message })
    }

    const snoozedIds = new Set(
      (snoozeRows || [])
        .map((r: any) => String(r.insight_id || ''))
        .filter((id: string) => id.length > 0)
    )

    const goalsSummary = await buildGoalsAndChallengesSummary(supabase, userId)
    const categoryNameById = await loadCategoryNameMap(supabase, userId)
    // Use the currencySymbol from the request payload (Main Currency)
    // const currencySymbol = await getCurrencySymbolForUser(supabase, userId)

    const baseInsights = buildSpendingInsightsFromServer(monthTxns, prevTxns, month, categoryNameById, locale, currencySymbol, userId, currencyCode)

    // For non-EN locales, only show insights that are fully localized
    const localizedTypes = locale === 'en'
      ? null // Show all for English
      : new Set(['SPENDING_VELOCITY', 'WEEKEND_SPIKE', 'SPIKE_DAY', 'TOP_CATEGORY', 'SMALL_LEAKS', 'SUBSCRIPTIONS', 'INCOME_SHARE', 'TIME_OF_DAY', 'GOAL_CONTRIB', 'CATEGORY_CHANGE_UP', 'CATEGORY_CHANGE_DOWN']) // All 10 types now localized

    const filteredInsights = baseInsights.filter((i) => {
      // Filter out snoozed insights
      if (snoozedIds.has(i.id)) return false
      // For non-EN, filter out non-localized insight types
      if (localizedTypes && !localizedTypes.has(i.type)) return false
      return true
    })

    if (!filteredInsights.length) {
      log('spending_engine.no_insights', { userToken: getAnonymousUserToken(userId), month, locale })
      return json({ ok: true, insights: [] })
    }

    // Phase 1: Generate persona-aware Gemini copy and store as pinned
    const rewrittenInsights = await generatePersonaAwareInsights(
      filteredInsights,
      month,
      goalsSummary,
      persona,
      generateVariantSlot
    )

    // ONE BRAIN Strategy B: Generate Strategy B content if feature enabled
    let insightsWithStrategyB = rewrittenInsights
    if (ONE_BRAIN_STRATEGY_B_ENABLED) {
      // LLM call gate: Only generate Strategy B content on cache-miss (not already pinned)
      log('spending_engine.strategy_b_generation_start', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        count: rewrittenInsights.length
      })

      const strategyBPromises = rewrittenInsights.map(async (insight) => {
        const originalInsight = filteredInsights.find(orig => orig.id === insight.id)
        const detailStats = originalInsight?.detailStats || []

        try {
          const strategyBContent = await generateStrategyBContent(
            insight,
            persona,
            detailStats,
            // Pass traditional fields for emoji coordination
            { title: insight.title, short: insight.short } // recommendation: insight.recommendation // REMOVED
          )
          return {
            ...insight,
            type: originalInsight?.type,
            detailStats,
            summaryLine: strategyBContent.summaryLine,
            whyItMatters: strategyBContent.whyItMatters,
            quickWin: strategyBContent.quickWin,
            // FIX: Preserve Quick Win action fields from original computed insight
            ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
            ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
            ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
          }
        } catch (e) {
          logError('spending_engine.strategy_b_insight_error', {
            userToken: getAnonymousUserToken(userId),
            insightId: insight.id,
            error: String(e)
          })
          return {
            ...insight,
            ...(originalInsight?.type ? { type: originalInsight.type } : {}),
            detailStats,
            ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
            ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
            ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
          }
        }
      })

      insightsWithStrategyB = await Promise.all(strategyBPromises)

      log('spending_engine.strategy_b_generation_complete', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        count: insightsWithStrategyB.length
      })
    }

    if (!ONE_BRAIN_STRATEGY_B_ENABLED) {
      insightsWithStrategyB = rewrittenInsights.map((insight) => {
        const originalInsight = filteredInsights.find(orig => orig.id === insight.id)
        return {
          ...insight,
          ...(originalInsight?.type ? { type: originalInsight.type } : {}),
          detailStats: originalInsight?.detailStats || [],
          ...(originalInsight?.quickWinLabel ? { quickWinLabel: originalInsight.quickWinLabel } : {}),
          ...(originalInsight?.quickWinActionType ? { quickWinActionType: originalInsight.quickWinActionType } : {}),
          ...(originalInsight?.quickWinPayload ? { quickWinPayload: originalInsight.quickWinPayload } : {})
        }
      })
    }

    // Store pinned copy for future requests ONLY if no pinned copy exists (prevent overwrites)
    const existingPinnedCopy = await getPinnedInsightCopy(supabase, userId, month, persona)
    const shouldStore = !existingPinnedCopy || existingPinnedCopy.length === 0

    if (shouldStore) {
      log('spending_engine.storing_new_pinned_copy_raw', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        count: insightsWithStrategyB.length
      })
    } else {
      log('spending_engine.skipping_pinned_overwrite_raw', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        existing_count: existingPinnedCopy.length
      })
    }

    // Handle partial pinned rows - fill missing Strategy B fields ONCE
    await fillMissingStrategyBFields(supabase, userId, month, persona, filteredInsights)

    // Apply overlay and format response (but don't return yet)
    const finalInsightsWithOverlay = await applyPinnedOverlayAndFormat(
      supabase,
      userId,
      month,
      persona,
      insightsWithStrategyB,
      shouldStore
    )

    // Phase 1.5: Generate 3-word notification card copy AFTER overlay
    // OPTIMIZATION: Use deterministic fallback templates directly (no LLM - saves Gemini tokens)
    let finalInsightsWithNotificationCopy = finalInsightsWithOverlay
    try {
      log('spending_engine.3word_generation_start', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        count: finalInsightsWithOverlay.length,
        method: 'deterministic_fallback'
      })

      // Convert overlaid insights back to RawInsight format for fallback generation
      const overlaidAsRawInsights: RawInsight[] = finalInsightsWithOverlay.map(insight => ({
        id: insight.id,
        type: insight.type || 'DEFAULT',
        title: insight.title,
        short: insight.short,
        // recommendation: insight.recommendation // REMOVED,
        metadata: insight.metadata || {}
      }))

      // Use deterministic fallback templates directly (no LLM, saves tokens)
      const threeWordCopy = generateThreeWordFallbackCopy(overlaidAsRawInsights)

      // Merge 3-word copy with existing insights
      const threeWordById = new Map(threeWordCopy.map(copy => [copy.id, copy]))

      finalInsightsWithNotificationCopy = finalInsightsWithOverlay.map(insight => {
        const notificationCopy = threeWordById.get(insight.id)
        if (notificationCopy) {
          return {
            ...insight,
            notification_title: notificationCopy.title,
            notification_subtitle: notificationCopy.subtitle
          }
        }
        return insight
      })

      log('spending_engine.3word_generation_complete', {
        userToken: getAnonymousUserToken(userId),
        month,
        persona,
        count: finalInsightsWithNotificationCopy.length,
        notification_copy_count: threeWordCopy.length,
        method: 'deterministic_fallback'
      })

    } catch (e) {
      logError('spending_engine.3word_generation_error', {
        userToken: getAnonymousUserToken(userId),
        month,
        error: String(e)
      })

      // CRITICAL FIX: Apply deterministic fallback templates when Gemini fails
      // This ensures cards stay 3-word even during LLM outages (429 errors, etc.)
      try {
        log('spending_engine.3word_generation_fallback', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          reason: 'gemini_error',
          count: finalInsightsWithOverlay.length
        })

        // Convert overlaid insights back to RawInsight format for fallback generation
        const overlaidAsRawInsights: RawInsight[] = finalInsightsWithOverlay.map(insight => ({
          id: insight.id,
          type: insight.type || 'DEFAULT',
          title: insight.title,
          short: insight.short,
          // recommendation: insight.recommendation // REMOVED,
          metadata: insight.metadata || {}
        }))

        // Generate deterministic 3-word fallback copy
        const fallbackCopy = generateThreeWordFallbackCopy(overlaidAsRawInsights)

        // Merge fallback copy with existing insights
        const fallbackById = new Map(fallbackCopy.map(copy => [copy.id, copy]))

        finalInsightsWithNotificationCopy = finalInsightsWithOverlay.map(insight => {
          const notificationCopy = fallbackById.get(insight.id)
          if (notificationCopy) {
            return {
              ...insight,
              notification_title: notificationCopy.title,
              notification_subtitle: notificationCopy.subtitle
            }
          }
          return insight
        })

        log('spending_engine.3word_fallback_applied', {
          userToken: getAnonymousUserToken(userId),
          month,
          persona,
          fallback_count: fallbackCopy.length,
          reason: 'gemini_error'
        })

      } catch (fallbackError) {
        logError('spending_engine.3word_fallback_error', {
          userToken: getAnonymousUserToken(userId),
          month,
          error: String(fallbackError)
        })
        // Last resort: continue with original insights (no notification fields)
      }
    }

    // Return final insights with notification copy
    const finalInsights = finalInsightsWithNotificationCopy

    log('spending_engine.generated', {
      userToken: getAnonymousUserToken(userId),
      month,
      locale,
      persona,
      raw_count: filteredInsights.length,
      final_count: finalInsights.length,
      strategy_b_enabled: ONE_BRAIN_STRATEGY_B_ENABLED
    })

    return json({ ok: true, insights: finalInsights })
  } catch (e) {
    logError('spending_engine.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})

// ============================================================================
// PHASE 2C: Build insights from aggregate data (no raw transaction queries)
// ============================================================================

function buildSpendingInsightsFromAggregates(
  aggregate: any,
  prevAggregate: any | null,
  monthKey: string,
  categoryNameById: Map<string, string>,
  locale: string = 'en',
  currencySymbol: string = '₺',
  userId: string,
  persona: string = 'companion',
  currencyCode: string = 'USD'
): Array<RawInsight & { detailStats?: Array<{ label: string; value: string; valueColor?: string }> }> {
  const insights: Array<RawInsight & { detailStats?: Array<{ label: string; value: string; valueColor?: string }> }> = []
  const strings = getLocalizedStrings(locale)
  const localeTag = locale === 'en' ? 'en-US' : locale === 'es' ? 'es-ES' : locale === 'ru' ? 'ru-RU' : locale === 'fr' ? 'fr-FR' : locale === 'de' ? 'de-DE' : 'en-US'

  // Helper function for generating stable insight IDs
  function generateStableInsightIdLocal(insightType: string, insightKey: string = ''): string {
    return generateStableInsightId(userId, monthKey, insightType, insightKey)
  }

  // Convert cents to dollars for display
  const totalExpense = aggregate.total_expense_cents / 100
  const totalIncome = aggregate.total_income_cents / 100
  const prevTotalExpense = prevAggregate ? prevAggregate.total_expense_cents / 100 : 0

  if (totalExpense === 0) return []

  // ---------- 1) Velocity vs last month ----------
  if (prevTotalExpense > 0 && totalExpense > 0) {
    const diff = totalExpense - prevTotalExpense
    const pct = (diff / prevTotalExpense) * 100
    if (Math.abs(pct) >= 5) {
      const faster = pct > 0

      const title = faster ? strings.velocity_higher : strings.velocity_lower

      const pctFormatted = Math.abs(pct).toFixed(1)
      const currentFormatted = formatMoney(totalExpense, currencySymbol, localeTag)
      const prevFormatted = formatMoney(prevTotalExpense, currencySymbol, localeTag)

      const shortTemplate = faster ? strings.velocity_higher_short : strings.velocity_lower_short
      const short = shortTemplate
        .replace('{pct}', pctFormatted)
        .replace('{current}', currentFormatted)
        .replace('{prev}', prevFormatted)

      // const recommendation = ... // REMOVED

      // Calculate projected month-end from daily totals
      const [yearStr, monthStr] = monthKey.split('-')
      const daysInMonth = new Date(Date.UTC(Number(yearStr), Number(monthStr), 0)).getUTCDate()
      const today = new Date()
      const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
      const isCurrentMonth = monthKey === currentMonth

      const dailyTotals = aggregate.daily_totals || {}
      // Count only expense days (where net < 0) for average calculation
      const expenseDays = Object.values(dailyTotals).filter((netCents: any) => Number(netCents) < 0).length
      const avgPerDay = expenseDays > 0 ? totalExpense / expenseDays : 0
      const projectedEnd = avgPerDay * daysInMonth

      const detailStats = [
        { label: strings.current_spending, value: formatMoney(totalExpense, currencySymbol, localeTag) },
        { label: strings.avg_per_day, value: formatMoney(avgPerDay, currencySymbol, localeTag) },
        { label: strings.vs_last_month, value: `${faster ? '+' : ''}${pctFormatted}%`, valueColor: faster ? '#B794F6' : '#63B3ED' }
      ]

      // Only show projected month-end for current month
      if (isCurrentMonth) {
        detailStats.push({ label: strings.projected_month_end, value: formatMoney(projectedEnd, currencySymbol, localeTag) })
      }

      const durationDays = 7
      const totalIncomeCents = Math.round(totalIncome * 100)
      const totalExpenseCents = Math.round(totalExpense * 100)
      const ratioPercent = totalIncomeCents > 0 ? Math.round((totalExpense / totalIncome) * 100) : 0
      const limitCents = totalIncomeCents > 0
        ? calculateBudgetCapLimit(ratioPercent, totalIncomeCents, durationDays, currencyCode)
        : 0

      insights.push({
        id: generateStableInsightIdLocal('spending_velocity'),
        type: 'SPENDING_VELOCITY',
        title,
        short,
        // recommendation, // REMOVED
        detailStats,
        ...(faster
          ? {
            quickWinLabel: 'Cap discretionary spending',
            quickWinActionType: 'BUDGET_CAP',
            quickWinPayload: {
              scope: 'discretionary',
              durationDays,
              ...(limitCents > 0 ? { limitCents } : {}),
              ...(totalIncomeCents > 0 ? { totalIncomeCents } : {}),
              ...(totalExpenseCents > 0 ? { totalExpenseCents } : {}),
              ...(ratioPercent > 0 ? { ratioPercent } : {})
            }
          }
          : {})
      })
    }
  }

  // ---------- 2) Weekend vs weekday (from daily_expense_totals) ----------
  // Use daily_expense_totals instead of daily_totals for accurate expense tracking
  const dailyExpenseTotals = aggregate.daily_expense_totals || {}
  const dailyEntries = Object.entries(dailyExpenseTotals)
    .map(([dateStr, expenseCents]: [string, any]) => ({
      date: new Date(dateStr + 'T00:00:00Z'),
      expenseOnly: Number(expenseCents) / 100
    }))
    .filter(entry => entry.expenseOnly > 0) // Only include days with expenses

  if (dailyEntries.length >= 3) {
    let weekendSum = 0
    let weekendDays = 0
    let weekdaySum = 0
    let weekdayDays = 0

    for (const { date, expenseOnly } of dailyEntries) {
      const dow = date.getUTCDay()
      const isWeekend = dow === 0 || dow === 6
      if (isWeekend) {
        weekendSum += expenseOnly
        weekendDays += 1
      } else {
        weekdaySum += expenseOnly
        weekdayDays += 1
      }
    }

    if (weekendDays > 0 && weekdayDays > 0 && weekdaySum > 0) {
      const weekendAvg = weekendSum / weekendDays
      const weekdayAvg = weekdaySum / weekdayDays
      const factor = weekendAvg / weekdayAvg

      if (factor >= 1.3) {
        const title = strings.weekend_spike
        const weekendFormatted = formatMoney(weekendAvg, currencySymbol, localeTag)
        const weekdayFormatted = formatMoney(weekdayAvg, currencySymbol, localeTag)

        const short = strings.weekend_spike_short
          .replace('{weekend}', weekendFormatted)
          .replace('{weekday}', weekdayFormatted)

        // const recommendation = ... // REMOVED

        const detailStats = [
          { label: strings.weekend_avg, value: formatMoney(weekendAvg, currencySymbol, localeTag) },
          { label: strings.weekday_avg, value: formatMoney(weekdayAvg, currencySymbol, localeTag) },
          { label: strings.factor, value: `${factor.toFixed(1)}x` }
        ]

        insights.push({
          id: generateStableInsightIdLocal('weekend_spike'),
          type: 'WEEKEND_SPIKE',
          title,
          short,
          // recommendation, // REMOVED
          detailStats
        })
      }
    }
  }

  // ---------- 3) Spike day (from daily_totals) ----------
  // Reuse dailyEntries from weekend spike (already filtered to expense-only days)
  if (dailyEntries.length >= 3) {
    const sortedDays = [...dailyEntries].sort((a, b) => b.expenseOnly - a.expenseOnly)
    const topDay = sortedDays[0]
    const medianDay = sortedDays[Math.floor(sortedDays.length / 2)]

    if (medianDay && medianDay.expenseOnly > 0) {
      const factor = topDay.expenseOnly / medianDay.expenseOnly

      if (factor >= 2.5) {
        const title = strings.spike_day
        const dateStr = topDay.date.toISOString().slice(0, 10)
        const amountFormatted = formatMoney(topDay.expenseOnly, currencySymbol, localeTag)

        const short = strings.spike_day_short
          .replace('{amount}', amountFormatted)
          .replace('{date}', dateStr)
          .replace('{factor}', factor.toFixed(1))

        // const recommendation = ... // REMOVED

        const detailStats = [
          { label: strings.spike_amount, value: formatMoney(topDay.expenseOnly, currencySymbol, localeTag) },
          { label: strings.spike_date, value: dateStr },
          { label: strings.typical_day, value: formatMoney(medianDay.expenseOnly, currencySymbol, localeTag) },
          { label: strings.factor, value: `${factor.toFixed(1)}x` }
        ]

        insights.push({
          id: generateStableInsightIdLocal('spike_day'),
          type: 'SPIKE_DAY',
          title,
          short,
          // recommendation, // REMOVED
          detailStats
        })
      }
    }
  }

  // ---------- 4) Top category (from category_totals) ----------
  // category_totals now stores: { "category_id": { id, name, cents }, ... }
  const categoryTotals = aggregate.category_totals || {}
  const categoryEntries = Object.entries(categoryTotals)
    .filter(([catId]) => catId !== 'other' && catId !== 'uncategorized')
    .map(([catId, catData]: [string, any]) => ({
      categoryId: catId,
      categoryName: catData.name || catId,
      total: Number(catData.cents || 0) / 100
    }))
    .filter((c) => !isFixedCostCategory(c.categoryName))
    .sort((a, b) => b.total - a.total)

  // DEBUG: Log top 3 categories with percentages for debugging
  log('spending_engine.top_3_categories', {
    userToken: getAnonymousUserToken(userId),
    month: monthKey,
    totalExpense,
    categoryCount: categoryEntries.length,
    categories: categoryEntries.slice(0, 3).map((c, idx) => ({
      rank: idx + 1,
      name: c.categoryName,
      id: c.categoryId,
      amount: c.total,
      percentage: totalExpense > 0 ? ((c.total / totalExpense) * 100).toFixed(1) + '%' : '0%'
    }))
  })

  if (categoryEntries.length > 0 && totalExpense > 0) {
    const topCat = categoryEntries[0]
    const pct = (topCat.total / totalExpense) * 100

    // DEBUG: Log top category qualification check (Phase 1: always-on, no threshold)
    log('spending_engine.top_category_check', {
      userToken: getAnonymousUserToken(userId),
      month: monthKey,
      categoryName: topCat.categoryName,
      categoryId: topCat.categoryId,
      amount: topCat.total,
      percentage: pct.toFixed(1),
      qualifies: true,  // Always qualifies in Phase 1
      threshold: 'none (always-on)'
    })

    const catName = topCat.categoryName
    const title = strings.top_category.replace('{category}', catName)
    const amountFormatted = formatMoney(topCat.total, currencySymbol, localeTag)

    const short = strings.top_category_short
      .replace('{category}', catName)
      .replace('{amount}', amountFormatted)
      .replace('{pct}', pct.toFixed(0))

    // const recommendation = ... // REMOVED

    const detailStats = [
      { label: strings.category_name, value: catName },
      { label: strings.category_total, value: formatMoney(topCat.total, currencySymbol, localeTag) },
      { label: strings.category_share, value: `${pct.toFixed(0)}%` }
    ]

    // PHASE 1: Quick Win Action for TOP_CATEGORY
    // Check if category is essential (never freeze essential categories)
    // Use category name and normalize it to match Android CategoryHelper logic
    const categoryKey = toCategoryKey(topCat.categoryName)
    const isEssential = isEssentialCategory(categoryKey)

    let quickWinLabel: string
    let quickWinActionType: string
    let quickWinPayload: any

    if (isEssential) {
      // For essential categories, suggest budget cap instead of freeze
      quickWinLabel = `Cap ${catName} spending`
      quickWinActionType = 'BUDGET_CAP'
      quickWinPayload = {
        scope: catName,
        categoryId: topCat.categoryId,
        categoryName: catName,
        limitCents: Math.round(topCat.total * 0.9 * 100), // 10% reduction
        durationDays: 7
      }
    } else {
      // For non-essential categories, suggest freeze (NO_SPEND_CATEGORY is canonical)
      quickWinLabel = `Freeze ${catName} spending`
      quickWinActionType = 'NO_SPEND_CATEGORY'
      quickWinPayload = {
        categoryId: topCat.categoryId,
        categoryName: catName,
        durationDays: 7
      }
    }

    insights.push({
      id: generateStableInsightIdLocal('top_category', topCat.categoryId),
      type: 'TOP_CATEGORY',
      title,
      short,
      // recommendation, // REMOVED
      detailStats,
      // Quick Win Action payload
      quickWinLabel,
      quickWinActionType,
      quickWinPayload
    })

    // DEBUG: Log TOP_CATEGORY insight creation
    log('spending_engine.top_category_created', {
      userToken: getAnonymousUserToken(userId),
      month: monthKey,
      insightId: generateStableInsightIdLocal('top_category', topCat.categoryId),
      categoryName: catName,
      percentage: pct.toFixed(1),
      isEssential,
      quickWinActionType,
      quickWinLabel
    })
  }

  // ---------- 5) Income share ----------
  if (totalIncome > 0 && totalExpense > 0) {
    const ratio = totalExpense / totalIncome
    const pct = ratio * 100

    let title: string
    let shortTemplate: string
    let recommendation: string

    if (ratio >= 0.8) {
      title = strings.income_share_high
      shortTemplate = strings.income_share_high_short
      // recommendation // REMOVED = strings.income_share_high_rec
    } else if (ratio >= 0.5) {
      title = strings.income_share_moderate
      shortTemplate = strings.income_share_moderate_short
      // recommendation // REMOVED = strings.income_share_moderate_rec
    } else {
      title = strings.income_share_low
      shortTemplate = strings.income_share_low_short
      // recommendation // REMOVED = strings.income_share_low_rec
    }

    const spentFormatted = formatMoney(totalExpense, currencySymbol, localeTag)
    const incomeFormatted = formatMoney(totalIncome, currencySymbol, localeTag)

    const short = shortTemplate
      .replace('{spent}', spentFormatted)
      .replace('{income}', incomeFormatted)
      .replace('{pct}', pct.toFixed(0))

    const detailStats = [
      { label: strings.total_income, value: formatMoney(totalIncome, currencySymbol, localeTag) },
      { label: strings.total_spending, value: formatMoney(totalExpense, currencySymbol, localeTag) },
      { label: strings.income_ratio, value: `${pct.toFixed(0)}%` }
    ]

    // Quick Win Action: Budget Cap for overspending
    let quickWinLabel: string | undefined
    let quickWinActionType: string | undefined
    let quickWinPayload: any

    if (ratio > 0.80) {
      // Overspending scenario - suggest intelligent budget cap
      
      const ratioPercent = Math.round(pct)
      const totalIncomeCents = Math.round(totalIncome * 100)
      const totalExpenseCents = Math.round(totalExpense * 100)
      const durationDays = 7 // Default duration
      
      // Phase 1A.2: Use shared Budget Cap calculation logic
      const limitCents = calculateBudgetCapLimit(
        ratioPercent,
        totalIncomeCents,
        durationDays,
        currencyCode
      )

      quickWinLabel = 'Cap discretionary spending'
      quickWinActionType = 'BUDGET_CAP'
      quickWinPayload = {
        scope: 'discretionary',
        limitCents: limitCents,
        durationDays: durationDays,
        // Context for proof text in dialog
        totalIncomeCents: totalIncomeCents,
        totalExpenseCents: totalExpenseCents,
        ratioPercent: ratioPercent
      }
      
      // Debug logging for verification
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'budget_cap.shared_calculation',
        ratioPercent,
        limitCents,
        durationDays,
        currencyCode,
        source: 'shared_helper'
      }))
    }

    insights.push({
      id: generateStableInsightIdLocal('income_share'),
      type: 'INCOME_SHARE',
      title,
      short,
      // recommendation, // REMOVED
      detailStats,
      // Quick Win fields (only present if conditions met)
      ...(quickWinLabel ? { quickWinLabel } : {}),
      ...(quickWinActionType ? { quickWinActionType } : {}),
      ...(quickWinPayload ? { quickWinPayload } : {})
    })
  }

  // ---------- 6) Category changes (compare with previous month) ----------
  if (prevAggregate && prevAggregate.category_totals) {
    const prevCategoryTotals = prevAggregate.category_totals || {}

    for (const [catId, currentData] of Object.entries(categoryTotals)) {
      if (catId === 'other' || catId === 'uncategorized') continue

      const currentTotal = Number((currentData as any).cents || 0) / 100
      const catName = (currentData as any).name || catId
      if (isFixedCostCategory(catName)) continue
      const prevData = prevCategoryTotals[catId]
      const prevTotal = prevData ? Number((prevData as any).cents || 0) / 100 : 0

      if (prevTotal > 0 && currentTotal > 0) {
        const diff = currentTotal - prevTotal
        const pct = (diff / prevTotal) * 100

        if (Math.abs(pct) >= 30 && Math.abs(diff) >= 20) {
          // catId is the category UUID (stable identifier)
          const categoryId = catId
          const isJump = pct > 0

          const title = isJump
            ? strings.category_jump.replace('{category}', catName)
            : strings.category_drop.replace('{category}', catName)

          const currentFormatted = formatMoney(currentTotal, currencySymbol, localeTag)
          const prevFormatted = formatMoney(prevTotal, currencySymbol, localeTag)
          const pctFormatted = Math.abs(pct).toFixed(0)
          const shareOfSpending = totalExpense > 0 ? (currentTotal / totalExpense * 100).toFixed(0) : '0'

          const shortTemplate = isJump ? strings.category_jump_short : strings.category_drop_short
          const short = shortTemplate
            .replace('{category}', catName)
            .replace('{current}', currentFormatted)
            .replace('{prev}', prevFormatted)
            .replace('{pct}', shareOfSpending)

          // const recommendation = ... // REMOVED

          const detailStats = [
            { label: strings.category_name, value: catName },
            { label: strings.category_current, value: currentFormatted },
            { label: strings.category_previous, value: prevFormatted },
            { label: strings.category_change, value: `${isJump ? '+' : ''}${pctFormatted}%` }
          ]

          // Use stable category UUID in insight ID (not category name)
          // This prevents snooze/cache breakage on category rename or translation
          const insightType = isJump ? 'CATEGORY_CHANGE_UP' : 'CATEGORY_CHANGE_DOWN'

          let quickWinLabel: string | undefined
          let quickWinActionType: string | undefined
          let quickWinPayload: any

          if (isJump) {
            const categoryKey = toCategoryKey(catName)
            const isEssential = isEssentialCategory(categoryKey)

            if (isEssential) {
              quickWinLabel = `Cap ${catName} spending`
              quickWinActionType = 'BUDGET_CAP'
              quickWinPayload = {
                scope: catName,
                categoryId,
                categoryName: catName,
                limitCents: Math.round(currentTotal * 0.9 * 100),
                durationDays: 7
              }
            } else {
              quickWinLabel = `Freeze ${catName}`
              quickWinActionType = 'NO_SPEND_CATEGORY'
              quickWinPayload = {
                categoryId,
                categoryName: catName,
                durationDays: 7
              }
            }
          }

          insights.push({
            id: generateStableInsightIdLocal(isJump ? 'category_jump' : 'category_drop', categoryId),
            type: insightType,
            title,
            short,
            // recommendation, // REMOVED
            detailStats,
            metadata: {
              categoryId,  // Stable UUID for snooze matching
              categoryName: catName  // Display name only
            },
            ...(quickWinLabel ? { quickWinLabel } : {}),
            ...(quickWinActionType ? { quickWinActionType } : {}),
            ...(quickWinPayload ? { quickWinPayload } : {})
          })
        }
      }
    }
  }

  // ========== CURATION: Reserve slot for TOP_CATEGORY, limit to 6 ========== 
  // Phase 1: Prioritize TOP_CATEGORY over lower-impact insights
  const topCategoryInsight = insights.find(i => i.type === 'TOP_CATEGORY')
  const otherInsights = insights.filter(i => i.type !== 'TOP_CATEGORY')

  // Deprioritize these types in Phase 1 to make room for TOP_CATEGORY
  const lowPriorityTypes = new Set(['GOAL_CONTRIB', 'TIME_OF_DAY'])
  const highPriority = otherInsights.filter(i => !lowPriorityTypes.has(i.type))
  const lowPriority = otherInsights.filter(i => lowPriorityTypes.has(i.type))

  // Build final list: TOP_CATEGORY first (if exists), then high priority, then low priority
  let curatedInsights: any[] = []
  if (topCategoryInsight) {
    curatedInsights.push(topCategoryInsight)
  }

  // Fill remaining slots (up to 6 total)
  const remainingSlots = 6 - curatedInsights.length
  curatedInsights.push(...highPriority.slice(0, remainingSlots))

  if (curatedInsights.length < 6) {
    const stillRemaining = 6 - curatedInsights.length
    curatedInsights.push(...lowPriority.slice(0, stillRemaining))
  }

  // Calculate dropped insights for logging
  const droppedInsights = insights.filter(i => !curatedInsights.includes(i))

  // Log curation decision
  log('spending_engine.curation_decision', {
    userToken: getAnonymousUserToken(userId),
    month: monthKey,
    totalGenerated: insights.length,
    selected: curatedInsights.map(i => ({ id: i.id, type: i.type })),
    dropped: droppedInsights.map(i => ({
      id: i.id,
      type: i.type,
      reason: lowPriorityTypes.has(i.type) ? 'deprioritized' : 'slot_limit'
    })),
    topCategoryIncluded: curatedInsights.some(i => i.type === 'TOP_CATEGORY')
  })

  // If TOP_CATEGORY was dropped (should never happen in Phase 1), log it
  if (topCategoryInsight && !curatedInsights.includes(topCategoryInsight)) {
    log('spending_engine.top_category_dropped', {
      userToken: getAnonymousUserToken(userId),
      month: monthKey,
      reason: 'curation_priority_conflict',
      competingTypes: curatedInsights.map(i => i.type)
    })
  }

  return curatedInsights
}

function buildSpendingInsightsFromServer(
  monthTxns: TxnRow[],
  prevTxns: TxnRow[],
  monthKey: string,
  categoryNameById: Map<string, string>,
  locale: string = 'en',
  currencySymbol: string = '₺',
  userId: string,
  currencyCode: string = 'USD'
): Array<RawInsight & { detailStats?: Array<{ label: string; value: string; valueColor?: string }> }> {
  const abs = (n: number) => Math.abs(n)

  const expenses = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const incomes = monthTxns.filter((t) => typeof t.amount === 'number' && t.amount > 0)
  if (!expenses.length) return []

  const totalExpense = abs(expenses.reduce((sum, t) => sum + t.amount, 0))
  const totalIncome = incomes.reduce((sum, t) => sum + t.amount, 0)

  const prevExpenses = prevTxns.filter((t) => typeof t.amount === 'number' && t.amount < 0)
  const prevTotalExpense = prevExpenses.length
    ? abs(prevExpenses.reduce((sum, t) => sum + t.amount, 0))
    : 0

  const insights: Array<RawInsight & { detailStats?: Array<{ label: string; value: string; valueColor?: string }> }> = []
  const strings = getLocalizedStrings(locale)
  const localeTag = locale === 'en' ? 'en-US' : locale === 'es' ? 'es-ES' : locale === 'ru' ? 'ru-RU' : locale === 'fr' ? 'fr-FR' : locale === 'de' ? 'de-DE' : 'en-US'

  // ---------- 1) Velocity vs last month ----------
  if (prevTotalExpense > 0 && totalExpense > 0) {
    const diff = totalExpense - prevTotalExpense
    const pct = (diff / prevTotalExpense) * 100
    if (Math.abs(pct) >= 5) {
      const faster = pct > 0

      const title = faster ? strings.velocity_higher : strings.velocity_lower

      const pctFormatted = Math.abs(pct).toFixed(1)
      const currentFormatted = formatMoney(totalExpense, currencySymbol, localeTag)
      const prevFormatted = formatMoney(prevTotalExpense, currencySymbol, localeTag)

      const shortTemplate = faster ? strings.velocity_higher_short : strings.velocity_lower_short
      const short = shortTemplate
        .replace('{pct}', pctFormatted)
        .replace('{current}', currentFormatted)
        .replace('{prev}', prevFormatted)

      // const recommendation = ... // REMOVED

      const [yearStr, monthStr] = monthKey.split('-')
      const daysInMonth = new Date(Date.UTC(Number(yearStr), Number(monthStr), 0)).getUTCDate()
      const today = new Date()
      const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
      const daysElapsed = monthKey === currentMonth ? today.getUTCDate() : daysInMonth
      const avgPerDay = daysElapsed > 0 ? totalExpense / daysElapsed : 0
      const projectedEnd = avgPerDay * daysInMonth

      const detailStats = [
        { label: strings.current_spending, value: formatMoney(totalExpense, currencySymbol, localeTag) },
        { label: strings.avg_per_day, value: formatMoney(avgPerDay, currencySymbol, localeTag) },
        { label: strings.vs_last_month, value: `${faster ? '+' : ''}${pctFormatted}%`, valueColor: faster ? '#B794F6' : '#63B3ED' },
        { label: strings.projected_month_end, value: formatMoney(projectedEnd, currencySymbol, localeTag) }
      ]

      // Add largest expense this month as evidence
      const sortedExpenses = [...expenses].sort((a, b) => abs(b.amount) - abs(a.amount))
      if (sortedExpenses.length > 0) {
        const largest = sortedExpenses[0]
        const txTitle = getTxnDisplayName(largest, strings.generic_transaction).slice(0, 20)
        const txDate = new Date(largest.date).toISOString().slice(0, 10)
        detailStats.push({
          label: strings.largest_expense,
          value: `${txTitle}: ${formatMoney(abs(largest.amount), currencySymbol, localeTag)}`,
          valueColor: '#FC8181'
        })
      }

      const durationDays = 7
      const totalIncomeCents = Math.round(totalIncome * 100)
      const totalExpenseCents = Math.round(totalExpense * 100)
      const ratioPercent = totalIncomeCents > 0 ? Math.round((totalExpense / totalIncome) * 100) : 0
      const limitCents = totalIncomeCents > 0
        ? calculateBudgetCapLimit(ratioPercent, totalIncomeCents, durationDays, currencyCode)
        : 0

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'spending_velocity'),
        type: 'SPENDING_VELOCITY',
        title,
        short,
        // recommendation, // REMOVED
        detailStats,
        ...(faster
          ? {
            quickWinLabel: 'Cap discretionary spending',
            quickWinActionType: 'BUDGET_CAP',
            quickWinPayload: {
              scope: 'discretionary',
              durationDays,
              ...(limitCents > 0 ? { limitCents } : {}),
              ...(totalIncomeCents > 0 ? { totalIncomeCents } : {}),
              ...(totalExpenseCents > 0 ? { totalExpenseCents } : {}),
              ...(ratioPercent > 0 ? { ratioPercent } : {})
            }
          }
          : {})
      })
    }
  }

  // ---------- 2) Weekend vs weekday & spike day ----------
  if (expenses.length >= 3) {
    const dayTotals = new Map<string, { date: Date; total: number }>()
    for (const t of expenses) {
      const d = new Date(t.date)
      const key = d.toISOString().slice(0, 10)
      const existing = dayTotals.get(key) || { date: d, total: 0 }
      existing.total += abs(t.amount)
      dayTotals.set(key, existing)
    }

    const days = [...dayTotals.values()]
    if (days.length) {
      let weekendSum = 0
      let weekendDays = 0
      let weekdaySum = 0
      let weekdayDays = 0
      for (const { date, total } of days) {
        const dow = date.getUTCDay() // 0=Sun
        const isWeekend = dow === 0 || dow === 6
        if (isWeekend) {
          weekendSum += total
          weekendDays += 1
        } else {
          weekdaySum += total
          weekdayDays += 1
        }
      }
      if (weekendDays > 0 && weekdayDays > 0 && weekdaySum > 0) {
        const weekendAvg = weekendSum / weekendDays
        const weekdayAvg = weekdaySum / weekdayDays
        const factor = weekendAvg / weekdayAvg
        if (factor >= 1.3) {
          const title = strings.weekend_spike

          const weekendFormatted = formatMoney(weekendAvg, currencySymbol, localeTag)
          const weekdayFormatted = formatMoney(weekdayAvg, currencySymbol, localeTag)

          const short = strings.weekend_spike_short
            .replace('{weekend}', weekendFormatted)
            .replace('{weekday}', weekdayFormatted)

          // const recommendation = ... // REMOVED

          const detailStats = [
            { label: strings.weekend_avg, value: formatMoney(weekendAvg, currencySymbol, localeTag) },
            { label: strings.weekday_avg, value: formatMoney(weekdayAvg, currencySymbol, localeTag) },
            { label: strings.factor, value: `${factor.toFixed(1)}x`, valueColor: '#FBD38D' }
          ]

          // Find biggest weekend day as evidence
          const weekendDaysList = [...dayTotals.entries()]
            .filter(([, v]) => {
              const dow = v.date.getUTCDay()
              return dow === 0 || dow === 6
            })
            .sort((a, b) => b[1].total - a[1].total)
          if (weekendDaysList.length > 0) {
            const [biggestKey, biggestDay] = weekendDaysList[0]
            detailStats.push({
              label: strings.biggest_weekend_day,
              value: `${biggestKey}: ${formatMoney(biggestDay.total, currencySymbol, localeTag)}`,
              valueColor: '#FC8181'
            })
          }

          insights.push({
            id: generateStableInsightId(userId, monthKey, 'weekend_spike'),
            type: 'WEEKEND_SPIKE',
            title,
            short,
            // recommendation, // REMOVED
            detailStats
          })
        }
      }

      if (days.length >= 3) {
        const sorted = [...days].sort((a, b) => b.total - a.total)
        const spike = sorted[0]
        const others = sorted.slice(1)
        const othersTotal = others.reduce((s, d) => s + d.total, 0)
        const othersDays = others.length
        if (othersDays > 0 && othersTotal > 0) {
          const othersAvg = othersTotal / othersDays
          const factor = spike.total / othersAvg
          if (factor >= 2.0) {
            const labelDay = spike.date.toISOString().slice(0, 10)

            const title = strings.spike_day

            const amountFormatted = formatMoney(spike.total, currencySymbol, localeTag)
            const typicalFormatted = formatMoney(othersAvg, currencySymbol, localeTag)

            const short = strings.spike_day_short
              .replace('{amount}', amountFormatted)
              .replace('{date}', labelDay)
              .replace('{factor}', factor.toFixed(1))

            // const recommendation = ... // REMOVED

            const detailStats = [
              { label: strings.spike_amount, value: formatMoney(spike.total, currencySymbol, localeTag), valueColor: '#F56565' },
              { label: strings.spike_date, value: labelDay },
              { label: strings.typical_day, value: formatMoney(othersAvg, currencySymbol, localeTag) },
              { label: strings.factor, value: `${factor.toFixed(1)}x`, valueColor: '#FBD38D' }
            ]

            // Find top transaction from that spike day as evidence
            const spikeDayTxns = expenses.filter((t) => {
              const txDate = new Date(t.date).toISOString().slice(0, 10)
              return txDate === labelDay
            }).sort((a, b) => abs(b.amount) - abs(a.amount))
            let merchantName: string | undefined
            if (spikeDayTxns.length > 0) {
              const topTx = spikeDayTxns[0]
              const txTitle = getTxnDisplayName(topTx, strings.generic_transaction).slice(0, 25)
              merchantName = txTitle
              detailStats.push({
                label: strings.top_transaction,
                value: `${txTitle}: ${formatMoney(abs(topTx.amount), currencySymbol, localeTag)}`,
                valueColor: '#FC8181'
              })
            }

            insights.push({
              id: generateStableInsightId(userId, monthKey, 'spike_day'),
              type: 'SPIKE_DAY',
              title,
              short,
              // recommendation, // REMOVED
              detailStats,
              ...(merchantName
                ? {
                  quickWinLabel: `Freeze ${merchantName}`,
                  quickWinActionType: 'NO_SPEND_MERCHANT',
                  quickWinPayload: {
                    merchantName,
                    categoryName: merchantName,
                    durationDays: 7
                  }
                }
                : {})
            })
          }
        }
      }
    }
  }

  // ---------- 3) Top merchant (ignoring transfers / goal moves) ----------
  const merchantMap = new Map<string, number>()
  for (const t of expenses) {
    const title = getTxnDisplayName(t, strings.generic_transaction)
    const cat = toCategoryKey(t.category)
    const lowerTitle = title.toLowerCase()
    if (
      cat === 'transfer' ||
      lowerTitle.includes('transfer to goal') ||
      lowerTitle.includes('transfer from goal')
    ) {
      continue
    }
    merchantMap.set(title, (merchantMap.get(title) || 0) + Math.abs(t.amount))
  }
  if (merchantMap.size) {
    const entries = [...merchantMap.entries()].sort((a, b) => b[1] - a[1])
    const [merchant, spentAtMerchant] = entries[0]
    const sharePct = (spentAtMerchant / totalExpense) * 100
    if (sharePct >= 15.0) {
      const count = expenses.filter((t) => (t.title || '').trim() === merchant).length

      const title = strings.top_merchant.replace('{merchant}', merchant)

      const amountFormatted = formatMoney(spentAtMerchant, currencySymbol, localeTag)

      const short = strings.top_merchant_short
        .replace('{merchant}', merchant)
        .replace('{amount}', amountFormatted)
        .replace('{count}', String(count))
        .replace('{pct}', sharePct.toFixed(1))

      // const recommendation = ... // REMOVED

      const detailStats = [
        { label: strings.merchant_name, value: merchant },
        { label: strings.merchant_total, value: formatMoney(spentAtMerchant, currencySymbol, localeTag), valueColor: '#9F7AEA' },
        { label: strings.merchant_count, value: String(count) },
        { label: strings.merchant_share, value: `${sharePct.toFixed(1)}%`, valueColor: '#FBD38D' }
      ]

      // Find largest single purchase at this merchant as evidence
      const merchantTxns = expenses
        .filter((t) => (t.title || '').trim() === merchant)
        .sort((a, b) => abs(b.amount) - abs(a.amount))
      if (merchantTxns.length > 0) {
        const largestTx = merchantTxns[0]
        const txDate = new Date(largestTx.date).toISOString().slice(0, 10)
        detailStats.push({
          label: strings.largest_purchase,
          value: `${formatMoney(abs(largestTx.amount), currencySymbol, localeTag)} (${txDate})`,
          valueColor: '#FC8181'
        })
      }

      // Find the most common category for this merchant for Quick Win mapping
      const categoryMap = new Map<string, { count: number, categoryId?: string }>()
      for (const t of merchantTxns) {
        const category = (t.category || 'Other').trim()
        const categoryId = t.category_id // Phase 2: UUID reference if available
        if (category) {
          const existing = categoryMap.get(category) || { count: 0 }
          categoryMap.set(category, { 
            count: existing.count + 1,
            categoryId: categoryId || existing.categoryId // Prefer first non-null categoryId
          })
        }
      }
      
      // Get the most frequent category with confidence metrics
      let primaryCategory: string | undefined
      let categoryId: string | undefined
      let categoryCount = 0
      
      if (categoryMap.size > 0) {
        const sortedCategories = [...categoryMap.entries()].sort((a, b) => b[1].count - a[1].count)
        const topCategory = sortedCategories[0]
        primaryCategory = topCategory[0]
        categoryId = topCategory[1].categoryId
        categoryCount = categoryMap.size
        
        // Additional confidence check: primary category should represent significant portion
        const totalTxns = merchantTxns.length
        const primaryCategoryTxns = topCategory[1].count
        const confidence = primaryCategoryTxns / totalTxns
        
        // If confidence is too low (< 60%), don't emit category mapping
        if (confidence < 0.6) {
          console.log(JSON.stringify({
            ts: new Date().toISOString(),
            event: 'top_merchant.low_confidence',
            merchantName: merchant,
            primaryCategory,
            confidence: confidence.toFixed(2),
            totalTxns,
            primaryCategoryTxns
          }))
          primaryCategory = undefined // Will trigger safety rule in Quick Win mapping
        }
      }

      if (!primaryCategory || !isFixedCostCategory(primaryCategory)) {
        insights.push({
          id: generateStableInsightId(userId, monthKey, 'top_merchant'),
          type: 'TOP_MERCHANT',
          title,
          short,
          // recommendation, // REMOVED
          detailStats,
          metadata: {
            merchantName: merchant,
            primaryCategory: primaryCategory,
            categoryId: categoryId,
            categoryCount: categoryCount,
            confidence: primaryCategory ? (merchantTxns.filter(t => (t.category || '').trim() === primaryCategory).length / merchantTxns.length) : 0
          },
          quickWinLabel: `Freeze ${merchant}`,
          quickWinActionType: 'NO_SPEND_MERCHANT',
          quickWinPayload: {
            merchantName: merchant,
            categoryName: merchant,
            durationDays: 7,
            ...(categoryId ? { categoryId } : {})
          }
        })
      }
    }
  }

  // ---------- 4) Small purchases ("money leaks") ----------
  const smallThreshold = 30 // dollars
  const smallTxns = expenses.filter((t) => abs(t.amount) > 0 && abs(t.amount) <= smallThreshold)
  const smallCount = smallTxns.length
  const smallTotal = smallTxns.reduce((s, t) => s + abs(t.amount), 0)
  if (smallCount >= 8 && smallTotal > 0) {
    const sharePct = (smallTotal / totalExpense) * 100
    if (sharePct >= 5.0) {
      const title = strings.small_leaks

      const thresholdFormatted = formatMoney(smallThreshold, currencySymbol, localeTag)
      const totalFormatted = formatMoney(smallTotal, currencySymbol, localeTag)
      const avgSmall = smallTotal / smallCount

      const short = strings.small_leaks_short
        .replace('{count}', String(smallCount))
        .replace('{threshold}', thresholdFormatted)
        .replace('{total}', totalFormatted)

      // const recommendation = ... // REMOVED

      const detailStats = [
        { label: strings.small_leaks_count, value: String(smallCount) },
        { label: strings.small_leaks_threshold, value: thresholdFormatted },
        { label: strings.small_leaks_total, value: formatMoney(smallTotal, currencySymbol, localeTag), valueColor: '#F6AD55' },
        { label: strings.small_leaks_share, value: `${sharePct.toFixed(1)}%` }
      ]

      // Find most frequent small merchant as evidence
      const smallMerchantMap = new Map<string, { count: number; total: number }>()
      for (const t of smallTxns) {
        const m = getTxnDisplayName(t, strings.generic_transaction).trim()
        const existing = smallMerchantMap.get(m) || { count: 0, total: 0 }
        existing.count += 1
        existing.total += abs(t.amount)
        smallMerchantMap.set(m, existing)
      }
      const topSmallMerchant = [...smallMerchantMap.entries()]
        .sort((a, b) => b[1].count - a[1].count)[0]
      if (topSmallMerchant) {
        const [merchantName, data] = topSmallMerchant
        detailStats.push({
          label: strings.frequent_merchant,
          value: `${merchantName.slice(0, 18)}: ${data.count}x, ${formatMoney(data.total, currencySymbol, localeTag)}`,
          valueColor: '#FC8181'
        })
      }

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'small_leaks'),
        type: 'SMALL_LEAKS',
        title,
        short,
        // recommendation, // REMOVED
        detailStats
      })
    }
  }

  // ---------- 5) Subscriptions slice ----------
  const subKeywords = ['subscription', 'netflix', 'spotify', 'hulu', 'disney', 'prime']
  const subs = expenses.filter((t) => {
    const cat = (t.category || '').toLowerCase()
    const title = (t.title || '').toLowerCase()
    const note = (t.note || '').toLowerCase()
    return subKeywords.some((k) =>
      cat.includes(k) || title.includes(k) || note.includes(k)
    )
  })
  const subsCount = subs.length
  const subsTotal = subs.reduce((s, t) => s + abs(t.amount), 0)
  if (subsCount >= 2 && subsTotal > 0) {
    const sharePct = (subsTotal / totalExpense) * 100
    if (sharePct >= 3.0) {
      const title = strings.subscriptions

      const totalFormatted = formatMoney(subsTotal, currencySymbol, localeTag)
      const avgSub = subsTotal / subsCount

      const short = strings.subscriptions_short
        .replace('{count}', String(subsCount))
        .replace('{total}', totalFormatted)

      // const recommendation = ... // REMOVED

      const detailStats = [
        { label: strings.subscriptions_count, value: String(subsCount) },
        { label: strings.subscriptions_total, value: formatMoney(subsTotal, currencySymbol, localeTag), valueColor: '#9F7AEA' },
        { label: strings.subscriptions_share, value: `${sharePct.toFixed(1)}%` }
      ]

      // Add top subscription as evidence
      const sortedSubs = [...subs].sort((a, b) => abs(b.amount) - abs(a.amount))
      if (sortedSubs.length > 0) {
        const topSub = sortedSubs[0]
        const subName = getTxnDisplayName(topSub, strings.generic_transaction).slice(0, 20)
        detailStats.push({
          label: strings.top_subscription,
          value: `${subName}: ${formatMoney(abs(topSub.amount), currencySymbol, localeTag)}`,
          valueColor: '#FC8181'
        })
      }

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'subscriptions'),
        type: 'SUBSCRIPTIONS',
        title,
        short,
        // recommendation, // REMOVED
        detailStats
      })
    }
  }

  // ---------- 6) Income vs spending health ----------
  if (totalIncome > 0 && totalExpense > 0) {
    const sharePct = (totalExpense / totalIncome) * 100
    const incomeShare = sharePct

    const spentFormatted = formatMoney(totalExpense, currencySymbol, localeTag)
    const incomeFormatted = formatMoney(totalIncome, currencySymbol, localeTag)

    let title: string
    let short: string
    let recommendation: string
    let valueColor: string

    if (incomeShare >= 90.0) {
      title = strings.income_share_high
      short = strings.income_share_high_short
        .replace('{spent}', spentFormatted)
        .replace('{income}', incomeFormatted)
        .replace('{pct}', incomeShare.toFixed(1))
      // recommendation // REMOVED = strings.income_share_high_rec
      valueColor = '#F56565'
    } else if (incomeShare <= 60.0) {
      title = strings.income_share_low
      short = strings.income_share_low_short
        .replace('{spent}', spentFormatted)
        .replace('{income}', incomeFormatted)
        .replace('{pct}', incomeShare.toFixed(1))
      // recommendation // REMOVED = strings.income_share_low_rec
      valueColor = '#48BB78'
    } else {
      title = strings.income_share_moderate
      short = strings.income_share_moderate_short
        .replace('{spent}', spentFormatted)
        .replace('{income}', incomeFormatted)
        .replace('{pct}', incomeShare.toFixed(1))
      // recommendation // REMOVED = strings.income_share_moderate_rec
      valueColor = '#4299E1'
    }

    const detailStats = [
      { label: strings.total_income, value: formatMoney(totalIncome, currencySymbol, localeTag) },
      { label: strings.total_spending, value: formatMoney(totalExpense, currencySymbol, localeTag) },
      { label: strings.income_ratio, value: `${incomeShare.toFixed(1)}%`, valueColor }
    ]

    // Add largest expense as evidence
    const sortedForIncome = [...expenses].sort((a, b) => abs(b.amount) - abs(a.amount))
    if (sortedForIncome.length > 0) {
      const largest = sortedForIncome[0]
      const txTitle = getTxnDisplayName(largest, strings.generic_transaction).slice(0, 20)
      detailStats.push({
        label: strings.largest_expense,
        value: `${txTitle}: ${formatMoney(abs(largest.amount), currencySymbol, localeTag)}`,
        valueColor: '#FC8181'
      })
    }

    const durationDays = 7
    const totalIncomeCents = Math.round(totalIncome * 100)
    const totalExpenseCents = Math.round(totalExpense * 100)
    const ratioPercent = Math.round(incomeShare)
    const limitCents = incomeShare > 80
      ? calculateBudgetCapLimit(ratioPercent, totalIncomeCents, durationDays, currencyCode)
      : 0

    insights.push({
      id: generateStableInsightId(userId, monthKey, 'income_share'),
      type: 'INCOME_SHARE',
      title,
      short,
      // recommendation, // REMOVED
      detailStats,
      ...(incomeShare > 80
        ? {
          quickWinLabel: 'Cap discretionary spending',
          quickWinActionType: 'BUDGET_CAP',
          quickWinPayload: {
            scope: 'discretionary',
            durationDays,
            ...(limitCents > 0 ? { limitCents } : {}),
            totalIncomeCents,
            totalExpenseCents,
            ratioPercent
          }
        }
        : {})
    })
  }

  // ---------- 7) Time-of-day spending pattern ----------
  const buckets: Record<string, number> = {}
  for (const t of expenses) {
    const d = new Date(t.date)
    const hour = d.getUTCHours()
    let bucket: string
    if (hour >= 6 && hour <= 11) bucket = 'Morning'
    else if (hour >= 12 && hour <= 17) bucket = 'Afternoon'
    else if (hour >= 18 && hour <= 22) bucket = 'Evening'
    else bucket = 'Late night'
    buckets[bucket] = (buckets[bucket] || 0) + abs(t.amount)
  }
  const bucketEntries = Object.entries(buckets).sort((a, b) => b[1] - a[1])
  if (bucketEntries.length >= 2) {
    const [topBucket, topVal] = bucketEntries[0]
    const othersTotal = bucketEntries.slice(1).reduce((s, [, v]) => s + v, 0)
    const othersAvg = othersTotal / (bucketEntries.length - 1)
    const sharePct = (topVal / totalExpense) * 100
    if (sharePct >= 30 && othersAvg > 0 && topVal / othersAvg >= 1.3) {
      const localizedPeriod = getLocalizedPeriod(topBucket, strings)
      const title = strings.time_of_day.replace('{period}', localizedPeriod)

      const amountFormatted = formatMoney(topVal, currencySymbol, localeTag)

      const short = strings.time_of_day_short
        .replace('{period}', localizedPeriod)
        .replace('{pct}', sharePct.toFixed(1))

      // const recommendation = ... // REMOVED

      const txCount = expenses.filter((t) => {
        const d = new Date(t.date)
        const hour = d.getUTCHours()
        let bucket: string
        if (hour >= 6 && hour <= 11) bucket = 'Morning'
        else if (hour >= 12 && hour <= 17) bucket = 'Afternoon'
        else if (hour >= 18 && hour <= 22) bucket = 'Evening'
        else bucket = 'Late night'
        return bucket === topBucket
      }).length

      const detailStats = [
        { label: strings.peak_period, value: localizedPeriod },
        { label: strings.peak_amount, value: formatMoney(topVal, currencySymbol, localeTag), valueColor: '#9F7AEA' },
        { label: strings.peak_transactions, value: String(txCount) }
      ]

      // Find example transaction from that time bucket as evidence
      const bucketTxns = expenses.filter((t) => {
        const d = new Date(t.date)
        const hour = d.getUTCHours()
        let b: string
        if (hour >= 6 && hour <= 11) b = 'Morning'
        else if (hour >= 12 && hour <= 17) b = 'Afternoon'
        else if (hour >= 18 && hour <= 22) b = 'Evening'
        else b = 'Late night'
        return b === topBucket
      }).sort((a, b) => abs(b.amount) - abs(a.amount))
      if (bucketTxns.length > 0) {
        const exTx = bucketTxns[0]
        const txTitle = getTxnDisplayName(exTx, strings.generic_transaction).slice(0, 20)
        detailStats.push({
          label: strings.example_transaction,
          value: `${txTitle}: ${formatMoney(abs(exTx.amount), currencySymbol, localeTag)}`,
          valueColor: '#FC8181'
        })
      }

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'time_of_day'),
        type: 'TIME_OF_DAY',
        title,
        short,
        // recommendation, // REMOVED
        detailStats
      })
    }
  }

  // ---------- 8) Goal contributions vs last month ----------
  const goalDepositsThis = monthTxns.filter((t) => {
    if (typeof t.amount !== 'number' || t.amount >= 0) return false
    const cat = toCategoryKey(t.category)
    const title = (t.title || '').toLowerCase()
    const note = (t.note || '').toLowerCase()
    return (
      isTransferLikeCategory(cat) ||
      title.includes('transfer to goal') ||
      note.includes('transfer to goal')
    )
  })

  const goalDepositsPrev = prevTxns.filter((t) => {
    if (typeof t.amount !== 'number' || t.amount >= 0) return false
    const cat = toCategoryKey(t.category)
    const title = (t.title || '').toLowerCase()
    const note = (t.note || '').toLowerCase()
    return (
      isTransferLikeCategory(cat) ||
      title.includes('transfer to goal') ||
      note.includes('transfer to goal')
    )
  })

  const contribThis = goalDepositsThis.reduce((s, t) => s + abs(t.amount), 0)
  const contribPrev = goalDepositsPrev.reduce((s, t) => s + abs(t.amount), 0)

  if (contribThis > 0 || contribPrev > 0) {
    log('spending_engine.goal_contrib_debug', { monthKey, contribThis, contribPrev })
    if (contribThis >= 10) {
      let title: string | null = null
      let short: string | null = null
      // let recommendation: string ... // REMOVED

      if (contribPrev <= 0 && contribThis > 0) {
        title = strings.goal_contrib_up
        short = strings.goal_contrib_up_short
          .replace('{current}', formatMoney(contribThis, currencySymbol, localeTag))
          .replace('{prev}', formatMoney(0, currencySymbol, localeTag))
        // recommendation // REMOVED = strings.goal_contrib_up_rec
      } else if (contribPrev > 0) {
        const diffPct = ((contribThis - contribPrev) / contribPrev) * 100
        if (Math.abs(diffPct) >= 20) {
          if (diffPct > 0) {
            title = strings.goal_contrib_up
            short = strings.goal_contrib_up_short
              .replace('{current}', formatMoney(contribThis, currencySymbol, localeTag))
              .replace('{prev}', formatMoney(contribPrev, currencySymbol, localeTag))
            // recommendation // REMOVED = strings.goal_contrib_up_rec
          } else {
            title = strings.goal_contrib_down
            short = strings.goal_contrib_down_short
              .replace('{current}', formatMoney(contribThis, currencySymbol, localeTag))
              .replace('{prev}', formatMoney(contribPrev, currencySymbol, localeTag))
            // recommendation // REMOVED = strings.goal_contrib_down_rec
          }
        }
      }

      if (title && short /* && recommendation */) {
        const change = contribThis - contribPrev
        const changeFormatted = `${change >= 0 ? '+' : ''}${formatMoney(Math.abs(change), currencySymbol, localeTag)}`

        const detailStats = [
          { label: strings.current_contrib, value: formatMoney(contribThis, currencySymbol, localeTag), valueColor: change >= 0 ? '#48BB78' : '#F6AD55' },
          { label: strings.previous_contrib, value: formatMoney(contribPrev, currencySymbol, localeTag) },
          { label: strings.contrib_change, value: changeFormatted, valueColor: change >= 0 ? '#48BB78' : '#F6AD55' }
        ]

        // Add largest goal transfer as evidence
        const sortedGoalTxns = [...goalDepositsThis].sort((a, b) => abs(b.amount) - abs(a.amount))
        if (sortedGoalTxns.length > 0) {
          const largest = sortedGoalTxns[0]
          const txTitle = getTxnDisplayName(largest, strings.generic_transaction).slice(0, 20)
          const txDate = new Date(largest.date).toISOString().slice(0, 10)
          detailStats.push({
            label: strings.largest_goal_transfer,
            value: `${txTitle}: ${formatMoney(abs(largest.amount), currencySymbol, localeTag)}`,
            valueColor: '#48BB78'
          })
        }

        insights.push({
          id: generateStableInsightId(userId, monthKey, 'goal_contrib'),
          type: 'GOAL_CONTRIB',
          title,
          short,
          // recommendation, // REMOVED
          detailStats
        })
      }
    }
  }

  // ---------- 9) Category change vs last month ----------
  if (prevExpenses.length > 0) {
    const monthCat = new Map<string, number>()
    const prevCat = new Map<string, number>()

    for (const t of expenses) {
      // Phase 2: Prefer category_id (UUID), fallback to category string
      const categoryKey = t.category_id
        ? t.category_id  // Use UUID as key
        : toCategoryKey(t.category)  // Fallback: normalize category string

      // Phase 2: Resolve display name to check transfer-ness (UUIDs won't match transfer patterns)
      const displayName = categoryNameById.get(categoryKey) || t.category || ''
      const normalizedName = toCategoryKey(displayName)

      // Skip transfers (check by resolved name)
      if (isTransferLikeCategory(normalizedName) || normalizedName === 'other') continue
      if (isFixedCostCategory(normalizedName)) continue

      monthCat.set(categoryKey, (monthCat.get(categoryKey) || 0) + abs(t.amount))
    }
    for (const t of prevExpenses) {
      // Phase 2: Prefer category_id (UUID), fallback to category string
      const categoryKey = t.category_id
        ? t.category_id  // Use UUID as key
        : toCategoryKey(t.category)  // Fallback: normalize category string

      // Phase 2: Resolve display name to check transfer-ness (UUIDs won't match transfer patterns)
      const displayName = categoryNameById.get(categoryKey) || t.category || ''
      const normalizedName = toCategoryKey(displayName)

      // Skip transfers (check by resolved name)
      if (isTransferLikeCategory(normalizedName) || normalizedName === 'other') continue
      if (isFixedCostCategory(normalizedName)) continue

      prevCat.set(categoryKey, (prevCat.get(categoryKey) || 0) + abs(t.amount))
    }

    type CatChange = { catKey: string; displayName: string; thisAmt: number; prevAmt: number; sharePct: number; changePct: number }
    const jumps: CatChange[] = []
    const drops: CatChange[] = []

    for (const [catKey, thisAmt] of monthCat.entries()) {
      const prevAmt = prevCat.get(catKey) || 0
      if (thisAmt <= 0) continue

      const sharePct = (thisAmt / totalExpense) * 100
      if (sharePct < 8) continue

      // Phase 2: Resolve display name (UUID -> name, or use key as-is)
      const displayName = categoryNameById.get(catKey) || catKey
      if (isFixedCostCategory(displayName)) continue

      if (prevAmt > 0) {
        const changePct = ((thisAmt - prevAmt) / prevAmt) * 100
        if (changePct >= 25) {
          jumps.push({ catKey, displayName, thisAmt, prevAmt, sharePct, changePct })
        } else if (changePct <= -25) {
          drops.push({ catKey, displayName, thisAmt, prevAmt, sharePct, changePct })
        }
      }
    }

    if (jumps.length) {
      jumps.sort((a, b) => b.sharePct - a.sharePct)
      const top = jumps[0]
      const safeCat = top.displayName

      const categoryKey = toCategoryKey(safeCat)
      const isEssential = isEssentialCategory(categoryKey)

      const title = strings.category_jump.replace('{category}', safeCat)

      const currentFormatted = formatMoney(top.thisAmt, currencySymbol, localeTag)
      const prevFormatted = formatMoney(top.prevAmt, currencySymbol, localeTag)

      const short = strings.category_jump_short
        .replace('{category}', safeCat)
        .replace('{current}', currentFormatted)
        .replace('{pct}', top.sharePct.toFixed(1))
        .replace('{prev}', prevFormatted)

      // const recommendation = ... // REMOVED

      const change = top.thisAmt - top.prevAmt
      const changeFormatted = `+${formatMoney(change, currencySymbol, localeTag)}`

      const detailStats = [
        { label: strings.category_name, value: safeCat },
        { label: strings.category_current, value: formatMoney(top.thisAmt, currencySymbol, localeTag), valueColor: '#F56565' },
        { label: strings.category_previous, value: formatMoney(top.prevAmt, currencySymbol, localeTag) },
        { label: strings.category_change, value: changeFormatted, valueColor: '#F56565' }
      ]

      // Add top transaction in this category as evidence
      const catTxns = expenses
        .filter((t) => {
          const catKey = t.category_id || toCategoryKey(t.category)
          return catKey === top.catKey
        })
        .sort((a, b) => abs(b.amount) - abs(a.amount))
      if (catTxns.length > 0) {
        const topTx = catTxns[0]
        const txTitle = getTxnDisplayName(topTx, strings.generic_transaction).slice(0, 18)
        detailStats.push({
          label: strings.top_category_transaction,
          value: `${txTitle}: ${formatMoney(abs(topTx.amount), currencySymbol, localeTag)}`,
          valueColor: '#FC8181'
        })
      }

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'category_jump', top.catKey),
        type: 'CATEGORY_CHANGE_UP',
        title,
        short,
        // recommendation, // REMOVED
        detailStats,
        ...(isEssential
          ? {
            quickWinLabel: `Cap ${safeCat} spending`,
            quickWinActionType: 'BUDGET_CAP',
            quickWinPayload: {
              scope: safeCat,
              categoryId: top.catKey,
              categoryName: safeCat,
              limitCents: Math.round(top.thisAmt * 0.9 * 100),
              durationDays: 7
            }
          }
          : {
            quickWinLabel: `Freeze ${safeCat}`,
            quickWinActionType: 'NO_SPEND_CATEGORY',
            quickWinPayload: {
              categoryId: top.catKey,
              categoryName: safeCat,
              durationDays: 7
            }
          })
      })
    } else if (drops.length) {
      drops.sort((a, b) => a.changePct - b.changePct)
      const top = drops[0]
      const safeCat = top.displayName

      const title = strings.category_drop.replace('{category}', safeCat)

      const currentFormatted = formatMoney(top.thisAmt, currencySymbol, localeTag)
      const prevFormatted = formatMoney(top.prevAmt, currencySymbol, localeTag)

      const short = strings.category_drop_short
        .replace('{category}', safeCat)
        .replace('{prev}', prevFormatted)
        .replace('{current}', currentFormatted)

      // const recommendation = ... // REMOVED

      const change = top.thisAmt - top.prevAmt
      const changeFormatted = `${formatMoney(Math.abs(change), currencySymbol, localeTag)}`

      const detailStats = [
        { label: strings.category_name, value: safeCat },
        { label: strings.category_current, value: formatMoney(top.thisAmt, currencySymbol, localeTag) },
        { label: strings.category_previous, value: formatMoney(top.prevAmt, currencySymbol, localeTag) },
        { label: strings.category_change, value: `-${changeFormatted}`, valueColor: '#48BB78' }
      ]

      // Add top transaction in this category as evidence
      const catTxnsDrop = expenses
        .filter((t) => {
          const catKey = t.category_id || toCategoryKey(t.category)
          return catKey === top.catKey
        })
        .sort((a, b) => abs(b.amount) - abs(a.amount))
      if (catTxnsDrop.length > 0) {
        const topTx = catTxnsDrop[0]
        const txTitle = getTxnDisplayName(topTx, strings.generic_transaction).slice(0, 18)
        detailStats.push({
          label: strings.top_category_transaction,
          value: `${txTitle}: ${formatMoney(abs(topTx.amount), currencySymbol, localeTag)}`,
          valueColor: '#48BB78'
        })
      }

      insights.push({
        id: generateStableInsightId(userId, monthKey, 'category_drop', top.catKey),
        type: 'CATEGORY_CHANGE_DOWN',
        title,
        short,
        // recommendation, // REMOVED
        detailStats
      })
    }
  }

  // Hard cap: avoid spamming. Keep strongest first N.
  const MAX_INSIGHTS = 6
  return insights.slice(0, MAX_INSIGHTS)
}

async function buildGoalsAndChallengesSummary(supabase: any, userId: string): Promise<string> {
  try {
    const { data: goals, error } = await supabase
      .from('goals')
      .select('name, is_wish, is_challenge, current_amount_cents, target_amount_cents, target_date_millis')
      .eq('user_id', userId)
      .limit(10)

    if (error || !goals || goals.length === 0) {
      return 'User has no active goals or challenges recorded.'
    }

    const isWishGoal = (g: any) =>
      !g?.is_challenge &&
      (g?.is_wish === true || (g?.is_wish !== false && Number(g?.target_amount_cents ?? 0) <= 0))
    const activeGoals = goals.filter((g: any) => !g.is_challenge && !isWishGoal(g))
    const wishItems = goals.filter((g: any) => isWishGoal(g))
    const activeChallenges = goals.filter((g: any) => !!g.is_challenge)

    const parts: string[] = []

    if (activeGoals.length > 0) {
      const goalLines = activeGoals.slice(0, 5).map((g: any) => {
        const curr = (g.current_amount_cents || 0) / 100
        const target = (g.target_amount_cents || 0) / 100
        const progress = target > 0 ? Math.round((curr / target) * 100) : 0
        return `${g.name}: $${curr.toFixed(0)}/$${target.toFixed(0)} (${progress}%)`
      })
      parts.push(`Goals: ${goalLines.join('; ')}`)
    }

    if (wishItems.length > 0) {
      const wishLines = wishItems.slice(0, 5).map((w: any) => {
        const targetDateMillis = Number(w.target_date_millis ?? 0)
        if (targetDateMillis > 0) {
          return `${w.name} (date hint ${new Date(targetDateMillis).toISOString().slice(0, 10)})`
        }
        return `${w.name}`
      })
      parts.push(`Wish items: ${wishLines.join(', ')}`)
    }

    if (activeChallenges.length > 0) {
      const challengeLines = activeChallenges.slice(0, 5).map((c: any) => c.name)
      parts.push(`Challenges: ${challengeLines.join(', ')}`)
    }

    if (parts.length === 0) {
      return 'User has no active goals or challenges recorded.'
    }

    return parts.join(' | ')
  } catch (e) {
    logError('spending_engine.goals_error', { error: String(e) })
    return 'User goals and challenges could not be loaded.'
  }
}

async function generatePersonaAwareInsights(
  insights: Array<RawInsight>,
  monthKey: string,
  goalsSummary: string,
  persona: string,
  generateVariantSlot: (userId: string, monthKey: string, insightId: string, persona: string) => number
): Promise<Array<{ id: string; title: string; short: string }>> {
  if (GEMINI_KEYS.length === 0) {
    logError('spending_engine.missing_gemini_key', { monthKey, persona })
    return generateDeterministicFallbackCopy(insights, persona)
  }

  // Voice rules based on persona
  const voiceRules = persona === 'coach'
    ? `Voice: Coach Wisey
- No emojis anywhere
- Tone: steady, calm, clear, supportive
- No slang, no jokes
- Professional but warm
- Focus on practical guidance`
    : `Voice: Wisey Companion  
- Max 2 emojis per insight (Quick Win line only)
- Only allowed emojis: ✨ 📊 🎯 🔍 💡 📈 📉 💳 🏦 💰 🍳 🏠 🚗 🛒 ☕ 🎬 💪 🎉 🌟 💝
- Tone: warm, energizing, lightly playful but professional
- Encouraging and motivating`

  const prompt = `You are ${persona === 'coach' ? 'Coach Wisey' : 'Wisey Companion'}, WiseFlow's AI money companion.

Transform these spending insights for ${monthKey} into personalized copy that feels alive but stays stable within the month.

${voiceRules}

CRITICAL RULES:
- Facts must not change (numbers are sacred)
- Must not invent merchants/categories  
- Must not shame the user
- Must not add actions/CTAs
- Stay short and scannable
- Must not contradict spending data
- Length limits (HARD): Title ≤42 chars, Subtitle ≤90 chars

USER CONTEXT:
${goalsSummary}

INSIGHTS TO REWRITE:
${insights.map((i, idx) => `${idx + 1}. ID: ${i.id}
   Type: ${i.type}
   Title: "${i.title}"
   Short: "${i.short}"`).join('\n\n')}
   // Recommendation: "" // REMOVED

Return ONLY valid JSON array with this exact structure:
[
  {
    "id": "<exact ID from above>",
    "title": "<rewritten title, ≤42 chars>",
    "short": "<rewritten subtitle, ≤90 chars>" 
  }
]

No backticks, no markdown, no extra text.`

  try {
    const res = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
      contents: [{
        parts: [{ text: prompt }]
      }]
    })

    if (!res) {
      throw new Error('Vertex AI request failed')
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Gemini error ${res.status}: ${txt}`)
    }

    const data = await res.json()
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!rawText) {
      throw new Error('No text from Gemini')
    }

    // Parse JSON response
    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    const jsonText = jsonMatch ? jsonMatch[0] : rawText
    const parsed = JSON.parse(jsonText)

    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }

    // Validate and enforce all rules on Gemini output
    const validated = parsed.map((item: any) => {
      let title = String(item.title || '').slice(0, 42)
      let short = String(item.short || '').slice(0, 90)

      // Track validation rewrites
      let validationRewrites = 0
      const originalTitle = String(item.title || '')
      const originalShort = String(item.short || '')

      if (originalTitle.length > 42) validationRewrites++
      if (originalShort.length > 90) validationRewrites++

      // Apply persona-specific validation
      if (persona === 'coach') {
        // Coach: Remove any emojis that might have slipped through
        const titleBefore = title
        const shortBefore = short

        title = removeEmojis(title)
        short = removeEmojis(short)

        if (titleBefore !== title || shortBefore !== short) {
          validationRewrites++
        }
      } else {
        // Companion: Enforce max 2 emoji rule and allowed list (Quick Win only)
        const titleBefore = title
        const shortBefore = short

        title = enforceCompanionEmojiRules(title)
        short = enforceCompanionEmojiRules(short)

        if (titleBefore !== title || shortBefore !== short) {
          validationRewrites++
        }
      }

      // Log validation rewrites for monitoring
      if (validationRewrites > 0) {
        log('spending_engine.validation_rewrite', {
          monthKey,
          persona,
          insightId: String(item.id || ''),
          rewriteCount: validationRewrites
        })
      }

      return {
        id: String(item.id || ''),
        title,
        short,
        // recommendation // REMOVED
      }
    })

    log('spending_engine.gemini_success', {
      monthKey,
      persona,
      inputCount: insights.length,
      outputCount: validated.length
    })

    return validated

  } catch (e) {
    log('spending_engine.gemini_failure', {
      monthKey,
      persona,
      error: String(e)
    })

    // Fallback to deterministic template copy with persona rules applied
    return generateDeterministicFallbackCopy(insights, persona)
  }
}

// Deterministic fallback that applies persona rules to original insights
function generateDeterministicFallbackCopy(
  insights: Array<RawInsight>,
  persona: string
): Array<{ id: string; title: string; short: string }> {
  return insights.map(insight => {
    let title = insight.title.slice(0, 42)
    let short = insight.short.slice(0, 90)
    // let recommendation = insight.recommendation.slice(0, 110) // REMOVED

    // Apply persona-specific rules to fallback copy
    if (persona === 'coach') {
      // Coach: Remove any emojis, ensure professional tone
      title = removeEmojis(title)
      short = removeEmojis(short)
      // recommendation // REMOVED = removeEmojis(recommendation)
    } else {
      // Companion: Apply emoji rules but keep existing emojis if compliant
      title = enforceCompanionEmojiRules(title)
      short = enforceCompanionEmojiRules(short)
      // recommendation // REMOVED = enforceCompanionEmojiRules(recommendation)
    }

    return {
      id: insight.id,
      title,
      short,
      // recommendation // REMOVED
    }
  })
}

// Helper function to remove all emojis (for Coach persona)
function removeEmojis(text: string): string {
  // Remove emoji characters using Unicode ranges
  return text.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim()
}

// Helper function to enforce Companion emoji rules
function enforceCompanionEmojiRules(text: string): string {
  const allowedEmojis = ['✨', '📊', '🎯', '🔍', '💡', '📈', '📉', '💳', '🏦', '💰']

  // Find all emojis in text
  const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
  const emojis = text.match(emojiRegex) || []

  // Filter to allowed emojis only
  const allowedEmojisInText = emojis.filter(emoji => allowedEmojis.includes(emoji))

  // Remove all emojis first
  let cleanText = text.replace(emojiRegex, '').trim()

  // Add back max 1 allowed emoji at the end if any were found
  if (allowedEmojisInText.length > 0) {
    cleanText = cleanText + ' ' + allowedEmojisInText[0]
  }

  return cleanText.trim()
}

// ============================================================================
// 3-WORD NOTIFICATION CARD COPY GENERATION
// ============================================================================

type ThreeWordCopy = {
  title: string    // exactly 3 words
  subtitle: string // exactly 3 words
}

// Fallback template catalog for 3-word copy
const FALLBACK_TEMPLATES: Record<string, ThreeWordCopy> = {
  SPENDING_VELOCITY: {
    title: "Spending Velocity High",
    subtitle: "Pace Increased Fast"
  },
  SPIKE_DAY: {
    title: "Spending Spike Today",
    subtitle: "Review Large Purchases"
  },
  WEEKEND_PATTERN: {
    title: "Weekend Pattern Found",
    subtitle: "Spending Clusters Weekends"
  },
  TOP_CATEGORY: {
    title: "Category Leads Spending",
    subtitle: "Set Weekly Limit"
  },
  TOP_MERCHANT: {
    title: "Top Merchant Identified",
    subtitle: "Clear Spending Leader"
  },
  INCOME_VS_SPEND: {
    title: "Income Beats Spending",
    subtitle: "Healthy Cash Buffer"
  },
  SMALL_LEAKS: {
    title: "Small Leaks Found",
    subtitle: "Review Tiny Purchases"
  },
  SUBSCRIPTION_PATTERN: {
    title: "Subscription Pattern Active",
    subtitle: "Monthly Charges Detected"
  },
  CATEGORY_JUMP: {
    title: "Category Spending Jumped",
    subtitle: "Unusual Activity Detected"
  },
  CATEGORY_DROP: {
    title: "Category Spending Dropped",
    subtitle: "Lower Activity Noticed"
  },
  TIME_OF_DAY: {
    title: "Time Pattern Found",
    subtitle: "Spending Clusters Hours"
  },
  GOAL_CONTRIB: {
    title: "Goal Progress Good",
    subtitle: "Savings On Track"
  },
  DEFAULT: {
    title: "Spending Pattern Found",
    subtitle: "Review Recent Trends"
  }
}

/**
 * Generate 3-word notification card copy using Gemini with strict validation
 * Falls back to deterministic templates if Gemini violates rules
 */
async function generateThreeWordNotificationCopy(
  insights: Array<RawInsight>,
  monthKey: string
): Promise<Array<{ id: string; title: string; subtitle: string }>> {
  if (GEMINI_KEYS.length === 0) {
    logError('spending_engine.missing_gemini_key_3word', { monthKey })
    return generateThreeWordFallbackCopy(insights)
  }

  const systemPrompt = `You are a concise UX copywriter for financial insights.
OUTPUT MUST BE STRICT JSON, no extra text.

Hard rules:
- title: EXACTLY 3 words, Title Case
- subtitle: EXACTLY 3 words, Title Case  
- Use only letters A–Z and spaces. No punctuation, emojis, numbers, symbols, currency signs, or abbreviations
- Do not include time periods or dates (e.g., "This Month", "Last 30 Days", "Detected 2 hours ago")
- Summarize the "what" in title, the "so what" in subtitle
- Do not repeat a word inside a field
- If a dynamic label has multiple words, compress into one token (e.g., "FastFood", "RideHailing") to preserve the 3-word rule

Return JSON ONLY: { "title": "...", "subtitle": "..." }`

  const userPrompt = `Transform these insights into 3-word notification cards:

${insights.map((insight, idx) => `${idx + 1}. ID: ${insight.id}
   InsightType: ${insight.type}
   Context: ${insight.title}
   Signal: ${insight.short}`).join('\n\n')}

CRITICAL: Return an array with the same length as the input (${insights.length} items).
Each object must include the exact same id as provided above.
Do not reorder the items.

Examples (shape only):
{ "title": "Spending Velocity High", "subtitle": "Pace Increased Fast" }
{ "title": "Spending Spike Today", "subtitle": "Review Large Purchases" }
{ "title": "Weekend Pattern Found", "subtitle": "Spending Clusters Weekends" }
{ "title": "Dining Leads Spending", "subtitle": "Set Weekly Limit" }
{ "title": "Income Beats Spending", "subtitle": "Healthy Cash Buffer" }

Return JSON array with exact IDs:
[
${insights.map(insight => `  { "id": "${insight.id}", "title": "...", "subtitle": "..." }`).join(',\n')}
]`

  try {
    const res = await fetchGeminiWithKeyFallback('gemini-2.5-flash-lite', {
      contents: [{
        parts: [{ text: systemPrompt + '\n\n' + userPrompt }]
      }]
    })

    if (!res) {
      throw new Error('All Gemini keys failed')
    }

    const data = await res.json()
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!rawText) {
      throw new Error('No text from Gemini')
    }

    // Parse JSON response
    const jsonMatch = rawText.match(/\[[\s\S]*\]/)
    const jsonText = jsonMatch ? jsonMatch[0] : rawText
    const parsed = JSON.parse(jsonText)

    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }

    // Strict validation with ID-based mapping (Fix #1: No more index-based mapping)
    const validatedById = new Map<string, { id: string; title: string; subtitle: string; usedFallback?: boolean }>()

    // First, process all Gemini outputs and validate them
    parsed.forEach((item: any) => {
      const id = String(item.id || '').trim()
      if (!id) return // Skip items without IDs

      const originalInsight = insights.find(insight => insight.id === id)
      if (!originalInsight) {
        log('spending_engine.3word_fallback', {
          reason: 'unknown_insight_id',
          monthKey,
          geminiId: id,
          availableIds: insights.map(i => i.id)
        })
        return // Skip unknown IDs
      }

      const result = validateThreeWordCopy(item, originalInsight, monthKey)
      validatedById.set(id, result)
    })

    // Second, ensure all original insights have copy (use fallback for missing)
    const validated = insights.map(originalInsight => {
      const existing = validatedById.get(originalInsight.id)
      if (existing) {
        return existing
      }

      // Missing from Gemini output - use fallback
      log('spending_engine.3word_fallback', {
        reason: 'missing_from_gemini_output',
        monthKey,
        insightId: originalInsight.id,
        insightType: originalInsight.type,
        usedFallback: true
      })

      const fallback = generateSingleThreeWordFallback(originalInsight)
      return { ...fallback, usedFallback: true }
    })

    log('spending_engine.3word_success', {
      monthKey,
      inputCount: insights.length,
      outputCount: validated.length,
      fallbackCount: validated.filter(v => v.usedFallback).length,
      llmComplianceRate: Math.round((1 - (validated.filter(v => v.usedFallback).length / validated.length)) * 100) // Percentage of successful LLM generations
    })

    return validated.map(v => ({ id: v.id, title: v.title, subtitle: v.subtitle }))

  } catch (e) {
    log('spending_engine.3word_failure', {
      monthKey,
      error: String(e)
    })

    return generateThreeWordFallbackCopy(insights)
  }
}

/**
 * Strict validator for 3-word copy with fallback on violations
 */
function validateThreeWordCopy(
  item: any,
  originalInsight: RawInsight,
  monthKey: string
): { id: string; title: string; subtitle: string; usedFallback?: boolean } {
  const id = String(item.id || originalInsight.id)
  let title = String(item.title || '').trim()
  let subtitle = String(item.subtitle || '').trim()

  // Strip punctuation and symbols
  title = title.replace(/[^A-Za-z\s]/g, '').replace(/\s+/g, ' ').trim()
  subtitle = subtitle.replace(/[^A-Za-z\s]/g, '').replace(/\s+/g, ' ').trim()

  // Check word count
  const titleWords = title.split(' ').filter(w => w.length > 0)
  const subtitleWords = subtitle.split(' ').filter(w => w.length > 0)

  if (titleWords.length !== 3 || subtitleWords.length !== 3) {
    log('spending_engine.3word_fallback', {
      reason: 'invalid_word_count',
      monthKey,
      insightId: id,
      insightType: originalInsight.type,
      titleWords: titleWords.length,
      subtitleWords: subtitleWords.length,
      llmTitle: title,
      llmSubtitle: subtitle,
      usedFallback: true
    })

    const fallback = generateSingleThreeWordFallback(originalInsight)
    return { ...fallback, usedFallback: true }
  }

  // Convert to Title Case
  title = titleWords.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
  subtitle = subtitleWords.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')

  return { id, title, subtitle }
}

/**
 * Generate fallback copy for all insights using templates
 */
function generateThreeWordFallbackCopy(
  insights: Array<RawInsight>
): Array<{ id: string; title: string; subtitle: string }> {
  return insights.map(insight => generateSingleThreeWordFallback(insight))
}

/**
 * Generate fallback copy for a single insight using templates
 */
function generateSingleThreeWordFallback(insight: RawInsight): { id: string; title: string; subtitle: string } {
  const insightType = insight.type?.toUpperCase() || 'DEFAULT'

  // Try exact match first
  let template = FALLBACK_TEMPLATES[insightType]

  // Try partial matches for complex types
  if (!template) {
    const typeKey = Object.keys(FALLBACK_TEMPLATES).find(key =>
      insightType.includes(key) || key.includes(insightType.split('_')[0])
    )
    template = typeKey ? FALLBACK_TEMPLATES[typeKey] : FALLBACK_TEMPLATES.DEFAULT
  }

  // Handle dynamic category/merchant substitution
  if (template.title.includes('Category') && insight.metadata?.categoryName) {
    const categoryName = insight.metadata.categoryName.replace(/\s+/g, '')
    template = {
      title: `${categoryName} Leads Spending`,
      subtitle: template.subtitle
    }
  }

  return {
    id: insight.id,
    title: template.title,
    subtitle: template.subtitle
  }
}
