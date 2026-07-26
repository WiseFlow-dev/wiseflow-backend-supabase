import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

import { cors } from '../_shared/cors.ts'
import { log, logError } from '../_shared/logger.ts'
import { getServiceSupabaseClient, getUserFromAuthHeader } from '../_shared/supabaseClient.ts'
import {
  normalizeTransactionsToMainCurrency,
  resolveMainCurrencyCode,
} from '../_shared/currencyReporting.ts'

type ProofChip = {
  label: string
  value: string
}

type UpdateCard = {
  id: string
  insightType:
    | 'SPENDING_VELOCITY'
    | 'INCOME_SHARE'
    | 'TOP_CATEGORY'
    | 'TOP_MERCHANT'
    | 'SPIKE_DAY'
    | 'SMALL_LEAKS'
    | 'WEEKEND_SPIKE'
    | 'SUBSCRIPTIONS'
    | 'TIME_OF_DAY'
    | 'GOAL_CONTRIB'
    | 'CATEGORY_CHANGE_UP'
    | 'CATEGORY_CHANGE_DOWN'
    | 'BUDGET_OVERSPENDING_PACE'
  kind: 'action' | 'notification'
  source: 'ai' | 'rules' | 'system'
  title: string
  body: string
  whyItMatters: string
  proofChips: ProofChip[]
  severity: 'info' | 'warning'
  createdAt: string
  actionLabel?: string
  actionType?: string
  payload?: Record<string, unknown>
}

type WiseyUpdatesResponse = {
  ok: true
  monthKey: string
  actions: UpdateCard[]
  notifications: UpdateCard[]
  meta: {
    version: 'v1'
    bootstrap: true
    userId: string
  }
}

type CompleteBudgetCapRequest = {
  action: 'complete_budget_cap'
  monthKey?: unknown
  updateId?: unknown
  title?: unknown
  body?: unknown
  whyItMatters?: unknown
  scope?: unknown
  durationDays?: unknown
  capAmountCents?: unknown
  currencyCode?: unknown
}

type CompleteNoSpendMerchantRequest = {
  action: 'complete_no_spend_merchant'
  monthKey?: unknown
  updateId?: unknown
  title?: unknown
  body?: unknown
  whyItMatters?: unknown
  merchant?: unknown
  durationDays?: unknown
}

type CompleteNoSpendCategoryRequest = {
  action: 'complete_no_spend_category'
  monthKey?: unknown
  updateId?: unknown
  title?: unknown
  body?: unknown
  whyItMatters?: unknown
  category?: unknown
  durationDays?: unknown
}

type MarkReadRequest = {
  action: 'mark_read'
  updateId?: unknown
}

type MutationResponse = {
  ok: true
  handled: boolean
  executedActionId: string
}

type MarkReadResponse = {
  ok: true
  handled: boolean
  markedCount: number
}

type WiseyLocale =
  | 'en-US'
  | 'fr-FR'
  | 'es-ES'
  | 'de-DE'
  | 'ru-RU'
  | 'tr-TR'
  | 'cs-CZ'
  | 'el-GR'
  | 'sv-SE'
  | 'fi-FI'
  | 'hu-HU'
  | 'uk-UA'
  | 'da-DK'
  | 'id-ID'
  | 'it-IT'
  | 'nl-NL'
  | 'pl-PL'
  | 'pt-PT'
  | 'ro-RO'
  | 'zh-CN'
  | 'ja-JP'

const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT') || ''

function userHasProAccess(user: unknown): boolean {
  const u = (user ?? {}) as Record<string, unknown>
  // Only app_metadata is trustworthy: it can only be written server-side.
  // user_metadata is editable by the user via the auth API, so it must never
  // be used for entitlement checks.
  const appMeta = (u['app_metadata'] ?? {}) as Record<string, unknown>
  const asLower = (value: unknown): string => String(value ?? '').trim().toLowerCase()

  const truthyFlag = (value: unknown): boolean =>
    value === true || asLower(value) === 'true' || asLower(value) === '1'
  if (
    truthyFlag(appMeta['is_pro']) ||
    truthyFlag(appMeta['pro'])
  ) {
    return true
  }

  const planCandidates = [
    appMeta['plan'],
    appMeta['tier'],
    appMeta['subscription_tier'],
    appMeta['subscription_plan'],
  ]
    .map(asLower)
    .filter(Boolean)

  return planCandidates.some((value) =>
    value === 'pro' ||
    value === 'premium' ||
    value === 'paid' ||
    value.startsWith('pro_') ||
    value.startsWith('premium_')
  )
}

type WiseyPushSummary = {
  actionsCount: number
  notificationsCount: number
  monthKey: string
}

async function getFcmAccessToken(serviceAccount: Record<string, string>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  const payload = btoa(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  const signingInput = `${header}.${payload}`
  const pemKey = serviceAccount.private_key.replace(/\\n/g, '\n')
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const keyBytes = Uint8Array.from(atob(pemBody), (char) => char.charCodeAt(0))
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  )
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signingInput}.${sig}`,
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => 'unknown')
    throw new Error(`OAuth2 token exchange failed: ${tokenRes.status} ${err}`)
  }

  const tokenData = await tokenRes.json()
  return tokenData.access_token
}

async function pushWiseyUpdatesToUser(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  summary: WiseyPushSummary,
): Promise<void> {
  if (!FCM_SERVICE_ACCOUNT_JSON) {
    log('wisey_updates.push.skip_no_fcm', { userId })
    return
  }

  const { data: rows, error } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('user_id', userId)

  if (error) {
    logError('wisey_updates.push.tokens_error', { userId, error })
    return
  }

  if (!rows || rows.length === 0) {
    log('wisey_updates.push.no_tokens', { userId })
    return
  }

  let accessToken: string
  let projectId: string
  try {
    const serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON)
    projectId = serviceAccount.project_id
    accessToken = await getFcmAccessToken(serviceAccount)
  } catch (error) {
    logError('wisey_updates.push.prepare_failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  let successCount = 0
  const deadTokens: string[] = []
  const payload = {
    type: 'wisey_updates',
    actions_count: String(Math.max(0, summary.actionsCount)),
    notifications_count: String(Math.max(0, summary.notificationsCount)),
    month_key: summary.monthKey,
  }

  for (const row of rows) {
    const token = String((row as Record<string, unknown>)['token'] ?? '').trim()
    if (!token) continue
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              data: payload,
              android: { priority: 'HIGH' },
            },
          }),
        },
      )

      if (response.ok) {
        successCount += 1
      } else {
        const body = await response.json().catch(() => null)
        const status = body?.error?.status ?? ''
        if (status === 'NOT_FOUND' || status === 'UNREGISTERED') {
          deadTokens.push(token)
        } else {
          logError('wisey_updates.push.send_failed', {
            userId,
            status: response.status,
            token: token.slice(0, 20),
          })
        }
      }
    } catch (error) {
      logError('wisey_updates.push.exception', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (deadTokens.length > 0) {
    const { error: deleteError } = await supabase
      .from('device_tokens')
      .delete()
      .eq('user_id', userId)
      .in('token', deadTokens)
    if (deleteError) {
      logError('wisey_updates.push.token_cleanup_failed', {
        userId,
        error: deleteError.message,
      })
    }
  }

  log('wisey_updates.push.sent', {
    userId,
    count: successCount,
    actionsCount: summary.actionsCount,
    notificationsCount: summary.notificationsCount,
  })
}

const WISEY_LOCALE_BY_LANGUAGE: Record<string, WiseyLocale> = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
  de: 'de-DE',
  ru: 'ru-RU',
  tr: 'tr-TR',
  cs: 'cs-CZ',
  el: 'el-GR',
  sv: 'sv-SE',
  fi: 'fi-FI',
  hu: 'hu-HU',
  uk: 'uk-UA',
  da: 'da-DK',
  id: 'id-ID',
  in: 'id-ID',
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-PT',
  ro: 'ro-RO',
  zh: 'zh-CN',
  ja: 'ja-JP',
}

function normalizeWiseyLocale(raw: unknown): WiseyLocale {
  const value = String(raw ?? '').trim().toLowerCase()
  const language = value.split(/[\s,;_-]+/)[0]
  return WISEY_LOCALE_BY_LANGUAGE[language] ?? 'en-US'
}

function isTurkishLocale(locale: WiseyLocale): boolean {
  return locale === 'tr-TR'
}

function localizedPeriodLabel(periodLabel: string, locale: WiseyLocale): string {
  if (!isTurkishLocale(locale)) return periodLabel.toLowerCase()
  switch (periodLabel.trim().toLowerCase()) {
    case 'month-to-date':
      return 'ayın şu ana kadarki kısmı'
    case 'cycle-to-date':
      return 'döngünün şu ana kadarki kısmı'
    case 'full month':
      return 'tam ay'
    case 'full cycle':
      return 'tam döngü'
    default:
      return periodLabel.toLowerCase()
  }
}

function normalizeCategoryKey(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return ''
  return value
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const SUPPRESSED_CATEGORY_KEYS = new Set([
  'uncategorized',
  'other',
  'other-expense',
  'other-income',
  'misc',
  'miscellaneous',
  'unknown',
])

function isSuppressedCategoryKey(raw: unknown): boolean {
  return SUPPRESSED_CATEGORY_KEYS.has(normalizeCategoryKey(raw))
}

function isTransferCategoryKey(raw: unknown): boolean {
  const key = normalizeCategoryKey(raw)
  return (
    key === 'transfer' ||
    key === 'internal-transfer' ||
    key === 'wallet-transfer' ||
    key === 'money-transfer' ||
    key === 'account-transfer'
  )
}

function isGoalCategoryKey(raw: unknown): boolean {
  const key = normalizeCategoryKey(raw)
  return key.startsWith('goal-') || key === 'my-goals' || key === 'goal'
}

function isRefundLikeCategoryKey(raw: unknown): boolean {
  return REFUND_LIKE_CATEGORY_KEYS.has(normalizeCategoryKey(raw))
}

const SUPPRESSED_WISEY_INSIGHT_TYPES = new Set<UpdateCard['insightType']>([
  'SPENDING_VELOCITY',
  'INCOME_SHARE',
  'TOP_CATEGORY',
  'CATEGORY_CHANGE_UP',
  'CATEGORY_CHANGE_DOWN',
  'TOP_MERCHANT',
])

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors })
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ ok: false, error: 'Method not allowed' }, 405)
  }

  try {
    const supabase = getServiceSupabaseClient()
    const user = await getUserFromAuthHeader(supabase, req)
    if (!userHasProAccess(user)) {
      return json(
        { ok: false, error: 'pro_required', message: 'Wisey Updates is Pro only.' },
        403,
      )
    }

    const body = req.method === 'POST'
      ? await req.json().catch(() => ({}))
      : {}

    if (req.method === 'POST' && body?.action === 'complete_budget_cap') {
      const result = await completeBudgetCapFlow(supabase, user.id, body as CompleteBudgetCapRequest)
      return json(result)
    }
    if (req.method === 'POST' && body?.action === 'complete_no_spend_merchant') {
      const result = await completeNoSpendMerchantFlow(supabase, user.id, body as CompleteNoSpendMerchantRequest)
      return json(result)
    }
    if (req.method === 'POST' && body?.action === 'complete_no_spend_category') {
      const result = await completeNoSpendCategoryFlow(supabase, user.id, body as CompleteNoSpendCategoryRequest)
      return json(result)
    }
    if (req.method === 'POST' && body?.action === 'mark_read') {
      const currencyResolution = await resolveMainCurrencyCode(supabase, user.id, {
        headerCurrency: req.headers.get('x-main-currency'),
        bodyCurrency: body?.currencyCode,
      })
      const result = await markInsightReadFlow(
        supabase,
        user.id,
        body as MarkReadRequest,
        currencyResolution.currency,
      )
      return json(result)
    }

    const monthKey = normalizeMonthKey(body?.monthKey)
    const timeZone = normalizeTimeZone(
      body?.timezone ??
      req.headers.get('x-timezone') ??
      req.headers.get('timezone'),
    ) ?? 'UTC'
    const locale = normalizeWiseyLocale(
      body?.locale ??
      req.headers.get('x-app-language') ??
      req.headers.get('accept-language'),
    )
    const cycleStartDay = await loadCycleStartDay(supabase, user.id)
    const cycleKey = currentCycleKey(cycleStartDay)

    log('wisey_updates.request', {
      userId: user.id,
      monthKey,
      method: req.method,
      locale,
    })

    const currencyResolution = await resolveMainCurrencyCode(supabase, user.id, {
      headerCurrency: req.headers.get('x-main-currency'),
      bodyCurrency: body?.currencyCode,
    })
    const currencyCode = currencyResolution.currency

    log('wisey_updates.currency_resolution', {
      userId: user.id,
      resolved_currency: currencyCode,
      currency_source: currencyResolution.source,
    })

    const [spikeDayCard, topCategoryCard, smallLeaksCard, weekendSpikeCard, subscriptionsCard, timeOfDayCard, goalContribCard, budgetPaceCards] = await Promise.all([
      buildSpikeDayCard(supabase, user.id, monthKey, currencyCode, locale),
      buildTopCategoryCard(supabase, user.id, monthKey, currencyCode),
      buildSmallLeaksCard(supabase, user.id, monthKey, currencyCode, locale),
      buildWeekendSpikeCard(supabase, user.id, currencyCode, locale),
      buildSubscriptionsCard(supabase, user.id, monthKey, currencyCode, locale),
      buildTimeOfDayCard(supabase, user.id, monthKey, timeZone, currencyCode, locale),
      buildGoalContribCard(supabase, user.id, monthKey, currencyCode, locale),
      buildBudgetOverspendingPaceCards(supabase, user.id, monthKey, currencyCode, locale),
    ])

    const cards: UpdateCard[] = []
    if (spikeDayCard) {
      cards.push(spikeDayCard)
    } else if (topCategoryCard) {
      cards.push(topCategoryCard)
    }
    if (smallLeaksCard) cards.push(smallLeaksCard)
    if (weekendSpikeCard) cards.push(weekendSpikeCard)
    if (subscriptionsCard) cards.push(subscriptionsCard)
    if (timeOfDayCard) cards.push(timeOfDayCard)
    if (goalContribCard) cards.push(goalContribCard)
    for (const card of budgetPaceCards) cards.push(card)

    const visibleCards = await filterDismissedCards(
      supabase,
      user.id,
      monthKey,
      cards,
    )
    const unsuppressedVisibleCards = visibleCards.filter(
      (card) => !SUPPRESSED_WISEY_INSIGHT_TYPES.has(card.insightType),
    )

    const insertedCards = await persistWiseyInsightsForCycle(
      supabase,
      user.id,
      monthKey,
      cycleKey,
      unsuppressedVisibleCards,
      currencyCode,
    )

    if (insertedCards.length > 0) {
      const actionsCount = insertedCards.filter((card) => card.kind === 'action').length
      const notificationsCount = insertedCards.length - actionsCount
      await pushWiseyUpdatesToUser(supabase, user.id, {
        actionsCount,
        notificationsCount,
        monthKey,
      })
    }

    const unreadCards = await loadUnreadWiseyInsights(supabase, user.id, currencyCode)

    const response: WiseyUpdatesResponse = {
      ok: true,
      monthKey,
      actions: unreadCards.filter((card) => card.kind === 'action'),
      notifications: unreadCards.filter((card) => card.kind === 'notification'),
      meta: {
        version: 'v1',
        bootstrap: true,
        userId: user.id,
      },
    }

    return json(response)
  } catch (error) {
    logError('wisey_updates.error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    )
  }
})

function normalizeMonthKey(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}$/.test(raw)) {
    return raw
  }

  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
    },
  })
}

const WISEY_HISTORY_PREFIX = 'wisey_'
const WISEY_HISTORY_SOURCE = 'wisey_updates'

type InsightHistoryRow = {
  id: string
  insight_type: string | null
  insight_key: string | null
  shown_at: string | null
  user_action: string | null
  metadata: Record<string, unknown> | null
}

function currentCycleKey(cycleStartDay: number, now = new Date()): string {
  // Keep cycle key generation aligned with the same anchor logic used for range math.
  // This avoids month-end drift (e.g. selected day=31 in 30-day months).
  const { startUTC } = getCurrentCycleWindow(cycleStartDay, now)
  return startUTC.toISOString().slice(0, 10)
}

function wiseyInsightKey(insightType: UpdateCard['insightType'], cycleKey: string): string {
  return `${WISEY_HISTORY_PREFIX}${insightType.toLowerCase()}_${cycleKey}`
}

function isReadAction(action: string | null | undefined): boolean {
  const value = String(action ?? '').trim().toLowerCase()
  return value === 'read' || value === 'acted_on' || value === 'dismissed' || value === 'accepted'
}

function extractWiseyCardFromHistory(row: InsightHistoryRow): UpdateCard | null {
  const metadata = row.metadata ?? {}
  const source = String(metadata['source'] ?? '')
  if (source !== WISEY_HISTORY_SOURCE) return null
  const card = metadata['card']
  if (!card || typeof card !== 'object') return null
  const raw = card as Record<string, unknown>
  const insightType = String(raw['insightType'] ?? '').trim()
  const kind = String(raw['kind'] ?? '').trim()
  const sourceType = String(raw['source'] ?? '').trim()
  const title = String(raw['title'] ?? '').trim()
  const body = String(raw['body'] ?? '').trim()
  const whyItMatters = String(raw['whyItMatters'] ?? '').trim()
  const severity = String(raw['severity'] ?? '').trim()
  const id = String(raw['id'] ?? '').trim()
  if (!id || !insightType || !kind || !sourceType || !title || !body) return null

  const proofRaw = Array.isArray(raw['proofChips']) ? raw['proofChips'] : []
  const proofChips: ProofChip[] = proofRaw
    .map((chip) => {
      const c = (chip ?? {}) as Record<string, unknown>
      const label = String(c['label'] ?? '').trim()
      const value = String(c['value'] ?? '').trim()
      if (!label || !value) return null
      return { label, value }
    })
    .filter((chip): chip is ProofChip => chip !== null)

  const payload = (raw['payload'] && typeof raw['payload'] === 'object')
    ? (raw['payload'] as Record<string, unknown>)
    : undefined

  const updateCard: UpdateCard = {
    id,
    insightType: insightType as UpdateCard['insightType'],
    kind: kind as UpdateCard['kind'],
    source: sourceType as UpdateCard['source'],
    title,
    body,
    whyItMatters,
    proofChips,
    severity: (severity || 'info') as UpdateCard['severity'],
    createdAt: String(raw['createdAt'] ?? row.shown_at ?? new Date().toISOString()),
    actionLabel: raw['actionLabel'] ? String(raw['actionLabel']) : undefined,
    actionType: raw['actionType'] ? String(raw['actionType']) : undefined,
    payload,
  }
  return updateCard
}

async function loadWiseyHistoryRows(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<InsightHistoryRow[]> {
  const { data, error } = await supabase
    .from('insight_history')
    .select('id, insight_type, insight_key, shown_at, user_action, metadata')
    .eq('user_id', userId)
    .like('insight_key', `${WISEY_HISTORY_PREFIX}%`)
    .order('shown_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to load wisey insight history: ${error.message}`)
  }

  return (data ?? []) as InsightHistoryRow[]
}

async function persistWiseyInsightsForCycle(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  cycleKey: string,
  cards: UpdateCard[],
  currencyCode: string,
): Promise<UpdateCard[]> {
  if (cards.length === 0) return []

  const rows = await loadWiseyHistoryRows(supabase, userId)
  const unreadIdentities = new Set<string>()
  const existingIdentitiesForCycle = new Set<string>()
  const unreadRowByIdentityForCycle = new Map<string, InsightHistoryRow>()

  for (const row of rows) {
    const card = extractWiseyCardFromHistory(row)
    if (!card) continue
    const rowCurrencyCode = normalizeCurrencyCode((row.metadata ?? {})['currencyCode'])
    const sameCurrency = rowCurrencyCode === currencyCode
    if (!sameCurrency) continue
    const identity = wiseyRefreshIdentity(card)
    const rowCycleKey = String((row.metadata ?? {})['cycleKey'] ?? '')
    if (!isReadAction(row.user_action)) {
      unreadIdentities.add(identity)
      if (rowCycleKey === cycleKey && !unreadRowByIdentityForCycle.has(identity)) {
        unreadRowByIdentityForCycle.set(identity, row)
      }
    }
    if (rowCycleKey === cycleKey) {
      existingIdentitiesForCycle.add(identity)
    }
  }

  const now = new Date().toISOString()
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{ id: string; insightKey: string; metadata: Record<string, unknown> }> = []
  const insertedCards: UpdateCard[] = []

  for (const card of cards) {
    // Keep one unread card per refresh identity per cycle, but refresh its content in place.
    const identity = wiseyRefreshIdentity(card)
    const existingUnreadForCycle = unreadRowByIdentityForCycle.get(identity)
    if (existingUnreadForCycle && !allowsMultiShowPerCycle(card.insightType)) {
      const historyKey = wiseyInsightKey(card.insightType, cycleKey)
      updates.push({
        id: existingUnreadForCycle.id,
        insightKey: historyKey,
        metadata: {
          source: WISEY_HISTORY_SOURCE,
          monthKey,
          cycleKey,
          currencyCode,
          updateId: card.id,
          card,
        },
      })
      continue
    }

    if (unreadIdentities.has(identity) && !allowsMultiShowPerCycle(card.insightType)) continue
    if (existingIdentitiesForCycle.has(identity) && !allowsMultiShowPerCycle(card.insightType)) continue

    const historyKey = wiseyInsightKey(card.insightType, cycleKey)
    inserts.push({
      user_id: userId,
      insight_type: card.insightType,
      insight_key: historyKey,
      shown_at: now,
      score: null,
      user_action: null,
      confidence_level: null,
      metadata: {
        source: WISEY_HISTORY_SOURCE,
        monthKey,
        cycleKey,
        currencyCode,
        updateId: card.id,
        card,
      },
      created_at: now,
    })

    insertedCards.push(card)
    unreadIdentities.add(identity)
    existingIdentitiesForCycle.add(identity)
  }

  for (const row of updates) {
    const { error } = await supabase
      .from('insight_history')
      .update({
        insight_key: row.insightKey,
        shown_at: now,
        metadata: row.metadata,
      })
      .eq('id', row.id)
      .eq('user_id', userId)

    if (error) {
      throw new Error(`Failed to refresh wisey insight row ${row.id}: ${error.message}`)
    }
  }

  if (inserts.length === 0) return insertedCards
  const { error } = await supabase.from('insight_history').insert(inserts)
  if (error) {
    throw new Error(`Failed to persist wisey insights: ${error.message}`)
  }

  return insertedCards
}

function wiseyRefreshIdentity(card: UpdateCard): string {
  if (card.insightType === 'BUDGET_OVERSPENDING_PACE') {
    const budgetId = String((card.payload ?? {})['budgetId'] ?? '').trim()
    return `BUDGET_OVERSPENDING_PACE:${budgetId}`
  }
  return card.insightType
}

function allowsMultiShowPerCycle(insightType: UpdateCard['insightType']): boolean {
  return insightType === 'WEEKEND_SPIKE' || insightType === 'SPIKE_DAY'
}

async function loadUnreadWiseyInsights(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  currencyCode: string,
): Promise<UpdateCard[]> {
  const rows = await loadWiseyHistoryRows(supabase, userId)
  const cards: UpdateCard[] = []
  const legacyUnreadIds: string[] = []
  const suppressedUnreadIds: string[] = []
  for (const row of rows) {
    if (isReadAction(row.user_action)) continue
    const metadata = row.metadata ?? {}
    const source = String(metadata['source'] ?? '')
    if (source !== WISEY_HISTORY_SOURCE) continue
    const rowCurrencyCode = normalizeCurrencyCode(metadata['currencyCode'])
    if (!rowCurrencyCode) {
      legacyUnreadIds.push(row.id)
      continue
    }
    if (rowCurrencyCode !== currencyCode) continue
    const card = extractWiseyCardFromHistory(row)
    if (!card) continue
    if (SUPPRESSED_WISEY_INSIGHT_TYPES.has(card.insightType)) {
      suppressedUnreadIds.push(row.id)
      continue
    }
    cards.push(card)
  }

  const staleUnreadIds = [...legacyUnreadIds, ...suppressedUnreadIds]
  if (staleUnreadIds.length > 0) {
    const { error } = await supabase
      .from('insight_history')
      .update({ user_action: 'dismissed' })
      .in('id', staleUnreadIds)
      .eq('user_id', userId)
    if (error) {
      logError('wisey_updates.cleanup_legacy_rows_failed', {
        userId,
        count: staleUnreadIds.length,
        error: error.message,
      })
    }
  }

  cards.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return cards
}

async function markWiseyHistoryAction(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  updateId: string,
  action: string,
  currencyCode?: string,
): Promise<number> {
  const rows = await loadWiseyHistoryRows(supabase, userId)
  const targetIds = rows
    .filter((row) => {
      const metadata = row.metadata ?? {}
      const source = String(metadata['source'] ?? '')
      const rowUpdateId = String(metadata['updateId'] ?? '')
      const rowCurrencyCode = normalizeCurrencyCode(metadata['currencyCode'])
      const currencyMatches = currencyCode ? rowCurrencyCode === currencyCode : true
      return source === WISEY_HISTORY_SOURCE &&
        rowUpdateId === updateId &&
        currencyMatches &&
        !isReadAction(row.user_action)
    })
    .map((row) => row.id)

  if (targetIds.length === 0) return 0

  const { error } = await supabase
    .from('insight_history')
    .update({ user_action: action })
    .in('id', targetIds)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to mark wisey insight ${action}: ${error.message}`)
  }

  return targetIds.length
}

async function markInsightReadFlow(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  request: MarkReadRequest,
  currencyCode: string,
): Promise<MarkReadResponse> {
  const updateId = typeof request.updateId === 'string' ? request.updateId.trim() : ''
  if (!updateId) {
    throw new Error('Missing updateId')
  }

  const markedCount = await markWiseyHistoryAction(supabase, userId, updateId, 'read', currencyCode)

  await supabase
    .from('insight_interactions')
    .insert({
      user_id: userId,
      insight_id: updateId,
      insight_type: inferInsightTypeFromUpdateId(updateId),
      action_type: 'read',
      insight_content: null,
      month_key: normalizeMonthKey(undefined),
    })

  return {
    ok: true,
    handled: true,
    markedCount,
  }
}

async function completeBudgetCapFlow(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  request: CompleteBudgetCapRequest,
): Promise<MutationResponse> {
  const monthKey = normalizeMonthKey(request.monthKey)
  const updateId = typeof request.updateId === 'string' ? request.updateId.trim() : ''
  if (!updateId) {
    throw new Error('Missing updateId')
  }
  const insightType = inferInsightTypeFromUpdateId(updateId)

  const title = typeof request.title === 'string' ? request.title.trim() : ''
  const body = typeof request.body === 'string' ? request.body.trim() : ''
  const whyItMatters = typeof request.whyItMatters === 'string' ? request.whyItMatters.trim() : ''
  const scope = typeof request.scope === 'string' ? request.scope.trim().toLowerCase() : 'discretionary'
  const durationDays = Number(request.durationDays ?? 0)
  const capAmountCents = Number(request.capAmountCents ?? 0)
  const currencyResolution = await resolveMainCurrencyCode(supabase, userId, {})
  const currencyCode = currencyResolution.currency

  const { error: stateError } = await supabase
    .from('insight_user_state')
    .upsert({
      user_id: userId,
      insight_id: updateId,
      month_key: monthKey,
      is_dismissed: true,
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  if (stateError) {
    throw new Error(`Failed to save insight state: ${stateError.message}`)
  }

  const { data: existingExecuted, error: existingError } = await supabase
    .from('executed_actions')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', 'wisey_budget_cap_created_v1')
    .contains('meta', { source_update_id: updateId })
    .maybeSingle()
  if (existingError) {
    throw new Error(`Failed to check executed action: ${existingError.message}`)
  }

  const executedActionId = existingExecuted?.id ?? crypto.randomUUID()
  if (!existingExecuted) {
    const { error: insertError } = await supabase
      .from('executed_actions')
      .insert({
        id: executedActionId,
        user_id: userId,
        proposal_id: null,
        rule_id: 'wisey_budget_cap_created_v1',
        status: 'success',
        payload_json: {
          title,
          body,
          why_it_matters: whyItMatters,
          challenge_name: 'Budget Cap Challenge',
          scope,
          duration_days: Number.isFinite(durationDays) ? durationDays : 0,
          cap_amount_cents: Number.isFinite(capAmountCents) ? capAmountCents : 0,
          currency_code: currencyCode,
          source_update_id: updateId,
          month_key: monthKey,
        },
        meta: {
          source: 'wisey_updates',
          source_update_id: updateId,
          month_key: monthKey,
        },
      })
    if (insertError) {
      throw new Error(`Failed to save completed action: ${insertError.message}`)
    }
  }

  await supabase
    .from('insight_interactions')
    .insert({
      user_id: userId,
      insight_id: updateId,
      insight_type: insightType,
      action_type: 'acted_on',
      insight_content: body,
      month_key: monthKey,
    })

  await markWiseyHistoryAction(supabase, userId, updateId, 'acted_on')

  return {
    ok: true,
    handled: true,
    executedActionId,
  }
}

async function completeNoSpendMerchantFlow(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  request: CompleteNoSpendMerchantRequest,
): Promise<MutationResponse> {
  const monthKey = normalizeMonthKey(request.monthKey)
  const updateId = typeof request.updateId === 'string' ? request.updateId.trim() : ''
  if (!updateId) {
    throw new Error('Missing updateId')
  }
  const insightType = inferInsightTypeFromUpdateId(updateId)

  const title = typeof request.title === 'string' ? request.title.trim() : ''
  const body = typeof request.body === 'string' ? request.body.trim() : ''
  const whyItMatters = typeof request.whyItMatters === 'string' ? request.whyItMatters.trim() : ''
  const merchant = typeof request.merchant === 'string' ? request.merchant.trim() : ''
  const durationDays = Number(request.durationDays ?? 0)

  const { error: stateError } = await supabase
    .from('insight_user_state')
    .upsert({
      user_id: userId,
      insight_id: updateId,
      month_key: monthKey,
      is_dismissed: true,
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  if (stateError) {
    throw new Error(`Failed to save insight state: ${stateError.message}`)
  }

  const { data: existingExecuted, error: existingError } = await supabase
    .from('executed_actions')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', 'wisey_no_spend_merchant_created_v1')
    .contains('meta', { source_update_id: updateId })
    .maybeSingle()
  if (existingError) {
    throw new Error(`Failed to check executed action: ${existingError.message}`)
  }

  const executedActionId = existingExecuted?.id ?? crypto.randomUUID()
  if (!existingExecuted) {
    const challengeName = `${merchant || 'Merchant'} Pause`
    const { error: insertError } = await supabase
      .from('executed_actions')
      .insert({
        id: executedActionId,
        user_id: userId,
        proposal_id: null,
        rule_id: 'wisey_no_spend_merchant_created_v1',
        status: 'success',
        payload_json: {
          title,
          body,
          why_it_matters: whyItMatters,
          challenge_name: challengeName,
          merchant: merchant || null,
          duration_days: Number.isFinite(durationDays) ? durationDays : 0,
          source_update_id: updateId,
          month_key: monthKey,
        },
        meta: {
          source: 'wisey_updates',
          source_update_id: updateId,
          month_key: monthKey,
        },
      })
    if (insertError) {
      throw new Error(`Failed to save completed merchant action: ${insertError.message}`)
    }
  }

  await supabase
    .from('insight_interactions')
    .insert({
      user_id: userId,
      insight_id: updateId,
      insight_type: insightType,
      action_type: 'acted_on',
      insight_content: body,
      month_key: monthKey,
    })

  await markWiseyHistoryAction(supabase, userId, updateId, 'acted_on')

  return {
    ok: true,
    handled: true,
    executedActionId,
  }
}

async function completeNoSpendCategoryFlow(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  request: CompleteNoSpendCategoryRequest,
): Promise<MutationResponse> {
  const monthKey = normalizeMonthKey(request.monthKey)
  const updateId = typeof request.updateId === 'string' ? request.updateId.trim() : ''
  if (!updateId) {
    throw new Error('Missing updateId')
  }
  const insightType = inferInsightTypeFromUpdateId(updateId)

  const title = typeof request.title === 'string' ? request.title.trim() : ''
  const body = typeof request.body === 'string' ? request.body.trim() : ''
  const whyItMatters = typeof request.whyItMatters === 'string' ? request.whyItMatters.trim() : ''
  const category = typeof request.category === 'string' ? request.category.trim() : ''
  const durationDays = Number(request.durationDays ?? 0)

  const { error: stateError } = await supabase
    .from('insight_user_state')
    .upsert({
      user_id: userId,
      insight_id: updateId,
      month_key: monthKey,
      is_dismissed: true,
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  if (stateError) {
    throw new Error(`Failed to save insight state: ${stateError.message}`)
  }

  const { data: existingExecuted, error: existingError } = await supabase
    .from('executed_actions')
    .select('id')
    .eq('user_id', userId)
    .eq('rule_id', 'wisey_no_spend_category_created_v1')
    .contains('meta', { source_update_id: updateId })
    .maybeSingle()
  if (existingError) {
    throw new Error(`Failed to check executed action: ${existingError.message}`)
  }

  const executedActionId = existingExecuted?.id ?? crypto.randomUUID()
  if (!existingExecuted) {
    const challengeName = `${category || 'Category'} Pause`
    const { error: insertError } = await supabase
      .from('executed_actions')
      .insert({
        id: executedActionId,
        user_id: userId,
        proposal_id: null,
        rule_id: 'wisey_no_spend_category_created_v1',
        status: 'success',
        payload_json: {
          title,
          body,
          why_it_matters: whyItMatters,
          challenge_name: challengeName,
          category: category || null,
          duration_days: Number.isFinite(durationDays) ? durationDays : 0,
          source_update_id: updateId,
          month_key: monthKey,
        },
        meta: {
          source: 'wisey_updates',
          source_update_id: updateId,
          month_key: monthKey,
        },
      })
    if (insertError) {
      throw new Error(`Failed to save completed category action: ${insertError.message}`)
    }
  }

  await supabase
    .from('insight_interactions')
    .insert({
      user_id: userId,
      insight_id: updateId,
      insight_type: insightType,
      action_type: 'acted_on',
      insight_content: body,
      month_key: monthKey,
    })

  await markWiseyHistoryAction(supabase, userId, updateId, 'acted_on')

  return {
    ok: true,
    handled: true,
    executedActionId,
  }
}

type TxnRow = {
  amount: number
  category: string | null
  date: string
  createdAt: string | null
  title: string | null
  note: string | null
  isOpeningBalance: boolean
  isManualTopup: boolean
}

type FairComparison = {
  currentPeriodExpenseCents: number
  prevPeriodExpenseCents: number
  currentPeriodIncomeCents: number
  periodLabel: string
  currentDay: number
}

type CurrentPeriodSnapshot = {
  expenseCents: number
  incomeCents: number
  periodLabel: string
  currentDay: number
  cycleLengthDays: number
  txns: TxnRow[]
}

type CategoryProfile = {
  expenseTier: string | null
  isFixedObligation: boolean
}

type ControllableExpenseRow = {
  amountCents: number
  date: string
  category: string
  merchant: string
  hourUtc: number
  timestampMs: number
}

type RecurringItem = {
  amountCents: number
  frequency: string | null
}

async function buildSpendingVelocityCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const comparison = await getVelocityComparison(supabase, userId, monthKey, cycleStartDay, currencyCode)

  if (!comparison) return null

  const current = comparison.currentPeriodExpenseCents
  const previous = comparison.prevPeriodExpenseCents
  if (current <= 0 && previous <= 0) return null

  const deltaCents = current - previous
  const absDeltaCents = Math.abs(deltaCents)
  const percentChange = calculatePercentChange(current, previous)
  const absPercentChange = Math.abs(percentChange)
  const deltaSharePercent = Math.round((absDeltaCents / Math.max(current, previous, 1)) * 100)
  const isHigher = deltaCents > 0

  const isImmediateWarning =
    isHigher &&
    absPercentChange >= 15 &&
    deltaSharePercent >= 8

  const isCheckpointInsight =
    comparison.currentDay >= 25 &&
    absPercentChange >= 8 &&
    deltaSharePercent >= 4

  if (!isImmediateWarning && !isCheckpointInsight) {
    return null
  }

  const currentFormatted = formatCurrency(current, currencyCode)
  const previousFormatted = formatCurrency(previous, currencyCode)
  const deltaFormatted = formatCurrency(absDeltaCents, currencyCode)
  const signWord = isHigher ? 'higher' : 'lower'

  const title = isImmediateWarning
    ? `Spending pace is ${absPercentChange}% higher`
    : isHigher
      ? `Spending pace is ${absPercentChange}% above last cycle`
      : `Spending pace is ${absPercentChange}% below last cycle`

  const body = isImmediateWarning
    ? `You are spending about ${absPercentChange}% faster than the same point last cycle (${currentFormatted} vs ${previousFormatted}).`
    : `At this point in the cycle, your spending is ${absPercentChange}% ${signWord} than the same point last cycle (${currentFormatted} vs ${previousFormatted}).`

  const whyItMatters = isImmediateWarning
    ? `If this pace keeps going, the rest of the cycle can feel tighter fast. Catching it now gives you room to adjust before it starts squeezing savings or bills.`
    : isHigher
      ? `This is a useful checkpoint because it shows your current cycle is running hotter than usual. It helps you spot drift before it becomes a bigger problem.`
      : `This breathing room is useful because it shows you have been spending more calmly than usual. That extra space can support savings, goals, or a less stressful month-end.`

  const proofChips: ProofChip[] = [
    { label: comparison.periodLabel, value: currentFormatted },
    { label: 'Same point last cycle', value: previousFormatted },
    { label: 'Change', value: `${percentChange >= 0 ? '+' : ''}${percentChange}%` },
    { label: 'Difference', value: deltaFormatted },
  ]

  const actionPayload = isImmediateWarning
    ? buildBudgetCapPayload(comparison.currentPeriodIncomeCents, current, absPercentChange)
    : undefined
  const isActionableWarning = isImmediateWarning && !!actionPayload

  return {
    id: `spending_velocity_${monthKey}_${isImmediateWarning ? 'warning' : 'checkpoint'}`,
    insightType: 'SPENDING_VELOCITY',
    kind: isActionableWarning ? 'action' : 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips,
    severity: isImmediateWarning ? 'warning' : 'info',
    createdAt: new Date().toISOString(),
    ...(isActionableWarning ? { actionLabel: 'Limit' } : {}),
    ...(isActionableWarning ? { actionType: 'BUDGET_CAP' } : {}),
    ...(actionPayload ? { payload: actionPayload } : {}),
  }
}

async function buildIncomeShareCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)

  if (!snapshot) return null

  const incomeCents = snapshot.incomeCents
  const expenseCents = snapshot.expenseCents
  if (incomeCents <= 0 || expenseCents <= 0) return null

  const ratioPercent = Math.round((expenseCents / incomeCents) * 100)
  const cycleProgressPercent = Math.max(
    1,
    Math.min(100, Math.round((snapshot.currentDay / Math.max(snapshot.cycleLengthDays, 1)) * 100)),
  )
  const overshootPercent = ratioPercent - cycleProgressPercent
  const isFresh = hasFreshTxnData(snapshot.txns, 48)
  if (!isFresh) return null

  if (ratioPercent < 10) {
    return null
  }

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const spendMix = summarizeSpendMix(snapshot.txns, categoryIndex)
  const controllableSharePercent = Math.round((spendMix.controllableCents / Math.max(expenseCents, 1)) * 100)

  const inRegularWindow = snapshot.currentDay >= 10 && snapshot.currentDay <= 25
  const severeEarlyOverride = snapshot.currentDay >= 7 && snapshot.currentDay < 10 && overshootPercent >= 30
  const isImmediateWarning =
    (inRegularWindow || severeEarlyOverride) &&
    overshootPercent >= 15 &&
    controllableSharePercent >= 30
  const isCheckpointInsight =
    inRegularWindow &&
    overshootPercent <= -10

  if (!isImmediateWarning && !isCheckpointInsight) {
    return null
  }

  const expenseFormatted = formatCurrency(expenseCents, currencyCode)
  const incomeFormatted = formatCurrency(incomeCents, currencyCode)
  const unspentFormatted = formatCurrency(Math.max(incomeCents - expenseCents, 0), currencyCode)
  const leftPercent = Math.max(0, 100 - ratioPercent)

  const title = isImmediateWarning
    ? `Spending has reached ${ratioPercent}% of income`
    : `Spending is using ${ratioPercent}% of income`

  const body = isImmediateWarning
    ? `You have already used about ${ratioPercent}% of your ${snapshot.periodLabel.toLowerCase()} income (${expenseFormatted} of ${incomeFormatted}), which is ${overshootPercent}% ahead of cycle pace.`
    : `You are using about ${ratioPercent}% of your ${snapshot.periodLabel.toLowerCase()} income (${expenseFormatted} of ${incomeFormatted}), which is ${Math.abs(overshootPercent)}% below cycle pace.`

  const whyItMatters = isImmediateWarning
    ? `You are running ahead of income pace, and a meaningful share is controllable spending. A temporary cap can protect the room left in this cycle.`
    : `This checkpoint shows your spending is running safely below cycle pace, which lowers month-end pressure and helps keep room for goals.`

  const proofChips: ProofChip[] = [
    { label: 'Share', value: `${ratioPercent}%` },
    { label: 'Cycle progress', value: `${cycleProgressPercent}%` },
    { label: 'Gap', value: `${overshootPercent >= 0 ? '+' : ''}${overshootPercent}%` },
    { label: 'Controllable share', value: `${controllableSharePercent}%` },
    { label: 'Left', value: `${leftPercent}%` },
    { label: 'Remaining', value: unspentFormatted },
  ]

  const actionPayload = isImmediateWarning
    ? buildBudgetCapPayload(incomeCents, expenseCents, Math.max(overshootPercent, 15))
    : undefined
  const isActionableWarning = isImmediateWarning && !!actionPayload

  return {
    id: `income_share_${monthKey}_${isImmediateWarning ? 'warning' : 'checkpoint'}`,
    insightType: 'INCOME_SHARE',
    kind: isActionableWarning ? 'action' : 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips,
    severity: isImmediateWarning ? 'warning' : 'info',
    createdAt: new Date().toISOString(),
    ...(isActionableWarning ? { actionLabel: 'Limit' } : {}),
    ...(isActionableWarning ? { actionType: 'BUDGET_CAP' } : {}),
    ...(actionPayload ? { payload: actionPayload } : {}),
  }
}

async function buildTopCategoryCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null
  if (snapshot.currentDay < 5) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  if (controllableRows.length < 5) return null

  const distinctDays = new Set(controllableRows.map((row) => row.date)).size
  if (distinctDays < 3) return null

  const totalCents = controllableRows.reduce((sum, row) => sum + row.amountCents, 0)
  if (totalCents <= 0) return null

  const byCategory = new Map<string, { amountCents: number; txnCount: number }>()
  for (const row of controllableRows) {
    const current = byCategory.get(row.category) ?? { amountCents: 0, txnCount: 0 }
    current.amountCents += row.amountCents
    current.txnCount += 1
    byCategory.set(row.category, current)
  }

  const ranked = [...byCategory.entries()]
    .sort((a, b) => {
      if (b[1].amountCents !== a[1].amountCents) return b[1].amountCents - a[1].amountCents
      if (b[1].txnCount !== a[1].txnCount) return b[1].txnCount - a[1].txnCount
      return a[0].localeCompare(b[0])
    })
  if (ranked.length === 0) return null

  const [topCategory, topStats] = ranked[0]
  const sharePercent = Math.round((topStats.amountCents / totalCents) * 100)
  if (sharePercent < 25 || topStats.txnCount < 3) return null

  const title = `${topCategory} is your top controllable category`
  const body = `${topCategory} is taking about ${sharePercent}% of your controllable spend so far this ${snapshot.periodLabel.toLowerCase()}.`
  const whyItMatters = `Spotting your top category early helps you decide where a small adjustment would have the biggest impact.`

  return {
    id: `top_category_${monthKey}_${slugify(topCategory)}`,
    insightType: 'TOP_CATEGORY',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: 'Category share', value: `${sharePercent}%` },
      { label: 'Category spend', value: formatCurrency(topStats.amountCents, currencyCode) },
      { label: 'Transactions', value: String(topStats.txnCount) },
      { label: 'Distinct days', value: String(distinctDays) },
    ],
    severity: 'info',
    createdAt: new Date().toISOString(),
    payload: {
      category: topCategory,
      sharePercent,
      spendCents: topStats.amountCents,
      txnCount: topStats.txnCount,
    },
  }
}

async function buildTopMerchantCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null
  if (snapshot.currentDay < 5) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  if (controllableRows.length < 5) return null

  const distinctDays = new Set(controllableRows.map((row) => row.date)).size
  if (distinctDays < 3) return null

  const totalCents = controllableRows.reduce((sum, row) => sum + row.amountCents, 0)
  if (totalCents <= 0) return null

  const byMerchant = new Map<string, { amountCents: number; txnCount: number; categoryAmounts: Map<string, number> }>()
  for (const row of controllableRows) {
    const current = byMerchant.get(row.merchant) ?? { amountCents: 0, txnCount: 0, categoryAmounts: new Map<string, number>() }
    current.amountCents += row.amountCents
    current.txnCount += 1
    current.categoryAmounts.set(row.category, (current.categoryAmounts.get(row.category) ?? 0) + row.amountCents)
    byMerchant.set(row.merchant, current)
  }

  const ranked = [...byMerchant.entries()]
    .sort((a, b) => {
      if (b[1].amountCents !== a[1].amountCents) return b[1].amountCents - a[1].amountCents
      if (b[1].txnCount !== a[1].txnCount) return b[1].txnCount - a[1].txnCount
      return a[0].localeCompare(b[0])
    })
  if (ranked.length === 0) return null

  const [topMerchant, topStats] = ranked[0]
  const sharePercent = Math.round((topStats.amountCents / totalCents) * 100)
  if (sharePercent < 15 || topStats.txnCount < 2) return null

  let topCategoryForMerchant = 'Uncategorized'
  let topCategoryAmount = 0
  for (const [category, amountCents] of topStats.categoryAmounts.entries()) {
    if (amountCents > topCategoryAmount) {
      topCategoryAmount = amountCents
      topCategoryForMerchant = category
    }
  }
  const overlapWithTopCategoryPercent = topStats.amountCents > 0
    ? Math.round((topCategoryAmount / topStats.amountCents) * 100)
    : 0

  const title = `${topMerchant} is your top merchant`
  const body = `${topMerchant} accounts for about ${sharePercent}% of controllable spend this ${snapshot.periodLabel.toLowerCase()}.`
  const whyItMatters = `Merchant-level patterns are specific and easy to act on, so they often produce cleaner behavior changes.`

  return {
    id: `top_merchant_${monthKey}_${slugify(topMerchant)}`,
    insightType: 'TOP_MERCHANT',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: 'Merchant share', value: `${sharePercent}%` },
      { label: 'Merchant spend', value: formatCurrency(topStats.amountCents, currencyCode) },
      { label: 'Transactions', value: String(topStats.txnCount) },
      { label: 'Distinct days', value: String(distinctDays) },
    ],
    severity: 'info',
    createdAt: new Date().toISOString(),
    payload: {
      merchant: topMerchant,
      sharePercent,
      spendCents: topStats.amountCents,
      txnCount: topStats.txnCount,
      topCategory: topCategoryForMerchant,
      overlapWithTopCategoryPercent,
    },
  }
}

async function buildSpikeDayCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  if (controllableRows.length < 5) return null

  const dayTotals = new Map<string, number>()
  for (const row of controllableRows) {
    dayTotals.set(row.date, (dayTotals.get(row.date) ?? 0) + row.amountCents)
  }

  const yesterdayKey = toDateKey(new Date(Date.now() - 86_400_000).toISOString()) ?? ''
  const spikeDayTotal = dayTotals.get(yesterdayKey) ?? 0
  if (spikeDayTotal <= 0) return null

  const baselineValues = [...dayTotals.entries()]
    .filter(([dayKey, total]) => dayKey !== yesterdayKey && total > 0)
    .map(([, total]) => total)
  if (baselineValues.length < 3) return null
  const baselineMedian = median(baselineValues)
  if (baselineMedian <= 0) return null

  const spikeFactor = spikeDayTotal / baselineMedian
  if (spikeFactor < 1.8) return null

  const spikeRows = controllableRows.filter((row) => row.date === yesterdayKey)
  if (spikeRows.length === 0) return null

  const merchantTotals = new Map<string, number>()
  const categoryTotals = new Map<string, number>()
  const merchantCounts = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  const merchantCategoryTotals = new Map<string, Map<string, number>>()
  for (const row of spikeRows) {
    merchantTotals.set(row.merchant, (merchantTotals.get(row.merchant) ?? 0) + row.amountCents)
    categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0) + row.amountCents)
    merchantCounts.set(row.merchant, (merchantCounts.get(row.merchant) ?? 0) + 1)
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    const merchantCategories = merchantCategoryTotals.get(row.merchant) ?? new Map<string, number>()
    merchantCategories.set(row.category, (merchantCategories.get(row.category) ?? 0) + row.amountCents)
    merchantCategoryTotals.set(row.merchant, merchantCategories)
  }

  const topMerchant = [...merchantTotals.entries()].sort((a, b) => b[1] - a[1])[0]
  const topCategory = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1])[0]
  const topMerchantShare = topMerchant ? Math.round((topMerchant[1] / spikeDayTotal) * 100) : 0
  const topCategoryShare = topCategory ? Math.round((topCategory[1] / spikeDayTotal) * 100) : 0
  const topMerchantCategoryBreakdown = topMerchant
    ? [...(merchantCategoryTotals.get(topMerchant[0]) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])[0]
    : undefined
  const topMerchantCategoryKey = topMerchantCategoryBreakdown
    ? normalizeCategoryKey(topMerchantCategoryBreakdown[0])
    : ''
  const topMerchantCategoryProfile = topMerchantCategoryKey
    ? categoryIndex.get(topMerchantCategoryKey)
    : undefined
  const merchantBudgetCapPayload =
    topMerchant && topMerchantShare > 50 && topMerchantCategoryBreakdown &&
      isBudgetCapExpenseTier(topMerchantCategoryProfile?.expenseTier)
      ? buildCategoryBudgetCapPayload(
          snapshot.incomeCents,
          snapshot.expenseCents,
          topMerchantCategoryBreakdown[0],
          topMerchantCategoryBreakdown[1],
          topMerchantShare,
        )
      : undefined
  const topCategoryKey = topCategory ? normalizeCategoryKey(topCategory[0]) : ''
  const topCategoryProfile = topCategoryKey ? categoryIndex.get(topCategoryKey) : undefined
  const spikeBudgetCapPayload =
    merchantBudgetCapPayload ??
    (
      topCategory && topCategoryShare > 50 && isBudgetCapExpenseTier(topCategoryProfile?.expenseTier)
        ? buildCategoryBudgetCapPayload(
            snapshot.incomeCents,
            snapshot.expenseCents,
            topCategory[0],
            topCategory[1],
            topCategoryShare,
          )
        : undefined
    )

  let actionType = 'GENERAL_NO_SPEND_WARNING'
  let actionLabel = 'Pause'
  if (spikeBudgetCapPayload) {
    actionType = 'BUDGET_CAP'
    actionLabel = 'Limit'
  } else if (topMerchant && topMerchantShare > 50) {
    actionType = 'NO_SPEND_MERCHANT'
    actionLabel = 'Pause Merchant'
  } else if (topCategory && topCategoryShare > 50) {
    actionType = 'NO_SPEND_CATEGORY'
    actionLabel = 'Pause Category'
  }

  const isDistributedSpike = actionType === 'GENERAL_NO_SPEND_WARNING'
  const categoryBreakdown = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([category, cents]) => ({
      category,
      spendCents: cents,
      sharePercent: spikeDayTotal > 0 ? Math.round((cents / spikeDayTotal) * 100) : 0,
      txnCount: categoryCounts.get(category) ?? 0,
    }))
  const merchantBreakdown = [...merchantTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([merchant, cents]) => ({
      merchant,
      spendCents: cents,
      sharePercent: spikeDayTotal > 0 ? Math.round((cents / spikeDayTotal) * 100) : 0,
      txnCount: merchantCounts.get(merchant) ?? 0,
    }))
  const extraVsTypicalCents = Math.max(0, spikeDayTotal - baselineMedian)
  const projectedWeeklyExtraCents = extraVsTypicalCents * 2
  const title = isDistributedSpike
    ? (isTurkishLocale(locale)
        ? 'Dün harcama birçok alana yayıldı'
        : 'Yesterday spread high across multiple areas')
    : (isTurkishLocale(locale)
        ? `Dün bir sıçrama günüydü (tipiğin %${Math.round(spikeFactor * 100)} kadarı)`
        : `Yesterday was a spike day (${Math.round(spikeFactor * 100)}% of typical)`)
  const body = isDistributedSpike
    ? (isTurkishLocale(locale)
        ? `Dün ${formatCurrency(spikeDayTotal, currencyCode, locale)} harcadın; bu, tipik gününün yaklaşık ${spikeFactor.toFixed(1)} katı (${formatCurrency(baselineMedian, currencyCode, locale)}). Tek bir işletme ya da kategori baskın değildi, yani bu gün genelinde yayılmış bir kayma gibi görünüyor.`
        : `You spent ${formatCurrency(spikeDayTotal, currencyCode, locale)} yesterday, about ${spikeFactor.toFixed(1)}x your typical day (${formatCurrency(baselineMedian, currencyCode, locale)}). No single merchant or category dominated, so this looks like broad drift across your day.`)
    : (isTurkishLocale(locale)
        ? `Dünün kontrol edilebilir harcaması ${formatCurrency(spikeDayTotal, currencyCode, locale)} seviyesine ulaştı; bu, tipik gününün yaklaşık ${spikeFactor.toFixed(1)} katı (${formatCurrency(baselineMedian, currencyCode, locale)} medyan).`
        : `Yesterday's controllable spending reached ${formatCurrency(spikeDayTotal, currencyCode, locale)}, about ${spikeFactor.toFixed(1)}x your typical day (${formatCurrency(baselineMedian, currencyCode, locale)} median).`)
  const whyItMatters = isDistributedSpike
    ? (isTurkishLocale(locale)
        ? `Böyle günler tekrar ederse ilerlemeyi sessizce eritebilir: bu desenin bu hafta sadece iki kez daha tekrarlanması bile normal temponun üzerine yaklaşık ${formatCurrency(projectedWeeklyExtraCents, currencyCode, locale)} ekleyebilir.`
        : `If days like this repeat, they can quietly eat progress: repeating this pattern just twice this week could add about ${formatCurrency(projectedWeeklyExtraCents, currencyCode, locale)} above your normal pace.`)
    : (isTurkishLocale(locale)
        ? 'Sıçrama günü eylemleri, gün tamamlandıktan hemen sonra; tetikleyen desen hâlâ net ve değiştirilebilirken en faydalıdır.'
        : 'Spike-day actions are most useful right after the day completes, while the trigger pattern is still clear and changeable.')

  return {
    id: `spike_day_${monthKey}_${yesterdayKey}`,
    insightType: 'SPIKE_DAY',
    kind: isDistributedSpike ? 'notification' : 'action',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Sıçrama günü' : 'Spike day', value: formatCurrency(spikeDayTotal, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Tipik gün' : 'Typical day', value: formatCurrency(baselineMedian, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Katsayı' : 'Factor', value: `${spikeFactor.toFixed(1)}x` },
      { label: isTurkishLocale(locale) ? 'Tarih' : 'Date', value: yesterdayKey },
    ],
    severity: 'warning',
    createdAt: new Date().toISOString(),
    ...(isDistributedSpike ? { actionLabel: isTurkishLocale(locale) ? 'Sızıntıları göster' : 'Show leaks' } : {
      actionLabel: isTurkishLocale(locale)
        ? (actionType === 'BUDGET_CAP'
            ? 'Sınırla'
            : actionType === 'NO_SPEND_MERCHANT'
              ? 'İşletmeyi duraklat'
              : actionType === 'NO_SPEND_CATEGORY'
                ? 'Kategoriyi duraklat'
                : actionLabel)
        : actionLabel,
    }),
    ...(isDistributedSpike ? { actionType: 'VIEW_SPIKE_BREAKDOWN' } : { actionType }),
    payload: {
      spikeDate: yesterdayKey,
      spikeDayCents: spikeDayTotal,
      baselineMedianCents: baselineMedian,
      spikeFactor,
      topMerchant: topMerchant?.[0] ?? null,
      topMerchantShare,
      topCategory: topCategory?.[0] ?? null,
      topCategoryShare,
      categoryBreakdown,
      merchantBreakdown,
      ...(spikeBudgetCapPayload ?? {}),
    },
  }
}

async function buildSmallLeaksCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null
  if (snapshot.currentDay < 7) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  if (controllableRows.length < 8) return null

  const distinctDays = new Set(controllableRows.map((row) => row.date)).size
  if (distinctDays < 2) return null

  const totalControllableCents = controllableRows.reduce((sum, row) => sum + row.amountCents, 0)
  if (totalControllableCents <= 0) return null

  const perTxnSmallMax = Math.max(1, Math.round(totalControllableCents * 0.02))

  const smallRows = controllableRows.filter((row) => row.amountCents <= perTxnSmallMax)
  if (smallRows.length < 5) return null

  const smallTotalCents = smallRows.reduce((sum, row) => sum + row.amountCents, 0)
  const smallSharePercent = Math.round((smallTotalCents / totalControllableCents) * 100)
  if (smallSharePercent < 8) {
    await dismissUnreadWiseyInsightForCycle(supabase, userId, 'SMALL_LEAKS', cycleKey, currencyCode)
    return null
  }

  const incomeCents = Math.max(0, snapshot.incomeCents)
  if (incomeCents > 0) {
    const incomeSharePercent = Math.round((smallTotalCents / incomeCents) * 100)
    if (incomeSharePercent < 3) {
      await dismissUnreadWiseyInsightForCycle(supabase, userId, 'SMALL_LEAKS', cycleKey, currencyCode)
      return null
    }
  }

  const title = isTurkishLocale(locale)
    ? 'Küçük harcamalar bu döngüde birikiyor'
    : 'Small purchases are adding up this cycle'
  const body = isTurkishLocale(locale)
    ? `${smallRows.length} küçük harcama yaptın; toplamı ${formatCurrency(smallTotalCents, currencyCode, locale)} ve bu, ${localizedPeriodLabel(snapshot.periodLabel, locale)} boyunca kontrol edilebilir harcamanın yaklaşık %${smallSharePercent} kadarı.`
    : `You made ${smallRows.length} small purchases totaling ${formatCurrency(smallTotalCents, currencyCode, locale)}, about ${smallSharePercent}% of controllable spend so far this ${localizedPeriodLabel(snapshot.periodLabel, locale)}.`
  const whyItMatters = isTurkishLocale(locale)
    ? 'Bunları fark etmek zor olabilir çünkü her biri tek başına küçük görünür; ama birlikte döngü sonucunu sessizce rayından çıkarabilirler.'
    : 'These are easy to miss because each one feels small, but together they can quietly push your cycle outcome off track.'

  const leakCategoryTotals = new Map<string, number>()
  const leakMerchantTotals = new Map<string, number>()
  const leakCategoryCounts = new Map<string, number>()
  const leakMerchantCounts = new Map<string, number>()
  for (const row of smallRows) {
    leakCategoryTotals.set(row.category, (leakCategoryTotals.get(row.category) ?? 0) + row.amountCents)
    leakMerchantTotals.set(row.merchant, (leakMerchantTotals.get(row.merchant) ?? 0) + row.amountCents)
    leakCategoryCounts.set(row.category, (leakCategoryCounts.get(row.category) ?? 0) + 1)
    leakMerchantCounts.set(row.merchant, (leakMerchantCounts.get(row.merchant) ?? 0) + 1)
  }
  const categoryBreakdown = [...leakCategoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([category, cents]) => ({
      category,
      spendCents: cents,
      sharePercent: smallTotalCents > 0 ? Math.round((cents / smallTotalCents) * 100) : 0,
      txnCount: leakCategoryCounts.get(category) ?? 0,
    }))
  const merchantBreakdown = [...leakMerchantTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([merchant, cents]) => ({
      merchant,
      spendCents: cents,
      sharePercent: smallTotalCents > 0 ? Math.round((cents / smallTotalCents) * 100) : 0,
      txnCount: leakMerchantCounts.get(merchant) ?? 0,
    }))

  return {
    id: `small_leaks_${monthKey}_${smallSharePercent}_${smallRows.length}`,
    insightType: 'SMALL_LEAKS',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Küçük harcamalar' : 'Small purchases', value: String(smallRows.length) },
      { label: isTurkishLocale(locale) ? 'Toplam sızıntı' : 'Leak total', value: formatCurrency(smallTotalCents, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Kontrol edilebilir pay' : 'Share of controllable', value: `${smallSharePercent}%` },
      { label: isTurkishLocale(locale) ? 'Küçük harcama üst sınırı' : 'Small purchase max', value: formatCurrency(perTxnSmallMax, currencyCode, locale) },
    ],
    severity: 'info',
    createdAt: new Date().toISOString(),
    actionLabel: isTurkishLocale(locale) ? 'Sızıntıları göster' : 'Show leaks',
    actionType: 'VIEW_SPIKE_BREAKDOWN',
    payload: {
      smallTxnCount: smallRows.length,
      smallTotalCents,
      smallSharePercent,
      perTxnSmallMaxCents: perTxnSmallMax,
      controllableTotalCents: totalControllableCents,
      categoryBreakdown,
      merchantBreakdown,
    },
  }
}

async function buildWeekendSpikeCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const now = new Date()
  const start = new Date(now.getTime() - 27 * 86_400_000)
  const txns = await loadTransactions(supabase, userId, start, now, currencyCode)
  if (txns.length === 0) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(txns, categoryIndex)
  if (controllableRows.length < 10) return null

  const weekendByDay = new Map<string, number>()
  const weekdayByDay = new Map<string, number>()
  const weekendRows: ControllableExpenseRow[] = []
  for (const row of controllableRows) {
    const dayType = weekendOrWeekday(row.date)
    if (dayType === 'weekend') {
      weekendByDay.set(row.date, (weekendByDay.get(row.date) ?? 0) + row.amountCents)
      weekendRows.push(row)
    } else {
      weekdayByDay.set(row.date, (weekdayByDay.get(row.date) ?? 0) + row.amountCents)
    }
  }

  const weekendDays = weekendByDay.size
  const weekdayDays = weekdayByDay.size
  if (weekendDays < 3 || weekdayDays < 8) return null

  const weekendTotal = [...weekendByDay.values()].reduce((sum, v) => sum + v, 0)
  const weekdayTotal = [...weekdayByDay.values()].reduce((sum, v) => sum + v, 0)
  if (weekendTotal <= 0 || weekdayTotal <= 0) return null

  const weekendAvg = weekendTotal / weekendDays
  const weekdayAvg = weekdayTotal / weekdayDays
  if (weekdayAvg <= 0) return null

  const factor = weekendAvg / weekdayAvg
  if (factor < 1.45) return null

  const totalControllableWindow = weekendTotal + weekdayTotal
  const meaningfulWeekendFloor = Math.round(totalControllableWindow * 0.02)
  if (Math.round(weekendAvg) < meaningfulWeekendFloor) return null

  const historyRows = await loadWiseyHistoryRows(supabase, userId)
  const latest = findLatestWiseyCard(historyRows, 'WEEKEND_SPIKE')
  if (latest) {
    const lastShownAtMs = Date.parse(latest.shownAt)
    if (Number.isFinite(lastShownAtMs)) {
      const daysSince = (Date.now() - lastShownAtMs) / 86_400_000
      if (daysSince < 14) return null
    }
    const prevFactor = Number(latest.card.payload?.['factor'] ?? 0)
    if (Number.isFinite(prevFactor) && prevFactor > 0 && factor < (prevFactor + 0.15)) return null
  }

  const title = isTurkishLocale(locale)
    ? 'Hafta sonların hafta içinden daha sıcak gidiyor'
    : 'Your weekends are running hotter than weekdays'
  const body = isTurkishLocale(locale)
    ? `Hafta sonu harcama ortalaması günde ${formatCurrency(Math.round(weekendAvg), currencyCode, locale)}, hafta içinde ise günde ${formatCurrency(Math.round(weekdayAvg), currencyCode, locale)} (${factor.toFixed(1)} kat daha yüksek).`
    : `Weekend spend averages ${formatCurrency(Math.round(weekendAvg), currencyCode, locale)}/day vs ${formatCurrency(Math.round(weekdayAvg), currencyCode, locale)}/day on weekdays (${factor.toFixed(1)}x higher).`
  const whyItMatters = isTurkishLocale(locale)
    ? 'Bu desen tekrarlandığında, hafta içi kontrollü hissettirse bile döngüdeki fazla harcamanın çoğunu hafta sonları sessizce sürükleyebilir.'
    : 'When this pattern repeats, weekends can quietly drive most cycle overspending even if weekdays feel controlled.'

  const categoryTotals = new Map<string, number>()
  const merchantTotals = new Map<string, number>()
  const categoryCounts = new Map<string, number>()
  const merchantCounts = new Map<string, number>()
  for (const row of weekendRows) {
    categoryTotals.set(row.category, (categoryTotals.get(row.category) ?? 0) + row.amountCents)
    merchantTotals.set(row.merchant, (merchantTotals.get(row.merchant) ?? 0) + row.amountCents)
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    merchantCounts.set(row.merchant, (merchantCounts.get(row.merchant) ?? 0) + 1)
  }

  const categoryBreakdown = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([category, cents]) => ({
      category,
      spendCents: cents,
      sharePercent: weekendTotal > 0 ? Math.round((cents / weekendTotal) * 100) : 0,
      txnCount: categoryCounts.get(category) ?? 0,
    }))

  const merchantBreakdown = [...merchantTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([merchant, cents]) => ({
      merchant,
      spendCents: cents,
      sharePercent: weekendTotal > 0 ? Math.round((cents / weekendTotal) * 100) : 0,
      txnCount: merchantCounts.get(merchant) ?? 0,
    }))

  const nowIso = new Date().toISOString()
  const windowLabel = `${start.toISOString().slice(0, 10)}..${now.toISOString().slice(0, 10)}`
  return {
    id: `weekend_spike_${nowIso.slice(0, 10)}`,
    insightType: 'WEEKEND_SPIKE',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Hafta sonu ort.' : 'Weekend avg', value: `${formatCurrency(Math.round(weekendAvg), currencyCode, locale)}/day` },
      { label: isTurkishLocale(locale) ? 'Hafta içi ort.' : 'Weekday avg', value: `${formatCurrency(Math.round(weekdayAvg), currencyCode, locale)}/day` },
      { label: isTurkishLocale(locale) ? 'Katsayı' : 'Factor', value: `${factor.toFixed(1)}x` },
      { label: isTurkishLocale(locale) ? 'Aralık' : 'Window', value: windowLabel },
    ],
    severity: 'info',
    createdAt: nowIso,
    actionLabel: isTurkishLocale(locale) ? 'Sıçramaları gör' : 'View spikes',
    actionType: 'VIEW_SPIKE_BREAKDOWN',
    payload: {
      weekendAvgCents: Math.round(weekendAvg),
      weekdayAvgCents: Math.round(weekdayAvg),
      factor,
      weekendDays,
      weekdayDays,
      windowStart: start.toISOString().slice(0, 10),
      windowEnd: now.toISOString().slice(0, 10),
      categoryBreakdown,
      merchantBreakdown,
    },
  }
}

async function buildSubscriptionsCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null
  const hasOneMonthHistory = await hasAtLeastOneMonthTransactionHistory(supabase, userId)
  if (!hasOneMonthHistory) return null

  const [subscriptions, recurringBills] = await Promise.all([
    loadActiveSubscriptions(supabase, userId, currencyCode),
    loadRecurringBills(supabase, userId, currencyCode),
  ])

  const items = [...subscriptions, ...recurringBills]
  if (items.length < 2) {
    await dismissUnreadWiseyInsightForCycle(supabase, userId, 'SUBSCRIPTIONS', cycleKey, currencyCode)
    return null
  }

  const recurringMonthlyTotalCents = items.reduce((sum, item) => sum + normalizeToMonthlyCents(item.amountCents, item.frequency), 0)

  const referenceIncomeCents = snapshot.incomeCents > 0
    ? snapshot.incomeCents
    : await loadThreeMonthMedianIncomeCents(supabase, userId, currencyCode)
  if (referenceIncomeCents <= 0) return null

  const burdenPercent = Math.round((recurringMonthlyTotalCents / referenceIncomeCents) * 100)
  if (burdenPercent < 6) {
    await dismissUnreadWiseyInsightForCycle(supabase, userId, 'SUBSCRIPTIONS', cycleKey, currencyCode)
    return null
  }

  const tier = burdenPercent >= 15 ? 'critical' : burdenPercent >= 10 ? 'high' : 'medium'

  const title = isTurkishLocale(locale)
    ? `Tekrarlayan giderler gelirinin %${burdenPercent} kadarını alıyor`
    : `Recurring costs are taking ${burdenPercent}% of your income`
  const body = isTurkishLocale(locale)
    ? `Tahmini tekrarlayan toplam ${items.length} aktif tekrarlayan kalem için aylık ${formatCurrency(recurringMonthlyTotalCents, currencyCode, locale)}.`
    : `Estimated recurring total is ${formatCurrency(recurringMonthlyTotalCents, currencyCode, locale)}/month across ${items.length} active recurring items.`
  const whyItMatters = isTurkishLocale(locale)
    ? 'Tekrarlayan giderler esnekliği azaltır çünkü isteğe bağlı seçimlerden önce otomatik yenilenirler.'
    : 'Recurring costs reduce flexibility because they renew automatically before discretionary choices.'

  return {
    id: `subscriptions_${monthKey}_${tier}_${burdenPercent}_${items.length}`,
    insightType: 'SUBSCRIPTIONS',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Aylık tekrar eden' : 'Recurring monthly', value: `${formatCurrency(recurringMonthlyTotalCents, currencyCode, locale)}/month` },
      { label: isTurkishLocale(locale) ? 'Referans gelir' : 'Reference income', value: formatCurrency(referenceIncomeCents, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Yük' : 'Burden', value: `${burdenPercent}%` },
      { label: isTurkishLocale(locale) ? 'Aktif kalemler' : 'Active items', value: String(items.length) },
    ],
    severity: tier === 'critical' || tier === 'high' ? 'warning' : 'info',
    createdAt: new Date().toISOString(),
    actionLabel: isTurkishLocale(locale) ? 'Abonelikleri incele' : 'Review subscriptions',
    actionType: 'REVIEW_SUBSCRIPTIONS',
    payload: {
      recurringMonthlyTotalCents,
      referenceIncomeCents,
      burdenPercent,
      recurringCount: items.length,
      tier,
    },
  }
}

async function buildTimeOfDayCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  timeZone: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return null
  if (snapshot.currentDay < 5) return null

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  if (controllableRows.length < 10) return null

  const requiredDistinctDays = Math.max(5, Math.ceil(snapshot.cycleLengthDays * 0.40))
  const distinctDays = new Set(controllableRows.map((row) => row.date)).size
  if (distinctDays < requiredDistinctDays) return null

  const bucketCounts = new Map<string, number>()
  for (const row of controllableRows) {
    const bucket = timeBucketForHour(resolveLocalHour(row, timeZone))
    bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
  }
  const rankedBuckets = [...bucketCounts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
  if (rankedBuckets.length < 2) return null

  const [dominantBucket, dominantCount] = rankedBuckets[0]
  const [, secondCount] = rankedBuckets[1]
  const dominantSharePercent = Math.round((dominantCount / Math.max(controllableRows.length, 1)) * 100)
  const secondSharePercent = Math.round((secondCount / Math.max(controllableRows.length, 1)) * 100)
  const shareGapPercent = dominantSharePercent - secondSharePercent
  if (dominantSharePercent < 40 || shareGapPercent < 12) {
    await dismissUnreadWiseyInsightForCycle(supabase, userId, 'TIME_OF_DAY', cycleKey, currencyCode)
    return null
  }

  const bucketBreakdown = rankedBuckets.map(([bucket, count]) => ({
    bucket,
    txnCount: count,
    sharePercent: Math.round((count / Math.max(controllableRows.length, 1)) * 100),
  }))

  const dominantLabel = timeBucketLabel(dominantBucket, locale)
  const dominanceStrength = describeDominanceStrength(shareGapPercent, locale)
  const title = isTurkishLocale(locale)
    ? `${dominantLabel} ana harcama penceren`
    : `${dominantLabel} is your main spending window`
  const body = isTurkishLocale(locale)
    ? `Kontrol edilebilir işlemlerin yaklaşık %${dominantSharePercent} kadarı ${dominantLabel.toLowerCase()} gerçekleşiyor ve bu zamanlama deseni ${dominanceStrength.toLowerCase()} görünüyor.`
    : `About ${dominantSharePercent}% of controllable transactions are happening in ${dominantLabel.toLowerCase()} this cycle-to-date, and that timing pattern looks ${dominanceStrength.toLowerCase()}.`
  const whyItMatters = isTurkishLocale(locale)
    ? 'Harcamaların ne zaman kümelendiğini bilmek, kategori toplamları normal görünse bile sessizce fazla harcamaya yol açan zamanlama desenlerini fark etmene yardım eder.'
    : 'Knowing when spending clusters helps you spot timing patterns that can quietly drive overspending even if category totals look normal.'

  return {
    id: `time_of_day_${monthKey}_${dominantBucket}_${dominantSharePercent}`,
    insightType: 'TIME_OF_DAY',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Baskın pencere' : 'Dominant window', value: dominantLabel },
      { label: isTurkishLocale(locale) ? 'Pay' : 'Share', value: `${dominantSharePercent}%` },
      { label: isTurkishLocale(locale) ? 'Desen gücü' : 'Pattern strength', value: dominanceStrength },
      { label: isTurkishLocale(locale) ? 'Kontrol edilebilir işlem' : 'Controllable txns', value: String(controllableRows.length) },
      { label: isTurkishLocale(locale) ? 'Farklı gün' : 'Distinct days', value: String(distinctDays) },
    ],
    severity: 'info',
    createdAt: new Date().toISOString(),
    payload: {
      dominantBucket,
      dominantSharePercent,
      shareGapPercent,
      timeZone,
      distinctDays,
      requiredDistinctDays,
      bucketBreakdown,
    },
  }
}

async function buildGoalContribCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const now = new Date()
  const cycleLengthDays = getCycleLengthDays(cycleStartDay, now)
  const currentDay = getCycleAwareCurrentDay(cycleStartDay, now)
  const windowStartDay = Math.max(1, Math.min(cycleLengthDays, Math.floor(cycleLengthDays * 0.67)))
  const windowEndDay = Math.max(
    windowStartDay,
    Math.min(cycleLengthDays, Math.ceil(cycleLengthDays * 0.83)),
  )
  const cleanupUnreadGoalContribAndReturnNull = async () => {
    await deleteUnreadWiseyInsightForCycle(supabase, userId, 'GOAL_CONTRIB', cycleKey, currencyCode)
    return null
  }

  if (currentDay < windowStartDay || currentDay > windowEndDay) {
    return cleanupUnreadGoalContribAndReturnNull()
  }

  const snapshot = await getCurrentPeriodSnapshot(supabase, userId, monthKey, cycleStartDay, currencyCode)
  if (!snapshot) return cleanupUnreadGoalContribAndReturnNull()
  if (snapshot.currentDay < 5) return cleanupUnreadGoalContribAndReturnNull()
  const activeGoalCount = await loadActiveGoalCount(supabase, userId)
  if (activeGoalCount <= 0) return cleanupUnreadGoalContribAndReturnNull()

  const { startUTC, nextStartUTC } = getCurrentCycleWindow(cycleStartDay, now)
  const cycleEndUTC = new Date(nextStartUTC.getTime() - 1)
  const todayKey = now.toISOString().slice(0, 10)
  const cycleEndKey = cycleEndUTC.toISOString().slice(0, 10)
  const spendableCashNowCents = await loadSpendableWalletBalanceCents(
    supabase,
    userId,
    currencyCode,
  )
  if (spendableCashNowCents <= 0 && snapshot.incomeCents <= 0) {
    return cleanupUnreadGoalContribAndReturnNull()
  }

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const controllableRows = extractControllableExpenseRows(snapshot.txns, categoryIndex)
  const completedDailySpend = buildCompletedDailyControllableTotals(controllableRows, startUTC, now)
  if (completedDailySpend.length < 5) return cleanupUnreadGoalContribAndReturnNull()

  const avgDailySpendCents = Math.round(trimmedMeanExcludeTopPercent(completedDailySpend, 0.05))
  const daysLeft = Math.max(snapshot.cycleLengthDays - snapshot.currentDay, 0)
  const projectedFutureSpendCents = avgDailySpendCents * daysLeft
  const projectedEndSpendCents = snapshot.expenseCents + (avgDailySpendCents * daysLeft)
  const upcoming = await loadUpcomingObligationsSnapshot(
    supabase,
    userId,
    todayKey,
    cycleEndKey,
    currencyCode,
  )
  const projectedCycleRoomCents = spendableCashNowCents - projectedFutureSpendCents - upcoming.totalCents
  const tightThresholdCents = Math.round(Math.max(spendableCashNowCents, 1) * 0.04)

  const status: 'has_room' | 'tight' | 'no_room' = projectedCycleRoomCents <= 0
    ? 'no_room'
    : projectedCycleRoomCents <= tightThresholdCents
      ? 'tight'
      : 'has_room'

  const title = status === 'has_room'
    ? (isTurkishLocale(locale) ? 'Bu döngüde hedefler için alan var' : 'There is room to fund goals this cycle')
    : status === 'tight'
      ? (isTurkishLocale(locale) ? 'Hedefler için döngü alanı dar görünüyor' : 'Cycle room for goals looks tight')
      : (isTurkishLocale(locale) ? 'Mevcut tempo bu döngüde hedeflere alan bırakmıyor' : 'Current pace leaves no goal room this cycle')

  const usesCarryOverContext = snapshot.incomeCents > 0 && spendableCashNowCents >= snapshot.incomeCents * 2
  const basisPrefix = snapshot.incomeCents <= 0
    ? (isTurkishLocale(locale) ? 'Mevcut harcanabilir bakiyene göre' : 'Based on your current spendable balance')
    : usesCarryOverContext
      ? (isTurkishLocale(locale) ? 'Mevcut harcanabilir bakiyen kullanılarak (devreden dahil)' : 'Using your current spendable balance (including carry-over)')
      : (isTurkishLocale(locale) ? 'Mevcut harcanabilir bakiyen kullanılarak' : 'Using your current spendable balance')

  const body = status === 'has_room'
    ? (isTurkishLocale(locale)
        ? `${basisPrefix}, harcama son günlük temponu izler ve yaklaşan yükümlülükler karşılanırsa bu döngü bitmeden önce hedefler için hâlâ alan kalır.`
        : `${basisPrefix}, if spending follows your recent daily pace and upcoming obligations are covered, there is still room left for goals before this cycle ends.`)
    : status === 'tight'
      ? (isTurkishLocale(locale)
          ? `${basisPrefix}, yaklaşan yükümlülükler mevcut tempoda bu döngüde hedefler için yalnızca ince bir tampon bırakıyor.`
          : `${basisPrefix}, upcoming obligations leave only a thin buffer for goals this cycle at current pace.`)
      : (isTurkishLocale(locale)
          ? `${basisPrefix}, tahmini gelecek harcama ve yaklaşan yükümlülükler kalan döngü alanını tüketiyor.`
          : `${basisPrefix}, projected future spending plus upcoming obligations consume the remaining cycle room.`)

  const whyItMatters = status === 'has_room'
    ? (isTurkishLocale(locale)
        ? 'Bu faydalı bir kontrol noktasıdır: tempo benzer kalırsa, temel ihtiyaçları sıkıştırmadan hedef finansmanı sığabilir demektir.'
        : 'This is a useful checkpoint: it means goal funding can fit without squeezing essentials if pace stays similar.')
    : status === 'tight'
      ? (isTurkishLocale(locale)
          ? 'Dar bir tampon, küçük fazla harcamaların döngü sonuna doğru hedef ilerlemesini sıkıştırma ihtimalini artırır.'
          : 'A tight buffer increases the chance that small overspends crowd out goal progress near cycle end.')
      : (isTurkishLocale(locale)
          ? 'Alan negatife düştüğünde, harcama temposu iyileşmez veya yükümlülükler değişmezse hedefler muhtemelen sıkışır.'
          : 'When room is negative, goals are likely to be crowded out unless spending pace improves or obligations change.')

  return {
    id: `goal_contrib_${monthKey}_${status}_${daysLeft}`,
    insightType: 'GOAL_CONTRIB',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Durum' : 'Status', value: isTurkishLocale(locale) ? status.replace('_', ' ').replace('has room', 'alan var').replace('no room', 'alan yok').replace('tight', 'dar') : status.replace('_', ' ') },
      { label: isTurkishLocale(locale) ? 'Döngü günü' : 'Cycle day', value: String(snapshot.currentDay) },
      { label: isTurkishLocale(locale) ? 'Kalan gün' : 'Days left', value: String(daysLeft) },
      { label: isTurkishLocale(locale) ? 'Tempo temeli' : 'Pace basis', value: isTurkishLocale(locale) ? `${completedDailySpend.length} tamamlanan gün` : `${completedDailySpend.length} completed days` },
      { label: isTurkishLocale(locale) ? 'Alan temeli' : 'Room basis', value: isTurkishLocale(locale) ? 'şu anki harcanabilir nakit' : 'spendable cash now' },
      { label: isTurkishLocale(locale) ? 'Yaklaşan yükümlülükler' : 'Upcoming obligations', value: isTurkishLocale(locale) ? `${upcoming.billCount + upcoming.subscriptionCount} vadesi gelen kalem` : `${upcoming.billCount + upcoming.subscriptionCount} due items` },
    ],
    actionLabel: isTurkishLocale(locale) ? 'Dökümü göster' : 'Show breakdown',
    actionType: 'VIEW_GOAL_CONTRIB_BREAKDOWN',
    severity: status === 'has_room' ? 'info' : 'warning',
    createdAt: new Date().toISOString(),
    payload: {
      status,
      cycleDay: snapshot.currentDay,
      cycleLengthDays: snapshot.cycleLengthDays,
      daysLeft,
      incomeCents: snapshot.incomeCents,
      spendableCashNowCents,
      currentSpendCents: snapshot.expenseCents,
      avgDailySpendCents,
      projectedFutureSpendCents,
      projectedEndSpendCents,
      projectedCycleRoomCents,
      tightThresholdCents,
      upcomingObligationsCents: upcoming.totalCents,
      upcomingBillCount: upcoming.billCount,
      upcomingSubscriptionCount: upcoming.subscriptionCount,
      upcomingObligations: upcoming.items.map((item) => ({
        kind: item.kind,
        name: item.name,
        amountCents: item.amountCents,
        dueDateKey: item.dueDateKey,
        occurrences: item.occurrences,
      })),
      cycleEndKey,
    },
  }
}

async function deleteUnreadWiseyInsightForCycle(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  insightType: UpdateCard['insightType'],
  cycleKey: string,
  currencyCode: string,
): Promise<number> {
  const rows = await loadWiseyHistoryRows(supabase, userId)
  const targetIds = rows
    .filter((row) => {
      const card = extractWiseyCardFromHistory(row)
      if (!card || card.insightType !== insightType) return false
      if (isReadAction(row.user_action)) return false
      const rowCycleKey = String((row.metadata ?? {})['cycleKey'] ?? '')
      if (rowCycleKey !== cycleKey) return false
      const rowCurrencyCode = normalizeCurrencyCode((row.metadata ?? {})['currencyCode'])
      return !rowCurrencyCode || rowCurrencyCode === currencyCode
    })
    .map((row) => row.id)

  if (targetIds.length === 0) return 0

  const { error } = await supabase
    .from('insight_history')
    .delete()
    .in('id', targetIds)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to delete stale wisey insight row(s): ${error.message}`)
  }

  return targetIds.length
}

async function dismissUnreadWiseyInsightForCycle(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  insightType: UpdateCard['insightType'],
  cycleKey: string,
  currencyCode: string,
): Promise<number> {
  const rows = await loadWiseyHistoryRows(supabase, userId)
  const targetIds = rows
    .filter((row) => {
      const card = extractWiseyCardFromHistory(row)
      if (!card || card.insightType !== insightType) return false
      if (isReadAction(row.user_action)) return false
      const rowCycleKey = String((row.metadata ?? {})['cycleKey'] ?? '')
      if (rowCycleKey !== cycleKey) return false
      const rowCurrencyCode = normalizeCurrencyCode((row.metadata ?? {})['currencyCode'])
      return !rowCurrencyCode || rowCurrencyCode === currencyCode
    })
    .map((row) => row.id)

  if (targetIds.length === 0) return 0

  const { error } = await supabase
    .from('insight_history')
    .update({ user_action: 'dismissed' })
    .in('id', targetIds)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to dismiss stale wisey insight row(s): ${error.message}`)
  }

  return targetIds.length
}

async function dismissUnreadWiseyCardsByUpdateId(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  updateIds: string[],
): Promise<number> {
  if (updateIds.length === 0) return 0
  const idSet = new Set(updateIds.filter(Boolean))
  if (idSet.size === 0) return 0
  const rows = await loadWiseyHistoryRows(supabase, userId)
  const targetIds = rows
    .filter((row) => {
      if (isReadAction(row.user_action)) return false
      const rowUpdateId = String((row.metadata ?? {})['updateId'] ?? '')
      return idSet.has(rowUpdateId)
    })
    .map((row) => row.id)

  if (targetIds.length === 0) return 0

  const { error } = await supabase
    .from('insight_history')
    .update({ user_action: 'dismissed' })
    .in('id', targetIds)
    .eq('user_id', userId)

  if (error) {
    throw new Error(`Failed to dismiss stale wisey insight row(s) by updateId: ${error.message}`)
  }

  return targetIds.length
}

async function buildBudgetOverspendingPaceCards(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale,
): Promise<UpdateCard[]> {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const monthStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
  const now = new Date()
  const monthDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthEnd = new Date(Date.UTC(year, month - 1, monthDaysInMonth, 23, 59, 59, 999))

  // Fetch all active budgets — recurring or one-shot. Each budget's pace is
  // measured against its own date range when present; otherwise we fall back
  // to the current calendar month.
  const { data: budgetRows, error: budgetError } = await supabase
    .from('budgets')
    .select('id, name, amount_cents, category_id, category_ids, icon_key, start_date, end_date, is_recurring, categories!category_id(name, icon_key)')
    .eq('user_id', userId)
    .eq('is_active', true)

  if (budgetError) {
    log('wisey_updates.budget_pace.budgets_error', { userId, error: budgetError.message })
    return []
  }

  const budgets = (budgetRows ?? []) as Array<Record<string, unknown>>

  const { data: historyRows } = await supabase
    .from('insight_history')
    .select('metadata, user_action')
    .eq('user_id', userId)
    .like('insight_key', 'wisey_budget_overspending_pace_%')

  const existingUnreadPaceIds = new Set<string>(
    ((historyRows ?? []) as Array<Record<string, unknown>>)
      .filter((r) => !isReadAction(r['user_action'] as string | null))
      .map((r) => String((r['metadata'] as Record<string, unknown>)?.['updateId'] ?? ''))
      .filter(Boolean),
  )

  if (budgets.length === 0) {
    await dismissUnreadWiseyCardsByUpdateId(supabase, userId, [...existingUnreadPaceIds])
    return []
  }

  // Load transactions once for the widest possible window any budget could need:
  // earliest budget start (or month start, whichever is earlier) → now.
  let earliestStart = monthStart
  for (const b of budgets) {
    const startMs = parseBudgetDateMs(b['start_date'])
    if (startMs != null) {
      const startDate = new Date(startMs)
      if (startDate < earliestStart) earliestStart = startDate
    }
  }

  let txns: TxnRow[]
  try {
    txns = await loadTransactions(supabase, userId, earliestStart, now, currencyCode)
  } catch {
    return []
  }
  const expenseTxns = txns.filter((t) => t.amount < 0 && !t.isOpeningBalance && !t.isManualTopup)

  // Collect multi-category budget category IDs for a single batch lookup
  const multiCategoryBudgetMap = new Map<string, string[]>()
  for (const budget of budgets) {
    const rawIds = typeof budget['category_ids'] === 'string' ? (budget['category_ids'] as string).trim() : ''
    if (!rawIds) continue
    try {
      const parsed = JSON.parse(rawIds)
      if (Array.isArray(parsed) && parsed.length > 1) {
        multiCategoryBudgetMap.set(String(budget['id']), parsed.map(String).filter(Boolean))
      }
    } catch {
      // not valid JSON
    }
  }

  const allMultiCategoryIds = Array.from(new Set([...multiCategoryBudgetMap.values()].flat()))
  const multiCategoryNameMap = new Map<string, string>()
  const multiCategoryIconMap = new Map<string, string>()
  if (allMultiCategoryIds.length > 0) {
    const { data: catRows } = await supabase
      .from('categories')
      .select('id, name, icon_key')
      .in('id', allMultiCategoryIds)
    for (const row of ((catRows ?? []) as Array<Record<string, unknown>>)) {
      const id = String(row['id'] ?? '')
      const name = String(row['name'] ?? '').trim()
      const icon = String(row['icon_key'] ?? '').trim()
      if (id && name) {
        multiCategoryNameMap.set(id, name)
        if (icon) multiCategoryIconMap.set(id, icon)
      }
    }
  }

  const isTurkish = isTurkishLocale(locale)
  const results: UpdateCard[] = []

  for (const budget of budgets) {
    const budgetId = String(budget['id'] ?? '').trim()
    const budgetName = String(budget['name'] ?? '').trim()
    const amountCents = Number(budget['amount_cents'] ?? 0)
    if (!budgetId || !budgetName || amountCents <= 0) continue

    // Resolve this budget's own time window. Priority:
    //   1. explicit start_date + end_date on the budget
    //   2. explicit start_date with no end → start → end of current month
    //   3. nothing → current calendar month
    const budgetStartMs = parseBudgetDateMs(budget['start_date'])
    const budgetEndMs = parseBudgetDateMs(budget['end_date'])
    const windowStart = budgetStartMs != null ? new Date(budgetStartMs) : monthStart
    const windowEnd = budgetEndMs != null ? new Date(budgetEndMs) : monthEnd

    if (now < windowStart) continue        // budget hasn't started yet
    if (now > windowEnd) continue          // budget already ended

    const totalDaysInWindow = Math.max(
      1,
      Math.ceil((windowEnd.getTime() - windowStart.getTime()) / 86_400_000),
    )
    const daysElapsedInWindow = Math.max(
      1,
      Math.ceil((now.getTime() - windowStart.getTime()) / 86_400_000),
    )
    if (daysElapsedInWindow < 3) continue  // too early to be meaningful

    const multiIds = multiCategoryBudgetMap.get(budgetId)
    const isMultiCategory = Array.isArray(multiIds) && multiIds.length > 1
    let categoryNames: string[]
    let iconKey: string

    if (isMultiCategory && multiIds) {
      categoryNames = multiIds.map((id) => multiCategoryNameMap.get(id) ?? '').filter(Boolean)
      iconKey = '📊'
    } else {
      const joinedCat = budget['categories'] as Record<string, unknown> | null | undefined
      const singleName = String(joinedCat?.['name'] ?? '').trim()
      if (!singleName) continue
      categoryNames = [singleName]
      const rawIcon = String(joinedCat?.['icon_key'] ?? budget['icon_key'] ?? '').trim()
      // Use icon only if it looks like an emoji (non-ASCII or non-alphanumeric, max 8 chars)
      iconKey =
        rawIcon.length > 0 &&
        rawIcon.length <= 8 &&
        (rawIcon.split('').some((c) => c.charCodeAt(0) > 127) || !/^[a-zA-Z0-9]+$/.test(rawIcon))
          ? rawIcon
          : '📊'
    }

    if (categoryNames.length === 0) continue

    const normalizedNames = new Set(categoryNames.map((n) => n.trim().toLowerCase()))
    let spentCents = 0
    for (const txn of expenseTxns) {
      const txnDate = txn.date ? new Date(txn.date) : null
      if (!txnDate || isNaN(txnDate.getTime())) continue
      if (txnDate < windowStart || txnDate > windowEnd) continue
      const txnCat = (txn.category ?? '').trim().toLowerCase()
      if (normalizedNames.has(txnCat)) {
        spentCents += Math.abs(txn.amount)
      }
    }

    if (spentCents <= 0) continue
    if (spentCents >= amountCents) continue

    const pacingRatio = (spentCents / amountCents) / (daysElapsedInWindow / totalDaysInWindow)
    if (pacingRatio < 1.5) continue

    const cardId = `budget_pace_${budgetId}_${monthKey}`

    const amountFormatted = formatCurrency(amountCents, currencyCode, locale)
    const spentFormatted = formatCurrency(spentCents, currencyCode, locale)
    const pacingLabel = `${(Math.round(pacingRatio * 10) / 10).toFixed(1)}×`

    const title = isTurkish ? 'Bütçe harcama hızı' : 'Budget overspending pace'

    let body: string
    if (isMultiCategory) {
      const catList = categoryNames.slice(0, 3).join(', ') + (categoryNames.length > 3 ? '…' : '')
      body = isTurkish
        ? `${budgetName} bütçen ${amountFormatted}. Şimdiye kadar ${spentFormatted} harcandı ve bütçenin ${daysElapsedInWindow}. gündesin (${totalDaysInWindow} gün üzerinden). Kapsanan kategoriler: ${catList}.`
        : `Your ${budgetName} budget is ${amountFormatted}. You've already spent ${spentFormatted} and we are only ${daysElapsedInWindow} days into a ${totalDaysInWindow}-day budget. It covers: ${catList}.`
    } else {
      body = isTurkish
        ? `${categoryNames[0]} için bütçen ${amountFormatted}. Şimdiye kadar ${spentFormatted} harcandı ve bütçenin ${daysElapsedInWindow}. gündesin (${totalDaysInWindow} gün üzerinden).`
        : `Your budget for ${categoryNames[0]} is ${amountFormatted}. You've already spent ${spentFormatted} and we are only ${daysElapsedInWindow} days into a ${totalDaysInWindow}-day budget.`
    }

    const whyItMatters = isTurkish
      ? 'Bu hızda devam edersen, dönem bitmeden bütçeni aşma ihtimalin yüksek. Şimdi fark etmek, sonu sıkıştırmadan önce düzeltme şansı verir.'
      : 'At this pace you are on track to exceed your budget before its end date. Catching it now gives you room to adjust before things get tight.'

    const proofChips: ProofChip[] = [
      { label: isTurkish ? 'Bütçe' : 'Budget', value: amountFormatted },
      { label: isTurkish ? 'Harcanan' : 'Spent so far', value: spentFormatted },
      { label: isTurkish ? 'Geçen gün' : 'Days elapsed', value: `${daysElapsedInWindow} / ${totalDaysInWindow}` },
      { label: isTurkish ? 'Hız' : 'Pace', value: pacingLabel },
    ]

    results.push({
      id: cardId,
      insightType: 'BUDGET_OVERSPENDING_PACE',
      kind: 'notification',
      source: 'ai',
      severity: 'warning',
      title,
      body,
      whyItMatters,
      proofChips,
      createdAt: new Date().toISOString(),
      payload: {
        budgetId,
        budgetName,
        iconKey,
        isMultiCategory,
        isRecurring: budget['is_recurring'] === true,
        categoryIds: multiIds ?? [],
        budgetAmountCents: amountCents,
        spentCents,
        daysElapsed: daysElapsedInWindow,
        daysInMonth: totalDaysInWindow,
        pacingRatio: Math.round(pacingRatio * 10) / 10,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      },
    })
  }

  const qualifyingIds = new Set(results.map((card) => card.id))
  const staleUnreadIds = [...existingUnreadPaceIds].filter((id) => !qualifyingIds.has(id))
  await dismissUnreadWiseyCardsByUpdateId(supabase, userId, staleUnreadIds)
  return results
}

function parseBudgetDateMs(raw: unknown): number | null {
  if (raw == null) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const asNumber = Number(trimmed)
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber
    const parsed = Date.parse(trimmed)
    if (!isNaN(parsed)) return parsed
  }
  return null
}

async function buildCategoryChangeDownCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale = 'en-US',
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const currentDay = getCycleAwareCurrentDay(cycleStartDay, new Date())
  if (currentDay < 5) return null

  const ranges = getFairRangeForMonth(monthKey, cycleStartDay, new Date())
  const [currentTxns, previousTxns] = await Promise.all([
    loadTransactions(supabase, userId, ranges.currentStartUTC, ranges.currentEndUTC, currencyCode),
    loadTransactions(supabase, userId, ranges.prevStartUTC, ranges.prevEndUTC, currencyCode),
  ])

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const currentRows = extractControllableExpenseRows(currentTxns, categoryIndex)
  const previousRows = extractControllableExpenseRows(previousTxns, categoryIndex)
  if (previousRows.length < 3) return null

  const previousByCategory = aggregateControllableByCategory(previousRows)
  const currentByCategory = aggregateControllableByCategory(currentRows)
  if (previousByCategory.size <= 1) return null

  const previousTotalCents = [...previousByCategory.values()].reduce((sum, row) => sum + row.amountCents, 0)
  const currentTotalCents = [...currentByCategory.values()].reduce((sum, row) => sum + row.amountCents, 0)
  if (previousTotalCents <= 0) return null

  const previousShareGate = 12
  const candidates: Array<{
    category: string
    previousAmountCents: number
    currentAmountCents: number
    previousTxnCount: number
    currentTxnCount: number
    previousSharePercent: number
    currentSharePercent: number
    shareDropRawPercent: number
    shareDropPercent: number
    relativeDropPercent: number
    amountDropCents: number
    isEliminated: boolean
  }> = []

  for (const [category, previousStats] of previousByCategory.entries()) {
    if (previousStats.txnCount < 3) continue
    const previousShareRawPercent = (previousStats.amountCents / Math.max(previousTotalCents, 1)) * 100
    const previousSharePercent = Math.round(previousShareRawPercent)
    if (previousSharePercent < previousShareGate) continue

    const currentStats = currentByCategory.get(category) ?? { amountCents: 0, txnCount: 0 }
    const amountDropCents = previousStats.amountCents - currentStats.amountCents
    if (amountDropCents <= 0) continue

    const currentShareRawPercent = currentTotalCents > 0
      ? (currentStats.amountCents / Math.max(currentTotalCents, 1)) * 100
      : 0
    const currentSharePercent = Math.round(currentShareRawPercent)
    const shareDropRawPercent = previousShareRawPercent - currentShareRawPercent
    const shareDropPercent = Math.round(shareDropRawPercent)
    const relativeDropPercent = Math.round((amountDropCents / Math.max(previousStats.amountCents, 1)) * 100)
    if (shareDropRawPercent < 6 || relativeDropPercent < 20) continue

    candidates.push({
      category,
      previousAmountCents: previousStats.amountCents,
      currentAmountCents: currentStats.amountCents,
      previousTxnCount: previousStats.txnCount,
      currentTxnCount: currentStats.txnCount,
      previousSharePercent,
      currentSharePercent,
      shareDropRawPercent,
      shareDropPercent,
      relativeDropPercent,
      amountDropCents,
      isEliminated: currentStats.txnCount === 0,
    })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const shareDropRawDelta = b.shareDropRawPercent - a.shareDropRawPercent
    if (Math.abs(shareDropRawDelta) > 0.0001) return shareDropRawDelta
    if (b.amountDropCents !== a.amountDropCents) return b.amountDropCents - a.amountDropCents
    return a.category.localeCompare(b.category)
  })
  const top = candidates[0]
  const otherCategoryBreakdown = candidates
    .slice(1, 3)
    .map((candidate) => ({
      category: candidate.category,
      previousAmountCents: candidate.previousAmountCents,
      currentAmountCents: candidate.currentAmountCents,
      previousTxnCount: candidate.previousTxnCount,
      currentTxnCount: candidate.currentTxnCount,
      previousSharePercent: candidate.previousSharePercent,
      currentSharePercent: candidate.currentSharePercent,
      shareDropPercent: candidate.shareDropPercent,
      relativeDropPercent: candidate.relativeDropPercent,
    }))

  const historyRows = await loadWiseyHistoryRows(supabase, userId)
  const latestSameCycle = findLatestWiseyCard(historyRows, 'CATEGORY_CHANGE_DOWN', cycleKey)
  if (latestSameCycle) {
    const prevCategory = String(latestSameCycle.card.payload?.['category'] ?? '')
    const prevShareDropPercent = Number(latestSameCycle.card.payload?.['shareDropPercent'] ?? 0)
    if (prevCategory === top.category && top.shareDropPercent < (prevShareDropPercent + 5)) {
      return null
    }
  }

  const categoryLabel = humanizeKey(top.category)
  const improvementStrength = describeCategoryImprovementStrength(top.shareDropPercent, top.relativeDropPercent, top.isEliminated, locale)
  const title = top.isEliminated
    ? (isTurkishLocale(locale) ? `Güzel düşüş: ${categoryLabel} harcaması durdu` : `Nice drop: ${categoryLabel} spending paused`)
    : (isTurkishLocale(locale) ? `${categoryLabel} harcaması soğuyor` : `${categoryLabel} spending is cooling down`)
  const body = top.isEliminated
    ? (isTurkishLocale(locale)
        ? `Önceki döngünün aynı noktasına göre ${categoryLabel}, kontrol edilebilir harcamada %${top.previousSharePercent} seviyesinden %0'a düştü.`
        : `Compared with the same point in the previous cycle, ${categoryLabel} dropped from ${top.previousSharePercent}% to 0% of controllable spending.`)
    : (isTurkishLocale(locale)
        ? `Önceki döngünün aynı noktasına göre ${categoryLabel}, ${improvementStrength.toLowerCase()} düzeyde daha düşük (%${top.relativeDropPercent} daha az harcama).`
        : `Compared with the same point in the previous cycle, ${categoryLabel} is ${improvementStrength.toLowerCase()} lower (${top.relativeDropPercent}% less spend).`)
  const whyItMatters = isTurkishLocale(locale)
    ? 'Bu anlamlı bir desen iyileşmesi. Bu eğilimi korumak döngünün geri kalanı için alan açabilir.'
    : 'This is a meaningful pattern improvement. Keeping this trend steady can free room across the rest of the cycle.'

  return {
    id: `category_change_down_${monthKey}_${slugify(top.category)}_${top.shareDropPercent}`,
    insightType: 'CATEGORY_CHANGE_DOWN',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Kategori' : 'Category', value: categoryLabel },
      { label: isTurkishLocale(locale) ? 'İyileşme' : 'Improvement', value: improvementStrength },
      { label: isTurkishLocale(locale) ? 'Göreli harcama düşüşü' : 'Relative spend drop', value: `${top.relativeDropPercent}%` },
      { label: isTurkishLocale(locale) ? 'Önceki harcama' : 'Previous spend', value: formatCurrency(top.previousAmountCents, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Şimdiki harcama' : 'Current spend', value: formatCurrency(top.currentAmountCents, currencyCode, locale) },
    ],
    severity: 'info',
    createdAt: new Date().toISOString(),
    ...(otherCategoryBreakdown.length > 0 ? { actionLabel: isTurkishLocale(locale) ? 'Diğer kategorileri gör' : 'View other categories' } : {}),
    ...(otherCategoryBreakdown.length > 0 ? { actionType: 'VIEW_CATEGORY_DROP_BREAKDOWN' } : {}),
    payload: {
      category: top.category,
      isEliminated: top.isEliminated,
      previousAmountCents: top.previousAmountCents,
      currentAmountCents: top.currentAmountCents,
      previousTxnCount: top.previousTxnCount,
      currentTxnCount: top.currentTxnCount,
      previousSharePercent: top.previousSharePercent,
      currentSharePercent: top.currentSharePercent,
      shareDropPercent: top.shareDropPercent,
      relativeDropPercent: top.relativeDropPercent,
      periodLabel: ranges.periodLabel,
      otherCategoryBreakdown,
    },
  }
}

async function buildCategoryChangeUpCard(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  currencyCode: string,
  locale: WiseyLocale = 'en-US',
): Promise<UpdateCard | null> {
  const cycleStartDay = await loadCycleStartDay(supabase, userId)
  const cycleKey = currentCycleKey(cycleStartDay)
  const currentDay = getCycleAwareCurrentDay(cycleStartDay, new Date())
  if (currentDay < 5) return null

  const ranges = getFairRangeForMonth(monthKey, cycleStartDay, new Date())
  const [currentTxns, previousTxns] = await Promise.all([
    loadTransactions(supabase, userId, ranges.currentStartUTC, ranges.currentEndUTC, currencyCode),
    loadTransactions(supabase, userId, ranges.prevStartUTC, ranges.prevEndUTC, currencyCode),
  ])

  const categoryIndex = await loadExpenseCategoryIndex(supabase, userId).catch(() => new Map<string, CategoryProfile>())
  const currentRows = extractControllableExpenseRows(currentTxns, categoryIndex)
  const previousRows = extractControllableExpenseRows(previousTxns, categoryIndex)
  if (previousRows.length < 3) return null

  const previousByCategory = aggregateControllableByCategory(previousRows)
  const currentByCategory = aggregateControllableByCategory(currentRows)
  if (previousByCategory.size <= 1) return null

  const previousTotalCents = [...previousByCategory.values()].reduce((sum, row) => sum + row.amountCents, 0)
  const currentTotalCents = [...currentByCategory.values()].reduce((sum, row) => sum + row.amountCents, 0)
  if (previousTotalCents <= 0 || currentTotalCents <= 0) return null

  const previousShareGate = 12
  const candidates: Array<{
    category: string
    previousAmountCents: number
    currentAmountCents: number
    previousTxnCount: number
    currentTxnCount: number
    previousSharePercent: number
    currentSharePercent: number
    shareIncreaseRawPercent: number
    shareIncreasePercent: number
    relativeIncreasePercent: number
    amountIncreaseCents: number
  }> = []

  for (const [category, previousStats] of previousByCategory.entries()) {
    if (previousStats.txnCount < 3) continue
    const previousShareRawPercent = (previousStats.amountCents / Math.max(previousTotalCents, 1)) * 100
    const previousSharePercent = Math.round(previousShareRawPercent)
    if (previousSharePercent < previousShareGate) continue

    const currentStats = currentByCategory.get(category)
    if (!currentStats || currentStats.amountCents <= previousStats.amountCents) continue

    const amountIncreaseCents = currentStats.amountCents - previousStats.amountCents
    const currentShareRawPercent = (currentStats.amountCents / Math.max(currentTotalCents, 1)) * 100
    const currentSharePercent = Math.round(currentShareRawPercent)
    const shareIncreaseRawPercent = currentShareRawPercent - previousShareRawPercent
    const shareIncreasePercent = Math.round(shareIncreaseRawPercent)
    const relativeIncreasePercent = Math.round((amountIncreaseCents / Math.max(previousStats.amountCents, 1)) * 100)
    if (shareIncreaseRawPercent < 6 || relativeIncreasePercent < 20) continue

    candidates.push({
      category,
      previousAmountCents: previousStats.amountCents,
      currentAmountCents: currentStats.amountCents,
      previousTxnCount: previousStats.txnCount,
      currentTxnCount: currentStats.txnCount,
      previousSharePercent,
      currentSharePercent,
      shareIncreaseRawPercent,
      shareIncreasePercent,
      relativeIncreasePercent,
      amountIncreaseCents,
    })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const shareIncreaseRawDelta = b.shareIncreaseRawPercent - a.shareIncreaseRawPercent
    if (Math.abs(shareIncreaseRawDelta) > 0.0001) return shareIncreaseRawDelta
    if (b.amountIncreaseCents !== a.amountIncreaseCents) return b.amountIncreaseCents - a.amountIncreaseCents
    return a.category.localeCompare(b.category)
  })
  const top = candidates[0]
  const otherCategoryBreakdown = candidates
    .slice(1, 3)
    .map((candidate) => ({
      category: candidate.category,
      previousAmountCents: candidate.previousAmountCents,
      currentAmountCents: candidate.currentAmountCents,
      previousTxnCount: candidate.previousTxnCount,
      currentTxnCount: candidate.currentTxnCount,
      previousSharePercent: candidate.previousSharePercent,
      currentSharePercent: candidate.currentSharePercent,
      shareIncreasePercent: candidate.shareIncreasePercent,
      relativeIncreasePercent: candidate.relativeIncreasePercent,
    }))

  const historyRows = await loadWiseyHistoryRows(supabase, userId)
  const latestSameCycle = findLatestWiseyCard(historyRows, 'CATEGORY_CHANGE_UP', cycleKey)
  if (latestSameCycle) {
    const prevCategory = String(latestSameCycle.card.payload?.['category'] ?? '')
    const prevShareIncreasePercent = Number(latestSameCycle.card.payload?.['shareIncreasePercent'] ?? 0)
    if (prevCategory === top.category && top.shareIncreasePercent < (prevShareIncreasePercent + 5)) {
      return null
    }
  }

  const categoryLabel = humanizeKey(top.category)
  const increaseStrength = describeCategoryIncreaseStrength(top.shareIncreasePercent, top.relativeIncreasePercent, locale)
  const title = isTurkishLocale(locale)
    ? `${categoryLabel} bu döngüde daha hızlı yükseliyor`
    : `${categoryLabel} is rising faster this cycle`
  const body = isTurkishLocale(locale)
    ? `Önceki döngünün aynı noktasına göre ${categoryLabel}, ${increaseStrength.toLowerCase()} düzeyde daha yüksek (%${top.relativeIncreasePercent} daha fazla harcama).`
    : `Compared with the same point in the previous cycle, ${categoryLabel} is ${increaseStrength.toLowerCase()} higher (${top.relativeIncreasePercent}% more spend).`
  const whyItMatters = isTurkishLocale(locale)
    ? 'Bu kategori kontrol edilebilir harcamanın öncekinden daha büyük bir payını alıyor. Bu kaymayı erken yakalamak, döngünün ilerleyen kısmındaki baskıyı azaltır.'
    : 'This category is taking a bigger share of controllable spend than before. Catching the shift early helps avoid pressure later in the cycle.'

  return {
    id: `category_change_up_${monthKey}_${slugify(top.category)}_${top.shareIncreasePercent}`,
    insightType: 'CATEGORY_CHANGE_UP',
    kind: 'notification',
    source: 'ai',
    title,
    body,
    whyItMatters,
    proofChips: [
      { label: isTurkishLocale(locale) ? 'Kategori' : 'Category', value: categoryLabel },
      { label: isTurkishLocale(locale) ? 'Artış düzeyi' : 'Increase level', value: increaseStrength },
      { label: isTurkishLocale(locale) ? 'Göreli harcama artışı' : 'Relative spend increase', value: `${top.relativeIncreasePercent}%` },
      { label: isTurkishLocale(locale) ? 'Önceki harcama' : 'Previous spend', value: formatCurrency(top.previousAmountCents, currencyCode, locale) },
      { label: isTurkishLocale(locale) ? 'Şimdiki harcama' : 'Current spend', value: formatCurrency(top.currentAmountCents, currencyCode, locale) },
    ],
    severity: 'warning',
    createdAt: new Date().toISOString(),
    ...(otherCategoryBreakdown.length > 0 ? { actionLabel: isTurkishLocale(locale) ? 'Diğer kategorileri gör' : 'View other categories' } : {}),
    ...(otherCategoryBreakdown.length > 0 ? { actionType: 'VIEW_CATEGORY_DROP_BREAKDOWN' } : {}),
    payload: {
      category: top.category,
      previousAmountCents: top.previousAmountCents,
      currentAmountCents: top.currentAmountCents,
      previousTxnCount: top.previousTxnCount,
      currentTxnCount: top.currentTxnCount,
      previousSharePercent: top.previousSharePercent,
      currentSharePercent: top.currentSharePercent,
      shareIncreasePercent: top.shareIncreasePercent,
      relativeIncreasePercent: top.relativeIncreasePercent,
      periodLabel: ranges.periodLabel,
      otherCategoryBreakdown,
      changeDirection: 'up',
    },
  }
}

function timeBucketForHour(hourUtc: number): string {
  const hour = Math.max(0, Math.min(23, Math.trunc(hourUtc)))
  if (hour < 6) return 'night'
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}

function resolveLocalHour(row: ControllableExpenseRow, timeZone: string): number {
  const zone = normalizeTimeZone(timeZone) ?? 'UTC'
  try {
    const hourText = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(row.timestampMs))
    const parsed = Number(hourText)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(23, Math.trunc(parsed)))
    }
  } catch {
    // Ignore and fall back to UTC hour
  }
  return row.hourUtc
}

function timeBucketLabel(bucket: string, locale: WiseyLocale = 'en-US'): string {
  if (bucket === 'night') return isTurkishLocale(locale) ? 'Gece' : 'Night'
  if (bucket === 'morning') return isTurkishLocale(locale) ? 'Sabah' : 'Morning'
  if (bucket === 'afternoon') return isTurkishLocale(locale) ? 'Öğleden sonra' : 'Afternoon'
  if (bucket === 'evening') return isTurkishLocale(locale) ? 'Akşam' : 'Evening'
  return isTurkishLocale(locale) ? 'Gün' : 'Day'
}

function describeDominanceStrength(gapPercentPoints: number, locale: WiseyLocale = 'en-US'): string {
  if (gapPercentPoints >= 50) return isTurkishLocale(locale) ? 'Çok güçlü' : 'Very strong'
  if (gapPercentPoints >= 30) return isTurkishLocale(locale) ? 'Güçlü' : 'Strong'
  if (gapPercentPoints >= 18) return isTurkishLocale(locale) ? 'Belirgin' : 'Clear'
  return isTurkishLocale(locale) ? 'Hafif' : 'Mild'
}

function describeCategoryImprovementStrength(
  shareDropPercent: number,
  relativeDropPercent: number,
  isEliminated: boolean,
  locale: WiseyLocale = 'en-US',
): string {
  if (isEliminated) return isTurkishLocale(locale) ? 'Mükemmel' : 'Excellent'
  const weighted = shareDropPercent + Math.round(relativeDropPercent / 4)
  if (weighted >= 50) return isTurkishLocale(locale) ? 'Mükemmel' : 'Excellent'
  if (weighted >= 30) return isTurkishLocale(locale) ? 'Güçlü' : 'Strong'
  return isTurkishLocale(locale) ? 'İyi' : 'Good'
}

function describeCategoryIncreaseStrength(
  shareIncreasePercent: number,
  relativeIncreasePercent: number,
  locale: WiseyLocale = 'en-US',
): string {
  const weighted = shareIncreasePercent + Math.round(relativeIncreasePercent / 4)
  if (weighted >= 50) return isTurkishLocale(locale) ? 'Çok güçlü' : 'Very strong'
  if (weighted >= 30) return isTurkishLocale(locale) ? 'Güçlü' : 'Strong'
  return isTurkishLocale(locale) ? 'Belirgin' : 'Clear'
}

function buildCompletedDailyControllableTotals(
  rows: ControllableExpenseRow[],
  cycleStartUTC: Date,
  nowUTC: Date,
): number[] {
  const todayStartUTC = new Date(Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate()))
  const daysCompleted = Math.floor((todayStartUTC.getTime() - cycleStartUTC.getTime()) / 86_400_000)
  if (daysCompleted <= 0) return []

  const spendByDay = new Map<string, number>()
  for (const row of rows) {
    spendByDay.set(row.date, (spendByDay.get(row.date) ?? 0) + row.amountCents)
  }

  const totals: number[] = []
  for (let i = 0; i < daysCompleted; i += 1) {
    const day = new Date(cycleStartUTC.getTime() + i * 86_400_000)
    const key = day.toISOString().slice(0, 10)
    totals.push(spendByDay.get(key) ?? 0)
  }
  return totals
}

function trimmedMeanExcludeTopPercent(values: number[], topPercent: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const trimCount = Math.floor(sorted.length * Math.max(0, Math.min(0.4, topPercent)))
  const endIndex = Math.max(1, sorted.length - trimCount)
  const trimmed = sorted.slice(0, endIndex)
  const total = trimmed.reduce((sum, value) => sum + value, 0)
  return total / Math.max(trimmed.length, 1)
}

type UpcomingObligationsSnapshot = {
  totalCents: number
  billCount: number
  subscriptionCount: number
  items: Array<{
    kind: 'bill' | 'subscription'
    name: string
    amountCents: number
    dueDateKey: string
    occurrences: number
  }>
}

async function loadUpcomingObligationsSnapshot(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  fromDateKey: string,
  toDateKey: string,
  mainCurrencyCode: string,
): Promise<UpcomingObligationsSnapshot> {
  const [billsResult, subscriptionsResult] = await Promise.all([
    supabase
      .from('bills')
      .select('name, amount_cents, is_paid, due_date, is_recurring, recurring_frequency, wallet_id, currency_code')
      .eq('user_id', userId)
      .or('is_paid.is.null,is_paid.eq.false'),
    supabase
      .from('subscriptions')
      .select('name, amount_cents, next_billing_date, is_active, billing_cycle, wallet_id, currency_code')
      .eq('user_id', userId)
      .eq('is_active', true)
  ])

  if (billsResult.error) {
    throw new Error(`Failed to load upcoming bills: ${billsResult.error.message}`)
  }
  if (subscriptionsResult.error) {
    throw new Error(`Failed to load upcoming subscriptions: ${subscriptionsResult.error.message}`)
  }

  const billRows = (billsResult.data ?? []) as Array<Record<string, unknown>>
  const subscriptionRows = (subscriptionsResult.data ?? []) as Array<Record<string, unknown>>
  type ObligationSyntheticRow = {
    wallet_id: string | null
    source_currency: string | null
    amount: number
    reporting_amount: null
    reporting_currency: null
    date: string
    kind: 'bill' | 'subscription'
    name: string
    dueDateKey: string
    occurrences: number
  }
  const obligationRows: ObligationSyntheticRow[] = []

  let billCount = 0
  let subscriptionCount = 0
  const items: UpcomingObligationsSnapshot['items'] = []

  for (const row of billRows) {
    const amountCents = Math.max(0, Math.round(Number(row.amount_cents ?? 0)))
    if (amountCents <= 0) continue
    const name = String(row.name ?? '').trim() || 'Bill'
    const dueDateKey = String(row.due_date ?? '').trim()
    const isRecurring = row.is_recurring === true
    const frequency = String(row.recurring_frequency ?? '').trim()
    const occurrences = isRecurring
      ? countRecurringOccurrencesInRange(dueDateKey, fromDateKey, toDateKey, frequency)
      : countSingleOccurrenceInRange(dueDateKey, fromDateKey, toDateKey)
    if (occurrences <= 0) continue
    const walletIdRaw = String(row.wallet_id ?? '').trim()
    const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
    const sourceCurrency = normalizeCurrencyCode(row.currency_code) ?? (walletId ? null : mainCurrencyCode)
    obligationRows.push({
      wallet_id: walletId,
      source_currency: sourceCurrency,
      amount: amountCents / 100,
      reporting_amount: null,
      reporting_currency: null,
      date: `${dueDateKey}T00:00:00.000Z`,
      kind: 'bill',
      name,
      dueDateKey,
      occurrences,
    })
  }

  for (const row of subscriptionRows) {
    const amountCents = Math.max(0, Math.round(Number(row.amount_cents ?? 0)))
    if (amountCents <= 0) continue
    const name = String(row.name ?? '').trim() || 'Subscription'
    const nextBillingDateKey = String(row.next_billing_date ?? '').trim()
    const frequency = String(row.billing_cycle ?? '').trim()
    const occurrences = countRecurringOccurrencesInRange(nextBillingDateKey, fromDateKey, toDateKey, frequency)
    if (occurrences <= 0) continue
    const walletIdRaw = String(row.wallet_id ?? '').trim()
    const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
    const sourceCurrency = normalizeCurrencyCode(row.currency_code) ?? (walletId ? null : mainCurrencyCode)
    obligationRows.push({
      wallet_id: walletId,
      source_currency: sourceCurrency,
      amount: amountCents / 100,
      reporting_amount: null,
      reporting_currency: null,
      date: `${nextBillingDateKey}T00:00:00.000Z`,
      kind: 'subscription',
      name,
      dueDateKey: nextBillingDateKey,
      occurrences,
    })
  }

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    obligationRows,
  )
  log('wisey_updates.upcoming_obligations_currency_normalization_metrics', {
    userId,
    ...normalized.metrics,
  })

  let billsTotal = 0
  let subscriptionsTotal = 0
  for (const row of normalized.rows as ObligationSyntheticRow[]) {
    const amountCents = Math.max(0, toCentsAmount(row.amount))
    if (amountCents <= 0) continue
    const parsedOccurrences = Number(row.occurrences ?? 1)
    const occurrences = Number.isFinite(parsedOccurrences)
      ? Math.max(1, Math.round(parsedOccurrences))
      : 1
    if (row.kind === 'bill') {
      billCount += occurrences
      billsTotal += amountCents * occurrences
    } else {
      subscriptionCount += occurrences
      subscriptionsTotal += amountCents * occurrences
    }
    items.push({
      kind: row.kind,
      name: row.name,
      amountCents,
      dueDateKey: row.dueDateKey,
      occurrences,
    })
  }

  items.sort((a, b) => {
    const left = Date.parse(`${a.dueDateKey}T00:00:00.000Z`)
    const right = Date.parse(`${b.dueDateKey}T00:00:00.000Z`)
    if (!Number.isFinite(left) && !Number.isFinite(right)) return 0
    if (!Number.isFinite(left)) return 1
    if (!Number.isFinite(right)) return -1
    return left - right
  })

  return {
    totalCents: billsTotal + subscriptionsTotal,
    billCount,
    subscriptionCount,
    items,
  }
}

function countSingleOccurrenceInRange(dateKey: string, fromDateKey: string, toDateKey: string): number {
  const date = parseDateKeyUTC(dateKey)
  const from = parseDateKeyUTC(fromDateKey)
  const to = parseDateKeyUTC(toDateKey)
  if (!date || !from || !to) return 0
  return date >= from && date <= to ? 1 : 0
}

function countRecurringOccurrencesInRange(
  seedDateKey: string,
  fromDateKey: string,
  toDateKey: string,
  rawFrequency: string,
): number {
  const seed = parseDateKeyUTC(seedDateKey)
  const from = parseDateKeyUTC(fromDateKey)
  const to = parseDateKeyUTC(toDateKey)
  if (!seed || !from || !to || from > to) return 0

  const frequency = String(rawFrequency ?? '').trim().toUpperCase()
  const normalized = frequency || 'MONTHLY'

  let current = seed
  let guard = 0
  while (current < from && guard < 500) {
    current = addRecurringStep(current, normalized)
    guard += 1
  }

  let count = 0
  while (current <= to && guard < 1000) {
    count += 1
    current = addRecurringStep(current, normalized)
    guard += 1
  }
  return count
}

function addRecurringStep(date: Date, frequency: string): Date {
  const key = String(frequency ?? '').trim().toUpperCase()
  if (key === 'DAILY') return addDaysUTC(date, 1)
  if (key === 'WEEKLY') return addDaysUTC(date, 7)
  if (key === 'BIWEEKLY' || key === 'FORTNIGHTLY') return addDaysUTC(date, 14)
  if (key === 'QUARTERLY') return addMonthsUTC(date, 3)
  if (key === 'ANNUALLY' || key === 'YEARLY') return addMonthsUTC(date, 12)
  return addMonthsUTC(date, 1) // monthly default
}

function addDaysUTC(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days))
}

function addMonthsUTC(date: Date, months: number): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  return new Date(Date.UTC(year, month + months, day))
}

function parseDateKeyUTC(value: string): Date | null {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return null
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed)
}

function aggregateControllableByCategory(rows: ControllableExpenseRow[]): Map<string, { amountCents: number; txnCount: number }> {
  const byCategory = new Map<string, { amountCents: number; txnCount: number }>()
  for (const row of rows) {
    const categoryKey = normalizeCategoryKey(row.category)
    if (!categoryKey) continue
    const current = byCategory.get(categoryKey) ?? { amountCents: 0, txnCount: 0 }
    current.amountCents += row.amountCents
    current.txnCount += 1
    byCategory.set(categoryKey, current)
  }
  return byCategory
}

async function filterDismissedCards(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  cards: UpdateCard[],
): Promise<UpdateCard[]> {
  if (cards.length === 0) return cards

  const { data, error } = await supabase
    .from('insight_user_state')
    .select('insight_id, is_dismissed')
    .eq('user_id', userId)
    .eq('month_key', monthKey)
    .in('insight_id', cards.map((card) => card.id))

  if (error) {
    throw new Error(`Failed to load insight state: ${error.message}`)
  }

  const dismissedIds = new Set(
    (data ?? [])
      .filter((row) => row?.is_dismissed === true)
      .map((row) => String(row.insight_id ?? ''))
      .filter(Boolean),
  )
  return cards.filter((card) => !dismissedIds.has(card.id))
}

async function loadCycleStartDay(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('cycle_start_day')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load cycle_start_day: ${error.message}`)
  }

  const raw = Number(data?.cycle_start_day ?? 1)
  if (!Number.isFinite(raw)) return 1
  return Math.min(31, Math.max(1, Math.trunc(raw)))
}

function normalizeCurrencyCode(raw: unknown): string | null {
  const code = String(raw ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

async function loadSpendableWalletBalanceCents(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  mainCurrencyCode: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id, balance, type, archived')
    .eq('user_id', userId)
    .eq('archived', false)
    .limit(500)

  if (error) {
    throw new Error(`Failed to load spendable wallet balances: ${error.message}`)
  }

  const wallets = ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      walletId: String(row.id ?? '').trim(),
      balanceMajor: Number(row.balance ?? 0),
      type: typeof row.type === 'string' ? row.type : null,
    }))
    .filter((row) => row.walletId.length > 0 && Number.isFinite(row.balanceMajor))

  if (wallets.length === 0) return 0

  const spendable = wallets.filter((row) => isSpendableWalletType(row.type))
  const source = spendable.length > 0 ? spendable : wallets
  if (source.length === 0) return 0

  const snapshotDate = new Date().toISOString()
  const syntheticBalanceRows = source.map((row) => ({
    wallet_id: row.walletId,
    amount: row.balanceMajor,
    reporting_amount: null,
    reporting_currency: null,
    date: snapshotDate,
  }))

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    syntheticBalanceRows,
  )

  log('wisey_updates.goal_contrib_balance_normalization_metrics', {
    userId,
    ...normalized.metrics,
  })

  return normalized.rows.reduce((sum, row) => sum + toCentsAmount(row.amount), 0)
}

async function loadActiveGoalCount(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('goals')
    .select('is_wish, is_challenge, current_amount_cents, target_amount_cents')
    .eq('user_id', userId)
    .limit(500)

  if (error) {
    throw new Error(`Failed to load goals: ${error.message}`)
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>
  let activeGoalCount = 0
  for (const row of rows) {
    const isChallenge = row.is_challenge === true
    const targetCents = Math.max(0, Math.round(Number(row.target_amount_cents ?? 0)))
    const currentCents = Math.max(0, Math.round(Number(row.current_amount_cents ?? 0)))
    const isWish = row.is_wish === true || (row.is_wish !== false && targetCents <= 0)
    if (isChallenge || isWish) continue
    if (targetCents <= 0) continue
    if (currentCents >= targetCents) continue
    activeGoalCount += 1
  }
  return activeGoalCount
}

function isSpendableWalletType(rawType: string | null): boolean {
  const key = String(rawType ?? '').trim().toLowerCase()
  if (!key) return true
  if (key.includes('saving') || key.includes('invest') || key.includes('goal') || key.includes('vault')) {
    return false
  }
  return !['savings', 'saving', 'investment', 'investments', 'goal', 'goals', 'vault'].includes(key)
}

function normalizeTimeZone(raw: unknown): string | null {
  const zone = String(raw ?? '').trim()
  if (!zone) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
    return zone
  } catch {
    return null
  }
}

async function getVelocityComparison(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  cycleStartDay: number,
  mainCurrencyCode: string,
): Promise<FairComparison | null> {
  const now = new Date()
  const ranges = getFairRangeForMonth(monthKey, cycleStartDay, now)
  const currentDay = getCycleAwareCurrentDay(cycleStartDay, now)

  const [currentTxns, prevTxns] = await Promise.all([
    loadTransactions(supabase, userId, ranges.currentStartUTC, ranges.currentEndUTC, mainCurrencyCode),
    loadTransactions(supabase, userId, ranges.prevStartUTC, ranges.prevEndUTC, mainCurrencyCode),
  ])

  return {
    currentPeriodExpenseCents: sumExpenses(currentTxns),
    prevPeriodExpenseCents: sumExpenses(prevTxns),
    currentPeriodIncomeCents: sumIncome(currentTxns),
    periodLabel: ranges.periodLabel,
    currentDay,
  }
}

async function getCurrentPeriodSnapshot(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  monthKey: string,
  cycleStartDay: number,
  mainCurrencyCode: string,
): Promise<CurrentPeriodSnapshot | null> {
  const now = new Date()
  const ranges = getFairRangeForMonth(monthKey, cycleStartDay, now)
  const currentDay = getCycleAwareCurrentDay(cycleStartDay, now)
  const cycleLengthDays = getCycleLengthDays(cycleStartDay, now)
  const currentTxns = await loadTransactions(supabase, userId, ranges.currentStartUTC, ranges.currentEndUTC, mainCurrencyCode)

  return {
    expenseCents: sumExpenses(currentTxns),
    incomeCents: sumIncome(currentTxns),
    periodLabel: ranges.periodLabel,
    currentDay,
    cycleLengthDays,
    txns: currentTxns,
  }
}

async function loadTransactions(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  startUTC: Date,
  endUTC: Date,
  mainCurrencyCode: string,
): Promise<TxnRow[]> {
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('wallet_id, amount, reporting_amount, reporting_currency, category, date, created_at, title, note, is_opening_balance, is_manual_topup')
    .eq('user_id', userId)
    .gte('date', startUTC.toISOString())
    .lte('date', endUTC.toISOString())

  if (error) {
    throw new Error(`Failed to load transactions: ${error.message}`)
  }

  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    (data ?? []) as Array<Record<string, unknown>>,
  )
  log('wisey_updates.currency_normalization_metrics', {
    userId,
    ...normalized.metrics,
  })

  return normalized.rows.map((row) => ({
    amount: toCentsAmount(row.amount),
    category: typeof row.category === 'string' ? row.category : null,
    date: String(row.date ?? ''),
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    title: typeof row.title === 'string' ? row.title : null,
    note: typeof row.note === 'string' ? row.note : null,
    isOpeningBalance: row.is_opening_balance === true,
    isManualTopup: row.is_manual_topup === true,
  }))
}

async function loadExpenseCategoryIndex(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<Map<string, CategoryProfile>> {
  const { data, error } = await supabase
    .from('categories')
    .select('name, expense_tier, is_fixed_obligation, is_system, user_id, is_income')
    .or(`is_system.eq.true,user_id.eq.${userId}`)

  if (error) {
    throw new Error(`Failed to load categories for income share: ${error.message}`)
  }

  const prioritized = new Map<string, { profile: CategoryProfile; priority: number }>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (row?.is_income === true) continue
    const name = normalizeCategoryKey(typeof row.name === 'string' ? row.name : '')
    if (!name) continue
    const isSystem = row.is_system === true
    const priority = isSystem ? 1 : 2
    const existing = prioritized.get(name)
    if (existing && existing.priority >= priority) continue

    prioritized.set(name, {
      priority,
      profile: {
        expenseTier: typeof row.expense_tier === 'string' ? row.expense_tier.trim().toLowerCase() : null,
        isFixedObligation: row.is_fixed_obligation === true,
      },
    })
  }

  const result = new Map<string, CategoryProfile>()
  for (const [key, value] of prioritized.entries()) {
    result.set(key, value.profile)
  }

  // Hardcoded essential overrides — these always count as essential regardless
  // of what the DB says, so Wisey never treats them as "controllable" spending.
  for (const key of HARDCODED_ESSENTIAL_CATEGORY_KEYS) {
    const existing = result.get(key)
    if (!existing || existing.expenseTier !== 'essential') {
      result.set(key, { expenseTier: 'essential', isFixedObligation: true })
    }
  }

  return result
}

function summarizeSpendMix(
  txns: TxnRow[],
  categoryIndex: Map<string, CategoryProfile>,
): { controllableCents: number; fixedCents: number } {
  let controllableCents = 0
  let fixedCents = 0

  for (const txn of txns) {
    if (txn.amount >= 0) continue
    if (isTransferOrRefundLike(txn)) continue

    const amountCents = Math.abs(txn.amount)
    const key = normalizeCategoryKey(txn.category ?? '')
    const category = key ? categoryIndex.get(key) : undefined
    const tier = category?.expenseTier ?? ''

    if (category?.isFixedObligation || tier === 'essential') {
      fixedCents += amountCents
      continue
    }
    if (tier === 'discretionary' || tier === 'flexible_essential') {
      controllableCents += amountCents
      continue
    }

    // Fallback when category profile is missing: treat common fixed labels as fixed.
    if (isFixedLikeLabel(txn.category)) {
      fixedCents += amountCents
    } else {
      controllableCents += amountCents
    }
  }

  return { controllableCents, fixedCents }
}

function isBudgetCapExpenseTier(tier: string | null | undefined): boolean {
  return tier === 'essential' || tier === 'flexible_essential'
}

function isFixedLikeLabel(category: string | null): boolean {
  const key = normalizeCategoryKey(category ?? '')
  if (!key) return false
  return [
    'rent',
    'mortgage',
    'housing',
    'insurance',
    'taxes',
    'debt',
    'loan',
    'utilities',
    'utility',
    'bill',
  ].some((term) => key.includes(term))
}

function hasFreshTxnData(txns: TxnRow[], freshnessHours: number): boolean {
  let freshestEpoch = 0
  for (const txn of txns) {
    const source = txn.createdAt ?? txn.date
    const parsed = Date.parse(source)
    if (!Number.isFinite(parsed)) continue
    freshestEpoch = Math.max(freshestEpoch, parsed)
  }
  if (freshestEpoch <= 0) return false
  const ageMs = Date.now() - freshestEpoch
  return ageMs <= freshnessHours * 60 * 60 * 1000
}

function extractControllableExpenseRows(
  txns: TxnRow[],
  categoryIndex: Map<string, CategoryProfile>,
): ControllableExpenseRow[] {
  const rows: ControllableExpenseRow[] = []
  for (const txn of txns) {
    if (txn.amount >= 0) continue
    if (isTransferOrRefundLike(txn)) continue

    const category = normalizeCategoryLabel(txn.category)
    if (isSuppressedCategoryKey(category)) continue
    const profile = categoryIndex.get(normalizeCategoryKey(category))
    const tier = profile?.expenseTier ?? ''
    const isFixed = profile?.isFixedObligation === true || tier === 'essential' || isFixedLikeLabel(category)
    if (isFixed) continue

    const parsed = Date.parse(txn.date)
    if (!Number.isFinite(parsed)) continue
    const dateKey = new Date(parsed).toISOString().slice(0, 10)
    const hourUtc = new Date(parsed).getUTCHours()

    rows.push({
      amountCents: Math.abs(txn.amount),
      date: dateKey,
      category,
      merchant: normalizeMerchantLabel(txn.title, category),
      hourUtc,
      timestampMs: parsed,
    })
  }
  return rows
}

function weekendOrWeekday(dateKey: string): 'weekend' | 'weekday' {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) return 'weekday'
  const day = new Date(parsed).getUTCDay()
  return day === 0 || day === 6 ? 'weekend' : 'weekday'
}

async function loadActiveSubscriptions(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  mainCurrencyCode: string,
): Promise<RecurringItem[]> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('amount_cents, billing_cycle, is_active, wallet_id, currency_code')
    .eq('user_id', userId)
    .eq('is_active', true)

  if (error) {
    throw new Error(`Failed to load subscriptions: ${error.message}`)
  }

  type SyntheticRecurringRow = {
    wallet_id: string | null
    source_currency: string | null
    amount: number
    reporting_amount: null
    reporting_currency: null
    date: string
    frequency: string | null
  }
  const todayIso = new Date().toISOString()
  const sourceRows = ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const amountCents = Number(row.amount_cents ?? 0)
      const walletIdRaw = String(row.wallet_id ?? '').trim()
      const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
      const sourceCurrency = normalizeCurrencyCode(row.currency_code) ?? (walletId ? null : mainCurrencyCode)
      return {
        wallet_id: walletId,
        source_currency: sourceCurrency,
        amount: amountCents / 100,
        reporting_amount: null,
        reporting_currency: null,
        date: todayIso,
        frequency: typeof row.billing_cycle === 'string' ? row.billing_cycle : null,
      } as SyntheticRecurringRow
    })
    .filter((row) => Number.isFinite(row.amount) && row.amount > 0)

  if (sourceRows.length === 0) return []
  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    sourceRows,
  )
  log('wisey_updates.subscriptions_currency_normalization_metrics', {
    userId,
    ...normalized.metrics,
  })
  return (normalized.rows as SyntheticRecurringRow[])
    .map((row) => ({
      amountCents: toCentsAmount(row.amount),
      frequency: row.frequency,
    }))
    .filter((row) => row.amountCents > 0)
}

async function loadRecurringBills(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  mainCurrencyCode: string,
): Promise<RecurringItem[]> {
  const { data, error } = await supabase
    .from('bills')
    .select('amount_cents, recurring_frequency, is_recurring, wallet_id, currency_code')
    .eq('user_id', userId)
    .eq('is_recurring', true)

  if (error) {
    throw new Error(`Failed to load recurring bills: ${error.message}`)
  }

  type SyntheticRecurringRow = {
    wallet_id: string | null
    source_currency: string | null
    amount: number
    reporting_amount: null
    reporting_currency: null
    date: string
    frequency: string | null
  }
  const todayIso = new Date().toISOString()
  const sourceRows = ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const amountCents = Number(row.amount_cents ?? 0)
      const walletIdRaw = String(row.wallet_id ?? '').trim()
      const walletId = walletIdRaw.length > 0 ? walletIdRaw : null
      const sourceCurrency = normalizeCurrencyCode(row.currency_code) ?? (walletId ? null : mainCurrencyCode)
      return {
        wallet_id: walletId,
        source_currency: sourceCurrency,
        amount: amountCents / 100,
        reporting_amount: null,
        reporting_currency: null,
        date: todayIso,
        frequency: typeof row.recurring_frequency === 'string' ? row.recurring_frequency : null,
      } as SyntheticRecurringRow
    })
    .filter((row) => Number.isFinite(row.amount) && row.amount > 0)

  if (sourceRows.length === 0) return []
  const normalized = await normalizeTransactionsToMainCurrency(
    supabase,
    userId,
    mainCurrencyCode,
    sourceRows,
  )
  log('wisey_updates.recurring_bills_currency_normalization_metrics', {
    userId,
    ...normalized.metrics,
  })
  return (normalized.rows as SyntheticRecurringRow[])
    .map((row) => ({
      amountCents: toCentsAmount(row.amount),
      frequency: row.frequency,
    }))
    .filter((row) => row.amountCents > 0)
}

function normalizeToMonthlyCents(amountCents: number, rawFrequency: string | null): number {
  const freq = String(rawFrequency ?? '').trim().toUpperCase()
  if (amountCents <= 0) return 0

  if (freq === 'WEEKLY') return Math.round(amountCents * 4.33)
  if (freq === 'BIWEEKLY' || freq === 'FORTNIGHTLY') return Math.round(amountCents * 2.16)
  if (freq === 'ANNUALLY' || freq === 'YEARLY') return Math.round(amountCents / 12)
  if (freq === 'QUARTERLY') return Math.round(amountCents / 3)
  if (freq === 'DAILY') return Math.round(amountCents * 30.42)
  return Math.round(amountCents) // default monthly
}

async function loadThreeMonthMedianIncomeCents(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
  mainCurrencyCode: string,
): Promise<number> {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
  const txns = await loadTransactions(supabase, userId, start, now, mainCurrencyCode)

  const monthBuckets = new Map<string, number>()
  for (const txn of txns) {
    if (txn.amount <= 0) continue
    if (isTransferOrRefundLike(txn)) continue
    const parsed = Date.parse(txn.date)
    if (!Number.isFinite(parsed)) continue
    const key = new Date(parsed).toISOString().slice(0, 7)
    monthBuckets.set(key, (monthBuckets.get(key) ?? 0) + txn.amount)
  }
  const values = [...monthBuckets.values()].filter((v) => v > 0)
  if (values.length === 0) return 0
  return Math.round(median(values))
}

async function hasAtLeastOneMonthTransactionHistory(
  supabase: ReturnType<typeof getServiceSupabaseClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('wallet_transactions')
    .select('date')
    .eq('user_id', userId)
    .order('date', { ascending: true })
    .limit(1)

  if (error) {
    throw new Error(`Failed to load transaction history age: ${error.message}`)
  }

  const oldestDateRaw = (data?.[0] as Record<string, unknown> | undefined)?.['date']
  const oldestDateMs = typeof oldestDateRaw === 'string' ? Date.parse(oldestDateRaw) : Number.NaN
  if (!Number.isFinite(oldestDateMs)) return false

  const ageDays = (Date.now() - oldestDateMs) / 86_400_000
  return ageDays >= 30
}

function findLatestWiseyCard(
  rows: InsightHistoryRow[],
  insightType: UpdateCard['insightType'],
  cycleKey?: string,
): { card: UpdateCard; shownAt: string } | null {
  for (const row of rows) {
    const card = extractWiseyCardFromHistory(row)
    if (!card || card.insightType !== insightType) continue
    if (cycleKey) {
      const rowCycleKey = String((row.metadata ?? {})['cycleKey'] ?? '')
      if (rowCycleKey !== cycleKey) continue
    }
    const shownAt = typeof row.shown_at === 'string' ? row.shown_at : card.createdAt
    return { card, shownAt }
  }
  return null
}

function subscriptionsTierRank(tier: string): number {
  const normalized = tier.trim().toLowerCase()
  if (normalized === 'critical') return 3
  if (normalized === 'high') return 2
  if (normalized === 'medium') return 1
  return 0
}

function toDateKey(value: string): string | null {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 10)
}

function normalizeCategoryLabel(category: string | null): string {
  const clean = (category ?? '').trim()
  return clean.length > 0 ? clean : 'Uncategorized'
}

function normalizeMerchantLabel(title: string | null, fallbackCategory: string): string {
  const clean = (title ?? '').trim()
  return clean.length > 0 ? clean : fallbackCategory
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function slugify(value: string): string {
  const lower = value.trim().toLowerCase()
  const replaced = lower.replace(/[^a-z0-9]+/g, '_')
  return replaced.replace(/^_+|_+$/g, '') || 'unknown'
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }
  return sorted[mid]
}

function sumExpenses(txns: TxnRow[]): number {
  return txns.reduce((sum, txn) => {
    if (txn.amount >= 0) return sum
    if (isTransferOrRefundLike(txn)) return sum
    return sum + Math.abs(txn.amount)
  }, 0)
}

function sumIncome(txns: TxnRow[]): number {
  return txns.reduce((sum, txn) => {
    if (txn.amount <= 0) return sum
    if (isTransferOrRefundLike(txn)) return sum
    return sum + txn.amount
  }, 0)
}

const REFUND_LIKE_CATEGORY_KEYS = new Set<string>([
  'refund',
  'tax-refund',
  'cashback',
  'cash-back',
  'reimbursement',
  'reimbursements',
  'reversal',
  'return',
  'credit',
])

/**
 * Categories that are always treated as "essential" (fixed obligations),
 * regardless of what tier the database says. This prevents Wisey from
 * proposing challenges or insights for utility/system categories (ATM,
 * uncategorized) and unavoidable financial obligations (debt payments,
 * fees, taxes). These are never "controllable" spending.
 */
const HARDCODED_ESSENTIAL_CATEGORY_KEYS = new Set<string>([
  // System / utility — no meaningful pattern to analyse
  'atm-withdrawals',
  'atm',
  'uncategorized',
  'opening-balance',
  'balance-adjustment',
  // Fixed financial obligations — no point challenging these
  'debt',
  'buy-now-pay-later',
  'bnpl',
  'interest-paid',
  'credit-card-payment',
  'loan-payment',
  'loan-principal',
  // Fees, taxes & fixed costs — user has no real discretion here
  'bank-fees',
  'credit-card-fees',
  'taxes',
  'insurance-other',
  'hoa-fees',
  'property-tax',
])

function isTransferOrRefundLike(txn: TxnRow): boolean {
  if (txn.isOpeningBalance || txn.isManualTopup) return true
  const categoryKey = normalizeCategoryKeyForTransfer(txn.category)
  if (isTransferCategoryKey(categoryKey)) return true
  if (isGoalCategoryKey(categoryKey)) return true
  if (isRefundLikeCategoryKey(categoryKey)) return true

  // Legacy fallback when category labels are inconsistent.
  const text = `${txn.category ?? ''} ${txn.title ?? ''} ${txn.note ?? ''}`.toLowerCase()
  return ['transfer', 'refund', 'reimbursement', 'opening balance', 'opening-balance', 'internal move'].some(
    (term) => text.includes(term),
  )
}

function normalizeCategoryKeyForTransfer(raw: string | null | undefined): string {
  return normalizeCategoryKey(raw) || 'other'
}

function toCentsAmount(raw: unknown): number {
  const numeric = Number(raw ?? 0)
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0
}

function getCycleAwareCurrentDay(cycleStartDay: number, now = new Date()): number {
  const { startUTC } = getCurrentCycleWindow(cycleStartDay, now)
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dayCount = Math.floor((todayUTC.getTime() - startUTC.getTime()) / 86_400_000) + 1
  return Math.max(1, dayCount)
}

function getCycleLengthDays(cycleStartDay: number, now = new Date()): number {
  const { startUTC, nextStartUTC } = getCurrentCycleWindow(cycleStartDay, now)
  const diffDays = Math.floor((nextStartUTC.getTime() - startUTC.getTime()) / 86_400_000)
  return Math.max(1, diffDays)
}

function getCurrentCycleWindow(
  cycleStartDay: number,
  now = new Date(),
): { startUTC: Date; nextStartUTC: Date } {
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()
  const thisMonthAnchor = buildCycleAnchorUTC(currentYear, currentMonth, cycleStartDay)
  const todayUTCDate = now.getUTCDate()
  const startUTC = todayUTCDate >= thisMonthAnchor.getUTCDate()
    ? thisMonthAnchor
    : buildCycleAnchorUTC(currentYear, currentMonth - 1, cycleStartDay)
  const nextStartUTC = buildCycleAnchorUTC(startUTC.getUTCFullYear(), startUTC.getUTCMonth() + 1, cycleStartDay)
  return { startUTC, nextStartUTC }
}

function buildCycleAnchorUTC(year: number, month: number, cycleStartDay: number): Date {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const safeDay = Math.min(Math.max(1, cycleStartDay), daysInMonth)
  return new Date(Date.UTC(year, month, safeDay))
}

function getFairRangeForMonth(
  monthKey: string,
  cycleStartDay: number,
  nowUTC = new Date(),
): {
  currentStartUTC: Date
  currentEndUTC: Date
  prevStartUTC: Date
  prevEndUTC: Date
  periodLabel: string
} {
  const [yearStr, monthStr] = monthKey.split('-')
  const requestedYear = Number(yearStr)
  const requestedMonth = Number(monthStr) - 1

  const currentUTCMonth = nowUTC.getUTCMonth()
  const currentUTCYear = nowUTC.getUTCFullYear()
  const isCurrentMonth = requestedYear === currentUTCYear && requestedMonth === currentUTCMonth

  if (!isCurrentMonth) {
    const currentStartUTC = new Date(Date.UTC(requestedYear, requestedMonth, 1))
    const currentEndUTC = new Date(Date.UTC(requestedYear, requestedMonth + 1, 0, 23, 59, 59, 999))
    const prevStartUTC = new Date(Date.UTC(requestedYear, requestedMonth - 1, 1))
    const prevEndUTC = new Date(Date.UTC(requestedYear, requestedMonth, 0, 23, 59, 59, 999))
    return {
      currentStartUTC,
      currentEndUTC,
      prevStartUTC,
      prevEndUTC,
      periodLabel: cycleStartDay === 1 ? 'Full month' : 'Full cycle',
    }
  }

  if (cycleStartDay === 1) {
    const currentStartUTC = new Date(Date.UTC(currentUTCYear, currentUTCMonth, 1))
    const currentEndUTC = new Date(Date.UTC(currentUTCYear, currentUTCMonth, nowUTC.getUTCDate(), 23, 59, 59, 999))
    const dayCount = nowUTC.getUTCDate()
    const prevMonth = currentUTCMonth === 0 ? 11 : currentUTCMonth - 1
    const prevYear = currentUTCMonth === 0 ? currentUTCYear - 1 : currentUTCYear
    const prevStartUTC = new Date(Date.UTC(prevYear, prevMonth, 1))
    const prevEndUTC = new Date(Date.UTC(prevYear, prevMonth, dayCount, 23, 59, 59, 999))
    return {
      currentStartUTC,
      currentEndUTC,
      prevStartUTC,
      prevEndUTC,
      periodLabel: 'Month-to-date',
    }
  }

  const { startUTC: cycleStartUTC } = getCurrentCycleWindow(cycleStartDay, nowUTC)
  const currentStartUTC = cycleStartUTC
  const currentEndUTC = new Date(Date.UTC(currentUTCYear, currentUTCMonth, nowUTC.getUTCDate(), 23, 59, 59, 999))
  const dayCount = Math.floor((currentEndUTC.getTime() - cycleStartUTC.getTime()) / 86_400_000) + 1

  const prevStartUTC = buildCycleAnchorUTC(cycleStartUTC.getUTCFullYear(), cycleStartUTC.getUTCMonth() - 1, cycleStartDay)
  const prevEndUTC = new Date(prevStartUTC.getTime() + (dayCount - 1) * 86_400_000)
  prevEndUTC.setUTCHours(23, 59, 59, 999)

  return {
    currentStartUTC,
    currentEndUTC,
    prevStartUTC,
    prevEndUTC,
    periodLabel: 'Cycle-to-date',
  }
}

function inferInsightTypeFromUpdateId(updateId: string): UpdateCard['insightType'] {
  if (updateId.startsWith('income_share_')) return 'INCOME_SHARE'
  if (updateId.startsWith('top_category_')) return 'TOP_CATEGORY'
  if (updateId.startsWith('top_merchant_')) return 'TOP_MERCHANT'
  if (updateId.startsWith('spike_day_')) return 'SPIKE_DAY'
  if (updateId.startsWith('small_leaks_')) return 'SMALL_LEAKS'
  if (updateId.startsWith('weekend_spike_')) return 'WEEKEND_SPIKE'
  if (updateId.startsWith('subscriptions_')) return 'SUBSCRIPTIONS'
  if (updateId.startsWith('time_of_day_')) return 'TIME_OF_DAY'
  if (updateId.startsWith('goal_contrib_')) return 'GOAL_CONTRIB'
  if (updateId.startsWith('category_change_up_')) return 'CATEGORY_CHANGE_UP'
  if (updateId.startsWith('category_change_down_')) return 'CATEGORY_CHANGE_DOWN'
  if (updateId.startsWith('budget_pace_')) return 'BUDGET_OVERSPENDING_PACE'
  return 'SPENDING_VELOCITY'
}

function calculatePercentChange(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : 0
  }
  return Math.round(((current - previous) / previous) * 100)
}

function buildBudgetCapPayload(
  totalIncomeCents: number,
  totalExpenseCents: number,
  pacePercent: number,
): Record<string, unknown> | undefined {
  if (totalIncomeCents <= 0 || totalExpenseCents <= 0) return undefined

  const ratioPercent = Math.round((totalExpenseCents / totalIncomeCents) * 100)
  const unspentCents = Math.max(totalIncomeCents - totalExpenseCents, 0)
  if (unspentCents <= 0) return undefined
  const durationDays = 7
  const limitCents = calculateBudgetCapLimit(pacePercent, unspentCents, durationDays)
  if (limitCents <= 0) return undefined

  return {
    scope: 'discretionary',
    durationDays,
    totalIncomeCents,
    totalExpenseCents,
    unspentCents,
    ratioPercent,
    pacePercent,
    limitCents,
  }
}

function buildCategoryBudgetCapPayload(
  totalIncomeCents: number,
  cycleExpenseCents: number,
  categoryName: string,
  categorySpendCents: number,
  categorySharePercent: number,
): Record<string, unknown> | undefined {
  const payload = buildBudgetCapPayload(
    totalIncomeCents,
    cycleExpenseCents,
    Math.max(15, Math.min(40, categorySharePercent)),
  )
  if (!payload) return undefined

  return {
    ...payload,
    scope: categoryName,
    category: categoryName,
    categoryName,
    display_name: categoryName,
    categorySpendCents,
    categorySharePercent,
  }
}

function calculateBudgetCapLimit(
  pacePercent: number,
  unspentCents: number,
  durationDays: number,
): number {
  if (unspentCents <= 0) return 0

  const fullWindowPct = pacePercent >= 25
    ? 0.25
    : pacePercent >= 15
      ? 0.35
      : 0.5

  const durationFactor = durationDays <= 3
    ? 0.35
    : durationDays <= 7
      ? 0.7
      : 1

  const suggestedCap = Math.round(unspentCents * fullWindowPct * durationFactor)
  return Math.min(Math.max(suggestedCap, 0), unspentCents)
}

function formatCurrency(cents: number, currencyCode: string, locale: WiseyLocale = 'en-US'): string {
  const amount = Math.abs(cents) / 100
  const roundedWhole = Math.round(amount)
  const safeCurrency = normalizeCurrencyCode(currencyCode)
  if (!safeCurrency) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(roundedWhole)
  }
  const fallbackSymbol = currencySymbolForCode(safeCurrency)
  if (fallbackSymbol !== safeCurrency) {
    return `${fallbackSymbol}${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(roundedWhole)}`
  }
  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: safeCurrency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(roundedWhole)
    if (!formatted.toUpperCase().includes(safeCurrency)) {
      return formatted
    }
  } catch {
    // Fall through to ISO-code fallback below.
  }
  return `${safeCurrency} ${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(roundedWhole)}`
}

function currencySymbolForCode(currencyCode: string): string {
  const code = normalizeCurrencyCode(currencyCode)
  if (!code) return String(currencyCode ?? '').trim().toUpperCase()
  const symbolMap: Record<string, string> = {
    USD: '$',
    EUR: '\u20AC',
    GBP: '\u00A3',
    TRY: '\u20BA',
    JPY: '\u00A5',
    CNY: '\u00A5',
    INR: '\u20B9',
    RUB: '\u20BD',
    KRW: '\u20A9',
    AUD: 'A$',
    CAD: 'C$',
    CHF: 'CHF',
    SEK: 'kr',
    NOK: 'kr',
    DKK: 'kr',
    PLN: 'z\u0142',
    BRL: 'R$',
    MXN: '$',
    NZD: 'NZ$',
    SGD: 'S$',
    HKD: 'HK$',
    AED: '\u062F.\u0625',
    SAR: '\uFDFC',
    QAR: '\uFDFC',
    ZAR: 'R',
  }
  return symbolMap[code] ?? code
}
