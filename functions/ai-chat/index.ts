import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.94.1'
import { getCanonicalObligations } from './obligations.ts'
import {
  buildPersonaIdentityLine,
  buildPersonaPromptSection,
  buildLengthRule,
  buildEmojiRule,
} from './wiseyPersona.ts'
import { buildBudgetLockContext } from '../_shared/budgetLocks.ts'
import {
  type ChatMemoryFact,
  type RetrievedMemoryRow,
  buildChatMemoryExtractionPrompt,
  extractSearchKeywords,
  formatRetrievedMemories,
  normalizeChatMemoryFacts,
  parseChatMemoryExtraction,
  rankChatMemoryMatch,
  upsertChatMemory,
} from '../_shared/chatMemory.ts'
import { normalizeTransactionsToMainCurrency } from '../_shared/currencyReporting.ts'
import {
  buildCentNormalizationWarning,
  normalizeCentFieldsToMainCurrency,
  type CentCurrencyNormalizationResult,
} from '../_shared/centCurrency.ts'
import {
  buildObligationNormalizationWarning,
  normalizeCanonicalObligationLinesToMainCurrency,
  sumNormalizedObligationTotals,
} from '../_shared/obligationCurrency.ts'
import {
  type DigestHandoffV1,
  buildDigestContextSummary,
  buildDigestPromptBlock,
  detectDigestInteractionMode,
  evaluateDigestHandoffTrust,
  normalizeDigestHandoff,
} from './digestHandoff.ts'
import {
  getWiseyBusyMessage,
  getWiseyInterruptedMessage,
  loadGeminiApiKeys,
  requestGeminiWithResilience,
  shouldPersistWiseyResponse,
  type GeminiApiKey,
  type GeminiRetryLogEvent,
} from './geminiModelFallback.ts'

// deno-lint-ignore no-explicit-any
let GOOGLE_SA: any = {};
try {
  GOOGLE_SA = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") ?? "{}");
} catch (e) {
  console.error("[ai-chat] GOOGLE_SERVICE_ACCOUNT_KEY parse error:", e);
}
const VERTEX_PROJECT = GOOGLE_SA.project_id ?? "";
const VERTEX_REGION = "global";

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
    return cachedAccessToken.token;
  }
  const sa = GOOGLE_SA;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  }
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlBytes = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const pem = sa.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  );
  const jwt = `${header}.${claims}.${b64urlBytes(sig)}`;
  const tokenRes = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(
      `Service account token exchange failed: ${JSON.stringify(tokenData)}`,
    );
  }
  cachedAccessToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + 3_300_000,
  };
  return tokenData.access_token;
}

const GEMINI_API_KEYS: GeminiApiKey[] = [{ slot: 'vertex_sa', value: 'service_account' }]
const CHAT_CONTEXT_V2_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(Deno.env.get('CHAT_CONTEXT_V2_ENABLED') || '').toLowerCase()
)
const AI_CHAT_MULTI_TURN_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(Deno.env.get('AI_CHAT_MULTI_TURN_ENABLED') || '').toLowerCase()
)
const AI_CHAT_GENERAL_CHAT_FACTS_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(Deno.env.get('AI_CHAT_GENERAL_CHAT_FACTS_ENABLED') || '').toLowerCase()
)
// Product decision for now: active Wisey chats are session-scoped.
// Archived memory can still be stored for future features, but it should not
// automatically bleed into a fresh chat session.
const ENABLE_CROSS_CHAT_MEMORY_RETRIEVAL = CHAT_CONTEXT_V2_ENABLED
const CHAT_CONTEXT_STATE_VERSION = 1 as const
const CHAT_CONTEXT_RECENT_TOPICS_LIMIT = 8
const CHAT_CONTEXT_INTENT_LIMIT = 7
const CHAT_CONTEXT_SLOTS_PER_INTENT_LIMIT = 12
const AI_CHAT_CONTEXT_TX_WINDOW_DAYS = 60
const AI_CHAT_CONTEXT_TX_ROW_LIMIT = 1000

if (!VERTEX_PROJECT) {
  console.error('[ai-chat] VERTEX_PROJECT is empty — GOOGLE_SERVICE_ACCOUNT_KEY may not be set')
}

type ChatContextIntent =
  | 'general_chat'
  | 'vacation_affordability'
  | 'save_more_plan'
  | 'afford_check'
  | 'emergency_fund'
  | 'budget_intel'
  | 'cash_flow'

type ChatContextActiveIntent = ChatContextIntent | null

type SlotStatus =
  | 'declared'
  | 'confirmed'
  | 'computed'
  | 'inferred'
  | 'hypothetical'

type SlotValueType =
  | 'money'
  | 'month'
  | 'integer'
  | 'boolean'
  | 'text'
  | 'date'

type SlotScope = 'committed' | 'working'

type SlotState = {
  value: unknown
  valueType: SlotValueType
  status: SlotStatus
  scope: SlotScope
  confidence: number
  updatedAt: string
  sourceTurnId: string
  sourceMessageRole: 'user' | 'assistant' | 'system'
  sourceKind: 'manual' | 'preset' | 'resolver' | 'deterministic_compute'
  evidenceText?: string
  scenarioId?: string | null
}

type IntentSlotsByType = Partial<Record<ChatContextIntent, Record<string, SlotState>>>

type OpenQuestionState = null | {
  intent: ChatContextIntent
  slotName: string
  askedAt: string
  prompt: string
}

type TopicState = {
  intent: ChatContextIntent
  updatedAt: string
}

type RollingSessionSummaryState = {
  text: string
  updatedAt: string | null
  lastIncludedMessageCount: number
}

type ChatContextStateV1 = {
  version: typeof CHAT_CONTEXT_STATE_VERSION
  activeIntent: ChatContextActiveIntent
  activeDigestHandoff: DigestHandoffV1 | null
  slots: IntentSlotsByType
  openQuestion: OpenQuestionState
  recentTopics: TopicState[]
  turnCounter: number
  summary: {
    text: string
    updatedAt: string | null
    lastTurnNumber: number
  }
  rollingSummary: RollingSessionSummaryState
}

type ResolvedFact = {
  intent: ChatContextIntent
  slotName: string
  value: unknown
  sourceScope: 'session' | 'memory'
  status: SlotStatus
  scope: SlotScope
  confidence: number
}

type FollowUpResolutionDecision = {
  kind: 'fresh_intent' | 'autofill' | 'autofill_with_assumption' | 'clarify' | 'fallback'
  confidence: number
  reason: string
  usedOpenQuestion: boolean
  usedCrossChatMemory: boolean
}

type RecentChatMessageRow = {
  content: string | null
  is_from_user: boolean
  created_at?: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChatContextIntent(value: unknown): value is ChatContextIntent {
  return [
    'general_chat',
    'vacation_affordability',
    'save_more_plan',
    'afford_check',
    'emergency_fund',
    'budget_intel',
    'cash_flow',
  ].includes(String(value))
}

function createDefaultChatContextStateV1(): ChatContextStateV1 {
  return {
    version: CHAT_CONTEXT_STATE_VERSION,
    activeIntent: null,
    activeDigestHandoff: null,
    slots: {},
    openQuestion: null,
    recentTopics: [],
    turnCounter: 0,
    summary: {
      text: '',
      updatedAt: null,
      lastTurnNumber: 0,
    },
    rollingSummary: {
      text: '',
      updatedAt: null,
      lastIncludedMessageCount: 0,
    },
  }
}

function isChatContextStateV1(value: unknown): value is ChatContextStateV1 {
  if (!isPlainObject(value)) return false
  if (value.version !== CHAT_CONTEXT_STATE_VERSION) return false
  if (!(value.activeIntent === null || isChatContextIntent(value.activeIntent))) return false
  if (!isPlainObject(value.slots)) return false
  if (!(value.activeDigestHandoff === null || normalizeDigestHandoff(value.activeDigestHandoff))) return false
  if (!(value.openQuestion === null || isPlainObject(value.openQuestion))) return false
  if (!Array.isArray(value.recentTopics)) return false
  if (typeof value.turnCounter !== 'number' || !Number.isFinite(value.turnCounter)) return false
  if (!isPlainObject(value.summary)) return false
  if (!isPlainObject(value.rollingSummary)) return false

  return typeof value.summary.text === 'string' &&
    (value.summary.updatedAt === null || typeof value.summary.updatedAt === 'string') &&
    typeof value.summary.lastTurnNumber === 'number' &&
    Number.isFinite(value.summary.lastTurnNumber) &&
    typeof value.rollingSummary.text === 'string' &&
    (value.rollingSummary.updatedAt === null || typeof value.rollingSummary.updatedAt === 'string') &&
    typeof value.rollingSummary.lastIncludedMessageCount === 'number' &&
    Number.isFinite(value.rollingSummary.lastIncludedMessageCount)
}

function migrateContextStateToV1(value: unknown): ChatContextStateV1 {
  const fallback = createDefaultChatContextStateV1()
  if (isChatContextStateV1(value)) return value
  if (!isPlainObject(value)) return fallback

  const summary = isPlainObject(value.summary) ? value.summary : {}
  const rollingSummary = isPlainObject(value.rollingSummary) ? value.rollingSummary : {}
  const openQuestion = isPlainObject(value.openQuestion) && isChatContextIntent(value.openQuestion.intent)
    ? {
        intent: value.openQuestion.intent,
        slotName: typeof value.openQuestion.slotName === 'string' ? value.openQuestion.slotName : '',
        askedAt: typeof value.openQuestion.askedAt === 'string' ? value.openQuestion.askedAt : '',
        prompt: typeof value.openQuestion.prompt === 'string' ? value.openQuestion.prompt : '',
      }
    : null

  const recentTopics = Array.isArray(value.recentTopics)
    ? value.recentTopics
        .filter((topic): topic is TopicState =>
          isPlainObject(topic) &&
          isChatContextIntent(topic.intent) &&
          typeof topic.updatedAt === 'string'
        )
        .slice(-CHAT_CONTEXT_RECENT_TOPICS_LIMIT)
    : []

  const slotsSource = isPlainObject(value.slots) ? value.slots : {}
  const slotsEntries = Object.entries(slotsSource)
    .filter(([intent]) => isChatContextIntent(intent))
    .slice(-CHAT_CONTEXT_INTENT_LIMIT)
    .map(([intent, slotMap]) => {
      if (!isPlainObject(slotMap)) return [intent, {}] as const
      return [intent, Object.fromEntries(Object.entries(slotMap).slice(-CHAT_CONTEXT_SLOTS_PER_INTENT_LIMIT))] as const
    })

  return {
    version: CHAT_CONTEXT_STATE_VERSION,
    activeIntent: isChatContextIntent(value.activeIntent) ? value.activeIntent : null,
    activeDigestHandoff: normalizeDigestHandoff(value.activeDigestHandoff),
    slots: Object.fromEntries(slotsEntries) as IntentSlotsByType,
    openQuestion,
    recentTopics,
    turnCounter: typeof value.turnCounter === 'number' && Number.isFinite(value.turnCounter)
      ? Math.max(0, Math.trunc(value.turnCounter))
      : 0,
    summary: {
      text: typeof summary.text === 'string' ? summary.text : '',
      updatedAt: summary.updatedAt === null || typeof summary.updatedAt === 'string'
        ? (summary.updatedAt as string | null)
        : null,
      lastTurnNumber: typeof summary.lastTurnNumber === 'number' && Number.isFinite(summary.lastTurnNumber)
        ? Math.max(0, Math.trunc(summary.lastTurnNumber))
        : 0,
    },
    rollingSummary: {
      text: typeof rollingSummary.text === 'string' ? rollingSummary.text : '',
      updatedAt: rollingSummary.updatedAt === null || typeof rollingSummary.updatedAt === 'string'
        ? (rollingSummary.updatedAt as string | null)
        : null,
      lastIncludedMessageCount: typeof rollingSummary.lastIncludedMessageCount === 'number' && Number.isFinite(rollingSummary.lastIncludedMessageCount)
        ? Math.max(0, Math.trunc(rollingSummary.lastIncludedMessageCount))
        : 0,
    },
  }
}

function logChatContextEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log('[chat-context]', JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...fields,
  }))
}

function extractJsonEnvelopeCandidate(text: string): string | null {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null

  const fencedMatch = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i)
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed

  if (
    (candidate.startsWith('{') && candidate.endsWith('}')) ||
    (candidate.startsWith('[') && candidate.endsWith(']'))
  ) {
    return candidate
  }

  return null
}

function isStructuredJsonResponseText(text: string): boolean {
  const candidate = extractJsonEnvelopeCandidate(text)
  if (!candidate) return false

  try {
    const parsed = JSON.parse(candidate)
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

function incrementChatContextCounter(metric: string, fields: Record<string, unknown> = {}): void {
  logChatContextEvent('metric', {
    metric,
    value: 1,
    ...fields,
  })
}

type ChatContextReadResult = {
  state: ChatContextStateV1
  revision: number
  summaryUpdatedAt: string | null
  available: boolean
}

type ContextRoutePlan =
  | { kind: 'none' }
  | {
      kind: 'clarify'
      intent: ChatContextIntent
      slotName: string
      question: string
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'afford_check'
      message: string
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'vacation_plan'
      payload: { vacationName?: string; costCents?: number; targetMonth?: string }
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'savings_plan'
      payload: { targetSavingsCents?: number; targetMonth?: string }
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'emergency_fund'
      payload: { goalMonths?: number; monthlyContribution?: number | null; includeTips: boolean }
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'budget_plan'
      payload: { cycleType: 'current' | 'next' }
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'cash_flow'
      message: string
      timeframe: 'current_cycle' | 'last_cycle' | 'this_year'
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }
  | {
      kind: 'text'
      message: string
      nextState: ChatContextStateV1
      decision: FollowUpResolutionDecision
    }

const MONEY_SLOT_NAMES = new Set(['amount', 'costCents', 'targetSavingsCents', 'requiredMonthlySavingCents', 'monthlyContributionCents', 'targetAmountCents'])
const MONTH_SLOT_NAMES = new Set(['targetMonth'])
const HIGH_IMPACT_SLOT_NAMES = new Set([
  'amount',
  'costCents',
  'targetMonth',
  'targetAmountCents',
  'targetSavingsCents',
  'monthlyContributionCents',
  'goalMonths',
  'cycleType',
  'timeframe',
  'dueDate',
  'categoryCaps',
  'activeTopic',
  'acceptedPlanBranch',
  'comparisonPeriod',
  'scenarioAssumption',
  'pendingQuestion',
])
const MONTH_NAME_TO_NUMBER: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
}

function toIsoNow(): string {
  return new Date().toISOString()
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function safeErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.trim().length > 0) return error
  return fallback
}

function cloneChatContextState(state: ChatContextStateV1): ChatContextStateV1 {
  return JSON.parse(JSON.stringify(state))
}

function slotStorageKey(slotName: string, scope: SlotScope = 'committed'): string {
  return scope === 'working' ? `working__${slotName}` : slotName
}

function stripWorkingPrefix(slotName: string): string {
  return slotName.startsWith('working__') ? slotName.slice('working__'.length) : slotName
}

function getIntentSlotMap(state: ChatContextStateV1, intent: ChatContextIntent): Record<string, SlotState> {
  if (!state.slots[intent]) {
    state.slots[intent] = {}
  }
  return state.slots[intent] || {}
}

function getChatContextSlot(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  scope: SlotScope | 'any' = 'any'
): SlotState | null {
  const slots = state.slots[intent]
  if (!slots) return null
  if (scope === 'committed') return slots[slotStorageKey(slotName, 'committed')] || null
  if (scope === 'working') return slots[slotStorageKey(slotName, 'working')] || null
  return (
    slots[slotStorageKey(slotName, 'working')] ||
    slots[slotStorageKey(slotName, 'committed')] ||
    null
  )
}

function removeChatContextSlot(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  scope: SlotScope
): void {
  const slots = state.slots[intent]
  if (!slots) return
  delete slots[slotStorageKey(slotName, scope)]
}

function createChatContextSlotState(
  value: unknown,
  valueType: SlotValueType,
  sourceTurnId: string,
  sourceMessageRole: 'user' | 'assistant' | 'system',
  sourceKind: 'manual' | 'preset' | 'resolver' | 'deterministic_compute',
  options: {
    status?: SlotStatus
    scope?: SlotScope
    confidence?: number
    evidenceText?: string
    scenarioId?: string | null
    updatedAt?: string
  } = {}
): SlotState {
  return {
    value,
    valueType,
    status: options.status || 'declared',
    scope: options.scope || 'committed',
    confidence: clampConfidence(options.confidence ?? 1),
    updatedAt: options.updatedAt || toIsoNow(),
    sourceTurnId,
    sourceMessageRole,
    sourceKind,
    evidenceText: options.evidenceText,
    scenarioId: options.scenarioId ?? null,
  }
}

function setChatContextSlot(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  slotState: SlotState,
  options: { clearOtherScope?: boolean } = {}
): void {
  const slotMap = getIntentSlotMap(state, intent)
  slotMap[slotStorageKey(slotName, slotState.scope)] = slotState
  if (options.clearOtherScope) {
    const otherScope: SlotScope = slotState.scope === 'committed' ? 'working' : 'committed'
    delete slotMap[slotStorageKey(slotName, otherScope)]
  }
}

function getSlotNumberValue(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  scope: SlotScope | 'any' = 'any'
): number | null {
  const slot = getChatContextSlot(state, intent, slotName, scope)
  if (!slot) return null
  if (typeof slot.value === 'number' && Number.isFinite(slot.value)) return slot.value
  if (typeof slot.value === 'string') {
    const parsed = Number(slot.value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getSlotStringValue(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  scope: SlotScope | 'any' = 'any'
): string | null {
  const slot = getChatContextSlot(state, intent, slotName, scope)
  if (!slot) return null
  return typeof slot.value === 'string' && slot.value.trim().length > 0 ? slot.value.trim() : null
}

function bumpChatContextRecentTopic(state: ChatContextStateV1, intent: ChatContextIntent, updatedAt = toIsoNow()): void {
  state.recentTopics = [
    { intent, updatedAt },
    ...state.recentTopics.filter((topic) => topic.intent !== intent),
  ].slice(0, CHAT_CONTEXT_RECENT_TOPICS_LIMIT)
}

function setChatContextOpenQuestion(
  state: ChatContextStateV1,
  intent: ChatContextIntent,
  slotName: string,
  prompt: string,
  askedAt = toIsoNow()
): void {
  state.openQuestion = {
    intent,
    slotName,
    askedAt,
    prompt,
  }
}

function clearChatContextOpenQuestion(state: ChatContextStateV1, intent?: ChatContextIntent, slotName?: string): void {
  if (!state.openQuestion) return
  if (intent && state.openQuestion.intent !== intent) return
  if (slotName && state.openQuestion.slotName !== slotName) return
  state.openQuestion = null
}

function isHighImpactSlot(slotName: string): boolean {
  return HIGH_IMPACT_SLOT_NAMES.has(stripWorkingPrefix(slotName))
}

function getSummarySlotValue(state: ChatContextStateV1, intent: ChatContextIntent, slotName: string): string | null {
  const slot = getChatContextSlot(state, intent, slotName)
  if (!slot) return null
  if (typeof slot.value === 'number' && Number.isFinite(slot.value)) {
    return String(slot.value)
  }
  if (typeof slot.value === 'string' && slot.value.trim().length > 0) {
    return slot.value.trim()
  }
  return null
}

function isGeneralChatSummaryText(summaryText: string): boolean {
  return /^general chat(?:\s*\|| continuity)?/i.test(String(summaryText || '').trim())
}

function buildGeneralChatContextSummary(state: ChatContextStateV1): string {
  if (!AI_CHAT_GENERAL_CHAT_FACTS_ENABLED) return ''

  const topic = getSummarySlotValue(state, 'general_chat', 'activeTopic')
  const acceptedPlanBranch = getSummarySlotValue(state, 'general_chat', 'acceptedPlanBranch')
  const targetAmount = getSummarySlotValue(state, 'general_chat', 'targetAmountCents')
  const targetMonth = getSummarySlotValue(state, 'general_chat', 'targetMonth')
  const comparisonPeriod = getSummarySlotValue(state, 'general_chat', 'comparisonPeriod')
  const pendingQuestion = getSummarySlotValue(state, 'general_chat', 'pendingQuestion')
  const scenarioAssumption = getSummarySlotValue(state, 'general_chat', 'scenarioAssumption')

  const detailParts = [
    topic ? `topic=${topic}` : null,
    acceptedPlanBranch ? `branch=${compactPromptExcerpt(acceptedPlanBranch, 90)}` : null,
    targetAmount ? `target=${targetAmount}` : null,
    targetMonth ? `month=${targetMonth}` : null,
    comparisonPeriod ? `period=${comparisonPeriod}` : null,
    scenarioAssumption ? `assumption=${compactPromptExcerpt(scenarioAssumption, 90)}` : null,
    pendingQuestion ? `pending=${compactPromptExcerpt(pendingQuestion, 90)}` : null,
  ]
    .filter(Boolean)

  if (detailParts.length === 0) return ''

  return ['General chat', ...detailParts]
    .join(' | ')
    .slice(0, 300)
}

function buildDeterministicContextSummary(state: ChatContextStateV1): string {
  if (state.activeDigestHandoff) {
    return buildDigestContextSummary(state.activeDigestHandoff)
  }

  const intent = state.activeIntent
  const generalChatSummary = buildGeneralChatContextSummary(state)
  if (!intent) return generalChatSummary

  if (intent === 'afford_check') {
    const itemName = getSummarySlotValue(state, intent, 'itemName')
    const amount = getSummarySlotValue(state, intent, 'amount')
    return [`Afford check`, itemName ? `item=${itemName}` : null, amount ? `amount=${amount}` : null]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300)
  }

  if (intent === 'save_more_plan') {
    const target = getSummarySlotValue(state, intent, 'targetSavingsCents')
    const month = getSummarySlotValue(state, intent, 'targetMonth')
    const working = getSummarySlotValue(state, intent, 'targetSavingsCents') && getChatContextSlot(state, intent, 'targetSavingsCents', 'working')
      ? `working=${getSummarySlotValue(state, intent, 'targetSavingsCents')}`
      : null
    return [`Savings plan`, target ? `target=${target}` : null, month ? `month=${month}` : null, working].filter(Boolean).join(' | ').slice(0, 300)
  }

  if (intent === 'vacation_affordability') {
    const name = getSummarySlotValue(state, intent, 'vacationName')
    const cost = getSummarySlotValue(state, intent, 'costCents')
    const month = getSummarySlotValue(state, intent, 'targetMonth')
    return [`Vacation plan`, name ? `name=${name}` : null, cost ? `cost=${cost}` : null, month ? `month=${month}` : null]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300)
  }

  if (intent === 'emergency_fund') {
    const goalMonths = getSummarySlotValue(state, intent, 'goalMonths')
    const monthlyContribution = getSummarySlotValue(state, intent, 'monthlyContributionCents')
    return [`Emergency fund`, goalMonths ? `goal=${goalMonths} months` : null, monthlyContribution ? `monthly=${monthlyContribution}` : null]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300)
  }

  if (intent === 'budget_intel') {
    const cycleType = getSummarySlotValue(state, intent, 'cycleType')
    return [`Budget helper`, cycleType ? `cycle=${cycleType}` : null]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300)
  }

  if (intent === 'cash_flow') {
    const timeframe = getSummarySlotValue(state, intent, 'timeframe')
    return [`Cash flow`, timeframe ? `timeframe=${timeframe}` : null]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300)
  }

  if (intent === 'general_chat') {
    return generalChatSummary || 'General chat continuity'
  }

  return String(intent)
}

function maybeRefreshContextSummary(
  previousState: ChatContextStateV1,
  nextState: ChatContextStateV1,
  summaryUpdatedAt: string | null,
  nowIso = toIsoNow()
): { state: ChatContextStateV1; summaryUpdatedAt: string | null } {
  const next = cloneChatContextState(nextState)
  const lastUpdatedAt = summaryUpdatedAt ? new Date(summaryUpdatedAt).getTime() : 0
  const elapsedMs = lastUpdatedAt > 0 ? Date.now() - lastUpdatedAt : Number.POSITIVE_INFINITY

  const intentChanged = previousState.activeIntent !== next.activeIntent
  const digestChanged = buildDigestContextSummary(previousState.activeDigestHandoff) !== buildDigestContextSummary(next.activeDigestHandoff)
  const shouldRefreshByTurn = next.turnCounter > 0 && next.turnCounter % 4 === 0
  const previousHighImpact = JSON.stringify(
    Object.entries(previousState.slots).flatMap(([intent, slotMap]) =>
      Object.entries(slotMap || {})
        .filter(([slotName]) => isHighImpactSlot(slotName))
        .map(([slotName, slot]) => `${intent}:${slotName}:${JSON.stringify(slot.value)}`)
    )
  )
  const nextHighImpact = JSON.stringify(
    Object.entries(next.slots).flatMap(([intent, slotMap]) =>
      Object.entries(slotMap || {})
        .filter(([slotName]) => isHighImpactSlot(slotName))
        .map(([slotName, slot]) => `${intent}:${slotName}:${JSON.stringify(slot.value)}`)
    )
  )
  const highImpactChanged = previousHighImpact !== nextHighImpact
  const shouldRefresh = elapsedMs >= 90_000 && (intentChanged || digestChanged || highImpactChanged || shouldRefreshByTurn)

  if (!shouldRefresh) {
    return { state: next, summaryUpdatedAt }
  }

  next.summary = {
    text: buildDeterministicContextSummary(next),
    updatedAt: nowIso,
    lastTurnNumber: next.turnCounter,
  }
  return { state: next, summaryUpdatedAt: nowIso }
}

function pruneChatContextState(state: ChatContextStateV1): ChatContextStateV1 {
  const next = cloneChatContextState(state)
  next.recentTopics = next.recentTopics.slice(0, CHAT_CONTEXT_RECENT_TOPICS_LIMIT)
  next.activeDigestHandoff = normalizeDigestHandoff(next.activeDigestHandoff)

  const slotEntries = Object.entries(next.slots)
    .slice(0, CHAT_CONTEXT_INTENT_LIMIT)
    .map(([intent, slotMap]) => {
      const limitedEntries = Object.entries(slotMap || {})
        .sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, CHAT_CONTEXT_SLOTS_PER_INTENT_LIMIT)
      return [intent, Object.fromEntries(limitedEntries)] as const
    })

  next.slots = Object.fromEntries(slotEntries) as IntentSlotsByType
  return next
}

function formatResolvedFactValue(slotName: string, slot: SlotState, currencyCode: string): string {
  const normalizedSlotName = stripWorkingPrefix(slotName)

  if (MONTH_SLOT_NAMES.has(normalizedSlotName)) {
    return String(slot.value)
  }

  if (normalizedSlotName === 'goalMonths') {
    const months = typeof slot.value === 'number' ? slot.value : Number(slot.value)
    return Number.isFinite(months) ? `${Math.max(1, Math.round(months))} months` : String(slot.value)
  }

  if (normalizedSlotName === 'cycleType') {
    const cycleType = normalizeBudgetCycleType(slot.value)
    return cycleType === 'next' ? 'next cycle / next month' : cycleType === 'current' ? 'rest of current cycle / this month' : String(slot.value)
  }

  if (normalizedSlotName === 'timeframe') {
    const timeframe = normalizeCashFlowTimeframe(slot.value)
    return timeframe === 'last_cycle'
      ? 'last cycle / last month'
      : timeframe === 'this_year'
        ? 'this year'
        : timeframe === 'current_cycle'
          ? 'current cycle / this month'
          : String(slot.value)
  }

  if (normalizedSlotName === 'comparisonPeriod') {
    const timeframe = normalizeCashFlowTimeframe(slot.value)
    if (timeframe === 'last_cycle') return 'last cycle / last month'
    if (timeframe === 'this_year') return 'this year'
    if (timeframe === 'current_cycle') return 'current cycle / this month'
    const cycleType = normalizeBudgetCycleType(slot.value)
    if (cycleType === 'next') return 'next cycle / next month'
    if (cycleType === 'current') return 'current cycle / this month'
    return String(slot.value)
  }

  if (MONEY_SLOT_NAMES.has(normalizedSlotName)) {
    const rawNumber = typeof slot.value === 'number' ? slot.value : Number(slot.value)
    if (!Number.isFinite(rawNumber)) return String(slot.value)
    const amount = rawNumber / 100
    const monthlySuffix =
      normalizedSlotName === 'targetSavingsCents' ||
      normalizedSlotName === 'requiredMonthlySavingCents' ||
      normalizedSlotName === 'monthlyContributionCents'
        ? '/month'
        : ''
    return `${amount.toFixed(2)} ${currencyCode}${monthlySuffix}`
  }

  return typeof slot.value === 'string' ? slot.value : JSON.stringify(slot.value)
}

function collectResolvedConversationFacts(state: ChatContextStateV1 | null | undefined): ResolvedFact[] {
  if (!state) return []

  const facts: Array<{ fact: ResolvedFact; updatedAt: string }> = []
  for (const [intentKey, slotMap] of Object.entries(state.slots || {})) {
    if (!isChatContextIntent(intentKey) || !slotMap || !isPlainObject(slotMap)) continue
    if (intentKey === 'general_chat' && !AI_CHAT_GENERAL_CHAT_FACTS_ENABLED) continue
    for (const [slotName, slotValue] of Object.entries(slotMap)) {
      if (!isPlainObject(slotValue)) continue
      const slot = slotValue as SlotState
      facts.push({
        fact: {
          intent: intentKey,
          slotName: stripWorkingPrefix(slotName),
          value: slot.value,
          sourceScope: 'session',
          status: slot.status,
          scope: slot.scope,
          confidence: clampConfidence(slot.confidence ?? 1),
        },
        updatedAt: typeof slot.updatedAt === 'string' ? slot.updatedAt : '',
      })
    }
  }

  return facts
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 12)
    .map((entry) => entry.fact)
}

function collectResolvedMemoryFacts(memoryFacts: ChatMemoryFact[] | null | undefined): ResolvedFact[] {
  if (!Array.isArray(memoryFacts) || memoryFacts.length === 0) return []

  const collected: Array<{ fact: ResolvedFact; updatedAt: string }> = []
  for (const fact of memoryFacts) {
    if (!isChatContextIntent(fact.intent)) continue
    const slotName = String(fact.slotName || '').trim()
    if (!slotName) continue
    collected.push({
      fact: {
        intent: fact.intent,
        slotName,
        value: fact.value,
        sourceScope: 'memory',
        status: (typeof fact.status === 'string' && fact.status.trim().length > 0 ? fact.status : 'inferred') as SlotStatus,
        scope: (typeof fact.scope === 'string' && fact.scope === 'working' ? 'working' : 'committed') as SlotScope,
        confidence: clampConfidence(typeof fact.confidence === 'number' ? fact.confidence : 0.72),
      },
      updatedAt: typeof fact.updatedAt === 'string' ? fact.updatedAt : '',
    })
  }

  return collected
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 12)
    .map((entry) => entry.fact)
}

function buildResolvedConversationFactsBlock(
  state: ChatContextStateV1 | null | undefined,
  currencyCode: string,
  memoryFacts: ChatMemoryFact[] | null | undefined = [],
): string {
  if (!state && (!memoryFacts || memoryFacts.length === 0)) return '(No resolved conversation facts)'

  const lines: string[] = []
  if (state?.activeIntent && !(state.activeIntent === 'general_chat' && !AI_CHAT_GENERAL_CHAT_FACTS_ENABLED)) {
    lines.push(`- active_intent: ${state.activeIntent}`)
  }
  if (state?.summary?.text && !( !AI_CHAT_GENERAL_CHAT_FACTS_ENABLED && isGeneralChatSummaryText(state.summary.text) )) {
    lines.push(`- deterministic_summary: ${state.summary.text}`)
  }
  if (state?.openQuestion?.intent) {
    lines.push(
      `- open_question: ${state.openQuestion.intent}.${state.openQuestion.slotName || 'unknown'} -> ${state.openQuestion.prompt}`
    )
  }

  for (const fact of collectResolvedConversationFacts(state)) {
    const slot = state ? getChatContextSlot(state, fact.intent, fact.slotName, fact.scope) : null
    if (!slot) continue
    lines.push(
      `- [${fact.sourceScope}][${fact.intent}][${fact.scope}][${fact.status}][confidence=${fact.confidence.toFixed(2)}] ${fact.slotName} = ${formatResolvedFactValue(fact.slotName, slot, currencyCode)}`
    )
  }

  for (const fact of collectResolvedMemoryFacts(memoryFacts)) {
    const syntheticSlot: SlotState = {
      value: fact.value,
      valueType: MONEY_SLOT_NAMES.has(fact.slotName) ? 'money' : MONTH_SLOT_NAMES.has(fact.slotName) ? 'month' : 'text',
      status: fact.status,
      scope: fact.scope,
      confidence: fact.confidence,
      updatedAt: new Date().toISOString(),
      sourceTurnId: 'memory',
      sourceMessageRole: 'system',
      sourceKind: 'preset',
      evidenceText: 'cross_session_memory',
      scenarioId: null,
    }
    lines.push(
      `- [${fact.sourceScope}][${fact.intent}][${fact.scope}][${fact.status}][confidence=${fact.confidence.toFixed(2)}] ${fact.slotName} = ${formatResolvedFactValue(fact.slotName, syntheticSlot, currencyCode)}`
    )
  }

  return lines.length > 0 ? lines.join('\n') : '(No resolved conversation facts)'
}

function buildConversationGroundingPromptBlock(params: {
  chatContextState: ChatContextStateV1 | null | undefined
  currencyCode: string
  chatHistory: string
  relevantMemories: string
  relevantMemoryFacts?: ChatMemoryFact[] | null | undefined
  includeRecentTranscript?: boolean
}): string {
  const resolvedFacts = buildResolvedConversationFactsBlock(params.chatContextState, params.currencyCode, params.relevantMemoryFacts)
  const chatHistory = params.chatHistory || '(No previous conversation)'
  const relevantMemories = params.relevantMemories || '(No relevant past conversations found)'
  const rollingSummaryText = String(params.chatContextState?.rollingSummary?.text || '').trim()
  const rollingSummaryBlock = rollingSummaryText
    ? `

OLDER SESSION SUMMARY (older turns no longer shown verbatim below; continuity only, not authoritative for new financial totals unless also grounded below):
${rollingSummaryText}`
    : ''
  const transcriptBlock = params.includeRecentTranscript === false
    ? ''
    : `

RECENT CONVERSATION TURNS (authoritative for continuity, shorthand resolution, and branch continuation; not authoritative for new financial totals unless also grounded below):
${chatHistory}`

  return `GROUNDING POLICY
- Live financial profile, analytics, obligations, budgets, and canonical app data below are the authoritative source for balances, debts, spending totals, subscriptions, bills, and other current financial facts.
- RESOLVED CONVERSATION FACTS may be used for user-declared planning inputs, accepted assumptions, requested scenarios, working targets, requested overrides, and active follow-up continuity.
- Recent conversation turns are authoritative for conversational intent and branch continuation. You must use them to resolve shorthand such as "it", "that", "those", "the plan", "the amount", "the cut", or "the verdict".
- Do not invent new financial totals from transcript text alone when those totals are not present in live profile data or RESOLVED CONVERSATION FACTS.
- If the user is clearly following up on Wisey's previous reply, continue that exact branch unless a required numeric fact is genuinely missing.
- If a needed number is missing from both live financial data and RESOLVED CONVERSATION FACTS, say you cannot confirm it yet and ask exactly 1 clarifying question.

RESOLVED CONVERSATION FACTS:
${resolvedFacts}${rollingSummaryBlock}${transcriptBlock}

CROSS-SESSION MEMORY SUMMARIES (secondary continuity background only; not authoritative for new financial totals unless confirmed elsewhere):
${relevantMemories}`
}

function isAffirmativeFollowUpReply(message: string): boolean {
  return /^(yes|yes please|yeah|yep|sure|sure please|please do|do it|okay|ok|sounds good|go ahead)\b[!.?]*$/i
    .test(String(message || '').trim())
}

function isAssistantOfferOrQuestion(message: string): boolean {
  const normalized = String(message || '').trim().toLowerCase()
  if (!normalized) return false

  return (
    /\bwould you like\b/.test(normalized) ||
    /\bdo you want\b/.test(normalized) ||
    /\bshould i\b/.test(normalized) ||
    /\bshall i\b/.test(normalized) ||
    /\bwant me to\b/.test(normalized) ||
    /\bwould it help if\b/.test(normalized) ||
    /\bcan help you\b/.test(normalized) ||
    /\bwould you like me to\b/.test(normalized)
  )
}

function compactPromptExcerpt(message: string, maxLength = 280): string {
  const compacted = String(message || '').replace(/\s+/g, ' ').trim()
  if (compacted.length <= maxLength) return compacted
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`
}

function buildConversationContinuityPromptBlock(
  chatHistory: string,
  currentUserMessage: string,
  lastAssistantMessage: string | null | undefined
): string {
  const hasPriorConversation = Boolean(String(chatHistory || '').trim())
  const affirmativeContinuation =
    isAffirmativeFollowUpReply(currentUserMessage) &&
    isAssistantOfferOrQuestion(lastAssistantMessage || '')
  const affirmativeContinuationBlock = affirmativeContinuation
    ? `
- The latest user message is an affirmative answer to Wisey's immediately previous offer/question.
- Previous Wisey offer/question: "${compactPromptExcerpt(lastAssistantMessage || '')}"
- Continue that exact branch now. Do not thank the user, do not ask whether they want it again, and do not switch to a fresh broad question unless a genuinely required input is still missing.
- If the previous offer was to explore, build, review, or set up a plan and the live profile already contains the needed data, provide the first concrete version of that plan now.`
    : ''

  return `CONVERSATION CONTINUITY POLICY
- Treat the recent transcript as shared live context, not background decoration.
- If the user refers to "it", "that", "those", "the amount", "the plan", or similar shorthand, resolve it against the latest compatible turn before asking anything.
- If the answer is already available from the live profile, resolved facts, or recent transcript, answer directly instead of asking the user to repeat themselves.
- Do not add a greeting, re-introduction, or the user's name unless the user is greeting you right now.
- Do not ask a closing question by habit. Ask exactly 1 question only when the answer is genuinely blocked by missing information or the user explicitly asks to explore options.
- Prefer continuing the current thread over restarting with a broad generic answer.
- Ongoing conversation already exists in this session: ${hasPriorConversation ? 'yes' : 'no'}.${affirmativeContinuationBlock}`
}

type MoneyMention = {
  amountCents: number
  isMonthly: boolean
  index: number
}

function extractMoneyMentions(message: string): MoneyMention[] {
  const normalized = String(message || '').replace(/\b20\d{2}[-/](0[1-9]|1[0-2])\b/g, ' ')
  const mentions: MoneyMention[] = []
  const regex = /\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:\$|usd|dollars?)?/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(normalized)) !== null) {
    const rawNumber = Number(match[1])
    if (!Number.isFinite(rawNumber) || rawNumber <= 0) continue

    const contextStart = Math.max(0, match.index - 16)
    const contextEnd = Math.min(normalized.length, regex.lastIndex + 24)
    const context = normalized.slice(contextStart, contextEnd).toLowerCase()
    const isMonthly = /\/mo|per month|monthly|a month/.test(context)

    mentions.push({
      amountCents: Math.round(rawNumber * 100),
      isMonthly,
      index: match.index,
    })
  }

  return mentions
}

function extractPrimaryMonthlyAmountCents(message: string): number | null {
  return extractMoneyMentions(message).find((mention) => mention.isMonthly)?.amountCents ?? null
}

function extractPrimaryNonMonthlyAmountCents(message: string): number | null {
  return extractMoneyMentions(message).find((mention) => !mention.isMonthly)?.amountCents ?? null
}

function countCompetingMoneyMentions(message: string): number {
  return extractMoneyMentions(message).length
}

function containsOverrideCue(message: string): boolean {
  return /\b(instead|actually|change|make it|use|replace)\b/i.test(message)
}

function containsWhatIfCue(message: string): boolean {
  return /\b(what if|if i|scenario)\b/i.test(message)
}

function containsContinuityCue(message: string): boolean {
  return /\b(same plan|that plan|this plan|same one|that one|this one|same goal|that goal|this goal|continue|keep it|keep the|update it|update that|what about|how about|and if|in that case|for that|for this|now)\b/i.test(message)
}

function containsObligationReference(message: string): boolean {
  return /\b(obligation|obligations|bill|bills|planned payment|planned payments|subscription|subscriptions|fixed payment|fixed payments)\b/i.test(message)
}

function detectExplicitSavingsPlanIntent(message: string): boolean {
  const lower = String(message || '').toLowerCase()
  const savingsGoalCelebrationOrSetback =
    /\b(hit|reached|met|achieved|completed|missed|blew past|fell short of)\s+my\s+savings goal\b/.test(lower) ||
    /\bmy\s+savings goal\b.*\b(hit|reached|met|achieved|completed|missed)\b/.test(lower)
  if (savingsGoalCelebrationOrSetback) return false

  const explicitSavingsGoalBuildIntent =
    /\b(create|build|set|start|make|plan|help me build|help me create|help me set)\s+(?:a\s+)?savings goal\b/.test(lower) ||
    /\bsavings goal\b.*\b(create|build|set|target|plan)\b/.test(lower) ||
    /\bcreate\b.*\bsaving goal\b/.test(lower) ||
    /\bsaving goal\b.*\bcreate\b/.test(lower)

  return (
    /\bsavings plan\b/.test(lower) ||
    explicitSavingsGoalBuildIntent ||
    /\bmonthly savings?\b/.test(lower) ||
    /\bhow much should i save\b/.test(lower) ||
    /\bsave\s+\$?\d/.test(lower) ||
    /\btarget savings\b/.test(lower) ||
    /\bsavings target\b/.test(lower)
  )
}

function isShortReply(message: string): boolean {
  return String(message || '').trim().split(/\s+/).filter(Boolean).length <= 6
}

function extractTargetMonthFromMessage(message: string, now = new Date()): string | null {
  const trimmed = String(message || '').trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()

  if (/\bthis month\b/.test(lower)) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  if (/\bnext month\b/.test(lower)) {
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    return `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`
  }

  const isoMatch = trimmed.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/)
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}`
  }

  const monthMatch = lower.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/
  )
  if (!monthMatch) return null

  const month = MONTH_NAME_TO_NUMBER[monthMatch[1]]
  if (!month) return null

  const explicitYear = monthMatch[2] ? Number(monthMatch[2]) : null
  const year = explicitYear ?? (() => {
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const targetMonth = Number(month)
    return targetMonth > currentMonth ? currentYear : currentYear + 1
  })()

  return `${year}-${month}`
}

function extractVacationNameFromMessage(message: string): string | null {
  const trimmed = String(message || '').trim()
  if (!trimmed) return null

  const destinationMatch = trimmed.match(/\b(?:vacation|trip|travel|getaway)\s+to\s+([a-zA-Z][a-zA-Z\s'-]{1,40})/i)
  if (destinationMatch && destinationMatch[1]) {
    return destinationMatch[1].trim()
  }

  if (/\b(vacation|trip|travel|getaway|holiday)\b/i.test(trimmed)) {
    return 'Vacation'
  }

  return null
}

function extractAffordItemNameFromMessage(message: string): string | null {
  const trimmed = String(message || '').trim()
  if (!trimmed) return null

  const patterns = [
    /can\s+(?:i\s+)?afford\s+(?:to\s+(?:buy|get|purchase)\s+)?(.+?)(?:\s+for\b|\?|$)/i,
    /can\s+(?:i\s+)?buy\s+(.+?)(?:\s+for\b|\?|$)/i,
    /should\s+i\s+buy\s+(.+?)(?:\s+for\b|\?|$)/i,
    /do\s+i\s+have\s+enough\s+for\s+(.+?)(?:\?|$)/i,
  ]

  for (const pattern of patterns) {
    const match = trimmed.match(pattern)
    const value = match?.[1]?.trim()
    if (value && !/^\$?\d/.test(value)) {
      return value.replace(/^(a|an|the)\s+/i, '').trim()
    }
  }

  return null
}

function inferOpenQuestionSlotName(intent: ChatContextIntent, question: string): string {
  const lower = question.toLowerCase()
  if (intent === 'afford_check') return 'amount'
  if (intent === 'save_more_plan') {
    if (lower.includes('month')) return 'targetMonth'
    return 'targetSavingsCents'
  }
  if (intent === 'vacation_affordability') {
    if (lower.includes('name')) return 'vacationName'
    if (lower.includes('cost')) return 'costCents'
    if (lower.includes('when')) return 'targetMonth'
  }
  return 'amount'
}

function buildResolverDecision(
  kind: FollowUpResolutionDecision['kind'],
  confidence: number,
  reason: string,
  usedOpenQuestion: boolean,
  usedCrossChatMemory = false
): FollowUpResolutionDecision {
  return {
    kind,
    confidence: clampConfidence(confidence),
    reason,
    usedOpenQuestion,
    usedCrossChatMemory,
  }
}

function hydrateStateFromCrossSessionMemory(
  state: ChatContextStateV1,
  memoryFacts: ChatMemoryFact[] | null | undefined,
  turnId: string,
): ChatContextStateV1 {
  if (!Array.isArray(memoryFacts) || memoryFacts.length === 0) return state

  const nextState = cloneChatContextState(state)
  const usableFacts = normalizeChatMemoryFacts(memoryFacts)
    .filter((fact) => isChatContextIntent(fact.intent) && String(fact.slotName || '').trim().length > 0)

  if (usableFacts.length === 0) return nextState

  for (const fact of usableFacts) {
    const intent = fact.intent as ChatContextIntent
    const slotName = String(fact.slotName || '').trim()
    if (getChatContextSlot(nextState, intent, slotName, 'any')) continue

    const valueType: SlotValueType =
      MONEY_SLOT_NAMES.has(slotName) ? 'money'
        : MONTH_SLOT_NAMES.has(slotName) ? 'month'
          : slotName === 'goalMonths' ? 'integer'
            : slotName === 'includeTips' ? 'boolean'
              : 'text'

    setChatContextSlot(
      nextState,
      intent,
      slotName,
      createChatContextSlotState(
        fact.value,
        valueType,
        turnId,
        'system',
        'preset',
        {
          status: (typeof fact.status === 'string' && fact.status.trim().length > 0 ? fact.status : 'inferred') as SlotStatus,
          scope: (typeof fact.scope === 'string' && fact.scope === 'working' ? 'working' : 'committed') as SlotScope,
          confidence: typeof fact.confidence === 'number' ? fact.confidence : 0.72,
          evidenceText: 'cross_session_memory',
          updatedAt: typeof fact.updatedAt === 'string' && fact.updatedAt.trim().length > 0 ? fact.updatedAt : toIsoNow(),
        }
      ),
    )

    bumpChatContextRecentTopic(nextState, intent, typeof fact.updatedAt === 'string' ? fact.updatedAt : toIsoNow())
  }

  if (!nextState.activeIntent) {
    const primaryIntent = usableFacts[0]?.intent
    if (primaryIntent && isChatContextIntent(primaryIntent)) {
      nextState.activeIntent = primaryIntent
    }
  }

  if (!nextState.summary?.text) {
    nextState.summary = {
      text: buildDeterministicContextSummary(nextState),
      updatedAt: toIsoNow(),
      lastTurnNumber: nextState.turnCounter,
    }
  }

  return nextState
}

function resolveContextRoute(message: string, state: ChatContextStateV1, turnId: string, currencyCode = 'USD'): ContextRoutePlan {
  const trimmed = String(message || '').trim()
  if (!trimmed || trimmed.startsWith('{')) return { kind: 'none' }

  const routeCurrencyCode = normalizeCurrencyCode(currencyCode)
  const lower = trimmed.toLowerCase()
  const explicitAfford = detectAffordCheckIntent(trimmed).detected
  const explicitVacation = /\b(vacation|trip|travel|getaway|holiday)\b/i.test(trimmed)
  const explicitSavings = detectExplicitSavingsPlanIntent(trimmed)
  const referencesObligations = containsObligationReference(trimmed)
  const activeIntent = state.activeIntent
  const openQuestion = state.openQuestion
  const parsedMonthlyAmount = extractPrimaryMonthlyAmountCents(trimmed)
  const parsedNonMonthlyAmount = extractPrimaryNonMonthlyAmountCents(trimmed)
  const parsedTargetMonth = extractTargetMonthFromMessage(trimmed)
  const parsedGoalMonths = extractGoalMonthsFromMessage(trimmed)
  const parsedBudgetCycleType = extractBudgetCycleTypeFromMessage(trimmed)
  const parsedCashFlowTimeframe = extractCashFlowTimeframeHint(trimmed)
  const parsedEmergencyContribution = detectWhatIfProjection(trimmed)
  const emergencyTipsRequest = isEmergencyFundTipsRequest(trimmed)
  const continuityCue = containsContinuityCue(trimmed)
  const overrideCue = containsOverrideCue(trimmed)
  const whatIfCue = containsWhatIfCue(trimmed)
  const competingValues = countCompetingMoneyMentions(trimmed) > 1
  const hasVacationPlanAnchor =
    activeIntent === 'vacation_affordability' ||
    openQuestion?.intent === 'vacation_affordability' ||
    getSlotNumberValue(state, 'vacation_affordability', 'costCents') != null ||
    getSlotStringValue(state, 'vacation_affordability', 'targetMonth') != null
  const looksLikeVacationMonthlyFollowUp =
    hasVacationPlanAnchor &&
    parsedMonthlyAmount != null &&
    (whatIfCue || continuityCue || isShortReply(trimmed)) &&
    !explicitVacation

  const candidateIntent: ChatContextIntent | null = (() => {
    if (looksLikeVacationMonthlyFollowUp) return 'vacation_affordability'
    if (explicitAfford) return 'afford_check'
    if (explicitVacation) return 'vacation_affordability'
    if (explicitSavings) return 'save_more_plan'
    if (
      openQuestion?.intent &&
      (
        parsedMonthlyAmount != null ||
        parsedNonMonthlyAmount != null ||
        parsedTargetMonth != null ||
        parsedGoalMonths != null ||
        parsedBudgetCycleType != null ||
        parsedCashFlowTimeframe != null ||
        parsedEmergencyContribution != null ||
        emergencyTipsRequest ||
        isShortReply(trimmed)
      )
    ) {
      if (openQuestion.intent === 'save_more_plan' && referencesObligations && !explicitSavings) {
        return null
      }
      if (openQuestion.intent === 'vacation_affordability' && explicitSavings && !explicitVacation) {
        return 'save_more_plan'
      }
      return openQuestion.intent
    }
    if (activeIntent && ['afford_check', 'vacation_affordability', 'save_more_plan'].includes(activeIntent) && (continuityCue || isShortReply(trimmed))) {
      return activeIntent
    }
    if (activeIntent === 'emergency_fund' && (continuityCue || isShortReply(trimmed) || parsedGoalMonths != null || parsedEmergencyContribution != null || emergencyTipsRequest)) {
      return activeIntent
    }
    if (activeIntent === 'budget_intel' && (continuityCue || isShortReply(trimmed) || parsedBudgetCycleType != null)) {
      return activeIntent
    }
    if (activeIntent === 'cash_flow' && (continuityCue || isShortReply(trimmed) || parsedCashFlowTimeframe != null)) {
      return activeIntent
    }
    return null
  })()

  if (!candidateIntent) return { kind: 'none' }

  const crossIntentCollision =
    Number(explicitAfford) + Number(explicitVacation) + Number(explicitSavings && parsedMonthlyAmount != null) > 1
  const vacationHasExecutablePayload = explicitVacation && (parsedNonMonthlyAmount != null || parsedTargetMonth != null)

  let score = 0
  if (openQuestion?.intent === candidateIntent && (
    (openQuestion.slotName === 'targetMonth' && parsedTargetMonth) ||
    (openQuestion.slotName !== 'targetMonth' && (parsedMonthlyAmount != null || parsedNonMonthlyAmount != null || isShortReply(trimmed)))
  )) {
    score += 0.45
  }
  if (continuityCue || overrideCue || whatIfCue || candidateIntent === activeIntent || explicitAfford || explicitVacation || explicitSavings) {
    score += 0.25
  }
  if (
    parsedMonthlyAmount != null ||
    parsedNonMonthlyAmount != null ||
    parsedTargetMonth != null ||
    parsedGoalMonths != null ||
    parsedBudgetCycleType != null ||
    parsedCashFlowTimeframe != null ||
    parsedEmergencyContribution != null ||
    emergencyTipsRequest ||
    explicitAfford ||
    explicitVacation
  ) {
    score += 0.20
  }
  if (candidateIntent === activeIntent) {
    score += 0.10
  }
  if (crossIntentCollision && !vacationHasExecutablePayload) score -= 0.35
  if (competingValues && !vacationHasExecutablePayload) score -= 0.25
  if (candidateIntent === 'vacation_affordability' && parsedMonthlyAmount != null && parsedNonMonthlyAmount == null && parsedTargetMonth == null) {
    score -= 0.35
  }

  score = clampConfidence(score)

  if (candidateIntent === 'afford_check') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'afford_check'
    bumpChatContextRecentTopic(nextState, 'afford_check')
    const hasAffordSessionAnchor =
      openQuestion?.intent === 'afford_check' ||
      activeIntent === 'afford_check' ||
      state.recentTopics.some((topic) => topic.intent === 'afford_check') ||
      getSlotStringValue(state, 'afford_check', 'itemName') != null ||
      getSlotNumberValue(state, 'afford_check', 'amount') != null

    const itemName = extractAffordItemNameFromMessage(trimmed) || getSlotStringValue(state, 'afford_check', 'itemName')
    const amountCents = parsedNonMonthlyAmount ?? getSlotNumberValue(state, 'afford_check', 'amount')

    if (itemName) {
      setChatContextSlot(nextState, 'afford_check', 'itemName', createChatContextSlotState(
        itemName,
        'text',
        turnId,
        'user',
        'resolver',
        { status: 'declared', scope: 'committed', confidence: itemName === 'Vacation' ? 0.65 : 0.95 }
      ))
    }

    if (amountCents != null) {
      setChatContextSlot(nextState, 'afford_check', 'amount', createChatContextSlotState(
        amountCents,
        'money',
        turnId,
        'user',
        'resolver',
        { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
      ), { clearOtherScope: true })
      clearChatContextOpenQuestion(nextState, 'afford_check')
    }

    if (score < 0.55 && hasAffordSessionAnchor && !explicitAfford) {
      setChatContextOpenQuestion(nextState, 'afford_check', 'amount', 'Is that for this affordability check?')
      return {
        kind: 'clarify',
        intent: 'afford_check',
        slotName: 'amount',
        question: 'Is that for this affordability check?',
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_afford_followup', openQuestion?.intent === 'afford_check'),
      }
    }

    const syntheticMessage = explicitAfford
      ? trimmed
      : (amountCents != null
        ? `Can I afford ${itemName || 'it'} for ${(amountCents / 100).toFixed(2).replace(/\.00$/, '')} ${routeCurrencyCode}?`
        : trimmed)

    return {
      kind: 'afford_check',
      message: syntheticMessage,
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'afford_followup_resolved', openQuestion?.intent === 'afford_check'),
    }
  }

  if (candidateIntent === 'save_more_plan') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'save_more_plan'
    bumpChatContextRecentTopic(nextState, 'save_more_plan')

    const amountCents = parsedMonthlyAmount ?? parsedNonMonthlyAmount ?? getSlotNumberValue(state, 'save_more_plan', 'targetSavingsCents')
    const targetMonth = parsedTargetMonth ?? getSlotStringValue(state, 'save_more_plan', 'targetMonth')
    const scope: SlotScope = whatIfCue ? 'working' : 'committed'

    if (amountCents != null) {
      setChatContextSlot(nextState, 'save_more_plan', 'targetSavingsCents', createChatContextSlotState(
        amountCents,
        'money',
        turnId,
        'user',
        'resolver',
        {
          status: whatIfCue ? 'hypothetical' : 'declared',
          scope,
          confidence: 0.95,
          evidenceText: trimmed,
        }
      ), { clearOtherScope: overrideCue || scope === 'committed' })
      if (scope === 'committed') clearChatContextOpenQuestion(nextState, 'save_more_plan')
    }

    if (targetMonth) {
      setChatContextSlot(nextState, 'save_more_plan', 'targetMonth', createChatContextSlotState(
        targetMonth,
        'month',
        turnId,
        'user',
        'resolver',
        {
          status: 'declared',
          scope: 'committed',
          confidence: 0.95,
          evidenceText: trimmed,
        }
      ), { clearOtherScope: true })
      clearChatContextOpenQuestion(nextState, 'save_more_plan')
    }

    const missingAmount = amountCents == null
    const missingMonth = !targetMonth
    if (missingAmount || missingMonth) {
      const slotName = missingAmount ? 'targetSavingsCents' : 'targetMonth'
      const question = missingAmount
        ? 'What total savings target amount should I use?'
        : 'By which month do you want to reach this savings target?'
      setChatContextOpenQuestion(nextState, 'save_more_plan', slotName, question)
      return {
        kind: 'clarify',
        intent: 'save_more_plan',
        slotName,
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'missing_savings_fields', openQuestion?.intent === 'save_more_plan'),
      }
    }

    if (score < 0.55) {
      const question = openQuestion?.intent === 'save_more_plan'
        ? openQuestion.prompt
        : 'What total savings target and target month should I use?'
      setChatContextOpenQuestion(nextState, 'save_more_plan', inferOpenQuestionSlotName('save_more_plan', question), question)
      return {
        kind: 'clarify',
        intent: 'save_more_plan',
        slotName: inferOpenQuestionSlotName('save_more_plan', question),
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_savings_followup', openQuestion?.intent === 'save_more_plan'),
      }
    }

    return {
      kind: 'savings_plan',
      payload: {
        targetSavingsCents: amountCents ?? undefined,
        targetMonth: targetMonth ?? undefined,
      },
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'savings_followup_resolved', openQuestion?.intent === 'save_more_plan'),
    }
  }

  if (candidateIntent === 'vacation_affordability') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'vacation_affordability'
    bumpChatContextRecentTopic(nextState, 'vacation_affordability')

    const vacationName =
      extractVacationNameFromMessage(trimmed) ||
      getSlotStringValue(state, 'vacation_affordability', 'vacationName') ||
      (explicitVacation ? 'Vacation' : null)
    const costCents = parsedNonMonthlyAmount ?? getSlotNumberValue(state, 'vacation_affordability', 'costCents')
    const targetMonth = parsedTargetMonth ?? getSlotStringValue(state, 'vacation_affordability', 'targetMonth')

    if (vacationName) {
      setChatContextSlot(nextState, 'vacation_affordability', 'vacationName', createChatContextSlotState(
        vacationName,
        'text',
        turnId,
        'user',
        'resolver',
        { status: vacationName === 'Vacation' ? 'inferred' : 'declared', scope: 'committed', confidence: vacationName === 'Vacation' ? 0.7 : 0.95 }
      ))
    }
    if (costCents != null) {
      setChatContextSlot(nextState, 'vacation_affordability', 'costCents', createChatContextSlotState(
        costCents,
        'money',
        turnId,
        'user',
        'resolver',
        { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
      ), { clearOtherScope: true })
    }
    if (targetMonth) {
      setChatContextSlot(nextState, 'vacation_affordability', 'targetMonth', createChatContextSlotState(
        targetMonth,
        'month',
        turnId,
        'user',
        'resolver',
        { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
      ), { clearOtherScope: true })
    }

    if (score < 0.55) {
      const question = openQuestion?.intent === 'vacation_affordability'
        ? openQuestion.prompt
        : 'What total vacation budget and target month should I use?'
      setChatContextOpenQuestion(nextState, 'vacation_affordability', openQuestion?.slotName || 'costCents', question)
      return {
        kind: 'clarify',
        intent: 'vacation_affordability',
        slotName: openQuestion?.slotName || 'costCents',
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_vacation_followup', openQuestion?.intent === 'vacation_affordability'),
      }
    }

    if (parsedMonthlyAmount != null && parsedNonMonthlyAmount == null && parsedTargetMonth == null && !explicitVacation) {
      const existingCostCents = getSlotNumberValue(state, 'vacation_affordability', 'costCents')
      if (existingCostCents != null && existingCostCents > 0) {
        const monthsNeeded = Math.max(1, Math.ceil(existingCostCents / parsedMonthlyAmount))
        const monthlyAmount = (parsedMonthlyAmount / 100).toFixed(2).replace(/\.00$/, '')
        const vacationLabel = vacationName && vacationName !== 'Vacation' ? vacationName : 'that vacation'
        const response =
          `At ${monthlyAmount} ${routeCurrencyCode}/month, you would need about ${monthsNeeded} month${monthsNeeded === 1 ? '' : 's'} to fund ${vacationLabel}.`

        setChatContextSlot(nextState, 'vacation_affordability', 'requiredMonthlySavingCents', createChatContextSlotState(
          parsedMonthlyAmount,
          'money',
          turnId,
          'user',
          'resolver',
          {
            status: whatIfCue ? 'hypothetical' : 'declared',
            scope: whatIfCue ? 'working' : 'committed',
            confidence: 0.95,
            evidenceText: trimmed,
          }
        ), { clearOtherScope: !whatIfCue })
        clearChatContextOpenQuestion(nextState, 'vacation_affordability')

        return {
          kind: 'text',
          message: response,
          nextState,
          decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'vacation_monthly_projection_resolved', openQuestion?.intent === 'vacation_affordability'),
        }
      }

      const question = 'Do you want me to keep this as the vacation plan, or start a separate savings plan?'
      setChatContextOpenQuestion(nextState, 'vacation_affordability', 'costCents', question)
      return {
        kind: 'clarify',
        intent: 'vacation_affordability',
        slotName: 'costCents',
        question,
        nextState,
        decision: buildResolverDecision('clarify', 0.5, 'ambiguous_vacation_monthly_followup', openQuestion?.intent === 'vacation_affordability'),
      }
    }

    return {
      kind: 'vacation_plan',
      payload: {
        vacationName: vacationName || undefined,
        costCents: costCents ?? undefined,
        targetMonth: targetMonth || undefined,
      },
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'vacation_followup_resolved', openQuestion?.intent === 'vacation_affordability'),
    }
  }

  if (candidateIntent === 'emergency_fund') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'emergency_fund'
    bumpChatContextRecentTopic(nextState, 'emergency_fund')

    const goalMonths = parsedGoalMonths ?? getSlotNumberValue(state, 'emergency_fund', 'goalMonths') ?? 3
    const monthlyContributionCents =
      parsedEmergencyContribution != null
        ? Math.round(parsedEmergencyContribution * 100)
        : getSlotNumberValue(state, 'emergency_fund', 'monthlyContributionCents')

      setChatContextSlot(nextState, 'emergency_fund', 'goalMonths', createChatContextSlotState(
        Math.max(1, Math.round(goalMonths)),
        'integer',
        turnId,
        'user',
        'resolver',
      { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
    ), { clearOtherScope: true })

    if (monthlyContributionCents != null && monthlyContributionCents > 0) {
      setChatContextSlot(nextState, 'emergency_fund', 'monthlyContributionCents', createChatContextSlotState(
        monthlyContributionCents,
        'money',
        turnId,
        'user',
        'resolver',
        { status: whatIfCue ? 'hypothetical' : 'declared', scope: whatIfCue ? 'working' : 'committed', confidence: 0.95, evidenceText: trimmed }
      ), { clearOtherScope: !whatIfCue })
    }

    if (score < 0.55 && parsedGoalMonths == null && parsedEmergencyContribution == null && !emergencyTipsRequest) {
      const question = openQuestion?.intent === 'emergency_fund'
        ? openQuestion.prompt
        : 'Do you want to change the months target or test a monthly saving amount?'
      setChatContextOpenQuestion(nextState, 'emergency_fund', 'goalMonths', question)
      return {
        kind: 'clarify',
        intent: 'emergency_fund',
        slotName: 'goalMonths',
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_emergency_followup', openQuestion?.intent === 'emergency_fund'),
      }
    }

    clearChatContextOpenQuestion(nextState, 'emergency_fund')
    return {
      kind: 'emergency_fund',
      payload: {
        goalMonths: Math.max(1, Math.round(goalMonths)),
        monthlyContribution: monthlyContributionCents != null ? monthlyContributionCents / 100 : null,
        includeTips: emergencyTipsRequest || parsedEmergencyContribution != null,
      },
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'emergency_followup_resolved', openQuestion?.intent === 'emergency_fund'),
    }
  }

  if (candidateIntent === 'budget_intel') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'budget_intel'
    bumpChatContextRecentTopic(nextState, 'budget_intel')

    const cycleType = parsedBudgetCycleType ?? normalizeBudgetCycleType(getSlotStringValue(state, 'budget_intel', 'cycleType'))
    if (cycleType) {
      setChatContextSlot(nextState, 'budget_intel', 'cycleType', createChatContextSlotState(
        cycleType,
        'text',
        turnId,
        'user',
        'resolver',
        { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
      ), { clearOtherScope: true })
      clearChatContextOpenQuestion(nextState, 'budget_intel')
    }

    if (score < 0.55 || !cycleType) {
      const question = openQuestion?.intent === 'budget_intel'
        ? openQuestion.prompt
        : 'Would you like me to plan for this month or next month?'
      setChatContextOpenQuestion(nextState, 'budget_intel', 'cycleType', question)
      return {
        kind: 'clarify',
        intent: 'budget_intel',
        slotName: 'cycleType',
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_budget_followup', openQuestion?.intent === 'budget_intel'),
      }
    }

    return {
      kind: 'budget_plan',
      payload: { cycleType },
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'budget_followup_resolved', openQuestion?.intent === 'budget_intel'),
    }
  }

  if (candidateIntent === 'cash_flow') {
    const nextState = cloneChatContextState(state)
    nextState.turnCounter += 1
    nextState.activeIntent = 'cash_flow'
    bumpChatContextRecentTopic(nextState, 'cash_flow')

    const timeframe =
      parsedCashFlowTimeframe ??
      normalizeCashFlowTimeframe(getSlotStringValue(state, 'cash_flow', 'timeframe')) ??
      'current_cycle'

    setChatContextSlot(nextState, 'cash_flow', 'timeframe', createChatContextSlotState(
      timeframe,
      'text',
      turnId,
      'user',
      'resolver',
      { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: trimmed }
    ), { clearOtherScope: true })

    if (score < 0.55 && parsedCashFlowTimeframe == null && !/\bcash flow|cashflow|money|spending|disposable income|on track\b/i.test(lower)) {
      const question = openQuestion?.intent === 'cash_flow'
        ? openQuestion.prompt
        : 'Do you want current cycle, last cycle, or this year?'
      setChatContextOpenQuestion(nextState, 'cash_flow', 'timeframe', question)
      return {
        kind: 'clarify',
        intent: 'cash_flow',
        slotName: 'timeframe',
        question,
        nextState,
        decision: buildResolverDecision('clarify', score, 'low_confidence_cash_flow_followup', openQuestion?.intent === 'cash_flow'),
      }
    }

    clearChatContextOpenQuestion(nextState, 'cash_flow')
    const syntheticMessage =
      /\bcash flow|cashflow|money|spending|disposable income|on track\b/i.test(lower)
        ? trimmed
        : timeframe === 'last_cycle'
          ? 'Show me my cash flow for last month.'
          : timeframe === 'this_year'
            ? 'Show me my cash flow for this year.'
            : 'Show me my cash flow for this cycle.'

    return {
      kind: 'cash_flow',
      message: syntheticMessage,
      timeframe,
      nextState,
      decision: buildResolverDecision(score >= 0.8 ? 'autofill' : 'autofill_with_assumption', score, 'cash_flow_followup_resolved', openQuestion?.intent === 'cash_flow'),
    }
  }

  return { kind: 'none' }
}

function extractAmountFromMessage(message: string): number | null {
  const trimmed = String(message || '').trim()
  if (!trimmed) return null

  // Common patterns: "$150", "150$", "150 usd", "150 dollars", or just "150"
  const patterns: RegExp[] = [
    /\$\s*(\d+(?:\.\d{1,2})?)/i,
    /(\d+(?:\.\d{1,2})?)\s*\$/i,
    /(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i,
    /^(\d+(?:\.\d{1,2})?)$/,
  ]

  for (const p of patterns) {
    const m = trimmed.match(p)
    if (m && m[1]) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v) && v > 0) return v
    }
  }

  return null
}

function extractAffordStateFromAssistantMessage(content: string): any | null {
  const prefix = 'AFFORD_STATE|'
  if (typeof content !== 'string') return null
  if (!content.startsWith(prefix)) return null

  const jsonPart = content.slice(prefix.length)
  if (!jsonPart) return null

  try {
    return JSON.parse(jsonPart)
  } catch {
    return null
  }
}

console.log(`[ai-chat] Vertex AI configured project=${VERTEX_PROJECT} region=${VERTEX_REGION}`)

function detectEmergencyFundIntent(message: string): boolean {
  const msg = (message || '').toLowerCase().trim()
  if (!msg) return false

  const hasEmergencyFund = msg.includes('emergency') && msg.includes('fund')
  const hasSafetyNet = msg.includes('safety net') || msg.includes('safetynet')
  const hasGrowSave =
    msg.includes('grow my emergency fund') ||
    msg.includes('build my emergency fund') ||
    msg.includes('help me grow my emergency fund') ||
    msg.includes('grow my savings') ||
    msg.includes('build my savings') ||
    msg.includes('increase my savings') ||
    msg.includes('increase my safety net')

  return hasEmergencyFund || hasSafetyNet || hasGrowSave
}

function isEmergencyFundTipsRequest(message: string): boolean {
  const msg = (message || '').toLowerCase().trim()
  if (!msg) return false

  // Accept broad phrasing; these requests often come without mentioning "emergency fund".
  return (
    msg.includes('show more ways to save') ||
    msg.includes('more ways to save') ||
    msg.includes('ways to save') ||
    msg.includes('how can i save') ||
    msg.includes('how do i save') ||
    msg.includes('help me save more') ||
    msg.includes('save more') ||
    msg.includes('cut spending') ||
    msg.includes('reduce spending') ||
    msg.includes('spending cuts') ||
    msg.includes('ways to get there faster')
  )
}

/**
 * Detect "What if I save $X/mo" projection queries
 * Returns the monthly amount if matched, null otherwise
 */
function detectWhatIfProjection(message: string): number | null {
  const msg = (message || '').toLowerCase().trim()
  if (!msg) return null

  // Pattern: "what if i save $X per month" or "what if i save $X/mo" or "save $X monthly"
  const patterns = [
    /what if i save \$?(\d+(?:\.\d+)?)\s*(?:\/mo|per month|monthly|a month)/i,
    /save \$?(\d+(?:\.\d+)?)\s*(?:\/mo|per month|monthly|a month)/i,
    /if i save \$?(\d+(?:\.\d+)?)\s*(?:\/mo|per month|monthly|a month)/i,
  ]

  for (const pattern of patterns) {
    const match = msg.match(pattern)
    if (match && match[1]) {
      const amount = parseFloat(match[1])
      if (Number.isFinite(amount) && amount > 0) {
        return amount
      }
    }
  }

  return null
}

function extractGoalMonthsFromMessage(message: string): number | null {
  const msg = (message || '').toLowerCase()

  const monthsMatch = msg.match(/\b(\d{1,2})\s*-?\s*months?\b/)
  if (!monthsMatch) return null
  const goalMonths = parseInt(monthsMatch[1], 10)
  if (!Number.isFinite(goalMonths) || goalMonths <= 0) return null
  return Math.max(1, Math.min(goalMonths, 24))
}

function extractEmergencyFundDialogInputs(message: string): { goalMonths: number } {
  let goalMonths = extractGoalMonthsFromMessage(message) ?? 3

  return {
    goalMonths,
  }
}

function normalizeBudgetCycleType(value: unknown): 'current' | 'next' | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (
    normalized === 'current' ||
    normalized === 'this month' ||
    normalized === 'current month' ||
    normalized === 'current cycle' ||
    normalized === 'rest of cycle' ||
    normalized === 'rest of this cycle' ||
    normalized === 'remaining days'
  ) {
    return 'current'
  }
  if (
    normalized === 'next' ||
    normalized === 'next month' ||
    normalized === 'next cycle' ||
    normalized === 'plan ahead'
  ) {
    return 'next'
  }
  return null
}

function extractBudgetCycleTypeFromMessage(message: string): 'current' | 'next' | null {
  const msg = String(message || '').trim().toLowerCase()
  if (!msg) return null
  if (/\b(next month|next cycle|plan ahead)\b/.test(msg)) return 'next'
  if (/\b(this month|current month|current cycle|rest of (?:this )?cycle|remaining days)\b/.test(msg)) return 'current'
  return normalizeBudgetCycleType(msg)
}

function normalizeCashFlowTimeframe(value: unknown): 'current_cycle' | 'last_cycle' | 'this_year' | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (
    normalized === 'current_cycle' ||
    normalized === 'current cycle' ||
    normalized === 'this cycle' ||
    normalized === 'this month' ||
    normalized === 'now'
  ) {
    return 'current_cycle'
  }
  if (
    normalized === 'last_cycle' ||
    normalized === 'last cycle' ||
    normalized === 'last month' ||
    normalized === 'previous month'
  ) {
    return 'last_cycle'
  }
  if (
    normalized === 'this_year' ||
    normalized === 'this year' ||
    normalized === 'year to date' ||
    normalized === 'ytd'
  ) {
    return 'this_year'
  }
  return null
}

function extractCashFlowTimeframeHint(message: string): 'current_cycle' | 'last_cycle' | 'this_year' | null {
  const msg = String(message || '').trim().toLowerCase()
  if (!msg) return null
  if (/\b(last month|last cycle|previous month)\b/.test(msg)) return 'last_cycle'
  if (/\b(this year|year to date|ytd)\b/.test(msg)) return 'this_year'
  if (/\b(this month|this cycle|current cycle|current month|right now|now)\b/.test(msg)) return 'current_cycle'
  return null
}

function detectGeneralChatTopic(message: string): string | null {
  const lower = String(message || '').trim().toLowerCase()
  if (!lower) return null

  const topicPatterns: Array<{ pattern: RegExp; topic: string }> = [
    { pattern: /\bnet worth\b.*\brecent transactions?\b|\brecent transactions?\b.*\bnet worth\b/, topic: 'net worth and recent transactions' },
    { pattern: /\bsubscriptions?\b/, topic: 'subscriptions' },
    { pattern: /\bbills?\b/, topic: 'bills' },
    { pattern: /\brecent transactions?\b|\btransactions?\b/, topic: 'recent transactions' },
    { pattern: /\bnet worth\b/, topic: 'net worth' },
    { pattern: /\bcash flow|cashflow|disposable income\b/, topic: 'cash flow' },
    { pattern: /\bbudget|budget caps?\b/, topic: 'budget' },
    { pattern: /\bemergency fund\b/, topic: 'emergency fund' },
    { pattern: /\bsavings plan\b|\bsavings goal\b|\bmonthly savings?\b|\bsave more\b|\btarget savings\b/, topic: 'savings goal' },
    { pattern: /\bvacation|trip|travel|getaway|holiday\b/, topic: 'vacation plan' },
    { pattern: /\bafford\b/, topic: 'affordability check' },
    { pattern: /\bdebt|debts|loan|loans|credit card\b/, topic: 'debt' },
    { pattern: /\bspending\b|\bexpenses?\b|\bcategories?\b/, topic: 'spending' },
    { pattern: /\bincome\b/, topic: 'income' },
  ]

  return topicPatterns.find(({ pattern }) => pattern.test(lower))?.topic || null
}

function extractGeneralComparisonPeriod(message: string): string | null {
  const trimmed = String(message || '').trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()

  const cashFlowTimeframe = extractCashFlowTimeframeHint(trimmed)
  if (cashFlowTimeframe === 'last_cycle') return 'last cycle / last month'
  if (cashFlowTimeframe === 'this_year') return 'this year'
  if (cashFlowTimeframe === 'current_cycle') return 'current cycle / this month'

  const budgetCycleType = extractBudgetCycleTypeFromMessage(trimmed)
  if (budgetCycleType === 'next') return 'next cycle / next month'
  if (budgetCycleType === 'current') return 'current cycle / this month'

  if (/\blast 30 days\b/.test(lower)) return 'last 30 days'
  if (/\blast 7 days\b/.test(lower)) return 'last 7 days'
  if (/\bthis week\b/.test(lower)) return 'this week'
  if (/\blast week\b/.test(lower)) return 'last week'
  if (/\bnext month\b/.test(lower)) return 'next month'
  if (/\bthis month\b/.test(lower)) return 'this month'

  return null
}

function extractAssistantFollowUpQuestion(message: string): string | null {
  const compacted = String(message || '').replace(/\s+/g, ' ').trim()
  if (!compacted.includes('?')) return null

  const matches = compacted.match(/[^?]{6,220}\?/g)
  if (!matches || matches.length === 0) return null

  const candidate = matches[matches.length - 1].trim()
  if (!candidate.endsWith('?')) return null
  if (
    isAssistantOfferOrQuestion(candidate) ||
    /^(what|which|when|where|why|how|can|could|would|do|did|should|shall|is|are)\b/i.test(candidate)
  ) {
    return candidate
  }
  return null
}

function inferAcceptedPlanBranchLabel(message: string): string | null {
  const compacted = compactPromptExcerpt(message, 180)
  if (!compacted) return null
  const topic = detectGeneralChatTopic(compacted)
  return topic ? `continue ${topic}` : compacted
}

function looksLikeGeneralPlanningMessage(message: string): boolean {
  const normalized = String(message || '').trim()
  if (!normalized) return false

  return (
    /\b(save|saving|goal|target|plan|budget|spend|spending|cut|reduce|afford|cost|limit|vacation|trip|travel|emergency fund|debt|loan|payment|income|projection|compare)\b/i.test(normalized) ||
    containsWhatIfCue(normalized) ||
    containsOverrideCue(normalized) ||
    containsContinuityCue(normalized)
  )
}

/**
 * Helper to call Gemini API with an explicitly selected key.
 */
async function fetchGemini(
  modelPath: string,
  body: any,
  options: { stream?: boolean; apiKey?: GeminiApiKey } = {}
): Promise<Response> {
  const accessToken = await getAccessToken();
  const streamParam = options.stream ? '&alt=sse' : ''
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${modelPath}${streamParam ? '?' + streamParam.slice(1) : ''}`

  const vertexBody = { ...body };
  if (vertexBody.contents && Array.isArray(vertexBody.contents)) {
    vertexBody.contents = vertexBody.contents.map((c: any) => ({
      ...c,
      role: c.role || 'user',
    }));
  }

  return await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(vertexBody)
  })
}
class GeminiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GeminiResponseError'
  }
}

function logGeminiRetry(event: GeminiRetryLogEvent): void {
  console.log(
    `[ai-chat] gemini_retry event=${event.event} operation=${event.operation} ` +
    `attempt=${event.attempt} model=${event.model} key=${event.keySlot ?? 'none'} ` +
    `reason=${event.reason} status=${event.status ?? 'none'} delay_ms=${event.delayMs ?? 'none'}`
  )
}

async function throwGeminiResponseError(response: Response, label: string): Promise<never> {
  const errorData = await response.text()
  throw new GeminiResponseError(`${label}: ${response.status} - ${errorData}`, response.status)
}

function readObjectString(value: unknown, key: string): string | null {
  if (!isPlainObject(value)) return null
  const raw = value[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

function readObjectNumber(value: unknown, key: string): number | null {
  if (!isPlainObject(value)) return null
  const raw = value[key]
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function readNestedObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  return isPlainObject(value[key]) ? value[key] as Record<string, unknown> : null
}

function titleCaseHistoryValue(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

function formatHistoryTargetMonth(value: string | null | undefined): string | null {
  const text = String(value || '').trim()
  const match = /^(\d{4})-(\d{2})$/.exec(text)
  if (!match) return text || null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return text
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${monthNames[month - 1]} ${year}`
}

function formatHistoryCurrencyAmount(
  amount: number | null | undefined,
  currencyCode: string | null | undefined,
  options: { cents?: boolean } = {}
): string | null {
  if (!Number.isFinite(amount ?? NaN)) return null
  const numericAmount = options.cents ? Number(amount) / 100 : Number(amount)
  const code = typeof currencyCode === 'string' && currencyCode.trim().length > 0
    ? currencyCode.trim().toUpperCase()
    : 'USD'

  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(numericAmount)
  } catch {
    return `${numericAmount.toFixed(2)} ${code}`
  }
}

function compactHistorySentence(text: string | null | undefined): string | null {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).trimEnd()}...`
}

function joinHistorySummaryParts(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts
    .map((part) => compactHistorySentence(part))
    .filter((part): part is string => Boolean(part))

  if (cleaned.length === 0) return null
  return cleaned.join(' ')
}

function extractConfidenceFromPlainTextResponse(
  rawText: string,
  logLabel: string,
): { answer: string; confidence: 'low' | 'medium' | 'high' } {
  let answer = String(rawText || '').trim()
  let confidence: 'low' | 'medium' | 'high' = 'medium'

  const confidenceMatch = answer.match(/<?<CONFIDENCE:(low|medium|high)>?>?/i)
  if (confidenceMatch) {
    confidence = confidenceMatch[1].toLowerCase() as 'low' | 'medium' | 'high'
    answer = answer.replace(/<?<CONFIDENCE:(low|medium|high)>?>?/gi, '').trim()
  } else {
    console.warn(`[ai-chat] No confidence marker found in ${logLabel} response, defaulting to medium`)
  }

  return { answer, confidence }
}

function summarizeAffordCheckHistory(payload: Record<string, unknown>): string | null {
  const input = readNestedObject(payload, 'input')
  const itemName = readObjectString(input, 'itemName') || 'purchase'
  const amount = readObjectNumber(input, 'amount')
  const currencyCode = readObjectString(payload, 'currencyCode') || 'USD'
  const verdict = titleCaseHistoryValue(readObjectString(payload, 'verdict') || 'maybe')
  const headline = readObjectString(payload, 'headline')
  const explanation = readObjectString(payload, 'explanation')
  const clarifyingQuestion = readObjectString(payload, 'clarifyingQuestion')
  const amountText = formatHistoryCurrencyAmount(amount, currencyCode)

  return joinHistorySummaryParts([
    `Wisey ran an afford check for ${itemName}${amountText ? ` at ${amountText}` : ''}.`,
    `Verdict: ${verdict}.`,
    clarifyingQuestion || headline || explanation,
  ])
}

function summarizeVacationPlanHistory(payload: Record<string, unknown>): string | null {
  const currencyCode = readObjectString(payload, 'currencyCode') || 'USD'
  const vacationName = readObjectString(payload, 'vacationName') || 'vacation'
  const costText = formatHistoryCurrencyAmount(readObjectNumber(payload, 'costCents'), currencyCode, { cents: true })
  const targetMonth = formatHistoryTargetMonth(readObjectString(payload, 'targetMonth'))
  const requiredMonthly = formatHistoryCurrencyAmount(readObjectNumber(payload, 'requiredMonthlySavingCents'), currencyCode, { cents: true })
  const verdict = titleCaseHistoryValue(readObjectString(payload, 'verdict') || 'close')
  const wiseyTip = readObjectString(payload, 'wiseyTip')

  return joinHistorySummaryParts([
    `Wisey built a vacation plan for ${vacationName}${costText ? ` costing ${costText}` : ''}${targetMonth ? ` by ${targetMonth}` : ''}.`,
    `Verdict: ${verdict}.${requiredMonthly ? ` Needed about ${requiredMonthly} per month.` : ''}`,
    wiseyTip,
  ])
}

function summarizeSavingsPlanHistory(payload: Record<string, unknown>): string | null {
  const currencyCode = readObjectString(payload, 'currencyCode') || 'USD'
  const goalAmount = formatHistoryCurrencyAmount(readObjectNumber(payload, 'goalAmountCents'), currencyCode, { cents: true })
  const targetMonth = formatHistoryTargetMonth(readObjectString(payload, 'targetMonth'))
  const requiredMonthly = formatHistoryCurrencyAmount(readObjectNumber(payload, 'requiredMonthlySavingCents'), currencyCode, { cents: true })
  const verdict = titleCaseHistoryValue(readObjectString(payload, 'verdict') || 'close')
  const wiseyNote = readObjectString(payload, 'wiseyNote')

  return joinHistorySummaryParts([
    `Wisey built a savings plan${goalAmount ? ` for ${goalAmount}` : ''}${targetMonth ? ` by ${targetMonth}` : ''}.`,
    `Verdict: ${verdict}.${requiredMonthly ? ` Needed about ${requiredMonthly} per month.` : ''}`,
    wiseyNote,
  ])
}

function summarizeCashFlowHistory(payload: Record<string, unknown>): string | null {
  const currencyCode = readObjectString(payload, 'currencyCode') || 'USD'
  const status = readNestedObject(payload, 'status')
  const timeframe = readNestedObject(payload, 'timeframe')
  const summary = readNestedObject(payload, 'summary')
  const level = titleCaseHistoryValue(readObjectString(status, 'level') || 'unknown')
  const statusMessage = readObjectString(status, 'message')
  const timeframeLabel = readObjectString(timeframe, 'label')
  const dailySafeSpend = formatHistoryCurrencyAmount(readObjectNumber(summary, 'dailySafeSpend'), currencyCode)
  const clarifyingQuestion = readObjectString(payload, 'clarifyingQuestion')

  return joinHistorySummaryParts([
    `Wisey shared a cash flow snapshot${timeframeLabel ? ` for ${timeframeLabel}` : ''}.`,
    `Status: ${level}.${dailySafeSpend ? ` Daily safe spend was ${dailySafeSpend}.` : ''}`,
    clarifyingQuestion || statusMessage,
  ])
}

function summarizeEmergencyFundHistory(payload: Record<string, unknown>): string | null {
  const status = titleCaseHistoryValue(readObjectString(payload, 'status') || 'unknown')
  const runway = readObjectString(payload, 'runwayFormatted')
  const goalMonths = readObjectNumber(payload, 'goalMonths')
  const clarifyingQuestion = readObjectString(payload, 'clarifyingQuestion')

  return joinHistorySummaryParts([
    `Wisey shared an emergency fund check.`,
    `Status: ${status}.${runway ? ` Runway: ${runway}.` : ''}${goalMonths ? ` Goal: ${Math.round(goalMonths)} months.` : ''}`,
    clarifyingQuestion,
  ])
}

function summarizeHealthScoreHistory(payload: Record<string, unknown>): string | null {
  const overallScore = readObjectNumber(payload, 'overallScore')
  const rating = readObjectString(payload, 'rating')
  const clarifyingMessage = readObjectString(payload, 'clarifyingMessage')
  const missingComponents = Array.isArray(payload.missingComponents)
    ? payload.missingComponents
        .map((value) => typeof value === 'string' ? titleCaseHistoryValue(value) : '')
        .filter(Boolean)
    : []

  return joinHistorySummaryParts([
    overallScore !== null
      ? `Wisey shared a financial health score of ${Math.round(overallScore)}/100${rating ? ` (${rating})` : ''}.`
      : `Wisey shared a partial financial health snapshot.`,
    missingComponents.length > 0 ? `Missing components: ${missingComponents.join(', ')}.` : null,
    clarifyingMessage,
  ])
}

function summarizeBudgetRecommendationHistory(payload: Record<string, unknown>): string | null {
  const recommendations = readNestedObject(payload, 'recommendations')
  const timeframeLabel = readObjectString(recommendations, 'timeframeLabel')
  const recommendedCategories = Array.isArray(recommendations?.recommendedCategories)
    ? recommendations?.recommendedCategories.length
    : 0

  return joinHistorySummaryParts([
    `Wisey prepared a budget recommendation${timeframeLabel ? ` for ${timeframeLabel}` : ''}.`,
    recommendedCategories > 0 ? `It suggested ${recommendedCategories} category caps.` : null,
  ])
}

function summarizeGenericStructuredAssistantHistory(payload: Record<string, unknown>): string | null {
  const directMessage = readObjectString(payload, 'message')
  const summary = readObjectString(payload, 'summary')
  const explanation = readObjectString(payload, 'explanation')
  const recommendation = readObjectString(payload, 'recommendation')
  const statusMessage = readObjectString(payload, 'statusMessage')
  const headline = readObjectString(payload, 'headline')
  const type = readObjectString(payload, 'type')

  return joinHistorySummaryParts([
    directMessage || summary || explanation || recommendation || statusMessage || headline,
    type ? `Structured update type: ${titleCaseHistoryValue(type)}.` : null,
  ])
}

function summarizeAssistantStructuredHistory(content: string): string | null {
  const trimmed = String(content || '').trim()
  if (!trimmed) return null

  const jsonCandidate = extractJsonEnvelopeCandidate(trimmed)
  if (!jsonCandidate) return null

  try {
    const parsed = JSON.parse(jsonCandidate)
    if (!isPlainObject(parsed)) return 'Wisey shared a structured update.'

    const type = readObjectString(parsed, 'type')
    if (type === 'afford_check') return summarizeAffordCheckHistory(parsed)
    if (type === 'vacation_plan') return summarizeVacationPlanHistory(parsed)
    if (type === 'savings_plan') return summarizeSavingsPlanHistory(parsed)
    if (type === 'cash_flow') return summarizeCashFlowHistory(parsed)
    if (type === 'emergency_fund') return summarizeEmergencyFundHistory(parsed)
    if (type === 'budget_category_recommendations') return summarizeBudgetRecommendationHistory(parsed)
    if (parsed.recommendations && readObjectString(parsed.recommendations, 'type') === 'budget_category_recommendations') {
      return summarizeBudgetRecommendationHistory(parsed)
    }
    if (parsed.components && Object.prototype.hasOwnProperty.call(parsed, 'overallScore')) {
      return summarizeHealthScoreHistory(parsed)
    }

    return summarizeGenericStructuredAssistantHistory(parsed) || 'Wisey shared a structured update.'
  } catch {
    return 'Wisey shared a structured update.'
  }
}

function buildModelHistoryText(row: RecentChatMessageRow): string | null {
  const rawContent = String(row.content || '').trim()
  if (!rawContent) return null

  if (row.is_from_user) {
    const isActionJson = rawContent.startsWith('{') && rawContent.includes('"action":')
    return isActionJson ? null : rawContent
  }

  if (rawContent.startsWith('AFFORD_STATE|') || rawContent.startsWith('VACATION_STATE|')) {
    return null
  }

  return summarizeAssistantStructuredHistory(rawContent) || rawContent
}

function buildGeminiConversationContents(
  recentMessages: RecentChatMessageRow[],
  currentUserMessage: string,
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []

  const appendTurn = (role: 'user' | 'model', text: string | null | undefined) => {
    const normalized = String(text || '').trim()
    if (!normalized) return

    const last = contents[contents.length - 1]
    if (last?.role === role && last.parts[0]) {
      last.parts[0].text = `${last.parts[0].text}\n\n${normalized}`
      return
    }

    contents.push({
      role,
      parts: [{ text: normalized }],
    })
  }

  for (const row of [...recentMessages].reverse()) {
    appendTurn(row.is_from_user ? 'user' : 'model', buildModelHistoryText(row))
  }

  appendTurn('user', currentUserMessage)
  return contents
}

function buildGeminiRequestBody(params: {
  systemPrompt: string
  recentMessages: RecentChatMessageRow[]
  currentUserMessage: string
  useMultiTurn: boolean
}): any {
  if (!params.useMultiTurn) {
    return {
      contents: [{
        parts: [{ text: params.systemPrompt }],
      }],
    }
  }

  return {
    systemInstruction: {
      parts: [{ text: params.systemPrompt }],
    },
    contents: buildGeminiConversationContents(params.recentMessages, params.currentUserMessage),
  }
}

const ROLLING_SUMMARY_RECENT_WINDOW_LIMIT = 20
const ROLLING_SUMMARY_COMPACT_WINDOW_LIMIT = 12
const ROLLING_SUMMARY_HISTORY_CHAR_BUDGET = 2800
const ROLLING_SUMMARY_MAX_CHARS = 400

function estimateModelHistoryChars(recentMessages: RecentChatMessageRow[]): number {
  return recentMessages.reduce((total, row) => {
    const text = buildModelHistoryText(row)
    return total + (text ? text.length + 16 : 0)
  }, 0)
}

function buildSummaryTranscript(rows: RecentChatMessageRow[]): string {
  return rows
    .map((row) => {
      const text = buildModelHistoryText(row)
      if (!text) return ''
      return `${row.is_from_user ? 'User' : 'Wisey'}: ${text}`
    })
    .filter((line) => line.length > 0)
    .join('\n')
}

function buildRollingSummaryPrompt(existingSummary: string, olderConversationChunk: string): string {
  return `Update the rolling summary for an ongoing WiseFlow chat.

Existing rolling summary:
${existingSummary || '(none yet)'}

New older conversation chunk:
${olderConversationChunk}

Rules:
1. Keep only durable continuity from older turns that may matter for later follow-up in THIS chat.
2. Include important user-declared facts, named entities that are likely to be referenced again, accepted assumptions, plan choices, pending branches, and key financial context.
3. Do not invent balances, totals, or decisions that are not clearly present.
4. Ignore filler, greetings, and repetitive wording.
5. Write 2-4 short sentences, max 320 characters.
6. Return plain text only.

Updated rolling summary:`
}

function normalizeRollingSummaryText(text: string | null | undefined): string {
  return String(text || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ROLLING_SUMMARY_MAX_CHARS)
}

// Timing helper
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// SSE helper function
function createSSEResponse(handler: (send: (data: any) => Promise<void>) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = async (data: any) => {
        const message = `data: ${JSON.stringify(data)}\n\n`
        controller.enqueue(encoder.encode(message))
      }

      try {
        await handler(send)
      } catch (error) {
        console.error('Ã¢ÂÅ’ SSE handler error:', error)
        await send({ type: 'error', message: safeErrorMessage(error, 'Stream failed') })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    }
  })
}



function isGreetingLike(input: string): boolean {
  const s = (input || '').toLowerCase().replace(/[^a-z\s!.?]/g, '').trim()
  if (s.length === 0) return false
  if (/^(hi+|hey+|hello+|yo+|sup)(\s+there)?[!.?]*$/.test(s)) return true
  if (/^good\s*(morning|afternoon|evening)[!.?]*$/.test(s)) return true
  return false
}

// Helper functions to create anonymous tokens for logging (no raw IDs in logs)
function getAnonymousEntityToken(prefix: string, value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return `${prefix}_${Math.abs(hash).toString(36)}`
}

function getAnonymousUserToken(userId: string): string {
  return getAnonymousEntityToken('user', userId)
}

function getAnonymousSessionToken(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return getAnonymousEntityToken('session', sessionId)
}

function userHasProAccess(user: any): boolean {
  const appMeta = (user?.app_metadata ?? {}) as Record<string, unknown>
  const userMeta = (user?.user_metadata ?? {}) as Record<string, unknown>
  const asLower = (value: unknown): string => String(value ?? '').trim().toLowerCase()

  const truthyFlag = (value: unknown): boolean => value === true || asLower(value) === 'true' || asLower(value) === '1'
  if (
    truthyFlag(appMeta['is_pro']) ||
    truthyFlag(appMeta['pro']) ||
    truthyFlag(userMeta['is_pro']) ||
    truthyFlag(userMeta['pro'])
  ) {
    return true
  }

  const planCandidates = [
    appMeta['plan'],
    appMeta['tier'],
    appMeta['subscription_tier'],
    appMeta['subscription_plan'],
    userMeta['plan'],
    userMeta['tier'],
    userMeta['subscription_tier'],
    userMeta['subscription_plan'],
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

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, accept, x-wisey-stream',
      }
    })
  }

  try {
    // Parse request body first to access stream field
    const body = await req.json()
    const {
      message,
      personalityMode,
      responseLength,
      sessionId = null,
      forceNewSession = false,
      stream = false,
      action = null,
      inputMode = null,
      digestHandoff = null,
      chatHandoff = null,
      languageCode = null,
      localeTag = null,
      mainCurrencyCode = null,
      numberFormatMode = null,
    } = body
    const requestLocaleContract = resolveLocaleContractFromRequest({
      languageCode,
      localeTag,
      mainCurrencyCode,
      numberFormatMode,
    })
    const requestDigestHandoff = normalizeDigestHandoff(digestHandoff ?? chatHandoff ?? null)
    const normalizedInputMode = typeof inputMode === 'string' ? inputMode.trim().toLowerCase() : ''
    const digestHandoffTrustDecision = evaluateDigestHandoffTrust({
      requestDigestHandoff,
      message: typeof message === 'string' ? message : '',
      inputMode: normalizedInputMode || null,
    })
    const trustedRequestDigestHandoff = digestHandoffTrustDecision.trusted
      ? requestDigestHandoff
      : null

    // Route budget intelligence readiness checks to dedicated function
    if (action === 'budget_readiness') {
      const budgetIntelligenceUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-budget-intelligence`
      const budgetResponse = await fetch(budgetIntelligenceUrl, {
        method: 'POST',
        headers: {
          'Authorization': req.headers.get('Authorization') || '',
          'apikey': Deno.env.get('SUPABASE_ANON_KEY') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          intent: 'readiness',
          sessionId,
          timezone: body.timezone
        })
      })

      if (!budgetResponse.ok) {
        throw new Error(`Budget intelligence failed: ${budgetResponse.status}`)
      }

      const budgetData = await budgetResponse.json()

      // Return as STRING wrapped in ChatResponse (Android expects response.response to be a string)
      return new Response(JSON.stringify({
        response: JSON.stringify(budgetData),
        sessionId: sessionId || '',
        confidence: null
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // Route budget creation prompts to dedicated budget intelligence function.
    // Keep this explicit so free-typed chat stays conversational.
    const normalizedMessage = (typeof message === 'string' ? message : '')
      .trim()
      .toLowerCase()
    const isPresetInput = normalizedInputMode === 'preset'
    // Support explicit action routing so preset chips work in any UI language.
    const isBudgetBuildPrompt =
      action === 'budget_build' ||
      (isPresetInput && (
        /\b(create|build|make|start|setup|set up|plan)\b[\w\s]*\bbudgets?\b/.test(normalizedMessage) ||
        /\bbudgets?\b[\w\s]*\b(create|build|make|start|setup|set up|plan|categories?|caps?)\b/.test(normalizedMessage) ||
        normalizedMessage.includes('help me create a budget') ||
        normalizedMessage.includes('help me make a budget') ||
        normalizedMessage.includes('help me build a budget') ||
        normalizedMessage.includes('budget for next month') ||
        normalizedMessage.includes('budget for this month') ||
        normalizedMessage.includes('budget categories') ||
        normalizedMessage.includes('category budget') ||
        // Phase 3.2 suggested prompts (from ai-budget-intelligence readiness)
        normalizedMessage.includes('draining me the most') ||
        normalizedMessage.includes('cut $200') ||
        normalizedMessage.includes('cut 200') ||
        normalizedMessage.includes('more aggressive budget')
      ))

    // isBudgetBuildPrompt and isCycleReply are handled AFTER session setup so messages can be persisted.
    // (Early exit here removed Ã¢â‚¬â€ see BUDGET FLOW block below.)

    if (!message) throw new Error('Missing message')
    const trimmed = String(message).trim()
    let actionObj: any = null
    if (trimmed.startsWith('{')) {
      try {
        actionObj = JSON.parse(trimmed)
      } catch {
        actionObj = null
      }
    }

    // Detect streaming mode from ANY of these signals
    const url = new URL(req.url)
    const acceptHeader = req.headers.get('Accept') || ''
    const streamParam = url.searchParams.get('stream')
    const streamHeader = (req.headers.get('X-Wisey-Stream') || '').toLowerCase()
    const useStreaming =
      acceptHeader.includes('text/event-stream') ||
      streamParam === 'true' ||
      streamHeader === 'true' ||
      stream === true

    // Debug log for streaming detection
    console.log('[ai-chat] streaming detect', {
      accept: acceptHeader,
      streamParam,
      streamHeader,
      streamBody: stream,
      useStreaming
    })

    // Phase 2: Normalize persona to coach|companion only (no legacy mode branching)
    const normalizePersona = (mode: string): 'coach' | 'companion' => {
      switch (mode?.toLowerCase()) {
        case 'expert':
        case 'focused':
          return 'coach'
        case 'friendly':
          return 'companion'
        case 'coach':
          return 'coach'
        case 'companion':
          return 'companion'
        default:
          return 'companion'
      }
    }

    // Normalize persona immediately - no legacy mode branching beyond this point
    const effectivePersona = normalizePersona(personalityMode)

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    )

    // Extract user from JWT token
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Missing Authorization header')

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) throw new Error('Invalid or expired token')
    if (!userHasProAccess(user)) {
      return new Response(JSON.stringify({ error: 'pro_required', message: 'Wisey AI Chat is Pro only.' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const userId = user.id
    const requestId = crypto.randomUUID()
    const userToken = getAnonymousUserToken(userId)

    logChatContextEvent('request_started', {
      requestId,
      userToken,
      action: action || 'chat',
      inputMode: normalizedInputMode || 'unknown',
      hasDigestHandoff: Boolean(requestDigestHandoff),
      hasTrustedDigestHandoff: Boolean(trustedRequestDigestHandoff),
      digestHandoffTrustReason: digestHandoffTrustDecision.reason,
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      contextStateVersion: CHAT_CONTEXT_STATE_VERSION,
      hasSessionId: Boolean(sessionId),
      forceNewSession: Boolean(forceNewSession),
      useStreaming,
    })
    if (requestDigestHandoff && !trustedRequestDigestHandoff) {
      incrementChatContextCounter('digest_handoff_rejected_total', {
        reason: digestHandoffTrustDecision.reason,
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      logChatContextEvent('digest_handoff_rejected', {
        requestId,
        userToken,
        reason: digestHandoffTrustDecision.reason,
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
    }
    incrementChatContextCounter('chat_context_request_total', {
      action: action || 'chat',
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })

    // Rate limiting: allow bursts but cap at 10 messages per minute
    const oneMinuteAgo = new Date(Date.now() - 60000).toISOString()
    const { count: recentMsgCount } = await supabaseClient
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_from_user', true)
      .gte('created_at', oneMinuteAgo)

    if ((recentMsgCount ?? 0) >= 10) {
      console.warn(`Rate limit hit for user ${userToken}: ${recentMsgCount} msgs`)
      incrementChatContextCounter('chat_context_request_rate_limited', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment before sending more messages.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Retry-After': '10'
        }
      })
    }

    // Get user's financial context lazily (only for non-greeting path)
    let context: any = null

    // Handle chat session management with 24-hour active session logic
    let currentSessionId = sessionId
    let isNewSession = false
    let shouldForceNewSession = forceNewSession

    // SECURITY: If client provides a sessionId, validate ownership before using it
    if (currentSessionId && !shouldForceNewSession) {
      const { data: ownedSession, error: ownershipError } = await supabaseClient
        .from('chat_sessions')
        .select('id')
        .eq('id', currentSessionId)
        .eq('user_id', userId)
        .single()

      if (ownershipError || !ownedSession) {
        // Session is stale/inaccessible for this user; recover by forcing a fresh session.
        // This avoids clients getting stuck when local state holds an old session id.
        console.warn(
          `[ai-chat] session recovery: invalid session for user ${getAnonymousUserToken(userId)}; forcing new session`,
        )
        currentSessionId = null
        shouldForceNewSession = true
      }
      // Session is valid and owned by this user, continue
    }

    // If forceNewSession is true, skip active session check and create new
    if (shouldForceNewSession) {
      // Ensure we don't end up with multiple unarchived sessions.
      // If user is explicitly starting a new chat, archive (or delete if empty) any existing unarchived sessions.
      try {
        const { data: existingUnarchived } = await supabaseClient
          .from('chat_sessions')
          .select('id')
          .eq('user_id', userId)
          .eq('is_archived', false)

        if (existingUnarchived && existingUnarchived.length > 0) {
          for (const s of existingUnarchived) {
            const sessionToClose = (s as any)?.id
            if (!sessionToClose) continue

            const { count: realMsgCount } = await supabaseClient
              .from('chat_messages')
              .select('*', { count: 'exact', head: true })
              .eq('session_id', sessionToClose)
              .eq('user_id', userId)

            if ((realMsgCount || 0) > 0) {
              await supabaseClient
                .from('chat_sessions')
                .update({ is_archived: true })
                .eq('id', sessionToClose)
                .eq('user_id', userId)
            } else {
              await supabaseClient
                .from('chat_sessions')
                .delete()
                .eq('id', sessionToClose)
                .eq('user_id', userId)
            }
          }
        }
      } catch (e) {
        console.error('Ã¢ÂÅ’ Failed to close previous unarchived sessions before forceNewSession:', e)
        // Continue anyway; we still want to create the new session.
      }

      const { data: newSession, error: sessionError } = await supabaseClient
        .from('chat_sessions')
        .insert([{
          user_id: userId,
          title: 'New Chat',
          personality_mode: effectivePersona,
          is_archived: false
        }])
        .select('id')
        .single()

      if (sessionError) throw new Error('Failed to create chat session')
      currentSessionId = newSession.id
      isNewSession = true
    }
    // If no session ID provided and not forcing new, check for active session or create new
    else if (!currentSessionId) {
      // Check for existing active session (< 24 hours old, not archived)
      const { data: activeSession } = await supabaseClient
        .from('chat_sessions')
        .select('id, updated_at')
        .eq('user_id', userId)
        .eq('is_archived', false)
        .order('updated_at', { ascending: false })
        .limit(1)
        .single()

      if (activeSession) {
        const hoursSinceUpdate = (Date.now() - new Date(activeSession.updated_at).getTime()) / (1000 * 60 * 60)

        if (hoursSinceUpdate < 24) {
          // Use existing active session
          currentSessionId = activeSession.id
        } else {
          // Archive old session and create new

          // Check actual message count to decide whether to archive or delete
          const { count: realMsgCount } = await supabaseClient
            .from('chat_messages')
            .select('*', { count: 'exact', head: true })
            .eq('session_id', activeSession.id)
            .eq('user_id', userId)

          // Only archive if it has messages
          if ((realMsgCount || 0) > 0) {
            await supabaseClient
              .from('chat_sessions')
              .update({ is_archived: true })
              .eq('id', activeSession.id)
              .eq('user_id', userId)

            // Extract memory from archived session (await for correctness)
            try {
              await extractSessionMemory(supabaseClient, activeSession.id, userId)
            } catch (memErr) {
              console.error('Ã¢ÂÅ’ Memory extraction failed:', memErr)
            }
          } else {
            // Delete empty session
            await supabaseClient
              .from('chat_sessions')
              .delete()
              .eq('id', activeSession.id)
              .eq('user_id', userId)
          }

          // Create new session
          const { data: newSession, error: sessionError } = await supabaseClient
            .from('chat_sessions')
            .insert([{
              user_id: userId,
              title: 'New Chat',
              personality_mode: effectivePersona,
              is_archived: false
            }])
            .select('id')
            .single()

          if (sessionError) throw new Error('Failed to create chat session')
          currentSessionId = newSession.id
          isNewSession = true
        }
      } else {
        // No active session exists, create new
        const { data: newSession, error: sessionError } = await supabaseClient
          .from('chat_sessions')
          .insert([{
            user_id: userId,
            title: 'New Chat',
            personality_mode: effectivePersona,
            is_archived: false
          }])
          .select('id')
          .single()

        if (sessionError) throw new Error('Failed to create chat session')
        currentSessionId = newSession.id
        isNewSession = true
      }
    }

    // The request's mode should win immediately for this turn.
    // We still read session metadata for counts, then persist the request mode
    // back to the session server-side so the app does not need to race a patch.
    let finalPersona = effectivePersona
    let sessionMessageCount = 0
    try {
      const { data: sessionRow } = await supabaseClient
        .from('chat_sessions')
        .select('personality_mode, message_count')
        .eq('id', currentSessionId)
        .eq('user_id', userId)
        .single()
      sessionMessageCount = Number(sessionRow?.message_count || 0)
      const persistedPersona = sessionRow?.personality_mode
        ? normalizePersona(sessionRow.personality_mode)
        : null
      if (persistedPersona !== finalPersona) {
        await supabaseClient
          .from('chat_sessions')
          .update({ personality_mode: finalPersona })
          .eq('id', currentSessionId)
          .eq('user_id', userId)
      }
    } catch (_) {
      // ignore and keep effectivePersona
    }

    logChatContextEvent('session_baseline', {
      requestId,
      userToken,
      sessionToken: getAnonymousSessionToken(currentSessionId),
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      isNewSession,
      forceNewSession: Boolean(shouldForceNewSession),
      reusedExistingSession: !isNewSession && Boolean(currentSessionId),
      persona: finalPersona,
    })
    incrementChatContextCounter('chat_context_session_resolved_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      isNewSession,
    })

    let chatContextState = createDefaultChatContextStateV1()
    let chatContextRevision = 0
    let chatContextSummaryUpdatedAt: string | null = null
    let chatContextAvailable = false

    const jsonChatResponse = (responseText: string, confidence: 'low' | 'medium' | 'high' = 'high', status = 200) =>
      new Response(JSON.stringify({
        response: responseText,
        sessionId: currentSessionId,
        confidence,
      }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })

    const streamTextResponse = (text: string, confidence: 'low' | 'medium' | 'high' = 'high') =>
      isStructuredJsonResponseText(text)
        ? jsonChatResponse(text, confidence)
        : createSSEResponse(async (send) => {
            await send({ type: 'delta', text })
            await send({ type: 'done', sessionId: currentSessionId, confidence })
          })

    const maybeUpdateSessionTitle = async (userText: string, assistantText: string) => {
      if (!isNewSession) return
      try {
        const title = await generateChatTitle(userText, assistantText)
        await supabaseClient
          .from('chat_sessions')
          .update({ title })
          .eq('id', currentSessionId)
          .eq('user_id', userId)
      } catch (titleError) {
        console.error('Error generating title:', titleError)
      }
    }

    const returnDirectTextReply = async (
      responseText: string,
      confidence: 'low' | 'medium' | 'high' = 'high',
    ) => {
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: responseText,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence,
          },
        ])
        await maybeUpdateSessionTitle(message, responseText)
      } catch (saveError) {
        console.error('Error saving direct reply:', saveError)
      }

      return useStreaming
        ? streamTextResponse(responseText, confidence)
        : jsonChatResponse(responseText, confidence)
    }

    const applyAffordResultToContextState = (
      baseState: ChatContextStateV1,
      advisorData: any,
      sourceMessage: string,
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'afford_check'
      bumpChatContextRecentTopic(nextState, 'afford_check')

      const itemName = typeof advisorData?.input?.itemName === 'string' && advisorData.input.itemName.trim().length > 0
        ? advisorData.input.itemName.trim()
        : (extractAffordItemNameFromMessage(sourceMessage) || getSlotStringValue(baseState, 'afford_check', 'itemName'))
      const amountCents = typeof advisorData?.input?.amount === 'number' && Number.isFinite(advisorData.input.amount) && advisorData.input.amount > 0
        ? Math.round(advisorData.input.amount * 100)
        : (extractPrimaryNonMonthlyAmountCents(sourceMessage) ?? getSlotNumberValue(baseState, 'afford_check', 'amount'))

      if (itemName) {
        setChatContextSlot(nextState, 'afford_check', 'itemName', createChatContextSlotState(
          itemName,
          'text',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ))
      }

      if (amountCents != null) {
        setChatContextSlot(nextState, 'afford_check', 'amount', createChatContextSlotState(
          amountCents,
          'money',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: sourceMessage }
        ), { clearOtherScope: true })
      }

      if (typeof advisorData?.clarifyingQuestion === 'string' && advisorData.clarifyingQuestion.trim().length > 0) {
        setChatContextOpenQuestion(nextState, 'afford_check', 'amount', advisorData.clarifyingQuestion.trim())
      } else {
        clearChatContextOpenQuestion(nextState, 'afford_check')
      }

      return nextState
    }

    const applyVacationPlannerResultToContextState = (
      baseState: ChatContextStateV1,
      payload: { vacationName?: string; costCents?: number; targetMonth?: string },
      plannerData: any,
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'vacation_affordability'
      bumpChatContextRecentTopic(nextState, 'vacation_affordability')

      const vacationName = payload.vacationName || plannerData?.vacationName || getSlotStringValue(baseState, 'vacation_affordability', 'vacationName') || 'Vacation'
      const costCents = typeof payload.costCents === 'number' && payload.costCents > 0
        ? payload.costCents
        : (typeof plannerData?.costCents === 'number' && plannerData.costCents > 0 ? plannerData.costCents : getSlotNumberValue(baseState, 'vacation_affordability', 'costCents'))
      const targetMonth = payload.targetMonth || plannerData?.targetMonth || getSlotStringValue(baseState, 'vacation_affordability', 'targetMonth')

      setChatContextSlot(nextState, 'vacation_affordability', 'vacationName', createChatContextSlotState(
        vacationName,
        'text',
        requestId,
        'user',
        sourceKind,
        { status: vacationName === 'Vacation' ? 'inferred' : 'declared', scope: 'committed', confidence: vacationName === 'Vacation' ? 0.7 : 0.95 }
      ))

      if (costCents != null) {
        setChatContextSlot(nextState, 'vacation_affordability', 'costCents', createChatContextSlotState(
          costCents,
          'money',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ), { clearOtherScope: true })
      }

      if (targetMonth) {
        setChatContextSlot(nextState, 'vacation_affordability', 'targetMonth', createChatContextSlotState(
          targetMonth,
          'month',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ), { clearOtherScope: true })
      }

      if (plannerData?.type === 'clarifying_question' && typeof plannerData?.question === 'string') {
        setChatContextOpenQuestion(
          nextState,
          'vacation_affordability',
          inferOpenQuestionSlotName('vacation_affordability', plannerData.question),
          plannerData.question
        )
      } else {
        clearChatContextOpenQuestion(nextState, 'vacation_affordability')
      }

      if (typeof plannerData?.requiredMonthlySavingCents === 'number' && plannerData.requiredMonthlySavingCents >= 0) {
        setChatContextSlot(nextState, 'vacation_affordability', 'requiredMonthlySavingCents', createChatContextSlotState(
          plannerData.requiredMonthlySavingCents,
          'money',
          requestId,
          'assistant',
          'deterministic_compute',
          { status: 'computed', scope: 'committed', confidence: 1 }
        ))
      }

      return nextState
    }

    const applySavingsPlannerResultToContextState = (
      baseState: ChatContextStateV1,
      payload: { targetSavingsCents?: number; targetMonth?: string },
      plannerData: any,
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'save_more_plan'
      bumpChatContextRecentTopic(nextState, 'save_more_plan')

      const targetSavingsCents = typeof payload.targetSavingsCents === 'number' && payload.targetSavingsCents > 0
        ? payload.targetSavingsCents
        : (typeof plannerData?.goalAmountCents === 'number' && plannerData.goalAmountCents > 0 ? plannerData.goalAmountCents : getSlotNumberValue(baseState, 'save_more_plan', 'targetSavingsCents'))
      const targetMonth =
        (typeof payload.targetMonth === 'string' && payload.targetMonth.trim().length > 0 ? payload.targetMonth.trim() : null) ||
        (typeof plannerData?.targetMonth === 'string' && plannerData.targetMonth.trim().length > 0 ? plannerData.targetMonth.trim() : null) ||
        getSlotStringValue(baseState, 'save_more_plan', 'targetMonth')

      if (targetSavingsCents != null) {
        setChatContextSlot(nextState, 'save_more_plan', 'targetSavingsCents', createChatContextSlotState(
          targetSavingsCents,
          'money',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ), { clearOtherScope: true })
      }

      if (targetMonth) {
        setChatContextSlot(nextState, 'save_more_plan', 'targetMonth', createChatContextSlotState(
          targetMonth,
          'month',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ), { clearOtherScope: true })
      }

      if (plannerData?.type === 'clarifying_question' && typeof plannerData?.question === 'string') {
        setChatContextOpenQuestion(nextState, 'save_more_plan', inferOpenQuestionSlotName('save_more_plan', plannerData.question), plannerData.question)
      } else {
        clearChatContextOpenQuestion(nextState, 'save_more_plan')
      }

      return nextState
    }

    const applyEmergencyFundResultToContextState = (
      baseState: ChatContextStateV1,
      emergencyData: any,
      sourceMessage: string,
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true,
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'emergency_fund'
      bumpChatContextRecentTopic(nextState, 'emergency_fund')

      const goalMonthsFromMessage = extractGoalMonthsFromMessage(sourceMessage)
      const goalMonths =
        goalMonthsFromMessage ??
        (typeof emergencyData?.requestedGoalMonths === 'number' && emergencyData.requestedGoalMonths > 0
          ? emergencyData.requestedGoalMonths
          : typeof emergencyData?.goalMonths === 'number' && emergencyData.goalMonths > 0
            ? emergencyData.goalMonths
            : getSlotNumberValue(baseState, 'emergency_fund', 'goalMonths'))
      const monthlyContributionFromMessage = detectWhatIfProjection(sourceMessage)
      const monthlyContributionUnits =
        monthlyContributionFromMessage ??
        (typeof emergencyData?.requestedMonthlyContribution === 'number' && emergencyData.requestedMonthlyContribution > 0
          ? emergencyData.requestedMonthlyContribution
          : null)
      const monthlyContributionCents = monthlyContributionUnits != null
        ? Math.round(monthlyContributionUnits * 100)
        : getSlotNumberValue(baseState, 'emergency_fund', 'monthlyContributionCents')

      if (goalMonths != null) {
        setChatContextSlot(nextState, 'emergency_fund', 'goalMonths', createChatContextSlotState(
          Math.max(1, Math.round(goalMonths)),
          'integer',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: sourceMessage }
        ), { clearOtherScope: true })
      }

      if (monthlyContributionCents != null && monthlyContributionCents > 0) {
        setChatContextSlot(nextState, 'emergency_fund', 'monthlyContributionCents', createChatContextSlotState(
          monthlyContributionCents,
          'money',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95, evidenceText: sourceMessage }
        ), { clearOtherScope: true })
      }

      clearChatContextOpenQuestion(nextState, 'emergency_fund')
      return nextState
    }

    const applyBudgetIntelligenceResultToContextState = (
      baseState: ChatContextStateV1,
      payload: { cycleType?: 'current' | 'next' | null },
      budgetData: any,
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true,
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'budget_intel'
      bumpChatContextRecentTopic(nextState, 'budget_intel')

      const responseText = typeof budgetData?.message === 'string'
        ? budgetData.message.trim()
        : ''
      const cycleType =
        payload.cycleType ??
        normalizeBudgetCycleType(budgetData?.recommendations?.metadata?.cycleType) ??
        normalizeBudgetCycleType(getSlotStringValue(baseState, 'budget_intel', 'cycleType'))

      if (cycleType) {
        setChatContextSlot(nextState, 'budget_intel', 'cycleType', createChatContextSlotState(
          cycleType,
          'text',
          requestId,
          'user',
          sourceKind,
          { status: 'declared', scope: 'committed', confidence: 0.95 }
        ), { clearOtherScope: true })
      }

      if (responseText && /would you like me to set budget caps|plan for next month|set caps for the remaining days/i.test(responseText)) {
        setChatContextOpenQuestion(nextState, 'budget_intel', 'cycleType', responseText)
      } else {
        clearChatContextOpenQuestion(nextState, 'budget_intel')
      }

      return nextState
    }

    const applyCashFlowResultToContextState = (
      baseState: ChatContextStateV1,
      timeframe: 'current_cycle' | 'last_cycle' | 'this_year',
      sourceKind: 'manual' | 'preset' | 'resolver',
      incrementTurn = true,
    ): ChatContextStateV1 => {
      const nextState = cloneChatContextState(baseState)
      if (incrementTurn) nextState.turnCounter += 1
      nextState.activeIntent = 'cash_flow'
      bumpChatContextRecentTopic(nextState, 'cash_flow')

      setChatContextSlot(nextState, 'cash_flow', 'timeframe', createChatContextSlotState(
        timeframe,
        'text',
        requestId,
        'user',
        sourceKind,
        { status: 'declared', scope: 'committed', confidence: 0.95 }
      ), { clearOtherScope: true })

      clearChatContextOpenQuestion(nextState, 'cash_flow')
      return nextState
    }

    const applyGeneralChatTurnToContextState = (
      baseState: ChatContextStateV1,
      userMessage: string,
      assistantMessage: string,
      previousAssistantMessage: string | null,
      sourceKind: 'manual' | 'preset' | 'resolver' = 'manual',
    ): { state: ChatContextStateV1; changed: boolean } => {
      const trimmedUser = String(userMessage || '').trim()
      const trimmedAssistant = String(assistantMessage || '').trim()
      if (!trimmedUser && !trimmedAssistant) {
        return { state: baseState, changed: false }
      }

      const nextState = cloneChatContextState(baseState)
      let changed = false

      const continuityCue = containsContinuityCue(trimmedUser)
      const overrideCue = containsOverrideCue(trimmedUser)
      const whatIfCue = containsWhatIfCue(trimmedUser)
      const affirmativeContinuation =
        isAffirmativeFollowUpReply(trimmedUser) &&
        isAssistantOfferOrQuestion(previousAssistantMessage || '')
      const directTopic = detectGeneralChatTopic(trimmedUser)
      const carryTopic =
        !directTopic && (continuityCue || affirmativeContinuation || isShortReply(trimmedUser))
          ? detectGeneralChatTopic(previousAssistantMessage || '')
          : null
      const nextTopic = directTopic || carryTopic
      const currentTopic = getSlotStringValue(nextState, 'general_chat', 'activeTopic')
      const topicSwitched = Boolean(
        currentTopic &&
        nextTopic &&
        currentTopic !== nextTopic &&
        !continuityCue &&
        !affirmativeContinuation
      )

      if (nextTopic && nextTopic !== currentTopic) {
        setChatContextSlot(nextState, 'general_chat', 'activeTopic', createChatContextSlotState(
          nextTopic,
          'text',
          requestId,
          'user',
          sourceKind,
          { status: 'inferred', scope: 'committed', confidence: directTopic ? 0.92 : 0.78, evidenceText: trimmedUser }
        ), { clearOtherScope: true })
        changed = true
      }

      if (topicSwitched) {
        for (const slotName of ['acceptedPlanBranch', 'comparisonPeriod', 'pendingQuestion']) {
          if (getChatContextSlot(nextState, 'general_chat', slotName, 'committed')) {
            removeChatContextSlot(nextState, 'general_chat', slotName, 'committed')
            changed = true
          }
        }
        if (getChatContextSlot(nextState, 'general_chat', 'scenarioAssumption', 'working')) {
          removeChatContextSlot(nextState, 'general_chat', 'scenarioAssumption', 'working')
          changed = true
        }
      }

      const planningMessage = looksLikeGeneralPlanningMessage(trimmedUser)
      const amountCents = planningMessage
        ? (extractPrimaryMonthlyAmountCents(trimmedUser) ?? extractPrimaryNonMonthlyAmountCents(trimmedUser))
        : null
      if (amountCents != null) {
        const amountScope: SlotScope = whatIfCue ? 'working' : 'committed'
        setChatContextSlot(nextState, 'general_chat', 'targetAmountCents', createChatContextSlotState(
          amountCents,
          'money',
          requestId,
          'user',
          sourceKind,
          {
            status: whatIfCue ? 'hypothetical' : 'declared',
            scope: amountScope,
            confidence: 0.9,
            evidenceText: trimmedUser,
          }
        ), { clearOtherScope: overrideCue || amountScope === 'committed' })
        changed = true
      }

      const targetMonth = planningMessage ? extractTargetMonthFromMessage(trimmedUser) : null
      if (targetMonth) {
        setChatContextSlot(nextState, 'general_chat', 'targetMonth', createChatContextSlotState(
          targetMonth,
          'month',
          requestId,
          'user',
          sourceKind,
          {
            status: 'declared',
            scope: 'committed',
            confidence: 0.92,
            evidenceText: trimmedUser,
          }
        ), { clearOtherScope: true })
        changed = true
      }

      const comparisonPeriod = extractGeneralComparisonPeriod(trimmedUser)
      if (comparisonPeriod) {
        setChatContextSlot(nextState, 'general_chat', 'comparisonPeriod', createChatContextSlotState(
          comparisonPeriod,
          'text',
          requestId,
          'user',
          sourceKind,
          {
            status: 'declared',
            scope: 'committed',
            confidence: 0.9,
            evidenceText: trimmedUser,
          }
        ), { clearOtherScope: true })
        changed = true
      }

      const scenarioAssumptionDetected = whatIfCue || /\b(assume|assuming|suppose|let's say|lets say)\b/i.test(trimmedUser)
      if (scenarioAssumptionDetected) {
        setChatContextSlot(nextState, 'general_chat', 'scenarioAssumption', createChatContextSlotState(
          compactPromptExcerpt(trimmedUser, 180),
          'text',
          requestId,
          'user',
          sourceKind,
          {
            status: 'hypothetical',
            scope: 'working',
            confidence: 0.9,
            evidenceText: trimmedUser,
          }
        ), { clearOtherScope: true })
        changed = true
      } else if ((topicSwitched || overrideCue) && getChatContextSlot(nextState, 'general_chat', 'scenarioAssumption', 'working')) {
        removeChatContextSlot(nextState, 'general_chat', 'scenarioAssumption', 'working')
        changed = true
      }

      if (affirmativeContinuation) {
        const acceptedPlanBranch = inferAcceptedPlanBranchLabel(previousAssistantMessage || '')
        if (acceptedPlanBranch) {
          setChatContextSlot(nextState, 'general_chat', 'acceptedPlanBranch', createChatContextSlotState(
            acceptedPlanBranch,
            'text',
            requestId,
            'assistant',
            'deterministic_compute',
            {
              status: 'confirmed',
              scope: 'committed',
              confidence: 0.88,
              evidenceText: compactPromptExcerpt(previousAssistantMessage || '', 180),
            }
          ), { clearOtherScope: true })
          changed = true
        }
      }

      if (getChatContextSlot(nextState, 'general_chat', 'pendingQuestion', 'committed')) {
        removeChatContextSlot(nextState, 'general_chat', 'pendingQuestion', 'committed')
        changed = true
      }

      const pendingQuestion = extractAssistantFollowUpQuestion(trimmedAssistant)
      if (pendingQuestion) {
        setChatContextSlot(nextState, 'general_chat', 'pendingQuestion', createChatContextSlotState(
          pendingQuestion,
          'text',
          requestId,
          'assistant',
          'deterministic_compute',
          {
            status: 'inferred',
            scope: 'committed',
            confidence: 0.84,
            evidenceText: pendingQuestion,
          }
        ), { clearOtherScope: true })
        changed = true
      }

      if (!changed) {
        return { state: baseState, changed: false }
      }

      nextState.turnCounter += 1
      return { state: nextState, changed: true }
    }

    const getBudgetResponseText = (budgetData: any): string =>
      budgetData && typeof budgetData.message === 'string' && budgetData.message.trim().length > 0
        ? budgetData.message
        : JSON.stringify(budgetData)

    const mergeContextStatesForRetry = (latestState: ChatContextStateV1, desiredState: ChatContextStateV1): ChatContextStateV1 => {
      const merged = cloneChatContextState(latestState)
      merged.activeIntent = desiredState.activeIntent
      merged.activeDigestHandoff = desiredState.activeDigestHandoff || latestState.activeDigestHandoff || null
      merged.openQuestion = desiredState.openQuestion
      merged.turnCounter = Math.max(latestState.turnCounter, desiredState.turnCounter)
      merged.recentTopics = desiredState.recentTopics
      merged.summary = desiredState.summary
      merged.rollingSummary = desiredState.rollingSummary

      for (const [intentKey, slotMap] of Object.entries(desiredState.slots || {})) {
        if (!slotMap || !isPlainObject(slotMap)) continue
        const intent = intentKey as ChatContextIntent
        merged.slots[intent] = {
          ...(merged.slots[intent] || {}),
          ...slotMap,
        }
      }

      return pruneChatContextState(merged)
    }

    const persistContextState = async (nextState: ChatContextStateV1, reason: string) => {
      if (!CHAT_CONTEXT_V2_ENABLED || !chatContextAvailable || !currentSessionId) return

      try {
        const previousState = chatContextState
        let stateToWrite = pruneChatContextState(nextState)
        let revisionToMatch = chatContextRevision
        let summaryCursor = chatContextSummaryUpdatedAt
        let attemptedRetry = false

        while (true) {
          const summaryResult = maybeRefreshContextSummary(previousState, stateToWrite, summaryCursor)
          stateToWrite = summaryResult.state
          summaryCursor = summaryResult.summaryUpdatedAt

          const { data: updatedRow, error: updateError } = await supabaseClient
            .from('chat_sessions')
            .update({
              context_state: stateToWrite,
              context_state_rev: revisionToMatch + 1,
              context_state_updated_at: toIsoNow(),
              summary_updated_at: summaryCursor,
            })
            .eq('id', currentSessionId)
            .eq('user_id', userId)
            .eq('context_state_rev', revisionToMatch)
            .select('context_state_rev, summary_updated_at')
            .maybeSingle()

          if (updateError) {
            throw updateError
          }

          if (updatedRow) {
            chatContextState = stateToWrite
            chatContextRevision = Number(updatedRow.context_state_rev) || (revisionToMatch + 1)
            chatContextSummaryUpdatedAt = updatedRow.summary_updated_at || summaryCursor
            logChatContextEvent('context_state_write_success', {
              requestId,
              sessionToken: getAnonymousSessionToken(currentSessionId),
              reason,
              revision: chatContextRevision,
              chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
            })
            return
          }

          if (attemptedRetry) {
            incrementChatContextCounter('context_state_write_conflict_total', {
              chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
              reason,
            })
            logChatContextEvent('context_state_write_conflict', {
              requestId,
              sessionToken: getAnonymousSessionToken(currentSessionId),
              reason,
              revision: revisionToMatch,
              chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
            })
            return
          }

          attemptedRetry = true
          const { data: latestRow, error: reloadError } = await supabaseClient
            .from('chat_sessions')
            .select('context_state, context_state_rev, summary_updated_at')
            .eq('id', currentSessionId)
            .eq('user_id', userId)
            .maybeSingle()

          if (reloadError || !latestRow) {
            throw reloadError || new Error('Failed to reload context state for retry')
          }

          const latestState = pruneChatContextState(migrateContextStateToV1(latestRow.context_state))
          revisionToMatch = Number(latestRow.context_state_rev) || 0
          summaryCursor = latestRow.summary_updated_at || null
          stateToWrite = mergeContextStatesForRetry(latestState, stateToWrite)
        }
      } catch (contextWriteError) {
        incrementChatContextCounter('context_state_write_failed_total', {
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
          reason,
        })
        logChatContextEvent('context_state_write_failed', {
          requestId,
          sessionToken: getAnonymousSessionToken(currentSessionId),
          reason,
          error: safeErrorMessage(contextWriteError),
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })
      }
    }

    const prepareRollingSessionSummary = async (
      sourceRecentMessages: RecentChatMessageRow[],
      totalMessageCount: number,
    ): Promise<{
      state: ChatContextStateV1
      recentMessages: RecentChatMessageRow[]
      visibleWindowLimit: number
      historyCharEstimate: number
      usedRollingSummary: boolean
    }> => {
      const historyCharEstimate = estimateModelHistoryChars(sourceRecentMessages)
      const existingRollingSummary = chatContextState.rollingSummary
      const shouldCompactByChars =
        totalMessageCount > ROLLING_SUMMARY_COMPACT_WINDOW_LIMIT &&
        historyCharEstimate > ROLLING_SUMMARY_HISTORY_CHAR_BUDGET
      const keepCompactWindow =
        totalMessageCount <= ROLLING_SUMMARY_RECENT_WINDOW_LIMIT &&
        (existingRollingSummary.lastIncludedMessageCount || 0) > 0
      const visibleWindowLimit = totalMessageCount > ROLLING_SUMMARY_RECENT_WINDOW_LIMIT
        ? ROLLING_SUMMARY_RECENT_WINDOW_LIMIT
        : (shouldCompactByChars || keepCompactWindow)
          ? ROLLING_SUMMARY_COMPACT_WINDOW_LIMIT
          : totalMessageCount

      const trimmedRecentMessages = sourceRecentMessages.slice(0, Math.min(visibleWindowLimit, sourceRecentMessages.length))
      const olderMessageCount = Math.max(0, totalMessageCount - visibleWindowLimit)

      if (!CHAT_CONTEXT_V2_ENABLED || !chatContextAvailable || !currentSessionId || olderMessageCount <= 0) {
        return {
          state: chatContextState,
          recentMessages: trimmedRecentMessages,
          visibleWindowLimit,
          historyCharEstimate,
          usedRollingSummary: false,
        }
      }

      const alreadyCoveredCount = Math.max(0, existingRollingSummary.lastIncludedMessageCount || 0)
      const summaryAlreadyCurrent =
        existingRollingSummary.text.trim().length > 0 &&
        alreadyCoveredCount >= olderMessageCount

      if (summaryAlreadyCurrent) {
        return {
          state: chatContextState,
          recentMessages: trimmedRecentMessages,
          visibleWindowLimit,
          historyCharEstimate,
          usedRollingSummary: true,
        }
      }

      const chunkStart = alreadyCoveredCount
      const chunkEnd = olderMessageCount - 1
      if (chunkEnd < chunkStart) {
        return {
          state: chatContextState,
          recentMessages: trimmedRecentMessages,
          visibleWindowLimit,
          historyCharEstimate,
          usedRollingSummary: existingRollingSummary.text.trim().length > 0,
        }
      }

      try {
        const { data: summaryChunkRows, error: summaryChunkError } = await supabaseClient
          .from('chat_messages')
          .select('content, is_from_user, created_at')
          .eq('session_id', currentSessionId)
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .range(chunkStart, chunkEnd)

        if (summaryChunkError || !summaryChunkRows || summaryChunkRows.length === 0) {
          throw summaryChunkError || new Error('No summary chunk rows found')
        }

        const olderConversationChunk = buildSummaryTranscript(summaryChunkRows as RecentChatMessageRow[])
        if (!olderConversationChunk) {
          return {
            state: chatContextState,
            recentMessages: trimmedRecentMessages,
            visibleWindowLimit,
            historyCharEstimate,
            usedRollingSummary: existingRollingSummary.text.trim().length > 0,
          }
        }

        const rollingSummaryPrompt = buildRollingSummaryPrompt(
          existingRollingSummary.text,
          olderConversationChunk,
        )

        const summaryResponse = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
          contents: [{
            parts: [{ text: rollingSummaryPrompt }],
          }],
        })

        if (!summaryResponse.ok) {
          const errorData = await summaryResponse.text()
          throw new Error(`Rolling summary generation failed: ${summaryResponse.status} - ${errorData}`)
        }

        const summaryData = await summaryResponse.json()
        const updatedSummaryText = normalizeRollingSummaryText(summaryData.candidates?.[0]?.content?.parts?.[0]?.text)
        if (!updatedSummaryText) {
          throw new Error('Rolling summary generation returned empty text')
        }

        const nextState = cloneChatContextState(chatContextState)
        nextState.rollingSummary = {
          text: updatedSummaryText,
          updatedAt: toIsoNow(),
          lastIncludedMessageCount: olderMessageCount,
        }

        await persistContextState(nextState, 'rolling_summary_refresh')

        return {
          state: nextState,
          recentMessages: trimmedRecentMessages,
          visibleWindowLimit,
          historyCharEstimate,
          usedRollingSummary: true,
        }
      } catch (rollingSummaryError) {
        console.warn('[ai-chat] rolling summary refresh skipped', safeErrorMessage(rollingSummaryError))
        return {
          state: chatContextState,
          recentMessages: trimmedRecentMessages,
          visibleWindowLimit,
          historyCharEstimate,
          usedRollingSummary: existingRollingSummary.text.trim().length > 0,
        }
      }
    }

    const hydrateContextFromRecentMessages = async () => {
      if (!CHAT_CONTEXT_V2_ENABLED || !chatContextAvailable || !currentSessionId) return
      if (chatContextState.activeDigestHandoff || chatContextState.activeIntent || Object.keys(chatContextState.slots).length > 0) return

      try {
        const { data: recentMessages, error: recentError } = await supabaseClient
          .from('chat_messages')
          .select('content, is_from_user')
          .eq('session_id', currentSessionId)
          .order('created_at', { ascending: false })
          .limit(12)

        if (recentError || !recentMessages) return

        for (const row of recentMessages) {
          if (row?.is_from_user) continue

          if (typeof row.content === 'string' && row.content.startsWith('AFFORD_STATE|')) {
            const affordState = extractAffordStateFromAssistantMessage(row.content)
            if (affordState?.type === 'afford_check') {
              chatContextState = applyAffordResultToContextState(chatContextState, affordState, '', 'resolver', false)
              logChatContextEvent('context_state_hydrated_from_history', {
                requestId,
                sessionToken: getAnonymousSessionToken(currentSessionId),
                intent: 'afford_check',
                chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
              })
              return
            }
          }

          if (typeof row.content !== 'string' || !row.content.trim().startsWith('{')) continue

          try {
            const parsed = JSON.parse(row.content)
            if (parsed?.type === 'vacation_plan') {
              chatContextState = applyVacationPlannerResultToContextState(chatContextState, {
                vacationName: typeof parsed.vacationName === 'string' ? parsed.vacationName : undefined,
                costCents: typeof parsed.costCents === 'number' ? parsed.costCents : undefined,
                targetMonth: typeof parsed.targetMonth === 'string' ? parsed.targetMonth : undefined,
              }, parsed, 'resolver', false)
              logChatContextEvent('context_state_hydrated_from_history', {
                requestId,
                sessionToken: getAnonymousSessionToken(currentSessionId),
                intent: 'vacation_affordability',
                chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
              })
              return
            }

            if (parsed?.type === 'savings_plan') {
              chatContextState = applySavingsPlannerResultToContextState(chatContextState, {
                targetSavingsCents: typeof parsed.goalAmountCents === 'number' ? parsed.goalAmountCents : undefined,
                targetMonth: typeof parsed.targetMonth === 'string' ? parsed.targetMonth : undefined,
              }, parsed, 'resolver', false)
              logChatContextEvent('context_state_hydrated_from_history', {
                requestId,
                sessionToken: getAnonymousSessionToken(currentSessionId),
                intent: 'save_more_plan',
                chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
              })
              return
            }

            if (parsed?.type === 'afford_check') {
              chatContextState = applyAffordResultToContextState(chatContextState, parsed, '', 'resolver', false)
              logChatContextEvent('context_state_hydrated_from_history', {
                requestId,
                sessionToken: getAnonymousSessionToken(currentSessionId),
                intent: 'afford_check',
                chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
              })
              return
            }
          } catch {
            // ignore invalid JSON assistant messages
          }
        }
      } catch (hydrateError) {
        logChatContextEvent('context_state_hydration_failed', {
          requestId,
          sessionToken: getAnonymousSessionToken(currentSessionId),
          error: safeErrorMessage(hydrateError),
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })
      }
    }

    if (CHAT_CONTEXT_V2_ENABLED && currentSessionId) {
      try {
        const { data: contextRow, error: contextError } = await supabaseClient
          .from('chat_sessions')
          .select('context_state, context_state_rev, summary_updated_at')
          .eq('id', currentSessionId)
          .eq('user_id', userId)
          .maybeSingle()

        if (contextError || !contextRow) {
          throw contextError || new Error('Context row not found')
        }

        const migratedState = pruneChatContextState(migrateContextStateToV1(contextRow.context_state))
        if (!isChatContextStateV1(contextRow.context_state)) {
          incrementChatContextCounter('context_state_migrated_total', {
            chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
          })
          logChatContextEvent('context_state_migrated', {
            requestId,
            sessionToken: getAnonymousSessionToken(currentSessionId),
            chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
          })
        }

        chatContextState = migratedState
        chatContextRevision = Number(contextRow.context_state_rev) || 0
        chatContextSummaryUpdatedAt = contextRow.summary_updated_at || null
        chatContextAvailable = true
        await hydrateContextFromRecentMessages()
      } catch (contextReadError) {
        incrementChatContextCounter('context_state_read_failed_total', {
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })
        logChatContextEvent('context_state_read_failed', {
          requestId,
          sessionToken: getAnonymousSessionToken(currentSessionId),
          error: safeErrorMessage(contextReadError),
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })
        chatContextAvailable = false
      }
    }

    if (trustedRequestDigestHandoff && CHAT_CONTEXT_V2_ENABLED && chatContextAvailable && currentSessionId) {
      const nextState = cloneChatContextState(chatContextState)
      nextState.activeDigestHandoff = trustedRequestDigestHandoff
      await persistContextState(nextState, 'digest_handoff_attached')
    }

    // =========================================================================
    // BUDGET FLOW (after session setup so messages can be persisted to DB)
    //
    // Handles two cases:
    //   A) isBudgetBuildPrompt: user said "create a budget" etc. Ã¢â€ â€™ ask cycle question
    //      AND save both messages so the next reply can detect context.
    //   B) isCycleReply: user replied "this month"/"next month" Ã¢â€ â€™ look up last AI
    //      message from DB (saved in case A) Ã¢â€ â€™ force build_budget_plan.
    // =========================================================================

    if (isBudgetBuildPrompt) {
      console.log('[ai-chat] Ã°Å¸â€™Â° Budget build prompt detected Ã¢â‚¬â€ calling build_budget_plan')

      const budgetIntelligenceUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-budget-intelligence`
      const budgetResponse = await fetch(budgetIntelligenceUrl, {
        method: 'POST',
        headers: {
          'Authorization': req.headers.get('Authorization') || '',
          'apikey': Deno.env.get('SUPABASE_ANON_KEY') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          intent: 'build_budget_plan',
          sessionId: currentSessionId,
          timezone: body.timezone,
          timeframe: 'dual_month_window',
          cycleType: body.cycleType || null,
          message: message || ''
        })
      })

      if (!budgetResponse.ok) {
        console.error('[ai-chat] Ã¢ÂÅ’ build_budget_plan failed:', budgetResponse.status)
        // Fall through to Gemini rather than crash
      } else {
        const budgetData = await budgetResponse.json()

        const responseText = getBudgetResponseText(budgetData)

        // Ã¢Å“â€¦ KEY FIX: Persist both messages so the cycle-reply intercept can detect context next turn.
        let aiMessageId = null
        try {
          await supabaseClient.from('chat_messages').insert([
            { session_id: currentSessionId, user_id: userId, content: message, is_from_user: true, personality_mode: finalPersona, created_at: new Date().toISOString() }
          ])

          const { data: aiRows } = await supabaseClient.from('chat_messages').insert([
            { session_id: currentSessionId, user_id: userId, content: responseText, is_from_user: false, personality_mode: finalPersona, created_at: new Date(Date.now() + 1).toISOString(), confidence: 'high' }
          ]).select('id').limit(1)

          aiMessageId = aiRows?.[0]?.id ?? null
          console.log('[ai-chat] Ã¢Å“â€¦ Budget prompt messages saved to chat_messages (cycle question will be detectable), aiMessageId:', aiMessageId)
        } catch (saveErr) {
          console.error('[ai-chat] Ã¢ÂÅ’ Failed to persist budget prompt messages:', saveErr)
        }

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          const nextContextState = applyBudgetIntelligenceResultToContextState(chatContextState, {
            cycleType: normalizeBudgetCycleType(body.cycleType),
          }, budgetData, message.trim().startsWith('{') ? 'preset' : 'manual')
          await persistContextState(nextContextState, 'budget_build_prompt')
        }

        return new Response(JSON.stringify({
          response: responseText,
          sessionId: currentSessionId,
          confidence: null,
          aiMessageId
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })
      }
    }

    // -------------------------------------------------------------------------
    // Cycle-reply intercept: "this month" / "next month" after cycle question
    // -------------------------------------------------------------------------
    const isCycleReply =
      normalizedMessage === 'this month' || normalizedMessage === 'next month'

    if (isCycleReply && currentSessionId) {
      console.log('[ai-chat] cycle-reply candidate detected:', normalizedMessage)

      // Fetch the most recent AI message in this session
      const { data: lastAiMessages } = await supabaseClient
        .from('chat_messages')
        .select('content')
        .eq('session_id', currentSessionId)
        .eq('user_id', userId)
        .eq('is_from_user', false)
        .order('created_at', { ascending: false })
        .limit(1)

      const lastAiContent = (lastAiMessages?.[0]?.content ?? '').toLowerCase()
      console.log('[ai-chat] last AI message (first 120 chars):', lastAiContent.slice(0, 120))

      // Detect cycle question phrasing (covers both template variants)
      const wasCycleQuestion =
        lastAiContent.includes('days left in your current cycle') ||
        lastAiContent.includes('plan ahead for next month') ||
        lastAiContent.includes('set caps for the remaining days') ||
        (lastAiContent.includes('this month') && lastAiContent.includes('next month') &&
          (lastAiContent.includes('budget caps') || lastAiContent.includes('set caps') ||
            lastAiContent.includes('remaining days') || lastAiContent.includes('budget')))

      if (wasCycleQuestion) {
        const cycleType = normalizedMessage === 'this month' ? 'current' : 'next'
        console.log('[ai-chat] Ã¢Å“â€¦ Cycle question confirmed Ã¢â‚¬â€ forcing build_budget_plan, cycleType=' + cycleType)

        const budgetIntelligenceUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-budget-intelligence`
        const budgetResponse = await fetch(budgetIntelligenceUrl, {
          method: 'POST',
          headers: {
            'Authorization': req.headers.get('Authorization') || '',
            'apikey': Deno.env.get('SUPABASE_ANON_KEY') || '',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            intent: 'build_budget_plan',
            sessionId: currentSessionId,
            cycleType,
            message
          })
        })

        if (!budgetResponse.ok) {
          console.error('[ai-chat] Ã¢ÂÅ’ build_budget_plan failed:', budgetResponse.status)
          // Fall through to Gemini rather than crash
        } else {
          const budgetData = await budgetResponse.json()

          const responseText = getBudgetResponseText(budgetData)

          // Persist user + AI messages
          let aiMessageId = null
          try {
            await supabaseClient.from('chat_messages').insert([
              { session_id: currentSessionId, user_id: userId, content: message, is_from_user: true, personality_mode: finalPersona, created_at: new Date().toISOString() }
            ])

            const { data: aiRows } = await supabaseClient.from('chat_messages').insert([
              { session_id: currentSessionId, user_id: userId, content: responseText, is_from_user: false, personality_mode: finalPersona, created_at: new Date(Date.now() + 1).toISOString(), confidence: 'high' }
            ]).select('id').limit(1)

            aiMessageId = aiRows?.[0]?.id ?? null
          } catch (saveErr) {
            console.error('[ai-chat] Ã¢ÂÅ’ Failed to persist cycle reply messages:', saveErr)
          }

          if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
            const nextContextState = applyBudgetIntelligenceResultToContextState(chatContextState, {
              cycleType,
            }, budgetData, message.trim().startsWith('{') ? 'preset' : 'manual')
            await persistContextState(nextContextState, 'budget_cycle_reply')
          }

          // Do not stream structured budget-card JSON. Android renders the card
          // after receiving the complete payload.
          return new Response(JSON.stringify({
            response: responseText,
            sessionId: currentSessionId,
            confidence: 'high',
            aiMessageId
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          })
        }
      } else {
        console.log('[ai-chat] Ã¢Å¡Â Ã¯Â¸Â Cycle-reply: last AI message not cycle question Ã¢â‚¬â€ fallback to Gemini. Content:', lastAiContent.slice(0, 80))
      }
    }

    // Friendly greeting sensitivity: short, mode-aware reply for casual greetings
    const displayNameRaw = (user as any)?.user_metadata?.full_name || (user as any)?.user_metadata?.name || user.email?.split('@')[0] || null
    const firstName = (displayNameRaw ? String(displayNameRaw).split(' ')[0] : 'there') as string
    const normalized = String(message || '').trim().toLowerCase()
    const isGreetingOnly = isGreetingLike(normalized)
    if (isGreetingOnly && sessionMessageCount === 0) {
      let greeting: string
      switch (finalPersona) {
        case 'coach':
          greeting = `Hello ${firstName}. What should we tackle first?`
          break
        case 'companion':
          greeting = `Hey ${firstName}. What would you like help with today?`
          break
        default:
          greeting = `Hey ${firstName}. What would you like help with today?`
      }
      // Save both user greeting and AI response
      try {
        const { error: userErr } = await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString()
          }
        ])
        const { error: aiErr } = await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: greeting,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            // Greeting replies are deterministic and safe Ã¢â€ â€™ mark as high confidence
            confidence: 'high'
          }
        ])
        if (userErr || aiErr) {
          console.error('Ã¢ÂÅ’ Greeting save error:', userErr || aiErr)
        } else if (isNewSession) {
          // Auto-generate title on first exchange (await for correctness)
          try {
            const title = await generateChatTitle(message, greeting)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleErr) {
            console.error('Ã¢ÂÅ’ Greeting title error:', titleErr)
          }
        }
      } catch (saveErr) {
        console.error('Ã¢ÂÅ’ Greeting persist error:', saveErr)
      }

      // Return greeting (streaming or JSON based on client request)
      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: greeting })
          await send({ type: 'done', sessionId: currentSessionId, confidence: 'high' })
        })
      }

      return new Response(JSON.stringify({ response: greeting, sessionId: currentSessionId }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    // =========================================================================
    // PHASE 4: Emergency Fund Intelligence routing (runs BEFORE generic routing)
    // Return JSON as a string so Android can render EmergencyFundCard.
    // =========================================================================
    const whatIfMonthlyAmount = detectWhatIfProjection(message)
    const hasEmergencyFundContext =
      chatContextState.activeIntent === 'emergency_fund' ||
      chatContextState.openQuestion?.intent === 'emergency_fund' ||
      getSlotNumberValue(chatContextState, 'emergency_fund', 'goalMonths') != null ||
      getSlotNumberValue(chatContextState, 'emergency_fund', 'monthlyContributionCents') != null
    const isExplicitEmergencyFundAction =
      action === 'emergency_fund' ||
      (actionObj && actionObj.action === 'emergency_fund')
    const isPresetEmergencyFundRequest =
      isPresetInput && detectEmergencyFundIntent(message)
    const shouldRouteEmergencyFund =
      isExplicitEmergencyFundAction ||
      isPresetEmergencyFundRequest ||
      (hasEmergencyFundContext && (isEmergencyFundTipsRequest(message) || whatIfMonthlyAmount !== null))

    if (shouldRouteEmergencyFund) {
      console.log('[ai-chat] Ã°Å¸Å¡Â¨ Emergency fund intent detected', { whatIfMonthlyAmount })

      try {
        const inputs = extractEmergencyFundDialogInputs(message)
        const includeTips = isEmergencyFundTipsRequest(message) || whatIfMonthlyAmount !== null

        console.log('[ai-chat] Ã°Å¸Å¡Â¨ emergency-fund payload', {
          goalMonths: inputs.goalMonths,
          includeTips,
          monthlyContribution: whatIfMonthlyAmount,
        })

        const { data: emergencyData, error: emergencyError } = await supabaseClient.functions.invoke('emergency-fund-intelligence', {
          body: {
            goalMonths: inputs.goalMonths,
            monthlyContribution: whatIfMonthlyAmount,
            includeTips,
          },
          headers: {
            Authorization: authHeader,
          },
        })

        if (emergencyError) {
          console.error('[ai-chat] Ã¢ÂÅ’ emergency-fund-intelligence error:', emergencyError)
          throw new Error(emergencyError.message || 'Emergency fund intelligence failed')
        }

        const responseText = JSON.stringify(emergencyData)

        let aiMessageId: string | null = null
        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: message,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
            },
          ])

          const { data: aiRows } = await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: responseText,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date(Date.now() + 1).toISOString(),
              confidence: 'high',
            },
          ]).select('id').limit(1)

          aiMessageId = aiRows?.[0]?.id ?? null

          if (isNewSession) {
            try {
              const title = await generateChatTitle(message, 'Emergency Fund')
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('[ai-chat] Ã¢ÂÅ’ Failed to persist emergency fund messages:', saveError)
        }

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          const nextContextState = applyEmergencyFundResultToContextState(
            chatContextState,
            emergencyData,
            message,
            message.trim().startsWith('{') ? 'preset' : 'manual',
          )
          await persistContextState(nextContextState, 'emergency_fund_route')
        }

        // UX: Do NOT stream the structured JSON (prevents partial JSON flicker)
        return new Response(JSON.stringify({
          response: responseText,
          sessionId: currentSessionId,
          confidence: 'high',
          aiMessageId,
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (e) {
        console.error('[ai-chat] Ã¢ÂÅ’ Emergency fund routing failed; falling back to normal chat:', e)
        // Fall through to normal routing/model.
      }
    }

    // Parallelize independent operations for non-greeting path
    // PHASE 1.5 (Option A): Route BEFORE expensive context building.
    // If ambiguous, return clarifying question immediately (no model call, no analytics/context query).
    const routingDecision = getModelRoutingDecision(message)

    console.log('[ai-chat] routing decision', {
      model: routingDecision.model,
      needsClarification: routingDecision.needsClarification,
    })

    if (routingDecision.needsClarification && routingDecision.clarifyingQuestion) {
      const clarifyingResponse = routingDecision.clarifyingQuestion

      // Return clarifying question (streaming or JSON based on client request)
      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: clarifyingResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: 'high' })
        })
      }

      return new Response(JSON.stringify({
        response: clarifyingResponse,
        sessionId: currentSessionId,
        confidence: 'high'
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    // Initial afford-check request submitted from the afford dialog as a structured action.
    // This is intentionally SEPARATE from the button-action handler below (affordActions):
    // an initial check must INSERT a brand-new card, whereas button actions UPDATE the latest card.
    const isInitialAffordCheck = actionObj &&
      actionObj.action === 'afford_check' &&
      actionObj.payload &&
      typeof actionObj.payload === 'object'

    if (isInitialAffordCheck) {
      console.log('[ai-chat] initial afford_check action detected')

      // Clean, human-readable user message. Never store the raw action JSON or any context blob.
      const affordUserMessage = (typeof actionObj.message === 'string' && actionObj.message.trim().length > 0)
        ? actionObj.message.trim()
        : `Can I afford ${actionObj.payload.itemName || 'this'}?`

      try {
        // ai-advisor is the only place that computes financial numbers. The structured payload
        // travels inside the action JSON (message), which ai-advisor parses.
        const advisorResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-advisor`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            apikey: Deno.env.get('SUPABASE_ANON_KEY') || '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: trimmed,
            persona: finalPersona,
            intentType: 'afford_check',
          }),
        })
        const advisorRaw = await advisorResponse.text()
        let advisorData: any = null
        try {
          advisorData = advisorRaw ? JSON.parse(advisorRaw) : null
        } catch {
          advisorData = null
        }

        if (!advisorResponse.ok || !advisorData || advisorData.type !== 'afford_check') {
          throw new Error(`ai-advisor did not return an afford_check result (${advisorResponse.status}): ${advisorRaw.slice(0, 300)}`)
        }

        const affordResponse = JSON.stringify(advisorData)

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          try {
            const nextContextState = applyAffordResultToContextState(chatContextState, advisorData, affordUserMessage, 'preset')
            await persistContextState(nextContextState, 'initial_afford_check_action')
          } catch (ctxError) {
            console.error('[ai-chat] afford context persist failed:', ctxError)
          }
        }

        // Insert a NEW user message and a NEW assistant afford card.
        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: affordUserMessage,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
            {
              session_id: currentSessionId,
              user_id: userId,
              content: affordResponse,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            }
          ])

          if (isNewSession) {
            try {
              const title = await generateChatTitle(affordUserMessage, affordResponse)
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('[ai-chat] afford title error:', titleError)
            }
          }
        } catch (saveError) {
          console.error('[ai-chat] Error saving afford conversation:', saveError)
        }

        // UX: never stream structured afford_check JSON (prevents partial-JSON flicker).
        return new Response(JSON.stringify({
          response: affordResponse,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      } catch (error) {
        console.error('[ai-chat] initial afford_check failed:', error)

        // Structured afford_check error card. NEVER fall back to Gemini / plain chat.
        const errorResponse = JSON.stringify({
          type: 'afford_check',
          currencyCode: (
            actionObj.payload &&
            typeof actionObj.payload.currencyCode === 'string' &&
            /^[A-Za-z]{3}$/.test(actionObj.payload.currencyCode.trim())
          ) ? actionObj.payload.currencyCode.trim().toUpperCase() : 'USD',
          verdict: 'maybe',
          headline: "Couldn't complete the check",
          explanation: "I couldn't safely complete this affordability check right now. Please try again in a moment.",
          input: {
            itemName: (actionObj.payload && typeof actionObj.payload.itemName === 'string') ? actionObj.payload.itemName : null,
            amount: null,
            dueDate: null
          },
          affordability: null,
          recommendation: null,
          confirm: null,
          plannedPayment: null,
          clarifyingQuestion: null
        })

        // Persist the user message + the error card so the UI still renders a card (not a chat bubble).
        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: affordUserMessage,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
            {
              session_id: currentSessionId,
              user_id: userId,
              content: errorResponse,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            }
          ])
        } catch (saveError) {
          console.error('[ai-chat] Error saving afford error card:', saveError)
        }

        return new Response(JSON.stringify({
          response: errorResponse,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
    }

    const affordActions = new Set(['dismiss', 'start_planned_payment', 'create_planned_payment'])
    const isAffordCheckAction = actionObj && typeof actionObj.action === 'string' && affordActions.has(actionObj.action)

    if (isAffordCheckAction) {
      console.log(`[ai-chat] afford_check action detected: ${actionObj.action}`)

      try {
        // Call ai-advisor function with action command
        const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
          body: {
            message: trimmed,
            persona: finalPersona,
            intentType: 'afford_check'
          },
          headers: {
            Authorization: authHeader,
          },
        })

        if (advisorError) {
          console.error('[ai-chat] ai-advisor action error:', advisorError)

          // Return structured afford_check error response (DO NOT fall through to Gemini)
          const errorResponse = JSON.stringify({
            type: 'afford_check',
            verdict: 'maybe',
            headline: 'Something went wrong',
            explanation: `Failed to process your request: ${advisorError.message || 'Unknown error'}. Please try again.`,
            input: null,
            affordability: null,
            recommendation: null,
            confirm: null,
            plannedPayment: null,
            clarifyingQuestion: null
          })

          return jsonChatResponse(errorResponse, 'high')
        }

        // Persist as a JSON string
        const actionResponse = JSON.stringify(advisorData)

        // Save or update AI response (skip saving action JSON user message)
        try {
          // For afford-check actions, UPDATE the existing afford-check message instead of inserting new
          const { data: existingMessages } = await supabaseClient
            .from('chat_messages')
            .select('id, content')
            .eq('session_id', currentSessionId)
            .eq('is_from_user', false)
            .order('created_at', { ascending: false })
            .limit(10)

          // Find the most recent afford-check message
          const lastAffordCheckMsg = existingMessages?.find((msg: any) => {
            try {
              const parsed = JSON.parse(msg.content)
              return parsed.type === 'afford_check'
            } catch {
              return false
            }
          })

          if (lastAffordCheckMsg) {
            // UPDATE existing afford-check message
            console.log(`[ai-chat] Updating existing afford-check message: ${lastAffordCheckMsg.id}`)
            await supabaseClient
              .from('chat_messages')
              .update({
                content: actionResponse,
                confidence: 'high',
                created_at: new Date().toISOString()
              })
              .eq('id', lastAffordCheckMsg.id)
          } else {
            // INSERT new message (first afford-check in session)
            console.log(`[ai-chat] Inserting new afford-check message`)
            await supabaseClient.from('chat_messages').insert([
              {
                session_id: currentSessionId,
                user_id: userId,
                content: actionResponse,
                is_from_user: false,
                personality_mode: finalPersona,
                created_at: new Date().toISOString(),
                confidence: 'high'
              }
            ])
          }

          if (isNewSession) {
            try {
              const title = await generateChatTitle(trimmed, actionResponse)
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
        }

        // UX: Do NOT stream structured afford_check JSON. Streaming causes UI flicker while partial JSON is shown.
        // Return as a normal response so the card renders once.
        if (useStreaming) {
          return new Response(JSON.stringify({
            response: actionResponse,
            sessionId: currentSessionId,
            confidence: 'high'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          })
        }

        // CRITICAL FIX: Return actionResponse as STRING, not object
        // Android expects response.response to be a STRING containing JSON
        return new Response(JSON.stringify({
          response: actionResponse,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      } catch (error) {
        console.error('[ai-chat] afford_check action failed:', error)

        // Return structured afford_check error response (DO NOT fall through to Gemini)
        const errorResponse = JSON.stringify({
          type: 'afford_check',
          verdict: 'maybe',
          headline: 'Something went wrong',
          explanation: 'Failed to process planned payment action. Please try again.',
          input: null,
          affordability: null,
          recommendation: null,
          confirm: null,
          plannedPayment: null,
          clarifyingQuestion: null
        })

        return jsonChatResponse(errorResponse, 'high')
      }
    }

    const topLevelAction = typeof body.action === 'string' ? body.action : null
    let plannerAction = (
      actionObj && (actionObj.action === 'vacation_plan' || actionObj.action === 'savings_plan')
    )
      ? actionObj.action
      : (topLevelAction === 'vacation_plan' || topLevelAction === 'savings_plan' ? topLevelAction : null)
    if (plannerAction) {
      const normalizedUserMessage = String(body.message || message || '').toLowerCase()
      const hasSavingsCue = /\b(save|saving|savings)\b/.test(normalizedUserMessage)
      const hasVacationCue = /\b(vacation|trip|travel|getaway|holiday)\b/.test(normalizedUserMessage)
      if (plannerAction === 'vacation_plan' && hasSavingsCue && !hasVacationCue) {
        plannerAction = 'savings_plan'
      }
    }
    if (plannerAction) {
      console.log(`[ai-chat] ${plannerAction} action detected`)

      try {
        const plannerLocaleContract = {
          languageCode: requestLocaleContract.languageCode,
          localeTag: requestLocaleContract.localeTag,
          mainCurrencyCode: requestLocaleContract.mainCurrencyCode,
          numberFormatMode: requestLocaleContract.numberFormatMode,
        }
        const plannerInvokeBody = actionObj && typeof actionObj === 'object'
          ? {
              ...actionObj,
              ...plannerLocaleContract,
              payload: {
                ...((actionObj as any).payload && typeof (actionObj as any).payload === 'object'
                  ? (actionObj as any).payload
                  : {}),
                ...plannerLocaleContract,
              },
            }
          : {
              action: plannerAction,
              payload: {
                ...(body.payload && typeof body.payload === 'object' ? body.payload : {}),
                ...plannerLocaleContract,
              },
              message: typeof body.message === 'string' ? body.message : '',
              ...plannerLocaleContract,
            }

        const { data: plannerData, error: plannerError } = await supabaseClient.functions.invoke('ai-planner', {
          body: plannerInvokeBody,
          headers: {
            Authorization: authHeader,
          },
        })

        if (plannerError) {
          console.error('[ai-chat] ai-planner action error:', plannerError)
          throw new Error(plannerError.message || `${plannerAction} failed`)
        }

        const plannerResponse = JSON.stringify(plannerData)

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          const nextContextState = plannerAction === 'vacation_plan'
            ? applyVacationPlannerResultToContextState(chatContextState, {
                vacationName: plannerInvokeBody?.payload?.vacationName,
                costCents: plannerInvokeBody?.payload?.costCents,
                targetMonth: plannerInvokeBody?.payload?.targetMonth,
              }, plannerData, message.trim().startsWith('{') ? 'preset' : 'manual')
            : applySavingsPlannerResultToContextState(chatContextState, {
                targetSavingsCents: plannerInvokeBody?.payload?.targetSavingsCents,
                targetMonth: plannerInvokeBody?.payload?.targetMonth,
              }, plannerData, message.trim().startsWith('{') ? 'preset' : 'manual')

          await persistContextState(nextContextState, `planner_action_${plannerAction}`)
        }

        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: plannerResponse,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high',
            },
          ])

          if (isNewSession) {
            try {
              const title = await generateChatTitle(
                plannerAction === 'vacation_plan' ? 'Vacation Plan' : 'Savings Plan',
                plannerResponse
              )
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating planner title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving planner response:', saveError)
        }

        return new Response(JSON.stringify({
          response: plannerResponse,
          sessionId: currentSessionId,
          confidence: 'high',
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (error) {
        console.error(`[ai-chat] ${plannerAction} action failed:`, error)

        const errorResponse = JSON.stringify({
          type: 'error',
          error: String((error as any)?.message || `Failed to process ${plannerAction} action`),
        })

        return new Response(JSON.stringify({
          response: errorResponse,
          sessionId: currentSessionId,
          confidence: 'high',
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
    }

    let prefetchedMemorySearchResult: RelevantMemorySearchResult = { promptText: '', facts: [] }
    let effectiveChatContextState = chatContextState

    if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
      prefetchedMemorySearchResult = await searchRelevantMemories(supabaseClient, message, userId)
      effectiveChatContextState = hydrateStateFromCrossSessionMemory(chatContextState, prefetchedMemorySearchResult.facts, requestId)
      const routePlan = resolveContextRoute(
        message,
        effectiveChatContextState,
        requestId,
        requestLocaleContract.mainCurrencyCode || 'USD',
      )

      if (routePlan.kind !== 'none') {
        const routeIntent: ChatContextIntent =
          routePlan.kind === 'vacation_plan'
            ? 'vacation_affordability'
            : routePlan.kind === 'savings_plan'
              ? 'save_more_plan'
              : routePlan.kind === 'emergency_fund'
                ? 'emergency_fund'
                : routePlan.kind === 'budget_plan'
                  ? 'budget_intel'
                  : routePlan.kind === 'cash_flow'
                    ? 'cash_flow'
                    : routePlan.kind === 'text'
                      ? routePlan.nextState.activeIntent || effectiveChatContextState.activeIntent || 'afford_check'
                    : 'afford_check'

        logChatContextEvent('resolver_decision', {
          requestId,
          sessionToken: getAnonymousSessionToken(currentSessionId),
          resolver_intent: routeIntent,
          resolver_decision: routePlan.decision.kind,
          resolver_score: routePlan.decision.confidence,
          resolver_reason: routePlan.decision.reason,
          resolver_used_open_question: routePlan.decision.usedOpenQuestion,
          resolver_used_cross_chat_memory: routePlan.decision.usedCrossChatMemory,
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })
        incrementChatContextCounter('resolver_decision_total', {
          resolver_intent: routeIntent,
          resolver_decision: routePlan.decision.kind,
          chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        })

        try {
          if (routePlan.kind === 'clarify') {
            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: routePlan.question,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: routePlan.decision.confidence >= 0.8 ? 'high' : 'medium',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver clarifying question:', saveError)
            }

            await persistContextState(routePlan.nextState, `resolver_clarify_${routePlan.intent}`)

            if (useStreaming) {
              return streamTextResponse(routePlan.question, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
            }

            return jsonChatResponse(routePlan.question, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'text') {
            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: routePlan.message,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: routePlan.decision.confidence >= 0.8 ? 'high' : 'medium',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver text conversation:', saveError)
            }

            await persistContextState(routePlan.nextState, 'resolver_text_followup')

            if (useStreaming) {
              return streamTextResponse(routePlan.message, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
            }

            return jsonChatResponse(routePlan.message, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'vacation_plan' || routePlan.kind === 'savings_plan') {
            const actionName = routePlan.kind === 'vacation_plan' ? 'vacation_plan' : 'savings_plan'

            const { data: plannerData, error: plannerError } = await supabaseClient.functions.invoke('ai-planner', {
              body: {
                action: actionName,
                payload: routePlan.payload,
                message,
              },
              headers: {
                Authorization: authHeader,
              },
            })

            if (plannerError) {
              throw new Error(plannerError.message || `Resolver ${actionName} failed`)
            }

            const plannerResponse = JSON.stringify(plannerData)
            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: plannerResponse,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver planner conversation:', saveError)
            }

            const nextContextState = routePlan.kind === 'vacation_plan'
              ? applyVacationPlannerResultToContextState(routePlan.nextState, routePlan.payload, plannerData, 'resolver', false)
              : applySavingsPlannerResultToContextState(routePlan.nextState, routePlan.payload, plannerData, 'resolver', false)

            await persistContextState(nextContextState, `resolver_execute_${actionName}`)
            await maybeUpdateSessionTitle(message, plannerResponse)

            return jsonChatResponse(plannerResponse, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'afford_check') {
            const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
              body: {
                message: routePlan.message,
                persona: finalPersona,
                intentType: 'afford_check',
              },
              headers: {
                Authorization: authHeader,
              },
            })

            if (advisorError) {
              throw new Error(advisorError.message || 'Resolver afford check failed')
            }

            const affordResponse = JSON.stringify(advisorData)
            const shouldShowPlainAffordPrompt = advisorData && advisorData.type === 'afford_check' && (
              advisorData?.input?.amount === null || advisorData?.input?.amount === undefined
            )
            const plainAffordPromptText = shouldShowPlainAffordPrompt
              ? String(advisorData?.clarifyingQuestion || advisorData?.headline || 'How much does it cost?')
              : null

            try {
              const rowsToInsert: any[] = [
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
              ]

              if (plainAffordPromptText) {
                rowsToInsert.push({
                  session_id: currentSessionId,
                  user_id: userId,
                  content: plainAffordPromptText,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                })
                rowsToInsert.push({
                  session_id: currentSessionId,
                  user_id: userId,
                  content: `AFFORD_STATE|${affordResponse}`,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                })
              } else {
                rowsToInsert.push({
                  session_id: currentSessionId,
                  user_id: userId,
                  content: affordResponse,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                })
              }

              await supabaseClient.from('chat_messages').insert(rowsToInsert)
            } catch (saveError) {
              console.error('Error saving resolver afford conversation:', saveError)
            }

            const nextContextState = applyAffordResultToContextState(routePlan.nextState, advisorData, message, 'resolver', false)
            await persistContextState(nextContextState, 'resolver_execute_afford_check')
            await maybeUpdateSessionTitle(message, affordResponse)

            if (useStreaming && plainAffordPromptText) {
              return streamTextResponse(plainAffordPromptText, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
            }

            return jsonChatResponse(plainAffordPromptText ?? affordResponse, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'emergency_fund') {
            const { data: emergencyData, error: emergencyError } = await supabaseClient.functions.invoke('emergency-fund-intelligence', {
              body: {
                goalMonths: routePlan.payload.goalMonths,
                monthlyContribution: routePlan.payload.monthlyContribution,
                includeTips: routePlan.payload.includeTips,
              },
              headers: {
                Authorization: authHeader,
              },
            })

            if (emergencyError) {
              throw new Error(emergencyError.message || 'Resolver emergency fund failed')
            }

            const emergencyResponse = JSON.stringify(emergencyData)
            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: emergencyResponse,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver emergency-fund conversation:', saveError)
            }

            const nextContextState = applyEmergencyFundResultToContextState(routePlan.nextState, emergencyData, message, 'resolver', false)
            await persistContextState(nextContextState, 'resolver_execute_emergency_fund')
            await maybeUpdateSessionTitle(message, emergencyResponse)

            return jsonChatResponse(emergencyResponse, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'budget_plan') {
            const budgetIntelligenceUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/ai-budget-intelligence`
            const budgetResponse = await fetch(budgetIntelligenceUrl, {
              method: 'POST',
              headers: {
                'Authorization': req.headers.get('Authorization') || '',
                'apikey': Deno.env.get('SUPABASE_ANON_KEY') || '',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                intent: 'build_budget_plan',
                sessionId: currentSessionId,
                timezone: body.timezone,
                cycleType: routePlan.payload.cycleType,
                message,
              }),
            })

            if (!budgetResponse.ok) {
              throw new Error(`Resolver budget plan failed: ${budgetResponse.status}`)
            }

            const budgetData = await budgetResponse.json()
            const budgetResponseText = getBudgetResponseText(budgetData)

            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: budgetResponseText,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver budget conversation:', saveError)
            }

            const nextContextState = applyBudgetIntelligenceResultToContextState(routePlan.nextState, {
              cycleType: routePlan.payload.cycleType,
            }, budgetData, 'resolver', false)
            await persistContextState(nextContextState, 'resolver_execute_budget_intel')
            await maybeUpdateSessionTitle(message, budgetResponseText)

            return jsonChatResponse(budgetResponseText, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }

          if (routePlan.kind === 'cash_flow') {
            const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
              body: {
                message: routePlan.message,
                persona: finalPersona,
                timeframe: routePlan.timeframe,
              },
              headers: {
                Authorization: authHeader,
              },
            })

            if (advisorError) {
              throw new Error(advisorError.message || 'Resolver cash flow failed')
            }

            const cashFlowResponse = JSON.stringify(advisorData)
            try {
              await supabaseClient.from('chat_messages').insert([
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: message,
                  is_from_user: true,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                },
                {
                  session_id: currentSessionId,
                  user_id: userId,
                  content: cashFlowResponse,
                  is_from_user: false,
                  personality_mode: finalPersona,
                  created_at: new Date().toISOString(),
                  confidence: 'high',
                },
              ])
            } catch (saveError) {
              console.error('Error saving resolver cash-flow conversation:', saveError)
            }

            const nextContextState = applyCashFlowResultToContextState(routePlan.nextState, routePlan.timeframe, 'resolver', false)
            await persistContextState(nextContextState, 'resolver_execute_cash_flow')
            await maybeUpdateSessionTitle(message, cashFlowResponse)

            return jsonChatResponse(cashFlowResponse, routePlan.decision.confidence >= 0.8 ? 'high' : 'medium')
          }
        } catch (resolverError) {
          logChatContextEvent('resolver_fallback', {
            requestId,
            sessionToken: getAnonymousSessionToken(currentSessionId),
            resolver_intent: routeIntent,
            error: safeErrorMessage(resolverError),
            chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
          })
        }
      }
    }

    // PHASE 3.4: Afford Check Intent Detection (runs BEFORE cash flow)
    // CONTEXT FIX: If the last assistant message was an afford_check asking for the amount,
    // and the user replies with just a number (e.g. "150" or "150$") then continue that
    // afford_check instead of treating this as a new unrelated intent.
    try {
      const amountFromUser = extractAmountFromMessage(message)
      if (amountFromUser != null && currentSessionId) {
        const { data: recentAssistantMessages } = await supabaseClient
          .from('chat_messages')
          .select('content')
          .eq('session_id', currentSessionId)
          .eq('is_from_user', false)
          .order('created_at', { ascending: false })
          .limit(10)

        const lastAffordState = recentAssistantMessages?.find((row: any) => {
          const state = extractAffordStateFromAssistantMessage(row?.content)
          if (!state || state?.type !== 'afford_check') return false
          const inputAmount = state?.input?.amount
          return inputAmount === null || inputAmount === undefined
        })

        if (lastAffordState) {
          const state = extractAffordStateFromAssistantMessage(lastAffordState.content)
          const n = state?.input?.itemName
          const itemName = typeof n === 'string' && n.trim().length > 0 ? n.trim() : null

          const affordCurrencyCode = requestLocaleContract.mainCurrencyCode || 'USD'
          const affordCheckMessage = itemName
            ? `Can I afford ${itemName} for ${amountFromUser} ${affordCurrencyCode}?`
            : `Can I afford it for ${amountFromUser} ${affordCurrencyCode}?`

          console.log('[ai-chat] afford_check follow-up detected (amount reply). Continuing afford_check with', { itemName, amountFromUser })

          const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
            body: {
              message: affordCheckMessage,
              persona: finalPersona,
              intentType: 'afford_check'
            },
            headers: {
              Authorization: authHeader,
            },
          })

          if (advisorError) {
            console.error('Ã¢ÂÅ’ ai-advisor afford check follow-up error:', advisorError)
            throw new Error(`Afford check follow-up failed: ${advisorError.message}`)
          }

          const affordResponse = JSON.stringify(advisorData)

          if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
            const nextContextState = applyAffordResultToContextState(chatContextState, advisorData, message, 'resolver')
            await persistContextState(nextContextState, 'legacy_afford_followup')
          }

          try {
            await supabaseClient.from('chat_messages').insert([
              {
                session_id: currentSessionId,
                user_id: userId,
                content: message,
                is_from_user: true,
                personality_mode: finalPersona,
                created_at: new Date().toISOString()
              },
              {
                session_id: currentSessionId,
                user_id: userId,
                content: affordResponse,
                is_from_user: false,
                personality_mode: finalPersona,
                created_at: new Date().toISOString(),
                confidence: 'high'
              }
            ])
          } catch (saveError) {
            console.error('Ã¢ÂÅ’ Error saving afford-check follow-up conversation:', saveError)
          }

          // UX: Do NOT stream structured afford_check JSON (prevents flicker)
          if (useStreaming) {
            return new Response(JSON.stringify({
              response: affordResponse,
              sessionId: currentSessionId,
              confidence: 'high'
            }), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            })
          }

          return new Response(JSON.stringify({
            response: affordResponse,
            sessionId: currentSessionId,
            confidence: 'high'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          })
        }
      }
    } catch (followUpError) {
      console.error('[ai-chat] afford_check follow-up handler error:', followUpError)
      // Fall through to normal intent detection
    }

    const affordIntent = detectAffordCheckIntent(message)
    console.log('[ai-chat] affordIntent', affordIntent)

    if (affordIntent.detected && affordIntent.confidence === 'high') {
      console.log('[ai-chat] afford check intent detected')

      try {
        // Call ai-advisor function for afford check
        const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
          body: {
            message,
            persona: finalPersona,
            intentType: 'afford_check'
          },
          headers: {
            Authorization: authHeader,
          },
        })

        if (advisorError) {
          console.error('Ã¢ÂÅ’ ai-advisor afford check error:', advisorError)
          throw new Error(`Afford check failed: ${advisorError.message}`)
        }

        // Persist as a JSON string
        const affordResponse = JSON.stringify(advisorData)

        // UX: If this afford_check is asking for a missing amount, show it as plain text
        // instead of rendering the afford-check card/form in the Android UI.
        const shouldShowPlainAffordPrompt = advisorData && advisorData.type === 'afford_check' && (
          advisorData?.input?.amount === null || advisorData?.input?.amount === undefined
        )
        const plainAffordPromptText = shouldShowPlainAffordPrompt
          ? String(advisorData?.clarifyingQuestion || advisorData?.headline || 'How much does it cost?')
          : null

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          const nextContextState = applyAffordResultToContextState(chatContextState, advisorData, message, message.trim().startsWith('{') ? 'preset' : 'manual')
          await persistContextState(nextContextState, 'legacy_afford_detected')
        }

        // Save both user message and AI response
        try {
          const rowsToInsert: any[] = [
            {
              session_id: currentSessionId,
              user_id: userId,
              content: message,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
          ]

          if (plainAffordPromptText) {
            // Visible plain question
            rowsToInsert.push({
              session_id: currentSessionId,
              user_id: userId,
              content: plainAffordPromptText,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            })

            // Hidden state to keep afford-check context across reloads
            rowsToInsert.push({
              session_id: currentSessionId,
              user_id: userId,
              content: `AFFORD_STATE|${affordResponse}`,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            })
          } else {
            // Normal afford-check response (rendered as card)
            rowsToInsert.push({
              session_id: currentSessionId,
              user_id: userId,
              content: affordResponse,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            })
          }

          await supabaseClient.from('chat_messages').insert(rowsToInsert)

          if (isNewSession) {
            try {
              const title = await generateChatTitle(message, affordResponse)
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
        }

        if (useStreaming) {
          // UX: Stream plain text prompts, but do NOT stream structured afford_check JSON (prevents flicker)
          if (plainAffordPromptText) {
            return createSSEResponse(async (send) => {
              await send({ type: 'delta', text: plainAffordPromptText })
              await send({ type: 'done', sessionId: currentSessionId, confidence: 'high' })
            })
          }

          return new Response(JSON.stringify({
            response: affordResponse,
            sessionId: currentSessionId,
            confidence: 'high'
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          })
        }

        return new Response(JSON.stringify({
          response: plainAffordPromptText ?? affordResponse,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      } catch (error) {
        console.error('Ã¢ÂÅ’ Afford check error:', error)
        // Fall through to normal chat flow on error
      }
    }

    // PHASE 3.1: Cash Flow Intent Detection
    console.log('[ai-chat] incoming message', { message, stream: useStreaming })

    // Financial Health Score Intent Detection
    // When the Android UI triggers a preset chip in a non-English language, the message text may not match
    // our English regex. Support an explicit action to make this deterministic.
    const healthScoreIntent =
      action === 'health_score' ||
      (isPresetInput && detectFinancialHealthIntent(message))
    console.log('[ai-chat] healthScoreIntent', healthScoreIntent)

    if (healthScoreIntent) {
      console.log('[ai-chat] financial health score intent detected')

      try {
        // Call ai-health-score function
        const { data: healthScoreData, error: healthScoreError } = await supabaseClient.functions.invoke('ai-health-score', {
          body: {
            languageCode: requestLocaleContract.languageCode,
            localeTag: requestLocaleContract.localeTag,
            mainCurrencyCode: requestLocaleContract.mainCurrencyCode,
            numberFormatMode: requestLocaleContract.numberFormatMode,
          },
          headers: {
            Authorization: authHeader,
          },
        })

        if (healthScoreError) {
          console.error('Ã¢ÂÅ’ ai-health-score error:', healthScoreError)
          throw new Error(`Health score calculation failed: ${healthScoreError.message}`)
        }

        // Check if we have missing components
        const missingComponents = healthScoreData?.missingComponents || []
        const blockedComponents = healthScoreData?.blockedComponents || []
        const overallScore = healthScoreData?.overallScore

        let responseContent: string

        if (overallScore === null && missingComponents.length > 0) {
          // Partial data scenario
          const clarifyingMessage =
            blockedComponents.length > 0
              ? (healthScoreData?.clarifyingMessage ||
                  "Some parts of your health score are temporarily unavailable because Wisey couldn't load all of the required data right now.")
              : "I can show you a partial health snapshot, but to give you a complete score I need more data. Would you like to see what I have so far?"
          responseContent = JSON.stringify({
            ...healthScoreData,
            clarifyingMessage,
          })
        } else {
          // Full health score available
          responseContent = JSON.stringify(healthScoreData)
        }

        // Save both user message and AI response
        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: message,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
            {
              session_id: currentSessionId,
              user_id: userId,
              content: responseContent,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            }
          ])

          if (isNewSession) {
            try {
              const title = 'Financial Health Score'
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
        }

        // Do NOT stream health score responses. The client renders a structured card and
        // streaming would show raw JSON while the message is still incomplete.
        return new Response(JSON.stringify({
          response: responseContent,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      } catch (error) {
        console.error('Ã¢ÂÅ’ Health score error:', error)

        const errorPayload = JSON.stringify({
          type: 'health_score_error',
          errorCode: 'calculation_failed'
        })

        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: message,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
            {
              session_id: currentSessionId,
              user_id: userId,
              content: errorPayload,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'low'
            }
          ])
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving error message:', saveError)
        }

        // Do NOT stream health score errors either.
        return new Response(JSON.stringify({
          response: errorPayload,
          sessionId: currentSessionId,
          confidence: 'low'
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      }
    }

    // Support explicit action routing so preset chips work in any UI language.
    const cashFlowIntent = action === 'cash_flow'
      ? { detected: true, confidence: 'high' as const, timeframe: 'current_cycle' as const }
      : (isPresetInput
        ? detectCashFlowIntent(message)
        : { detected: false, confidence: 'low' as const, timeframe: 'current_cycle' as const })
    console.log('[ai-chat] cashFlowIntent', cashFlowIntent)

    if (cashFlowIntent.detected && cashFlowIntent.confidence === 'high') {
      console.log('[ai-chat] cash flow intent detected', {
        timeframe: cashFlowIntent.timeframe
      })

      try {
        // Call ai-advisor function with timeframe
        // IMPORTANT: Forward the user's Authorization header so ai-advisor can auth.getUser()
        const { data: advisorData, error: advisorError } = await supabaseClient.functions.invoke('ai-advisor', {
          body: {
            message,
            persona: finalPersona,
            timeframe: cashFlowIntent.timeframe
          },
          headers: {
            Authorization: authHeader,
          },
        })

        if (advisorError) {
          console.error('Ã¢ÂÅ’ ai-advisor error:', advisorError)
          throw new Error(`Cash flow analysis failed: ${advisorError.message}`)
        }

        // Persist as a JSON string, but return structured object to the client
        const cashFlowResponse = JSON.stringify(advisorData)

        // Save both user message and AI response
        try {
          await supabaseClient.from('chat_messages').insert([
            {
              session_id: currentSessionId,
              user_id: userId,
              content: message,
              is_from_user: true,
              personality_mode: finalPersona,
              created_at: new Date().toISOString()
            },
            {
              session_id: currentSessionId,
              user_id: userId,
              content: cashFlowResponse,
              is_from_user: false,
              personality_mode: finalPersona,
              created_at: new Date().toISOString(),
              confidence: 'high'
            }
          ])

          if (isNewSession) {
            try {
              const title = await generateChatTitle(message, cashFlowResponse)
              await supabaseClient
                .from('chat_sessions')
                .update({ title })
                .eq('id', currentSessionId)
                .eq('user_id', userId)
            } catch (titleError) {
              console.error('Ã¢ÂÅ’ Error generating title:', titleError)
            }
          }
        } catch (saveError) {
          console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
        }

        if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable) {
          const nextContextState = applyCashFlowResultToContextState(
            chatContextState,
            cashFlowIntent.timeframe,
            message.trim().startsWith('{') ? 'preset' : 'manual',
          )
          await persistContextState(nextContextState, 'cash_flow_route')
        }

        // Do not stream structured cash-flow JSON. Android renders the card
        // after receiving the complete payload.
        return new Response(JSON.stringify({
          response: cashFlowResponse,
          sessionId: currentSessionId,
          confidence: 'high'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        })
      } catch (error) {
        console.error('Ã¢ÂÅ’ Cash flow analysis error:', error)
        // Fall through to normal chat flow on error
      }
    }

    const t0 = nowMs()

    const tHistory0 = nowMs()
    const recentMessagesPromise = supabaseClient
      .from('chat_messages')
      .select('content, is_from_user, created_at', { count: 'exact' })
      .eq('session_id', currentSessionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(20)

    const tMem0 = nowMs()
    const relevantMemoriesPromise = (
      prefetchedMemorySearchResult.promptText ||
      prefetchedMemorySearchResult.facts.length > 0
    )
      ? Promise.resolve(prefetchedMemorySearchResult)
      : searchRelevantMemories(supabaseClient, message, userId)

    const tCtx0 = nowMs()
    const contextPromise = buildFinancialContext(
      supabaseClient,
      userId,
      authHeader,
      requestLocaleContract
    )

    const [recentMessagesRes, memorySearchResult, ctx] = await Promise.all([
      recentMessagesPromise,
      relevantMemoriesPromise,
      contextPromise,
    ])

    context = ctx
    const relevantMemories = memorySearchResult.promptText
    const relevantMemoryFacts = memorySearchResult.facts
    effectiveChatContextState = hydrateStateFromCrossSessionMemory(chatContextState, relevantMemoryFacts, requestId)

    const historyMs = Math.round(nowMs() - tHistory0)
    const memMs = Math.round(nowMs() - tMem0)
    const ctxMs = Math.round(nowMs() - tCtx0)

    const recentMessages = recentMessagesRes.data || []
    const totalRecentMessageCount = typeof recentMessagesRes.count === 'number'
      ? recentMessagesRes.count
      : recentMessages.length
    const rollingSummaryPrep = await prepareRollingSessionSummary(
      recentMessages as RecentChatMessageRow[],
      totalRecentMessageCount,
    )
    chatContextState = rollingSummaryPrep.state
    effectiveChatContextState = hydrateStateFromCrossSessionMemory(chatContextState, relevantMemoryFacts, requestId)
    const visibleRecentMessages = rollingSummaryPrep.recentMessages
    const lastAssistantMessage =
      visibleRecentMessages.find((m) => !m.is_from_user && typeof m.content === 'string')?.content || null
    const chatHistory =
      [...visibleRecentMessages].reverse()
        .map((m) => `${m.is_from_user ? 'User' : 'Wisey'}: ${m.content}`)
        .join('\n') || ''

    const listIntentMessage = String(message || '').trim()
    const listIntentMessageLower = listIntentMessage.toLowerCase()

    const isRecentTransactionsListIntent =
      /^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:(?:my\s+)?(?:(?:\d+\s+)?(?:most\s+)?(?:recent|last)\s+transactions?|latest(?:\s+\d+)?\s+transactions?)|transactions?)[!.?]*\s*$/i.test(listIntentMessage)

    if (isRecentTransactionsListIntent) {
      return await returnDirectTextReply(String(context?.recentTransactions || 'No recent transactions'))
    }

    const topCategoriesResponse = (() => {
      const isTopCategoriesListIntent =
        /^(?:\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:top\s+categories|spending\s+categories)|\s*(?:what(?:'s| is)\s+my\s+top\s+categories|what\s+did\s+i\s+spen[dt]\s+most\s+on|what\s+have\s+i\s+spen[dt]\s+most\s+on|spent\s+most(?:\s+on)?))\s*(?:for|in|during)?\s*(?:the\s+)?(this\s+week|last\s+week|this\s+month|last\s+month|previous\s+month|last\s+30\s+days|past\s+30\s+days|30\s+days)[!.?]*\s*$/i.test(listIntentMessage)
      if (!isTopCategoriesListIntent) return null
      if (/\bthis week\b/.test(listIntentMessageLower)) return String(context?.topCategoriesThisWeek || 'No data available')
      if (/\blast week\b/.test(listIntentMessageLower)) return String(context?.topCategoriesLastWeek || 'No data available')
      if (/\bthis month\b/.test(listIntentMessageLower)) return String(context?.topCategoriesThisMonth || 'No data available')
      if (/\blast month\b|\bprevious month\b/.test(listIntentMessageLower)) return String(context?.topCategoriesLastMonth || 'No data available')
      return String(context?.topCategories || 'No data available')
    })()

    if (topCategoriesResponse !== null) {
      return await returnDirectTextReply(topCategoriesResponse)
    }

    const isLargestExpensesListIntent =
      /^(?:\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:largest|biggest|highest)\s+(?:expenses?|transactions?)|\s*what(?:'s| are)\s+(?:my\s+)?(?:largest|biggest|highest)\s+(?:expenses?|transactions?))(?:\s+(?:for|in|during)\s*(?:the\s+)?)?(?:last\s+30\s+days|past\s+30\s+days|30\s+days)?[!.?]*\s*$/i.test(listIntentMessage)

    if (isLargestExpensesListIntent) {
      return await returnDirectTextReply(String(context?.largestExpenses || 'No expense data available'))
    }

    const isTopMerchantsListIntent =
      /^(?:\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:top\s+merchants?)|\s*(?:where\s+do\s+i\s+shop(?:\s+most)?|where\s+am\s+i\s+spending\s+most))(?:\s+(?:for|in|during)\s*(?:the\s+)?)?(?:last\s+30\s+days|past\s+30\s+days|30\s+days)?[!.?]*\s*$/i.test(listIntentMessage)

    if (isTopMerchantsListIntent) {
      return await returnDirectTextReply(String(context?.topMerchants || 'No merchant data available'))
    }

    const isSpendingByDayListIntent =
      /^(?:\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:spending\s+patterns?(?:\s+by\s+day)?|spending\s+by\s+day)|\s*when\s+do\s+i\s+spend\s+most)(?:\s+(?:for|in|during)\s*(?:the\s+)?)?(?:last\s+30\s+days|past\s+30\s+days|30\s+days)?[!.?]*\s*$/i.test(listIntentMessage)

    if (isSpendingByDayListIntent) {
      return await returnDirectTextReply(String(context?.spendingByDay || 'No spending patterns available'))
    }

    const isDebtsListIntent =
      /^(?:\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?debts?|\s*(?:what\s+debts\s+do\s+i\s+have|my\s+debts?|remaining\s+debts?))[!.?]*\s*$/i.test(listIntentMessage)

    if (isDebtsListIntent) {
      return await returnDirectTextReply(String(context?.debtsList || 'No active debts'))
    }

    // PHASE 2.1: Subscriptions LIST intent should return the machine-parsable list verbatim.
    // Relying on the model to copy the list often produces paraphrased sentences, which breaks the structured UI.
    const isSubscriptionsListIntent = (() => {
      const msg = String(message || '').trim().toLowerCase()
      if (!msg) return false
      const hasSubWord = /\bsubscriptions?\b/.test(msg)
      if (!hasSubWord) return false
      const listSignals = /\b(show|list|active|current|my|next)\b/.test(msg)
      return listSignals || msg === 'subscriptions'
    })()

    if (isSubscriptionsListIntent) {
      const subscriptionsResponse = String(context?.subscriptionsList || 'No active subscriptions')
      const subscriptionsConfidence: 'low' | 'medium' | 'high' = 'high'

      // Save both user message and AI response to current session
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: subscriptionsResponse,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence: subscriptionsConfidence,
          },
        ])

        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, subscriptionsResponse)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      } catch (saveError) {
        console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      }

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: subscriptionsResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: subscriptionsConfidence })
        })
      }

      return new Response(JSON.stringify({
        response: subscriptionsResponse,
        sessionId: currentSessionId,
        confidence: subscriptionsConfidence,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // PHASE 2.2: Bills LIST intent should return the machine-parsable list verbatim.
    // Relying on the model to copy the list often produces paraphrased sentences, which breaks the structured UI.
    const isBillsListIntent = (() => {
      const msg = String(message || '').trim().toLowerCase()
      if (!msg) return false
      const hasBillsWord = /\bbills?\b/.test(msg)
      if (!hasBillsWord) return false
      const listSignals = /\b(show|list|upcoming|current|my|next|due)\b/.test(msg)
      return listSignals || msg === 'bills' || msg === 'bill'
    })()

    if (isBillsListIntent) {
      const billsResponse = String(context?.billsList || 'No active bills')
      const billsConfidence: 'low' | 'medium' | 'high' = 'high'

      // Save both user message and AI response to current session
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: billsResponse,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence: billsConfidence,
          },
        ])

        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, billsResponse)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      } catch (saveError) {
        console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      }

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: billsResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: billsConfidence })
        })
      }

      return new Response(JSON.stringify({
        response: billsResponse,
        sessionId: currentSessionId,
        confidence: billsConfidence,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // PHASE 2.4: Receivables LIST intent should return the machine-parsable list verbatim.
    // Relying on the model to copy the list often produces paraphrased sentences, which breaks the structured UI.
    const isReceivablesListIntent = (() => {
      const msg = String(message || '').trim().toLowerCase()
      if (!msg) return false
      const hasReceivablesWord = /\breceivables?\b/.test(msg) || /\bwho\s+owes\s+me\b/.test(msg) || /\bowes\s+me\b/.test(msg)
      if (!hasReceivablesWord) return false
      const listSignals = /\b(show|list|upcoming|expected|current|my|next|due|coming)\b/.test(msg)
      return listSignals || msg === 'receivables' || msg === 'receivable'
    })()

    if (isReceivablesListIntent) {
      const receivablesResponse = String(context?.receivablesList || 'No receivables')
      const receivablesConfidence: 'low' | 'medium' | 'high' = 'high'

      // Save both user message and AI response to current session
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: receivablesResponse,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence: receivablesConfidence,
          },
        ])

        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, receivablesResponse)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      } catch (saveError) {
        console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      }

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: receivablesResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: receivablesConfidence })
        })
      }

      return new Response(JSON.stringify({
        response: receivablesResponse,
        sessionId: currentSessionId,
        confidence: receivablesConfidence,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // PHASE 2.5: Planned Income LIST intent should return the machine-parsable list verbatim.
    // Relying on the model to copy the list often produces paraphrased sentences, which breaks the structured UI.
    const isPlannedIncomeListIntent = (() => {
      const msg = String(message || '').trim().toLowerCase()
      if (!msg) return false
      const hasIncomeWord = /\bplanned\s+income\b/.test(msg) || /\bupcoming\s+income\b/.test(msg) || /\bexpected\s+income\b/.test(msg) || /\bincome\s+schedule\b/.test(msg) || /\bincome\s+plan\b/.test(msg) || /\bsalary\s+schedule\b/.test(msg) || /\bexpected\s+salary\b/.test(msg)
      if (!hasIncomeWord) return false
      const listSignals = /\b(show|list|upcoming|current|my|next|due)\b/.test(msg)
      return listSignals || msg === 'planned income' || msg === 'income schedule'
    })()

    if (isPlannedIncomeListIntent) {
      const plannedIncomeResponse = String(context?.plannedIncomeList || 'No planned income')
      const plannedIncomeConfidence: 'low' | 'medium' | 'high' = 'high'

      // Save both user message and AI response to current session
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: plannedIncomeResponse,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence: plannedIncomeConfidence,
          },
        ])

        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, plannedIncomeResponse)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      } catch (saveError) {
        console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      }

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: plannedIncomeResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: plannedIncomeConfidence })
        })
      }

      return new Response(JSON.stringify({
        response: plannedIncomeResponse,
        sessionId: currentSessionId,
        confidence: plannedIncomeConfidence,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    // PHASE 2.6: Planned Payments LIST intent should return the machine-parsable list verbatim.
    // Relying on the model to copy the list often produces paraphrased sentences, which breaks the structured UI.
    const isPlannedPaymentsListIntent = (() => {
      const msg = String(message || '').trim().toLowerCase()
      if (!msg) return false
      const hasPaymentsWord = /\bplanned\s+payments?\b/.test(msg) || /\bupcoming\s+payments?\b/.test(msg) || /\bscheduled\s+bills?\b/.test(msg) || /\bpayment\s+schedule\b/.test(msg) || /\bscheduled\s+payments?\b/.test(msg)
      if (!hasPaymentsWord) return false
      const listSignals = /\b(show|list|upcoming|current|my|next|due|scheduled)\b/.test(msg)
      return listSignals || msg === 'planned payments' || msg === 'payment schedule'
    })()

    if (isPlannedPaymentsListIntent) {
      const plannedPaymentsResponse = String(context?.plannedPaymentsList || 'No planned payments')
      const plannedPaymentsConfidence: 'low' | 'medium' | 'high' = 'high'

      // Save both user message and AI response to current session
      try {
        await supabaseClient.from('chat_messages').insert([
          {
            session_id: currentSessionId,
            user_id: userId,
            content: message,
            is_from_user: true,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
          },
          {
            session_id: currentSessionId,
            user_id: userId,
            content: plannedPaymentsResponse,
            is_from_user: false,
            personality_mode: finalPersona,
            created_at: new Date().toISOString(),
            confidence: plannedPaymentsConfidence,
          },
        ])

        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, plannedPaymentsResponse)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      } catch (saveError) {
        console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      }

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'delta', text: plannedPaymentsResponse })
          await send({ type: 'done', sessionId: currentSessionId, confidence: plannedPaymentsConfidence })
        })
      }

      return new Response(JSON.stringify({
        response: plannedPaymentsResponse,
        sessionId: currentSessionId,
        confidence: plannedPaymentsConfidence,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    const modelToUse = routingDecision.model
    const activeDigestHandoff = trustedRequestDigestHandoff || chatContextState.activeDigestHandoff || null

    // Get Wisey's reply with cross-chat memory context (including confidence)
    const tGem0 = nowMs()

    // Branch: streaming vs non-streaming
    if (useStreaming) {
      // Streaming mode: return SSE response
      return createSSEResponse(async (send) => {
        try {
          let fullResponseText = ''
          let finalConfidence: 'low' | 'medium' | 'high' = 'medium'

          // Stream the response
          const result = await getWiseyResponseStreaming(
            message,
            context,
            chatHistory,
            relevantMemories,
            relevantMemoryFacts,
            finalPersona,
            responseLength,
            modelToUse,
            activeDigestHandoff,
            normalizedInputMode || null,
            trustedRequestDigestHandoff,
            chatContextAvailable ? effectiveChatContextState : null,
            visibleRecentMessages,
            async (chunk: string) => {
              fullResponseText += chunk
              await send({ type: 'delta', text: chunk })
            },
            lastAssistantMessage
          )

          fullResponseText = result.text
          finalConfidence = result.confidence

          const gemMs = Math.round(nowMs() - tGem0)
          console.log(`Ã¢ÂÂ±Ã¯Â¸Â ai-chat timing: history=${historyMs}ms memories=${memMs}ms context=${ctxMs}ms gemini=${gemMs}ms total=${Math.round(nowMs() - t0)}ms`)

          if (!shouldPersistWiseyResponse(result.availabilityFallback)) {
            console.log('[ai-chat] availability fallback returned; conversation persistence skipped')
            await send({
              type: 'done',
              sessionId: currentSessionId,
              confidence: finalConfidence,
              availabilityFallback: true,
            })
            return
          }

          // Save both user message and AI response to current session
          try {
            // Save user message
            const { error: userError } = await supabaseClient.from('chat_messages').insert([
              {
                session_id: currentSessionId,
                user_id: userId,
                content: message,
                is_from_user: true,
                personality_mode: finalPersona,
                created_at: new Date().toISOString()
              }
            ])

            // Save AI response (with confidence label)
            const { error: aiError } = await supabaseClient.from('chat_messages').insert([
              {
                session_id: currentSessionId,
                user_id: userId,
                content: fullResponseText,
                is_from_user: false,
                personality_mode: finalPersona,
                created_at: new Date().toISOString(),
                confidence: finalConfidence
              }
            ])

            if (userError || aiError) {
              console.error('Ã¢ÂÅ’ Database insert error:', userError || aiError)
            } else {
              console.log('Ã°Å¸â€™Â¾ Complete conversation saved to database')

              // Auto-generate title if this is a new session (first message)
              if (isNewSession) {
                try {
                  const title = await generateChatTitle(message, fullResponseText)
                  await supabaseClient
                    .from('chat_sessions')
                    .update({ title })
                    .eq('id', currentSessionId)
                    .eq('user_id', userId)
                  console.log(`Ã°Å¸ÂÂ·Ã¯Â¸Â Generated title: "${title}"`)
                } catch (titleError) {
                  console.error('Ã¢ÂÅ’ Error generating title:', titleError)
                }
              }
            }
          } catch (saveError) {
            console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
          }

          if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable && AI_CHAT_GENERAL_CHAT_FACTS_ENABLED) {
            const generalChatUpdate = applyGeneralChatTurnToContextState(
              chatContextState,
              message,
              fullResponseText,
              lastAssistantMessage,
              message.trim().startsWith('{') ? 'preset' : 'manual',
            )
            if (generalChatUpdate.changed) {
              chatContextState = generalChatUpdate.state
              await persistContextState(chatContextState, 'general_chat_turn')
            }
          }

          // Send final done event
          await send({ type: 'done', sessionId: currentSessionId, confidence: finalConfidence })
        } catch (streamError) {
          console.error('Ã¢ÂÅ’ Streaming error:', streamError)
          await send({ type: 'error', message: safeErrorMessage(streamError, 'Streaming failed') })
        }
      })
    }

    // Non-streaming mode (existing behavior)
    const modelResult = await getWiseyResponse(
      message,
      context,
      chatHistory,
      relevantMemories,
      relevantMemoryFacts,
      finalPersona,
      responseLength,
      modelToUse,
      activeDigestHandoff,
      normalizedInputMode || null,
      trustedRequestDigestHandoff,
      chatContextAvailable ? effectiveChatContextState : null,
      visibleRecentMessages,
      lastAssistantMessage
    )
    const responseText = modelResult.text
    const confidence = modelResult.confidence
    const gemMs = Math.round(nowMs() - tGem0)

    console.log(`Ã¢ÂÂ±Ã¯Â¸Â ai-chat timing: history=${historyMs}ms memories=${memMs}ms context=${ctxMs}ms gemini=${gemMs}ms total=${Math.round(nowMs() - t0)}ms`)

    if (!shouldPersistWiseyResponse(modelResult.availabilityFallback)) {
      console.log('[ai-chat] availability fallback returned; conversation persistence skipped')
      return new Response(JSON.stringify({
        response: responseText,
        sessionId: currentSessionId,
        confidence,
        aiMessageId: null,
        availabilityFallback: true,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }

    // Save both user message and AI response to current session
    let aiMessageId: string | null = null
    try {
      // Save user message
      const { error: userError } = await supabaseClient.from('chat_messages').insert([
        {
          session_id: currentSessionId,
          user_id: userId,
          content: message,
          is_from_user: true,
          personality_mode: finalPersona,
          created_at: new Date().toISOString()
        }
      ])

      // Save AI response (with confidence label)
      const { data: aiRows, error: aiError } = await supabaseClient.from('chat_messages').insert([
        {
          session_id: currentSessionId,
          user_id: userId,
          content: responseText,
          is_from_user: false,
          personality_mode: finalPersona,
          created_at: new Date().toISOString(),
          confidence
        }
      ]).select('id').limit(1)

      aiMessageId = aiRows?.[0]?.id ?? null

      if (userError || aiError) {
        console.error('Ã¢ÂÅ’ Database insert error:', userError || aiError)
      } else {
        console.log('Ã°Å¸â€™Â¾ Complete conversation saved to database')

        // Auto-generate title if this is a new session (first message)
        if (isNewSession) {
          try {
            const title = await generateChatTitle(message, responseText)
            await supabaseClient
              .from('chat_sessions')
              .update({ title })
              .eq('id', currentSessionId)
              .eq('user_id', userId)
            console.log(`Ã°Å¸ÂÂ·Ã¯Â¸Â Generated title: "${title}"`)
          } catch (titleError) {
            console.error('Ã¢ÂÅ’ Error generating title:', titleError)
          }
        }
      }
    } catch (saveError) {
      console.error('Ã¢ÂÅ’ Error saving conversation:', saveError)
      // Don't fail the request if saving fails
    }

    if (CHAT_CONTEXT_V2_ENABLED && chatContextAvailable && AI_CHAT_GENERAL_CHAT_FACTS_ENABLED) {
      const generalChatUpdate = applyGeneralChatTurnToContextState(
        chatContextState,
        message,
        responseText,
        lastAssistantMessage,
        message.trim().startsWith('{') ? 'preset' : 'manual',
      )
      if (generalChatUpdate.changed) {
        chatContextState = generalChatUpdate.state
        await persistContextState(chatContextState, 'general_chat_turn')
      }
    }

    return new Response(JSON.stringify({
      response: responseText,
      sessionId: currentSessionId,
      confidence,
      aiMessageId
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error) {
    console.error('Ã¢ÂÅ’ Error:', error)

    // Check if we're in streaming mode by looking at request headers/params
    try {
      const url = new URL(req.url)
      const acceptHeader = req.headers.get('Accept') || ''
      const streamParam = url.searchParams.get('stream')
      const useStreaming = acceptHeader.includes('text/event-stream') || streamParam === 'true'

      if (useStreaming) {
        return createSSEResponse(async (send) => {
          await send({ type: 'error', message: safeErrorMessage(error, 'Failed to get response') })
        })
      }
    } catch (_) {
      // If we can't determine streaming mode, fall back to JSON
    }

    return new Response(JSON.stringify({ error: safeErrorMessage(error, 'Failed to get response') }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
})

/**
 * PHASE 3.4: Afford Check Intent Detection
 * Detects when user is asking if they can afford something
 */
function detectAffordCheckIntent(message: string): {
  detected: boolean
  confidence: 'high' | 'medium' | 'low'
} {
  const msg = message.toLowerCase().trim()

  console.log('[ai-chat] detectAffordCheckIntent normalized', msg)

  // High confidence patterns for afford queries
  const highConfidencePatterns = [
    /can\s+(i\s+)?afford/,  // "can afford" or "can i afford"
    /is it ok if i buy/,
    /should i buy/,
    /can\s+(i\s+)?buy/,  // "can buy" or "can i buy"
    /do i have enough (for|to buy)/,
    /afford to (buy|get|purchase)/,
  ]

  const isHighConfidence = highConfidencePatterns.some(pattern => pattern.test(msg))

  if (!isHighConfidence) {
    return { detected: false, confidence: 'low' }
  }

  return {
    detected: true,
    confidence: 'high'
  }
}

/**
 * Financial Health Score Intent Detection
 * Detects when user is asking about their financial health score
 */
function detectFinancialHealthIntent(message: string): boolean {
  const msg = message
    .toLowerCase()
    .replace(/[Ã¢â‚¬â„¢Ã¢â‚¬Ëœ`Ã‚Â´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

  console.log('[ai-chat] detectFinancialHealthIntent normalized', msg)

  // Trigger patterns for health score queries
  const healthScorePatterns = [
    /financial\s+health\s+score/,
    /what'?s\s+my\s+financial\s+health\s+score/,
    /what'?s\s+my\s+financial\s+health/,
    /how\s+healthy\s+(are|is)\s+my\s+finances/,
    /\bhealth\s+score\b/,
    /my\s+financial\s+health\b/,
  ]

  // Avoid false positives (e.g., "mental health", "health insurance")
  const falsePositivePatterns = [
    /mental\s+health/,
    /health\s+insurance/,
    /health\s+care/,
    /healthcare/,
  ]

  // Check for false positives first
  if (falsePositivePatterns.some(pattern => pattern.test(msg))) {
    return false
  }

  // Check for health score patterns
  return healthScorePatterns.some(pattern => pattern.test(msg))
}

/**
 * PHASE 3.1: Cash Flow Intent Detection
 * Detects when user is asking about cash flow and determines timeframe
 */
function detectCashFlowIntent(message: string): {
  detected: boolean
  confidence: 'high' | 'medium' | 'low'
  timeframe: 'current_cycle' | 'last_cycle' | 'this_year'
} {
  const msg = message.toLowerCase().trim()

  console.log('[ai-chat] detectCashFlowIntent normalized', msg)

  // High confidence patterns for cash flow queries (removed afford patterns)
  const highConfidencePatterns = [
    /how am i doing( financially)?/,
    /am i on track/,
    /how'?s my (money|cash flow|spending)/,
    /what'?s my (disposable income|daily spend)/,
    /how much (can i spend|do i have left)/,
    /am i spending too fast/,
    /show me my cash flow/,
    /cashflow/,
    /cash flow/,
  ]

  const isHighConfidence = highConfidencePatterns.some(pattern => pattern.test(msg))

  if (!isHighConfidence) {
    return { detected: false, confidence: 'low', timeframe: 'current_cycle' }
  }

  // Detect timeframe
  let timeframe: 'current_cycle' | 'last_cycle' | 'this_year' = 'current_cycle'

  // Explicit last cycle
  if (/last (month|cycle)/i.test(msg)) {
    timeframe = 'last_cycle'
  }
  // This year
  else if (/this year|year to date|ytd/i.test(msg)) {
    timeframe = 'this_year'
  }
  // Default: current cycle (no explicit timeframe)

  return {
    detected: true,
    confidence: 'high',
    timeframe
  }
}

/**
 * PHASE 0: Model Routing (Cost Control)
 * Determines whether to use gemini-2.5-flash-lite (fast/cheap) or gemini-2.5-flash (quality).
 */
function getModelRoutingDecision(message: string): {
  model: 'gemini-2.5-flash-lite' | 'gemini-2.5-flash'
  needsClarification: boolean
  clarifyingQuestion: string | null
} {
  const lowerMessage = (message || '').toLowerCase().trim()

  // Keep flash-lite only for short, pure recent-transactions asks.
  // Match examples:
  // - "recent transactions"
  // - "my 3 recent transactions"
  // - "show me my recent transactions"
  // - "latest 10 transactions"
  // - "transactions"
  // Reject examples:
  // - "what's my net worth and my 3 recent transactions"
  // - "who named Milo and show my recent transactions"
  const isRecentTransactionsIntent =
    /^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?(?:(?:show|list)\s+(?:me\s+)?(?:my\s+)?)?(?:(?:my\s+)?(?:(?:\d+\s+)?(?:most\s+)?(?:recent|last)\s+transactions?|latest(?:\s+\d+)?\s+transactions?)|transactions?)[!.?]*\s*$/i.test(lowerMessage)

  if (isRecentTransactionsIntent) {
    return { model: 'gemini-2.5-flash-lite', needsClarification: false, clarifyingQuestion: null }
  }

  const hasExplicitTimeRange =
    /(last\s+month|this\s+month|previous\s+month|past\s+month|last\s+30\s+days|last\s+60\s+days|30\s+days|60\s+days|last\s+week|past\s+week|this\s+week|yesterday|today)/.test(lowerMessage)

  const isSpendingMostQuestion =
    /(what.*spent.*most|what.*spend.*most|what.*top.*categor|top\s+categor|spent\s+most)/.test(lowerMessage)

  // If the user asks a spending-summary question without a time range, ask 1 clarifying question.
  // This prevents us from assuming "last 30 days" when the user might mean "this month" or "last month".
  if (isSpendingMostQuestion && !hasExplicitTimeRange) {
    return {
      model: 'gemini-2.5-flash',
      needsClarification: true,
      clarifyingQuestion: 'Got it - what time range do you mean: this month, last month, or the last 30 days?',
    }
  }

  const lightweightPatterns = [
    /^(hi|hey|hello|yo|sup|good morning|good afternoon|good evening)\b/,
    /^thanks?\b/,
    /^thank you\b/,
    /^(ok|okay|cool|nice|great|perfect)\b/,
  ]

  if (lightweightPatterns.some((pattern) => pattern.test(lowerMessage))) {
    return { model: 'gemini-2.5-flash-lite', needsClarification: false, clarifyingQuestion: null }
  }
  // Default to higher-quality chat model for natural conversation and follow-ups.
  return { model: 'gemini-2.5-flash', needsClarification: false, clarifyingQuestion: null }
}

/**
 * PHASE 1: Deep Analytics Calculation Function
 * Computes all 7 analytics fields from transaction data with graceful error handling
 */
type LooseRow = Record<string, any>

type DeepAnalyticsSummary = {
  topCategories: string
  topCategoriesThisWeek: string
  topCategoriesLastWeek: string
  topCategoriesThisMonth: string
  topCategoriesLastMonth: string
  spendingByDay: string
  topMerchants: string
  weekComparison: string
  monthComparison: string
  totalIncome: string
  recurringBills: string
  largestExpenses: string
}

type WiseyFinancialContext = Record<string, any>
type NumberFormatMode = 'comma' | 'period' | 'system'

type RequestLocaleContract = {
  languageCode?: string | null
  localeTag?: string | null
  mainCurrencyCode?: string | null
  numberFormatMode?: NumberFormatMode | null
}

const LANGUAGE_TO_LOCALE_TAG: Record<string, string> = {
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
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-PT',
  ro: 'ro-RO',
  zh: 'zh-CN',
  ja: 'ja-JP',
}

function normalizeLanguageCode(raw: unknown): string {
  const primary = String(raw || '')
    .trim()
    .toLowerCase()
    .replace('_', '-')
    .split('-')[0] || 'en'
  const normalized = primary === 'in' ? 'id' : primary
  return LANGUAGE_TO_LOCALE_TAG[normalized] ? normalized : 'en'
}

function normalizeLocaleTag(raw: unknown, fallbackLanguageCode = 'en'): string {
  const candidate = String(raw || '').trim()
  if (/^[a-z]{2}(-[A-Z]{2})$/.test(candidate)) return candidate
  return LANGUAGE_TO_LOCALE_TAG[fallbackLanguageCode] || 'en-US'
}

function normalizeNumberFormatMode(raw: unknown): NumberFormatMode {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'comma' || value === 'period' || value === 'system') return value
  return 'system'
}

function normalizeCurrencyCode(raw: unknown): string {
  const candidate = String(raw || '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(candidate) ? candidate : 'USD'
}

function resolveLocaleContractFromRequest(rawBody: unknown): RequestLocaleContract {
  const body = isPlainObject(rawBody) ? rawBody : {}
  const hasLanguageCode = typeof body.languageCode === 'string' && body.languageCode.trim().length > 0
  const languageCode = hasLanguageCode ? normalizeLanguageCode(body.languageCode) : null
  const hasLocaleTag = typeof body.localeTag === 'string' && body.localeTag.trim().length > 0
  const hasMainCurrencyCode = typeof body.mainCurrencyCode === 'string' && body.mainCurrencyCode.trim().length > 0
  const hasNumberFormatMode = typeof body.numberFormatMode === 'string' && body.numberFormatMode.trim().length > 0
  return {
    languageCode,
    localeTag: hasLocaleTag ? normalizeLocaleTag(body.localeTag, languageCode || 'en') : null,
    mainCurrencyCode: hasMainCurrencyCode ? normalizeCurrencyCode(body.mainCurrencyCode) : null,
    numberFormatMode: hasNumberFormatMode ? normalizeNumberFormatMode(body.numberFormatMode) : null,
  }
}

function buildLocaleFormattingTools(localeTag: string, numberFormatMode: NumberFormatMode) {
  const numberLocale = numberFormatMode === 'comma'
    ? 'de-DE'
    : numberFormatMode === 'period'
      ? 'en-US'
      : localeTag

  const formatNumber = (value: number, minimumFractionDigits = 2, maximumFractionDigits = 2): string => {
    const numeric = Number(value)
    const safe = Number.isFinite(numeric) ? numeric : 0
    return safe.toLocaleString(numberLocale, { minimumFractionDigits, maximumFractionDigits })
  }

  const formatMoney = (value: number, currencyCode: string): string => {
    return `${formatNumber(value, 2, 2)} ${currencyCode}`
  }

  const formatShortDate = (value: unknown): string => {
    if (!value) return 'unknown'
    const date = new Date(String(value))
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleDateString(localeTag, { month: 'short', day: 'numeric' })
  }

  return { formatNumber, formatMoney, formatShortDate }
}

function logCentNormalization(
  label: string,
  result: CentCurrencyNormalizationResult<Record<string, unknown>>,
): void {
  for (const summary of result.summaries) {
    console.log(
      `[ai-chat] ${label}.${summary.field} normalization: usable=${summary.usableRows}, normalized=${summary.normalizedRows}, zeroed=${summary.zeroedRows}, keptRaw=${summary.keptRawRows}, fx=${summary.metrics.temporary_converted_rows_used}, same=${summary.metrics.raw_same_currency_rows_used}, missing=${summary.metrics.rows_with_missing_reporting_fields}, fxFailures=${summary.metrics.fx_lookup_failures}`,
    )
  }
}

function calculateDeepAnalytics(
  transactions: LooseRow[] | null | undefined,
  subscriptions: LooseRow[] | null | undefined,
  bills: LooseRow[] | null | undefined,
  debts: LooseRow[] | null | undefined,
  currencyCode: string,
  numberFormatMode: NumberFormatMode,
  localeTag: string,
): DeepAnalyticsSummary {
  try {
    const tx: LooseRow[] = Array.isArray(transactions) ? transactions : []
    const subs: LooseRow[] = Array.isArray(subscriptions) ? subscriptions : []
    const billsArr: LooseRow[] = Array.isArray(bills) ? bills : []
    const debtsArr: LooseRow[] = Array.isArray(debts) ? debts : []
    const { formatNumber, formatMoney } = buildLocaleFormattingTools(localeTag, numberFormatMode)

    // Category normalization + transfer detection (copied from spending-engine to keep analytics consistent)
    const toCategoryKey = (raw: string | null): string => {
      const trimmed = String(raw || '').trim()
      if (!trimmed) return 'other'

      return trimmed
        .toLowerCase()
        .replace(/\s+/g, ' ')  // Collapse whitespace
        .replace(/[^a-z0-9\s-]/g, '')  // Remove special chars (keep hyphens)
        .replace(/\s+/g, '-')  // Spaces to hyphens
        .replace(/^-+|-+$/g, '')  // Trim hyphens
        || 'other'
    }

    const isTransferLikeCategory = (categoryKey: string): boolean => {
      return (
        categoryKey === 'transfer' ||
        categoryKey === 'internal-transfer' ||
        categoryKey === 'wallet-transfer' ||
        categoryKey === 'money-transfer'
      )
    }

    const formatTopCategories = (inputTx: any[], label: string, emptyLabel: string): string => {
      try {
        const categoryTotals: Record<string, number> = {}
        let totalSpending = 0

        inputTx.forEach((t: any) => {
          const categoryKey = toCategoryKey(t.category)
          if (isTransferLikeCategory(categoryKey)) return
          if ((t.amount || 0) < 0) {
            const category = t.category || 'Uncategorized'
            const amount = Math.abs(t.amount || 0)
            categoryTotals[category] = (categoryTotals[category] || 0) + amount
            totalSpending += amount
          }
        })

        if (totalSpending <= 0) return emptyLabel

        const sortedCategories = Object.entries(categoryTotals)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 15)
          .map(([category, amount]) => {
            const percentage = ((amount / totalSpending) * 100).toFixed(0)
            return `${category} at ${formatMoney(amount, currencyCode)} (${percentage}%)`
          })

        return `${label}:\n${sortedCategories.join('\n')}`
      } catch (e) {
        console.error('Error formatting top categories:', e)
        return emptyLabel
      }
    }

    // Date calculations
    const now = new Date()
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(now.getDate() - 30)

    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const previousMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0)

    // Calendar weeks use Monday as the first day so "this week" has a stable meaning.
    const startOfThisWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0))
    const utcDay = startOfThisWeek.getUTCDay()
    const mondayOffset = utcDay === 0 ? -6 : 1 - utcDay
    startOfThisWeek.setUTCDate(startOfThisWeek.getUTCDate() + mondayOffset)

    const startOfLastWeek = new Date(startOfThisWeek)
    startOfLastWeek.setUTCDate(startOfLastWeek.getUTCDate() - 7)
    const samePointLastWeek = new Date(now)
    samePointLastWeek.setUTCDate(samePointLastWeek.getUTCDate() - 7)

    // Filter transactions by time periods
    const last30Days = tx.filter((t: LooseRow) => new Date(t.date) >= thirtyDaysAgo)
    const currentMonth = tx.filter((t: LooseRow) => new Date(t.date) >= currentMonthStart)
    const previousMonth = tx.filter((t: LooseRow) => {
      const date = new Date(t.date)
      return date >= previousMonthStart && date <= previousMonthEnd
    })
    const txThisWeek = tx.filter((t: LooseRow) => {
      const date = new Date(t.date)
      return date >= startOfThisWeek
    })
    const txLastWeek = tx.filter((t: LooseRow) => {
      const date = new Date(t.date)
      return date >= startOfLastWeek && date < startOfThisWeek
    })
    const txLastWeekToDate = tx.filter((t: LooseRow) => {
      const date = new Date(t.date)
      return date >= startOfLastWeek && date <= samePointLastWeek
    })

    // Month boundaries (UTC) for month-scoped analytics
    const startOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0))
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0))
    const startOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0))

    const txThisMonth = tx.filter((t: LooseRow) => {
      const d = new Date(t.date)
      return d >= startOfThisMonth && d < startOfNextMonth
    })

    const txLastMonth = tx.filter((t: LooseRow) => {
      const d = new Date(t.date)
      return d >= startOfLastMonth && d < startOfThisMonth
    })

    // 1. TOP SPENDING CATEGORIES (Last 30 Days) - existing field (unchanged meaning)
    const topCategories = formatTopCategories(
      last30Days,
      'Top categories (last 30 days)',
      'No spending data available'
    )

    const topCategoriesThisWeek = formatTopCategories(
      txThisWeek,
      'Top categories this week',
      'No spending data available for this week'
    )

    const topCategoriesLastWeek = formatTopCategories(
      txLastWeek,
      'Top categories last week',
      'No spending data available for last week'
    )

    // 1b. TOP SPENDING CATEGORIES (Calendar Month, UTC)
    const topCategoriesThisMonth = formatTopCategories(
      txThisMonth,
      'Top categories this month',
      'No spending data available for this month'
    )

    const topCategoriesLastMonth = formatTopCategories(
      txLastMonth,
      'Top categories last month',
      'No spending data available for last month'
    )

    // 2. SPENDING PATTERNS BY DAY OF WEEK
    let spendingByDay = 'No spending patterns available'
    try {
      const dayTotals: Record<string, number> = {}
      const dayCounts: Record<string, number> = {}

      last30Days.forEach((t: LooseRow) => {
        const categoryKey = toCategoryKey(t.category)
        if (isTransferLikeCategory(categoryKey)) return
        if ((t.amount || 0) < 0) { // Only expenses
          const dayOfWeek = new Date(t.date).toLocaleDateString(localeTag, { weekday: 'long' })
          const amount = Math.abs(t.amount || 0)
          dayTotals[dayOfWeek] = (dayTotals[dayOfWeek] || 0) + amount
          dayCounts[dayOfWeek] = (dayCounts[dayOfWeek] || 0) + 1
        }
      })

      const dayAverages = Object.entries(dayTotals)
        .map(([day, total]: [string, number]) => [day, total / (dayCounts[day] || 1)] as const)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)

      if (dayAverages.length > 0) {
        spendingByDay = dayAverages
          .map(([day, avg]) => `${day}: ${formatNumber(avg, 0, 0)} avg`)
          .join(', ')
      }
    } catch (e) {
      console.error('Error calculating spending by day:', e)
    }

    // 3. TOP MERCHANTS (Frequency & Total)
    let topMerchants = 'No merchant data available'
    try {
      const merchantData: Record<string, { total: number; count: number }> = {}

      last30Days.forEach((t: LooseRow) => {
        const categoryKey = toCategoryKey(t.category)
        if (isTransferLikeCategory(categoryKey)) return
        if ((t.amount || 0) < 0) { // Only expenses
          const merchant = t.title || 'Unknown Merchant'
          const amount = Math.abs(t.amount || 0)
          if (!merchantData[merchant]) {
            merchantData[merchant] = { total: 0, count: 0 }
          }
          merchantData[merchant].total += amount
          merchantData[merchant].count += 1
        }
      })

      const sortedMerchants = Object.entries(merchantData)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, 3)
        .map(([merchant, data]: [string, { total: number; count: number }]) => `${merchant}: ${data.count}x (${formatMoney(data.total, currencyCode)})`)

      if (sortedMerchants.length > 0) {
        topMerchants = sortedMerchants.join(', ')
      }
    } catch (e) {
      console.error('Error calculating top merchants:', e)
    }

    // 4. MONTH-OVER-MONTH COMPARISON
    let weekComparison = 'No comparison data available'
    try {
      const thisWeekSpending = txThisWeek
        .filter(t => {
          if ((t.amount || 0) >= 0) return false
          const categoryKey = toCategoryKey((t as any).category)
          return !isTransferLikeCategory(categoryKey)
        })
        .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)

      const lastWeekSpending = txLastWeekToDate
        .filter(t => {
          if ((t.amount || 0) >= 0) return false
          const categoryKey = toCategoryKey((t as any).category)
          return !isTransferLikeCategory(categoryKey)
        })
        .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)

      if (lastWeekSpending > 0) {
        const change = ((thisWeekSpending - lastWeekSpending) / lastWeekSpending) * 100
        const direction = change > 0 ? 'up' : 'down'
        weekComparison = `Spending ${direction} ${Math.abs(change).toFixed(0)}% vs the same point last week (${formatMoney(thisWeekSpending, currencyCode)} vs ${formatMoney(lastWeekSpending, currencyCode)})`
      } else if (thisWeekSpending > 0) {
        weekComparison = `This week spending: ${formatMoney(thisWeekSpending, currencyCode)} (no previous week data)`
      }
    } catch (e) {
      console.error('Error calculating week comparison:', e)
    }

    // 5. MONTH-OVER-MONTH COMPARISON
    let monthComparison = 'No comparison data available'
    try {
      const currentMonthSpending = currentMonth
        .filter(t => {
          if ((t.amount || 0) >= 0) return false
          const categoryKey = toCategoryKey((t as any).category)
          return !isTransferLikeCategory(categoryKey)
        })
        .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)

      const previousMonthSpending = previousMonth
        .filter(t => {
          if ((t.amount || 0) >= 0) return false
          const categoryKey = toCategoryKey((t as any).category)
          return !isTransferLikeCategory(categoryKey)
        })
        .reduce((sum, t) => sum + Math.abs(t.amount || 0), 0)

      if (previousMonthSpending > 0) {
        const change = ((currentMonthSpending - previousMonthSpending) / previousMonthSpending) * 100
        const direction = change > 0 ? 'up' : 'down'
        monthComparison = `Spending ${direction} ${Math.abs(change).toFixed(0)}% vs last month (${formatMoney(currentMonthSpending, currencyCode)} vs ${formatMoney(previousMonthSpending, currencyCode)})`
      } else if (currentMonthSpending > 0) {
        monthComparison = `Current month spending: ${formatMoney(currentMonthSpending, currencyCode)} (no previous month data)`
      }
    } catch (e) {
      console.error('Error calculating month comparison:', e)
    }

    // 6. INCOME TRACKING
    let totalIncome = 'No income data available'
    try {
      const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Income', 'Wages', 'Bonus']

      const incomeTransactions = currentMonth.filter((t: LooseRow) =>
        (t.amount || 0) > 0 &&
        INCOME_CATEGORIES.includes(t.category)
      )

      if (incomeTransactions.length > 0) {
        const totalIncomeAmount = incomeTransactions.reduce((sum: number, t: LooseRow) => sum + (t.amount || 0), 0)
        const incomeByCategory: Record<string, number> = {}

        incomeTransactions.forEach((t: LooseRow) => {
          const category = t.category || 'Other'
          incomeByCategory[category] = (incomeByCategory[category] || 0) + (t.amount || 0)
        })

        const categoryBreakdown = Object.entries(incomeByCategory)
          .map(([category, amount]: [string, number]) => `${category}: ${formatMoney(amount, currencyCode)}`)
          .join(', ')

        totalIncome = `Total income this month: ${formatMoney(totalIncomeAmount, currencyCode)} (${categoryBreakdown})`
      }
    } catch (e) {
      console.error('Error calculating income:', e)
    }

    // 7. RECURRING BILLS FROM AUTHORITATIVE TABLES ONLY
    let recurringBills = 'No recurring bills found'
    try {
      const billsList: string[] = []

      if (subs.length > 0) {
        subs.forEach((s: any) => {
          const amount = (s.amount_cents ? (s.amount_cents / 100) : 0) || 0
          const nextDate = s.next_billing_date ? new Date(s.next_billing_date).getDate() : null
          const ordinal = nextDate === 1 ? '1st' : nextDate === 2 ? '2nd' : nextDate === 3 ? '3rd' : (nextDate ? `${nextDate}th` : '?')
          billsList.push(`${s.name || 'Subscription'} ${formatMoney(amount, currencyCode)} (${ordinal})`)
        })
      }

      if (billsArr.length > 0) {
        billsArr.forEach((b: any) => {
          const amount = (b.amount_cents ? (b.amount_cents / 100) : 0) || 0
          const dueDate = b.due_date ? new Date(b.due_date).getDate() : null
          const ordinal = dueDate === 1 ? '1st' : dueDate === 2 ? '2nd' : dueDate === 3 ? '3rd' : (dueDate ? `${dueDate}th` : '?')
          billsList.push(`${b.name || 'Bill'} ${formatMoney(amount, currencyCode)} (${ordinal})`)
        })
      }

      if (debtsArr.length > 0) {
        debtsArr.forEach((d: any) => {
          const remaining = (d.remaining_amount_cents ? (d.remaining_amount_cents / 100) : 0) || 0
          if (remaining > 0) {
            const payment = (d.minimum_payment_cents ? (d.minimum_payment_cents / 100) : 0) || 0
            if (payment > 0) {
              billsList.push(`${d.name || 'Debt'} ${formatMoney(payment, currencyCode)}/month`)
            }
          }
        })
      }

      if (billsList.length > 0) {
        recurringBills = billsList.slice(0, 5).join(', ')
      }
    } catch (e) {
      console.error('Error loading recurring bills from tables:', e)
    }

    // 7. LARGEST EXPENSES
    let largestExpenses = 'No expense data available'
    try {
      const expenses = last30Days
        .filter(t => {
          if ((t.amount || 0) >= 0) return false
          const categoryKey = toCategoryKey((t as any).category)
          return !isTransferLikeCategory(categoryKey)
        })
        .map(t => ({
          merchant: t.title || 'Unknown Merchant',
          amount: Math.abs(t.amount || 0)
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map(e => `${e.merchant} ${formatMoney(e.amount, currencyCode)}`)

      if (expenses.length > 0) {
        largestExpenses = `Largest expenses: ${expenses.join(', ')}`
      }
    } catch (e) {
      console.error('Error calculating largest expenses:', e)
    }

    return {
      topCategories,
      topCategoriesThisWeek,
      topCategoriesLastWeek,
      topCategoriesThisMonth,
      topCategoriesLastMonth,
      spendingByDay,
      topMerchants,
      weekComparison,
      monthComparison,
      totalIncome,
      recurringBills,
      largestExpenses
    }

  } catch (error) {
    console.error('Ã¢Å¡Â Ã¯Â¸Â Error in calculateDeepAnalytics:', error)
    return {
      topCategories: 'Analytics calculation failed',
      topCategoriesThisWeek: 'Analytics calculation failed',
      topCategoriesLastWeek: 'Analytics calculation failed',
      topCategoriesThisMonth: 'Analytics calculation failed',
      topCategoriesLastMonth: 'Analytics calculation failed',
      spendingByDay: 'Analytics calculation failed',
      topMerchants: 'Analytics calculation failed',
      weekComparison: 'Analytics calculation failed',
      monthComparison: 'Analytics calculation failed',
      totalIncome: 'Analytics calculation failed',
      recurringBills: 'Analytics calculation failed',
      largestExpenses: 'Analytics calculation failed'
    }
  }
}

function determinePrimaryCurrency(
  userPrefCurrency: string | null | undefined,
  wallets: any[] | null
): { primaryCurrency: string; warning: string | null } {
  if (userPrefCurrency && typeof userPrefCurrency === 'string' && userPrefCurrency.length >= 2) {
    return { primaryCurrency: userPrefCurrency, warning: null }
  }

  if (!wallets || wallets.length === 0) {
    return { primaryCurrency: 'USD', warning: null }
  }

  const counts = new Map<string, number>()
  for (const w of wallets) {
    const cc = String(w?.currency_code || 'USD')
    counts.set(cc, (counts.get(cc) || 0) + 1)
  }

  let best = 'USD'
  let bestCount = 0
  for (const [cc, count] of counts) {
    if (count > bestCount) {
      best = cc
      bestCount = count
    }
  }

  const warning = counts.size > 1
    ? `Multiple currencies detected (${[...counts.keys()].join(', ')}). Context focuses on ${best} wallets.`
    : null

  return { primaryCurrency: best, warning }
}

async function buildFinancialContext(
  supabase: any,
  userId: string,
  authHeader: string | null = null,
  requestLocaleContract?: RequestLocaleContract
): Promise<WiseyFinancialContext> {
  const startTime = nowMs()

  try {
    // Bound the read shape so AI context stays fast for heavy-history users.
    const sixtyDaysAgo = new Date()
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - AI_CHAT_CONTEXT_TX_WINDOW_DAYS)

    const obligationsClient = authHeader
      ? createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        {
          auth: { persistSession: false },
          global: { headers: { Authorization: authHeader } }
        }
      )
      : supabase

    const walletsPromise = supabase
      .from('wallets')
      .select('id, name, type, balance, currency_code, archived, account_class, created_at, updated_at')
      .eq('user_id', userId)

    const userPrefsPromise = supabase
      .from('user_preferences')
      .select('cycle_start_day, currency, preferred_language')
      .eq('user_id', userId)
      .maybeSingle()

    const txPromise = supabase
      .from('wallet_transactions')
      .select('id, wallet_id, amount, reporting_amount, reporting_currency, category, category_id, title, note, date, created_at, goal_id, budget_id, is_opening_balance, is_manual_topup')
      .eq('user_id', userId)
      .gte('date', sixtyDaysAgo.toISOString())
      .order('date', { ascending: false })
      .limit(AI_CHAT_CONTEXT_TX_ROW_LIMIT)

    const goalsPromise = supabase
      .from('goals')
      .select('id, name, target_amount_cents, current_amount_cents, target_date_millis, linked_wallet_id, is_deduction_paused, is_challenge, is_wish, currency_code, auto_save_amount_cents, created_at, updated_at')
      .eq('user_id', userId)
      .limit(5)

    const budgetsPromise = supabase
      .from('budgets')
      .select('id, name, amount_cents, category_id, category_ids, wallet_id, start_date, end_date, spent_cents, is_active, tracking_start_date, updated_at, categories(name)')
      .eq('user_id', userId)
      .eq('is_active', true)

    const debtsPromise = supabase
      .from('debts')
      .select('id, name, total_amount_cents, remaining_amount_cents, interest_rate, minimum_payment_cents, monthly_payment_cents, due_date, updated_at')
      .eq('user_id', userId)
      .limit(5)

    const subsPromise = supabase
      .from('subscriptions')
      .select('id, name, amount_cents, billing_cycle, next_billing_date, wallet_id, is_active, currency_code, day_of_month, notes')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(10)

    const billsPromise = supabase
      .from('bills')
      .select('id, name, amount_cents, due_date, is_recurring, recurring_frequency, category, wallet_id, is_paid, currency_code, notes, updated_at')
      .eq('user_id', userId)
      // Get all active bills (not just recurring) - include one-time bills too
      .eq('is_paid', false)
      .limit(15)

    const incomesPromise = supabase
      .from('incomes')
      .select('id, name, amount_cents, expected_date, is_recurring, recurring_frequency, source, wallet_id, is_received, currency_code, notes, updated_at')
      .eq('user_id', userId)
      .eq('is_received', false)
      .limit(15)

    const plannedPaymentsPromise = supabase
      .from('planned_payments')
      .select('id, name, amount_cents, due_date, is_recurring, recurring_frequency, category, wallet_id, is_paid, currency_code, notes, updated_at')
      .eq('user_id', userId)
      .eq('is_paid', false)
      .limit(15)

    const receivablesPromise = supabase
      .from('receivables')
      .select('id, person_name, original_amount_cents, amount_received_cents, monthly_payment_cents, due_date, note, updated_at')
      .eq('user_id', userId)
      .limit(15)

    const insightsPromise = supabase
      .from('insights')
      .select('source, type, title, description, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10)

    const [
      walletsRes,
      userPrefsRes,
      txRes,
      goalsRes,
      budgetsRes,
      debtsRes,
      subsRes,
      billsRes,
      incomesRes,
      plannedPaymentsRes,
      receivablesRes,
      insightsRes,
    ] = await Promise.all([
      walletsPromise,
      userPrefsPromise,
      txPromise,
      goalsPromise,
      budgetsPromise,
      debtsPromise,
      subsPromise,
      billsPromise,
      incomesPromise,
      plannedPaymentsPromise,
      receivablesPromise,
      insightsPromise,
    ])

    // Extract data and log errors
    const wallets = (walletsRes.data ?? null) as LooseRow[] | null
    if (walletsRes.error) console.error('Wallets query error:', walletsRes.error.message)

    const userPrefs = (userPrefsRes.data ?? null) as LooseRow | null
    if (userPrefsRes.error) console.error('User preferences query error:', userPrefsRes.error.message)

    let transactions: LooseRow[] | null = null
    if (!txRes.error && txRes.data?.length > 0) {
      transactions = txRes.data as LooseRow[]
    }
    const preferredLanguage = normalizeLanguageCode(
      requestLocaleContract?.languageCode || userPrefs?.preferred_language || 'en'
    )
    const localeTag = normalizeLocaleTag(requestLocaleContract?.localeTag, preferredLanguage)
    const numberFormatMode = normalizeNumberFormatMode(requestLocaleContract?.numberFormatMode)

    const baseCurrency = requestLocaleContract?.mainCurrencyCode || userPrefs?.currency
    const { primaryCurrency, warning: currencyScopeWarning } = determinePrimaryCurrency(baseCurrency, wallets || [])
    const { formatNumber, formatMoney, formatShortDate } = buildLocaleFormattingTools(localeTag, numberFormatMode)
    let effectiveCurrencyWarning = currencyScopeWarning
    const walletBalanceByIdInPrimary = new Map<string, number>()

    const balanceFxDate = new Date().toISOString().slice(0, 10)
    const walletRowsForNormalization = (wallets || [])
      .map((w: any) => ({
        wallet_id: String(w?.id || '').trim(),
        amount: Number(w?.balance || 0),
        reporting_amount: null,
        reporting_currency: null,
        source_currency: String(w?.currency_code || primaryCurrency),
        date: balanceFxDate,
      }))
      .filter((row: any) => row.wallet_id.length > 0 && Number.isFinite(row.amount))

    if (walletRowsForNormalization.length > 0) {
      const normalizedWalletBalances = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        primaryCurrency,
        walletRowsForNormalization as Array<Record<string, unknown>>,
      )

      for (const row of normalizedWalletBalances.rows as any[]) {
        const walletId = String(row?.wallet_id || '').trim()
        const normalizedAmount = Number(row?.amount)
        if (walletId && Number.isFinite(normalizedAmount)) {
          walletBalanceByIdInPrimary.set(walletId, normalizedAmount)
        }
      }

      const excludedCrossCurrencyWallets = (wallets || []).filter((w: any) => {
        const walletId = String(w?.id || '').trim()
        const walletCurrency = String(w?.currency_code || primaryCurrency)
        if (walletCurrency === primaryCurrency) return false
        return !walletBalanceByIdInPrimary.has(walletId)
      })

      if (excludedCrossCurrencyWallets.length > 0) {
        const extraWarning = `${excludedCrossCurrencyWallets.length} wallet balance(s) could not be converted to ${primaryCurrency} and were excluded from total balance.`
        effectiveCurrencyWarning = effectiveCurrencyWarning
          ? `${effectiveCurrencyWarning} ${extraWarning}`
          : extraWarning
      }

      console.log(
        `[ai-chat] wallet currency normalization: converted=${walletBalanceByIdInPrimary.size}, excludedCrossCurrency=${excludedCrossCurrencyWallets.length}, primary=${primaryCurrency}`
      )
    }
    if (transactions && transactions.length > 0) {
      const normalized = await normalizeTransactionsToMainCurrency(
        supabase,
        userId,
        primaryCurrency,
        transactions as Array<Record<string, unknown>>,
      )
      transactions = normalized.rows as any[]
      console.log(
        `[ai-chat] tx currency normalization: normalized=${normalized.metrics.normalized_rows_used}, fx=${normalized.metrics.temporary_converted_rows_used}, same=${normalized.metrics.raw_same_currency_rows_used}, missing=${normalized.metrics.rows_with_missing_reporting_fields}, fxFailures=${normalized.metrics.fx_lookup_failures}`
      )
    }

    let goals = (goalsRes.data ?? null) as LooseRow[] | null
    if (goalsRes.error) console.error('Goals query error:', goalsRes.error.message)

    let budgets = (budgetsRes.data ?? null) as LooseRow[] | null
    if (budgetsRes.error) console.error('Budgets query error:', budgetsRes.error.message)

    let debts = (debtsRes.data ?? null) as LooseRow[] | null
    if (debtsRes.error) console.error('Debts query error:', debtsRes.error.message)

    let subscriptions = (subsRes.data ?? null) as LooseRow[] | null
    if (subsRes.error) console.error('Subscriptions query error:', subsRes.error.message)

    let bills = (billsRes.data ?? null) as LooseRow[] | null
    if (billsRes.error) console.error('Bills query error:', billsRes.error.message)

    let incomes = (incomesRes.data ?? null) as LooseRow[] | null
    if (incomesRes.error) console.error('Incomes query error:', incomesRes.error.message)

    let plannedPayments = (plannedPaymentsRes.data ?? null) as LooseRow[] | null
    if (plannedPaymentsRes.error) console.error('Planned payments query error:', plannedPaymentsRes.error.message)

    let receivables = (receivablesRes.data ?? null) as LooseRow[] | null
    if (receivablesRes.error) console.error('Receivables query error:', receivablesRes.error.message)

    const insights = (insightsRes.data ?? null) as LooseRow[] | null
    if (insightsRes.error) console.error('Insights query error:', insightsRes.error.message)

    const insightsSummary = insights && insights.length > 0
      ? insights.map((i: LooseRow) => {
        const src = (i.source || 'app').toString().toUpperCase()
        const typ = (i.type || '').toString().toUpperCase()
        return `[${src}/${typ}] ${i.title}: ${i.description}`
      }).join('\n')
      : 'No recent in-app insights logged yet.'

    const appendCurrencyWarning = (warning: string | null | undefined): void => {
      if (!warning) return
      effectiveCurrencyWarning = effectiveCurrencyWarning
        ? `${effectiveCurrencyWarning} ${warning}`
        : warning
    }

    const normalizeMoneyRows = async (
      label: string,
      rows: LooseRow[] | null,
      fields: Array<{ amountField: string; dateField?: string }>,
    ): Promise<LooseRow[] | null> => {
      const sourceRows = Array.isArray(rows) ? rows : []
      if (sourceRows.length === 0) return rows

      const result = await normalizeCentFieldsToMainCurrency(
        supabase,
        userId,
        primaryCurrency,
        sourceRows as Array<Record<string, unknown>>,
        fields.map((field) => ({
          ...field,
          missingConversion: 'zero' as const,
        })),
      )
      logCentNormalization(label, result)
      appendCurrencyWarning(buildCentNormalizationWarning(label, result, primaryCurrency))
      return result.rows as LooseRow[]
    }

    subscriptions = await normalizeMoneyRows('subscriptions', subscriptions, [
      { amountField: 'amount_cents', dateField: 'next_billing_date' },
    ])
    bills = await normalizeMoneyRows('bills', bills, [
      { amountField: 'amount_cents', dateField: 'due_date' },
    ])
    incomes = await normalizeMoneyRows('incomes', incomes, [
      { amountField: 'amount_cents', dateField: 'expected_date' },
    ])
    plannedPayments = await normalizeMoneyRows('plannedPayments', plannedPayments, [
      { amountField: 'amount_cents', dateField: 'due_date' },
    ])
    receivables = await normalizeMoneyRows('receivables', receivables, [
      { amountField: 'original_amount_cents', dateField: 'due_date' },
      { amountField: 'amount_received_cents', dateField: 'updated_at' },
      { amountField: 'monthly_payment_cents', dateField: 'updated_at' },
    ])
    debts = await normalizeMoneyRows('debts', debts, [
      { amountField: 'remaining_amount_cents', dateField: 'updated_at' },
      { amountField: 'total_amount_cents', dateField: 'updated_at' },
      { amountField: 'monthly_payment_cents', dateField: 'updated_at' },
      { amountField: 'minimum_payment_cents', dateField: 'updated_at' },
    ])
    budgets = await normalizeMoneyRows('budgets', budgets, [
      { amountField: 'amount_cents', dateField: 'updated_at' },
      { amountField: 'spent_cents', dateField: 'updated_at' },
    ])
    goals = await normalizeMoneyRows(
      'goals',
      (goals || []).map((goal: LooseRow) => ({
        ...goal,
        wallet_id: goal.wallet_id ?? goal.linked_wallet_id ?? null,
      })),
      [
        { amountField: 'current_amount_cents', dateField: 'updated_at' },
        { amountField: 'target_amount_cents', dateField: 'updated_at' },
        { amountField: 'auto_save_amount_cents', dateField: 'updated_at' },
      ],
    )

    // PHASE 1: DEEP ANALYTICS CALCULATIONS
    const analytics = calculateDeepAnalytics(
      transactions || [],
      subscriptions || [],
      bills || [],
      debts || [],
      primaryCurrency,
      numberFormatMode,
      localeTag
    )

    // CALCULATE COMPREHENSIVE FINANCIAL SUMMARY
    const totalBalance = (wallets || []).reduce((sum: number, w: any) => {
      const walletId = String(w?.id || '').trim()
      const normalizedAmount = walletBalanceByIdInPrimary.get(walletId)
      if (typeof normalizedAmount === 'number' && Number.isFinite(normalizedAmount)) {
        return sum + normalizedAmount
      }

      const walletCurrency = String(w?.currency_code || primaryCurrency)
      if (walletCurrency !== primaryCurrency) {
        return sum
      }

      const rawBalance = Number(w?.balance || 0)
      return sum + (Number.isFinite(rawBalance) ? rawBalance : 0)
    }, 0)
    const totalDebt = debts?.reduce((sum: number, d: LooseRow) => sum + (d.remaining_amount_cents / 100 || 0), 0) || 0
    const monthlySubscriptions = subscriptions?.reduce((sum: number, s: LooseRow) => {
      const amount = s.amount_cents / 100 || 0
      return sum + (s.billing_cycle === 'MONTHLY' ? amount :
        s.billing_cycle === 'YEARLY' ? amount / 12 : amount * 30)
    }, 0) || 0

    // Recent spending (last 30 days expenses only; exclude transfer-like)
    const toCategoryKey = (raw: string | null): string => {
      const trimmed = String(raw || '').trim()
      if (!trimmed) return 'other'

      return trimmed
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'other'
    }

    const isTransferLikeCategory = (categoryKey: string): boolean => {
      return (
        categoryKey === 'transfer' ||
        categoryKey === 'internal-transfer' ||
        categoryKey === 'wallet-transfer' ||
        categoryKey === 'money-transfer'
      )
    }

    const recentExpenses = (transactions || []).filter((t: any) => {
      if ((t.amount || 0) >= 0) return false
      const categoryKey = toCategoryKey(t.category)
      return !isTransferLikeCategory(categoryKey)
    })
    const totalRecentSpending = recentExpenses.reduce((sum: number, t: LooseRow) => sum + Math.abs(t.amount || 0), 0)

    // Wishes are stored in the goals table today; keep them out of goal progress summaries.
    const isWishGoal = (g: any) => !g?.is_challenge && (g?.is_wish === true || (g?.is_wish !== false && Number(g?.target_amount_cents ?? 0) <= 0))
    const activeGoals = goals?.filter((g: any) => !g.is_challenge && !isWishGoal(g)) || []
    const wishItems = goals?.filter((g: any) => isWishGoal(g)) || []
    const activeChallenges = goals?.filter((g: any) => g.is_challenge) || []

    // Canonical obligations + cycle-aware budgets (same source-of-truth model as ai-advisor/ai-budget-intelligence)
    const toYmd = (value: unknown): string | null => {
      if (!value) return null
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return null
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
        const d = new Date(trimmed)
        return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
      }
      const d = new Date(value as any)
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
    }
    const toShortDate = (value: unknown): string => {
      const d = toYmd(value)
      if (!d) return 'unknown'
      return formatShortDate(`${d}T00:00:00Z`)
    }
    const fmtCents = (cents: number): string => {
      const amount = Math.max(0, Math.round(Number(cents || 0))) / 100
      return formatNumber(amount, 2, 2)
    }

    const todayKey = new Date().toISOString().slice(0, 10)
    const cycleStartDay = Math.max(1, Math.min(31, Number(userPrefs?.cycle_start_day || 1)))

    const activeWalletIds = new Set<string>(
      (wallets || [])
        .filter((w: any) => w?.archived !== true)
        .map((w: any) => String(w?.id || '').trim())
        .filter((id: string) => id.length > 0)
    )

    let obligationsSummary = 'No obligations data available'
    let obligationsList = 'No upcoming obligations'
    let obligationsWindow = `Window: ${todayKey} to ${todayKey}`
    let obligationsWarningText = effectiveCurrencyWarning || 'None'
    let obligationsTotalCents = 0
    let obligationsBillsCents = 0
    let obligationsPlannedPaymentsCents = 0
    let obligationsSubscriptionsCents = 0
    let obligationsGoalAutoSaveCents = 0
    let obligationsOverdueCents = 0
    let obligationsCount = 0
    let obligationWindowStart = todayKey
    let obligationWindowEnd = todayKey

    try {
      const canonical = await getCanonicalObligations(obligationsClient, {
        mode: 'current_cycle',
        anchorDate: todayKey,
        cycleStartDay,
        walletIds: activeWalletIds,
        includeOverdue: true,
        includeLines: true,
      })

      obligationWindowStart = canonical?.window?.startDate || todayKey
      obligationWindowEnd = canonical?.window?.endDate || todayKey
      obligationsWindow = `Window: ${obligationWindowStart} to ${obligationWindowEnd}`

      const normalizedObligations = await normalizeCanonicalObligationLinesToMainCurrency(
        supabase,
        userId,
        primaryCurrency,
        Array.isArray(canonical?.lines) ? canonical.lines : [],
        obligationWindowStart,
      )
      const normalizedTotals = sumNormalizedObligationTotals(normalizedObligations.lines)

      obligationsBillsCents = normalizedTotals.billsCents
      obligationsPlannedPaymentsCents = normalizedTotals.plannedPaymentsCents
      obligationsSubscriptionsCents = normalizedTotals.subscriptionsCents
      obligationsGoalAutoSaveCents = normalizedTotals.goalAutoSaveCents
      obligationsOverdueCents = normalizedTotals.overdueCents
      obligationsTotalCents = normalizedTotals.totalCents
      obligationsCount = normalizedObligations.lines.filter((line) => !line.isOverdue).length

      const sortedLines = [...normalizedObligations.lines].sort((a, b) => {
        const da = String(a?.dateKey || '')
        const db = String(b?.dateKey || '')
        return da.localeCompare(db)
      })
      obligationsList = sortedLines.slice(0, 12).map((line) => {
        const amount = fmtCents(line?.amountCents || 0)
        const due = toShortDate(line?.dateKey)
        const src = String(line?.source || 'item').replace(/_/g, ' ')
        const overdue = line?.isOverdue ? ' overdue' : ''
        return `${line?.name || 'Unnamed obligation'}: ${amount} ${primaryCurrency} due ${due} (${src}${overdue})`
      }).join('\n') || 'No upcoming obligations'

      const warnings: string[] = []
      if (effectiveCurrencyWarning) warnings.push(effectiveCurrencyWarning)
      if (Array.isArray(canonical?.warnings) && canonical.warnings.length > 0) {
        warnings.push(...canonical.warnings.map((w: any) => String(w)))
      }
      const normalizationWarning = buildObligationNormalizationWarning(normalizedObligations, primaryCurrency)
      if (normalizationWarning) warnings.push(normalizationWarning)
      obligationsWarningText = warnings.length > 0 ? warnings.join(' | ') : 'None'

      obligationsSummary = `Current cycle obligations (${obligationWindowStart} to ${obligationWindowEnd}) - Bills: ${fmtCents(obligationsBillsCents)} ${primaryCurrency}, Planned: ${fmtCents(obligationsPlannedPaymentsCents)} ${primaryCurrency}, Subscriptions: ${fmtCents(obligationsSubscriptionsCents)} ${primaryCurrency}, Goal autosave: ${fmtCents(obligationsGoalAutoSaveCents)} ${primaryCurrency}, Overdue: ${fmtCents(obligationsOverdueCents)} ${primaryCurrency}, Total: ${fmtCents(obligationsTotalCents)} ${primaryCurrency}`
    } catch (obError) {
      console.error('[ai-chat] canonical obligations context failed:', obError)
      obligationsSummary = 'Unable to load canonical obligations right now'
      obligationsList = 'Unable to load canonical obligations list'
      obligationsWarningText = effectiveCurrencyWarning || String((obError as any)?.message || obError)
    }

    const activeBudgets = (budgets || []).filter((b: any) => b && b?.is_active !== false)
    const scopedBudgets = activeBudgets.filter((b: any) => {
      const walletId = typeof b?.wallet_id === 'string' ? b.wallet_id.trim() : ''
      if (!walletId) return true
      if (activeWalletIds.size === 0) return true
      return activeWalletIds.has(walletId)
    })
    const budgetLocks = buildBudgetLockContext({
      budgets: scopedBudgets,
      windowStartISO: obligationWindowStart,
      windowEndISO: obligationWindowEnd,
    })
    const currentCycleBudgetRows = budgetLocks.overlappingBudgets
    const currentCycleBudgetSummary = currentCycleBudgetRows.map((b: any) => {
      const spent = Number(b?.spent_cents || 0) / 100
      const budget = Number(b?.amount_cents || 0) / 100
      const remaining = budget - spent
      const percentage = budget > 0 ? formatNumber(spent / budget * 100, 0, 0) : '0'
      const cat = b?.categories?.name || b?.name || 'Unknown'
      return `${cat}: ${formatMoney(spent, primaryCurrency)}/${formatMoney(budget, primaryCurrency)} (${percentage}%, ${formatMoney(remaining, primaryCurrency)} left)`
    }).join(', ') || 'No active budgets in current cycle window'

    // Keep "budgets" field backward-compatible, but make it cycle-aware and wallet-scoped.
    const budgetSummary = currentCycleBudgetSummary

    // PHASE 2.1: SUBSCRIPTIONS LIST (line-by-line, machine-parsable, max 15)
    const subscriptionsList = (() => {
      try {
        if (!subscriptions || subscriptions.length === 0) {
          return 'No active subscriptions'
        }

        // Sort by next billing date (soonest first)
        const sorted = [...subscriptions].sort((a, b) => {
          const dateA = a.next_billing_date ? new Date(a.next_billing_date).getTime() : Infinity
          const dateB = b.next_billing_date ? new Date(b.next_billing_date).getTime() : Infinity
          return dateA - dateB
        })

        // Format: "Name at $amount (billing_cycle) - next: Feb 14"
        // DO NOT include icon - Android app renders it by matching name to local subscription
        const lines = sorted.slice(0, 15).map(s => {
          const amount = (s.amount_cents / 100) || 0
          const cycle = (s.billing_cycle || 'monthly').toLowerCase()
          const nextDate = s.next_billing_date
            ? formatShortDate(s.next_billing_date)
            : (s.day_of_month ? `day ${s.day_of_month}` : 'unknown')
          return `${s.name} at ${formatMoney(amount, primaryCurrency)} (${cycle}) - next: ${nextDate}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting subscriptionsList:', e)
        return 'No active subscriptions'
      }
    })()

    // PHASE 2.4: RECEIVABLES LIST (line-by-line, machine-parsable, max 15)
    const receivablesList = (() => {
      try {
        if (!receivables || receivables.length === 0) {
          return 'No receivables'
        }

        // Sort by due date (soonest first)
        const sorted = [...receivables].sort((a, b) => {
          const dateA = a.due_date ? new Date(a.due_date).getTime() : Infinity
          const dateB = b.due_date ? new Date(b.due_date).getTime() : Infinity
          return dateA - dateB
        })

        // Format: "Person: $remaining remaining | due: Feb 14 | received: $X of $Y | monthly: $X/mo"
        const lines = sorted.slice(0, 15).map(r => {
          const originalCents = r.original_amount_cents || 0
          const receivedCents = r.amount_received_cents || 0
          const remainingCents = Math.max(0, originalCents - receivedCents)

          const remaining = formatNumber(remainingCents / 100, 2, 2)
          const received = formatNumber(receivedCents / 100, 2, 2)
          const original = formatNumber(originalCents / 100, 2, 2)

          const dueRaw = String(r.due_date || '').trim()
          let dueText = 'unknown'
          if (dueRaw && dueRaw !== 'null' && dueRaw !== '') {
            try {
              const dateObj = new Date(dueRaw)
              if (!isNaN(dateObj.getTime())) {
                dueText = formatShortDate(dueRaw)
              } else {
                dueText = dueRaw
              }
            } catch (e) {
              dueText = dueRaw
            }
          }

          const suffixParts = [
            `due: ${dueText}`,
            `received: ${received} ${primaryCurrency} of ${original} ${primaryCurrency}`
          ]

          if (r.monthly_payment_cents && r.monthly_payment_cents > 0) {
            const monthly = formatNumber(r.monthly_payment_cents / 100, 2, 2)
            suffixParts.push(`monthly: ${monthly} ${primaryCurrency}/mo`)
          }

          return `${r.person_name}: ${remaining} ${primaryCurrency} remaining | ${suffixParts.join(' | ')}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting receivablesList:', e)
        return 'No receivables'
      }
    })()

    // PHASE 2.2: BILLS LIST (line-by-line, machine-parsable, max 15)
    const billsList = (() => {
      try {
        if (!bills || bills.length === 0) {
          return 'No active bills'
        }

        // Sort by due date (soonest first)
        const sorted = [...bills].sort((a, b) => {
          const dateA = a.due_date ? new Date(a.due_date).getTime() : Infinity
          const dateB = b.due_date ? new Date(b.due_date).getTime() : Infinity
          return dateA - dateB
        })

        // Format: "Name at $amount (cycle) - next: YYYY-MM-DD" (fallback: "day X" or "unknown")
        const lines = sorted.slice(0, 15).map(b => {
          const amount = (b.amount_cents / 100) || 0
          const cycle = (b.recurring_frequency || (b.is_recurring ? 'monthly' : 'one-off')).toString().toLowerCase()

          // Try to get a proper date from due_date field
          let nextDate = 'unknown'
          const dueRaw = String(b.due_date || '').trim()
          if (dueRaw && dueRaw !== 'null' && dueRaw !== '') {
            try {
              const dateObj = new Date(dueRaw)
              if (!isNaN(dateObj.getTime())) {
                nextDate = formatShortDate(dueRaw)
              }
            } catch (e) {
              // If parsing fails, try treating as day of month
              const dayNum = parseInt(dueRaw)
              if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
                nextDate = `day ${dayNum}`
              }
            }
          }

          return `${b.name} at ${formatMoney(amount, primaryCurrency)} (${cycle}) - next: ${nextDate}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting billsList:', e)
        return 'No active bills'
      }
    })()

    // PHASE 2.5: PLANNED INCOME LIST (line-by-line, machine-parsable, max 15)
    const plannedIncomeList = (() => {
      try {
        if (!incomes || incomes.length === 0) {
          return 'No planned income'
        }

        // Sort by expected date (soonest first)
        const sorted = [...incomes].sort((a, b) => {
          const dateA = a.expected_date ? new Date(a.expected_date).getTime() : Infinity
          const dateB = b.expected_date ? new Date(b.expected_date).getTime() : Infinity
          return dateA - dateB
        })

        // Format: "Name at $amount (cycle) - next: YYYY-MM-DD" (fallback: "unknown")
        const lines = sorted.slice(0, 15).map(i => {
          const amount = (i.amount_cents / 100) || 0
          const cycle = (i.recurring_frequency || (i.is_recurring ? 'monthly' : 'one-off')).toString().toLowerCase()

          // Try to get a proper date from expected_date field
          let nextDate = 'unknown'
          const expectedRaw = String(i.expected_date || '').trim()
          if (expectedRaw && expectedRaw !== 'null' && expectedRaw !== '') {
            try {
              const dateObj = new Date(expectedRaw)
              if (!isNaN(dateObj.getTime())) {
                nextDate = formatShortDate(expectedRaw)
              }
            } catch (e) {
              // Fallback to unknown
            }
          }

          return `${i.name} at ${formatMoney(amount, primaryCurrency)} (${cycle}) - next: ${nextDate}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting plannedIncomeList:', e)
        return 'No planned income'
      }
    })()

    // PHASE 2.6: PLANNED PAYMENTS LIST (line-by-line, machine-parsable, max 15)
    const plannedPaymentsList = (() => {
      try {
        if (!plannedPayments || plannedPayments.length === 0) {
          return 'No planned payments'
        }

        // Sort by due date (soonest first)
        const sorted = [...plannedPayments].sort((a, b) => {
          const dateA = a.due_date ? new Date(a.due_date).getTime() : Infinity
          const dateB = b.due_date ? new Date(b.due_date).getTime() : Infinity
          return dateA - dateB
        })

        // Format: "Name at $amount (cycle) - next: YYYY-MM-DD" (fallback: "unknown")
        const lines = sorted.slice(0, 15).map(p => {
          const amount = (p.amount_cents / 100) || 0
          const cycle = (p.recurring_frequency || (p.is_recurring ? 'monthly' : 'one-off')).toString().toLowerCase()

          // Try to get a proper date from due_date field
          let nextDate = 'unknown'
          const dueRaw = String(p.due_date || '').trim()
          if (dueRaw && dueRaw !== 'null' && dueRaw !== '') {
            try {
              const dateObj = new Date(dueRaw)
              if (!isNaN(dateObj.getTime())) {
                nextDate = formatShortDate(dueRaw)
              }
            } catch (e) {
              // Fallback to unknown
            }
          }

          return `${p.name} at ${formatMoney(amount, primaryCurrency)} (${cycle}) - next: ${nextDate}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting plannedPaymentsList:', e)
        return 'No planned payments'
      }
    })()

    // PHASE 2.3: DEBTS LIST (line-by-line, machine-parsable, max 15)
    const debtsList = (() => {
      try {
        if (!debts || debts.length === 0) {
          return 'No active debts'
        }

        // Sort by highest remaining balance first
        const sorted = [...debts].sort((a, b) => {
          const remainingA = a.remaining_amount_cents || 0
          const remainingB = b.remaining_amount_cents || 0
          return remainingB - remainingA
        })

        // Format: "Name: $remaining remaining | paid: $X of $Y | due: YYYY-MM-DD | monthly: $X/mo | min: $X/mo"
        const lines = sorted.slice(0, 15).map(d => {
          const remaining = formatNumber((d.remaining_amount_cents || 0) / 100, 2, 2)

          const total = ((d.total_amount_cents || 0) / 100)
          const remainingNum = ((d.remaining_amount_cents || 0) / 100)
          const paidNum = Math.max(0, total - remainingNum)
          const paidText = `${formatNumber(paidNum, 2, 2)} ${primaryCurrency} of ${formatNumber(total, 2, 2)} ${primaryCurrency}`

          const dueRaw = String(d.due_date || '').trim()
          let dueText = 'unknown'
          if (dueRaw && dueRaw !== 'null' && dueRaw !== '') {
            try {
              const dateObj = new Date(dueRaw)
              if (!isNaN(dateObj.getTime())) {
                dueText = formatShortDate(dueRaw)
              } else {
                dueText = dueRaw
              }
            } catch (e) {
              dueText = dueRaw
            }
          }

          const suffixParts = [
            `due: ${dueText}`,
            `paid: ${paidText}`
          ]

          // Add monthly payment if present and > 0
          if (d.monthly_payment_cents && d.monthly_payment_cents > 0) {
            const monthly = formatNumber(d.monthly_payment_cents / 100, 2, 2)
            suffixParts.push(`monthly: ${monthly} ${primaryCurrency}/mo`)
          }

          // Add minimum payment if present and > 0
          if (d.minimum_payment_cents && d.minimum_payment_cents > 0) {
            const min = formatNumber(d.minimum_payment_cents / 100, 2, 2)
            suffixParts.push(`min: ${min} ${primaryCurrency}/mo`)
          }

          return `${d.name}: ${remaining} ${primaryCurrency} remaining | ${suffixParts.join(' | ')}`
        })

        return lines.join('\n')
      } catch (e) {
        console.error('Error formatting debtsList:', e)
        return 'No active debts'
      }
    })()

    const queryTime = nowMs() - startTime
    console.log(`Ã°Å¸â€œÅ  Analytics query completed in ${queryTime.toFixed(1)}ms (${transactions?.length || 0} transactions)`)

    return {
      // Core financial data
      currencyCode: primaryCurrency,
      currencyWarning: effectiveCurrencyWarning || null,
      totalBalance: formatNumber(totalBalance, 2, 2),
      totalDebt: formatNumber(totalDebt, 2, 2),
      netWorth: formatNumber(totalBalance - totalDebt, 2, 2),
      monthlySubscriptions: formatNumber(monthlySubscriptions, 2, 2),
      recentSpending: formatNumber(totalRecentSpending, 2, 2),
      localeTag,
      numberFormatMode,
      preferredLanguage,

      // PHASE 1: Deep Analytics Fields
      topCategories: analytics.topCategories,
      topCategoriesThisWeek: analytics.topCategoriesThisWeek,
      topCategoriesLastWeek: analytics.topCategoriesLastWeek,
      topCategoriesThisMonth: analytics.topCategoriesThisMonth,
      topCategoriesLastMonth: analytics.topCategoriesLastMonth,
      spendingByDay: analytics.spendingByDay,
      topMerchants: analytics.topMerchants,
      weekComparison: analytics.weekComparison,
      monthComparison: analytics.monthComparison,
      totalIncome: analytics.totalIncome,
      recurringBills: analytics.recurringBills,
      largestExpenses: analytics.largestExpenses,

      // PHASE 2.1: Subscriptions List
      subscriptionsList: subscriptionsList,

      // PHASE 2.2: Bills List
      billsList: billsList,

      // PHASE 2.3: Debts List
      debtsList: debtsList,

      // PHASE 2.4: Receivables List
      receivablesList: receivablesList,

      // PHASE 2.5: Planned Income List
      plannedIncomeList: plannedIncomeList,

      // PHASE 2.6: Planned Payments List
      plannedPaymentsList: plannedPaymentsList,

      // Detailed breakdowns
      wallets: (wallets || []).map((w: any) => {
        const walletId = String(w?.id || '').trim()
        const name = String(w?.name || 'Unnamed wallet')
        const type = String(w?.type || 'unknown')
        const walletCurrency = String(w?.currency_code || primaryCurrency)
        const rawBalance = Number(w?.balance || 0)
        const rawBalanceText = `${formatNumber(Number.isFinite(rawBalance) ? rawBalance : 0, 2, 2)} ${walletCurrency}`
        const normalizedAmount = walletBalanceByIdInPrimary.get(walletId)
        const convertedText =
          walletCurrency !== primaryCurrency &&
            typeof normalizedAmount === 'number' &&
            Number.isFinite(normalizedAmount)
            ? ` (~${formatNumber(normalizedAmount, 2, 2)} ${primaryCurrency})`
            : ''

        return `${name}: ${rawBalanceText}${convertedText} [${type}]`
      }).join(', ') || 'No wallets',

      recentTransactions: (() => {
        const goalNameById: Record<string, string> = {}
          ; (goals || []).forEach((g: any) => {
            if (g?.id) goalNameById[String(g.id)] = String(g.name || '').trim()
          })

        return (transactions || []).slice(0, 10)
          .map((t: any) => {
            const amount = Math.abs(t.amount || 0)
            const category = t.category || 'Uncategorized'
            const categoryKey = toCategoryKey(t.category)

            if (isTransferLikeCategory(categoryKey)) {
              const goalId = t.goal_id ? String(t.goal_id) : ''
              const goalName = goalId ? (goalNameById[goalId] || '') : ''
              const label = goalName ? `Transfer to ${goalName}` : 'Transfer'
              return `${formatNumber(amount, 2, 2)} ${primaryCurrency} transfer ${label} (${category})`
            }

            const type = (t.amount || 0) >= 0 ? 'income' : 'expense'
            const merchant = t.title || 'Unknown'
            return `${formatNumber(amount, 2, 2)} ${primaryCurrency} ${type} at ${merchant} (${category})`
          })
          .join('\n') || 'No recent transactions'
      })(),

      goals: activeGoals?.map((g: any) => {
        const current = (g.current_amount_cents / 100) || 0
        const target = (g.target_amount_cents / 100) || 0
        const progress = target > 0 ? formatNumber(current / target * 100, 0, 0) : '0'
        return `${g.name}: ${formatMoney(current, primaryCurrency)}/${formatMoney(target, primaryCurrency)} (${progress}%)`
      }).join(', ') || 'No active goals',

      wishItems: wishItems?.map((g: any) => {
        const targetDateMillis = Number(g.target_date_millis ?? 0)
        if (targetDateMillis > 0) {
          return `${g.name} (wish item, date hint ${new Date(targetDateMillis).toISOString().slice(0, 10)})`
        }
        return `${g.name} (wish item)`
      }).join(', ') || 'No wish items',

      challenges: activeChallenges?.map((c: any) => `${c.name}`).join(', ') || 'No active challenges',

      obligationsSummary: obligationsSummary,
      obligationsWindow: obligationsWindow,
      obligationsList: obligationsList,
      obligationsWarnings: obligationsWarningText,
      obligationsTotal: fmtCents(obligationsTotalCents),
      obligationsBillTotal: fmtCents(obligationsBillsCents),
      obligationsPlannedTotal: fmtCents(obligationsPlannedPaymentsCents),
      obligationsSubscriptionTotal: fmtCents(obligationsSubscriptionsCents),
      obligationsGoalAutoSaveTotal: fmtCents(obligationsGoalAutoSaveCents),
      obligationsOverdueTotal: fmtCents(obligationsOverdueCents),
      obligationsCount: obligationsCount,

      budgets: budgetSummary,
      currentCycleBudgets: currentCycleBudgetSummary,
      currentCycleBudgetCount: currentCycleBudgetRows.length,

      debts: debts?.map((d: LooseRow) => {
        const remaining = (d.remaining_amount_cents / 100) || 0
        const rate = d.interest_rate || 0
        return `${d.name}: ${formatMoney(remaining, primaryCurrency)} at ${rate}%`
      }).join(', ') || 'No debts',

      subscriptions: subscriptions?.map((s: LooseRow) => {
        const amount = (s.amount_cents / 100) || 0
        return `${s.name}: ${formatMoney(amount, primaryCurrency)}/${s.billing_cycle?.toLowerCase()}`
      }).join(', ') || 'No subscriptions',

      bills: bills?.map((b: LooseRow) => {
        const amount = (b.amount_cents / 100) || 0
        const due = b.due_date ? new Date(b.due_date).toISOString().slice(0, 10) : 'unknown date'
        return `${b.name}: ${formatMoney(amount, primaryCurrency)} due ${due}`
      }).join(', ') || 'No recurring bills',

      // Counts for context
      transactionCount: transactions?.length || 0,
      goalCount: activeGoals?.length || 0,
      challengeCount: activeChallenges?.length || 0,
      budgetCount: currentCycleBudgetRows.length,
      debtCount: debts?.length || 0,
      subscriptionCount: subscriptions?.length || 0,
      billCount: bills?.length || 0,
      recentInsights: insightsSummary
    }
  } catch (error) {
    console.error('Ã¢Å¡Â Ã¯Â¸Â Error building context:', error)
    return {
      currencyCode: 'USD',
      currencyWarning: 'Context load failed',
      localeTag: 'en-US',
      numberFormatMode: 'system',
      preferredLanguage: 'en',
      totalBalance: '0.00',
      totalDebt: '0.00',
      netWorth: '0.00',
      monthlySubscriptions: '0.00',
      recentSpending: '0.00',

      // PHASE 1: Graceful analytics fallbacks
      topCategories: 'Unable to load spending categories',
      topCategoriesThisWeek: 'Unable to load spending categories (this week)',
      topCategoriesLastWeek: 'Unable to load spending categories (last week)',
      topCategoriesThisMonth: 'Unable to load spending categories (this month)',
      topCategoriesLastMonth: 'Unable to load spending categories (last month)',
      spendingByDay: 'Unable to load spending patterns',
      topMerchants: 'Unable to load merchant data',
      weekComparison: 'Unable to load week comparison',
      monthComparison: 'Unable to load month comparison',
      totalIncome: 'Unable to load income data',
      recurringBills: 'Unable to load recurring bills',
      largestExpenses: 'Unable to load expense data',

      // PHASE 2.1: Subscriptions fallback
      subscriptionsList: 'Unable to load subscriptions',

      // PHASE 2.2: Bills fallback
      billsList: 'Unable to load bills',

      // PHASE 2.3: Debts fallback
      debtsList: 'Unable to load debts',

      // PHASE 2.4: Receivables fallback
      receivablesList: 'Unable to load receivables',

      // PHASE 2.5: Planned Income fallback
      plannedIncomeList: 'Unable to load planned income',

      // PHASE 2.6: Planned Payments fallback
      plannedPaymentsList: 'Unable to load planned payments',

      wallets: 'Unable to load wallets',
      recentTransactions: 'Unable to load transactions',
      goals: 'Unable to load goals',
      challenges: 'Unable to load challenges',
      obligationsSummary: 'Unable to load canonical obligations',
      obligationsWindow: 'Window: unknown',
      obligationsList: 'Unable to load obligations list',
      obligationsWarnings: 'Context load failed',
      obligationsTotal: '0.00',
      obligationsBillTotal: '0.00',
      obligationsPlannedTotal: '0.00',
      obligationsSubscriptionTotal: '0.00',
      obligationsGoalAutoSaveTotal: '0.00',
      obligationsOverdueTotal: '0.00',
      obligationsCount: 0,
      budgets: 'Unable to load budgets',
      currentCycleBudgets: 'Unable to load cycle budgets',
      currentCycleBudgetCount: 0,
      debts: 'Unable to load debts',
      subscriptions: 'Unable to load subscriptions',
      bills: 'Unable to load bills',
      transactionCount: 0,
      goalCount: 0,
      challengeCount: 0,
      budgetCount: 0,
      debtCount: 0,
      subscriptionCount: 0,
      billCount: 0
    }
  }
}


/**
 * Phase 2: Hard emoji enforcement for voice rules compliance
 */
function enforceEmojiRules(text: string, persona: 'coach' | 'companion'): string {
  const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu

  if (persona === 'coach') {
    return text.replace(emojiRegex, '').trim()
  }

  const allEmojis = text.match(emojiRegex) || []
  let cleanText = text.replace(emojiRegex, '').trim()
  if (allEmojis.length > 0) {
    cleanText += ` ${allEmojis.slice(0, 2).join(' ')}`
  }
  return cleanText.trim()
}

type WiseyModelResponse = {
  text: string
  confidence: 'low' | 'medium' | 'high'
  availabilityFallback?: boolean
}

async function getWiseyResponse(
  message: string,
  context: WiseyFinancialContext,
  chatHistory: string,
  relevantMemories: string,
  relevantMemoryFacts: ChatMemoryFact[] | null | undefined,
  persona: 'coach' | 'companion',
  responseLength: 'short' | 'normal' | 'detailed' = 'normal',
  modelToUse: string = 'gemini-2.5-flash',
  activeDigestHandoff: DigestHandoffV1 | null = null,
  inputMode: string | null = null,
  requestDigestHandoff: DigestHandoffV1 | null = null,
  chatContextState: ChatContextStateV1 | null = null,
  recentMessages: RecentChatMessageRow[] = [],
  lastAssistantMessage: string | null = null
): Promise<WiseyModelResponse> {
  const digestInteractionMode = detectDigestInteractionMode({
    message,
    inputMode,
    activeDigestHandoff,
    requestDigestHandoff,
  })
  const useMultiTurnGemini = AI_CHAT_MULTI_TURN_ENABLED

  const lengthRule = buildLengthRule(persona, responseLength, digestInteractionMode)
  const emojiRule = buildEmojiRule(persona)
  const outputLanguageCode = normalizeLanguageCode(context.preferredLanguage || 'en')
  const outputLocaleTag = normalizeLocaleTag(context.localeTag, outputLanguageCode)
  const outputNumberFormatMode = normalizeNumberFormatMode(context.numberFormatMode)
  const outputNumberFormatRule = outputNumberFormatMode === 'comma'
    ? 'Use comma decimals and dot thousands (example: 1.234,56).'
    : outputNumberFormatMode === 'period'
      ? 'Use period decimals and comma thousands (example: 1,234.56).'
      : `Use locale-aware formatting for ${outputLocaleTag}.`

  const digestPromptBlock = buildDigestPromptBlock({
    activeDigestHandoff,
    requestDigestHandoff,
    message,
    inputMode,
  })
  const conversationGroundingBlock = buildConversationGroundingPromptBlock({
    chatContextState,
    currencyCode: context.currencyCode || 'USD',
    chatHistory,
    relevantMemories,
    relevantMemoryFacts,
    includeRecentTranscript: !useMultiTurnGemini,
  })
  const conversationContinuityBlock = buildConversationContinuityPromptBlock(
    chatHistory,
    message,
    lastAssistantMessage,
  )
  const digestStyleOverride = digestInteractionMode === 'digest_follow_up'
    ? `DIGEST CONVERSATION STYLE OVERRIDE
- This is an ongoing follow-up inside an already-grounded weekly digest conversation.
- Override the default coach stiffness when needed so the reply feels natural and human.
- Treat the digest as shared context in the background, not as a report that must be re-explained.
- Match the user's phrasing lightly and continue the thread like a real conversation.
- Do not compress the answer into the same recap each turn. One direct answer plus one fresh point is better than another summary.`
    : digestInteractionMode === 'initial_handoff'
      ? `DIGEST CONVERSATION STYLE OVERRIDE
- This is the first reply after opening from a weekly digest.
- Sound informed and fluid, not formal or scripted.
- Explain the week cleanly, then open the door for follow-up without repeating the digest headline word-for-word.`
      : ''
const systemPrompt = `${buildPersonaIdentityLine(persona)}

${buildPersonaPromptSection(persona)}

OUTPUT LOCALE CONTRACT
- Reply fully in language code: ${outputLanguageCode}
- Keep number/date style consistent with locale: ${outputLocaleTag}
- ${outputNumberFormatRule}
- Keep currency amounts in the user's primary currency (${context.currencyCode || 'USD'}) unless explicitly asked for source-currency details.

GROUNDING OVERVIEW:
${conversationGroundingBlock}

${conversationContinuityBlock}

USER'S COMPREHENSIVE FINANCIAL PROFILE

- Primary Currency: ${context.currencyCode || 'USD'}
- Currency Scope: ${context.currencyWarning || 'Single-currency profile'}
- Total Balance: ${context.totalBalance} ${context.currencyCode || 'USD'}
- Total Debt: ${context.totalDebt} ${context.currencyCode || 'USD'}
- Net Worth: ${context.netWorth} ${context.currencyCode || 'USD'}
- Monthly Subscriptions: ${context.monthlySubscriptions} ${context.currencyCode || 'USD'}
- Recent Spending: ${context.recentSpending} ${context.currencyCode || 'USD'}

- Wallets (${context.wallets?.split(',').length || 0}):
${context.wallets}

- Recent Transactions (${context.transactionCount}):
${context.recentTransactions}

- Goals (${context.goalCount}):
${context.goals}

- Challenges (${context.challengeCount}):
${context.challenges}

- Budgets (${context.budgetCount}):
${context.budgets}

- Current-Cycle Budgets (${context.currentCycleBudgetCount || context.budgetCount}):
${context.currentCycleBudgets || context.budgets}

- Obligations (canonical source of truth):
${context.obligationsSummary || 'No obligations data available'}

- Obligations Window:
${context.obligationsWindow || 'Window: unknown'}

- Upcoming Obligations (${context.obligationsCount || 0}):
${context.obligationsList || 'No upcoming obligations'}

- Debts (${context.debtCount}):
${context.debts}

- Subscriptions (${context.subscriptionCount}):
${context.subscriptions}

- Bills (${context.billCount}):
${context.bills}

- Recent App Insights (what the app/Wisey has already surfaced):
${context.recentInsights || 'No recent insights'}

${digestPromptBlock ? `${digestPromptBlock}
` : ''}
${digestStyleOverride ? `${digestStyleOverride}
` : ''}

DEEP ANALYTICS (computed from transaction data):
- Top Categories (last 30 days): ${context.topCategories || 'No data available'}
- Top Categories (this week): ${context.topCategoriesThisWeek || 'No data available'}
- Top Categories (last week): ${context.topCategoriesLastWeek || 'No data available'}
- Top Categories (this month): ${context.topCategoriesThisMonth || 'No data available'}
- Top Categories (last month): ${context.topCategoriesLastMonth || 'No data available'}
- Spending by Day (last 30 days): ${context.spendingByDay || 'No data available'}
- Top Merchants (last 30 days): ${context.topMerchants || 'No data available'}
- Week Comparison (current vs previous): ${context.weekComparison || 'No data available'}
- Month Comparison (current vs previous): ${context.monthComparison || 'No data available'}
- Total Income (current month): ${context.totalIncome || 'No data available'}
- Recurring Bills (from authoritative tables): ${context.recurringBills || 'No data available'}
- Largest Expenses (last 30 days): ${context.largestExpenses || 'No data available'}
- Subscriptions List: ${context.subscriptionsList || 'No active subscriptions'}
- Bills List: ${context.billsList || 'No active bills'}
- Debts List: ${context.debtsList || 'No active debts'}
- Receivables List: ${context.receivablesList || 'No receivables'}
- Planned Income List: ${context.plannedIncomeList || 'No planned income'}
- Planned Payments List: ${context.plannedPaymentsList || 'No planned payments'}
- Obligations Warnings: ${context.obligationsWarnings || 'None'}

ANALYTICS REFERENCE GUIDE (use these fields to answer user questions):
- "What did I spend most on?" / "Top categories" -> Use topCategories
- "What did I spend most on this week?" -> Use topCategoriesThisWeek
- "What did I spend most on last week?" -> Use topCategoriesLastWeek
- "What did I spend most on this month?" -> Use topCategoriesThisMonth
- "What did I spend most on last month?" / "previous month" -> Use topCategoriesLastMonth
- "Recent transactions" / "Show my recent transactions" / "Latest transactions" -> Use recentTransactions
- "Biggest expenses" / "Largest transactions" -> Use largestExpenses
- "Recurring bills" / "Subscriptions" -> Use recurringBills (authoritative tables only)
- "Show my subscriptions" / "Active subscriptions" / "List subscriptions" / "Next subscription" -> Use subscriptionsList
- "Show my bills" / "List my bills" / "Upcoming bills" / "What bills do I have" / "Monthly bills" -> Use billsList
- "Show my debts" / "List my debts" / "What debts do I have" / "Remaining debt" / "Minimum payments" -> Use debtsList
- "Show my receivables" / "List my receivables" / "Who owes me" / "Money coming in" / "Expected payments" -> Use receivablesList
- "Show my planned income" / "Planned income" / "Upcoming income" / "Expected salary" / "Income schedule" -> Use plannedIncomeList
- "Show my planned payments" / "Planned payments" / "Upcoming payments" / "Payment schedule" / "Scheduled bills" / "Scheduled payments" -> Use plannedPaymentsList
- "Upcoming obligations" / "fixed obligations" / "obligations this cycle" -> Use obligationsSummary + obligationsList
- "Current budgets" / "active budgets this cycle" -> Use currentCycleBudgets
- "Income this month" -> Use totalIncome
- "Spending patterns" / "When do I spend most?" -> Use spendingByDay
- "Top merchants" / "Where do I shop?" -> Use topMerchants
- "This week" / "Compared to last week" -> Use weekComparison
- "Month over month" / "Compared to last month" -> Use monthComparison
- If the user says "this week", use topCategoriesThisWeek and/or weekComparison. Do NOT silently answer with this month or last 30 days.
- If the user says "last week", use topCategoriesLastWeek.
- If the user says "last 30 days", use topCategories
- topCategoriesThisWeek is based on the CURRENT CALENDAR WEEK TO DATE
- weekComparison is CURRENT WEEK TO DATE vs THE SAME POINT LAST WEEK
- topCategoriesLastWeek is based on the PREVIOUS CALENDAR WEEK
- topCategories, spendingByDay, topMerchants, largestExpenses are based on LAST 30 DAYS
- monthComparison, totalIncome use CURRENT MONTH vs PREVIOUS MONTH
- recurringBills comes from authoritative tables (subscriptions, bills, debts), NOT transaction patterns
- When answering a question, explicitly name the time range you are using (this week vs last week vs last 30 days vs current month vs previous month).

NORMALITY / TYPICALITY GUIDANCE:
- If the user asks whether spending is "normal", "typical", or "usual for me", do not make a strong personal-pattern claim from only one comparison period.
- You may say "compared with last week" or "compared with last month" when those fields support it, but do NOT say "this is not typical for you" unless there is repeated-history evidence in RESOLVED CONVERSATION FACTS or another explicit profile field.
- If only one prior comparison period is available, say that there is not enough history here to judge the user's true normal yet, then give the concrete comparison you do have.

SPENDING CHECK-IN GUIDANCE:
- Statements or questions like "I think I spent too much this week", "did I overspend this week", or "am I spending too much this month" are evaluative check-ins, NOT list requests.
- For these check-ins, answer the user's concern first using weekComparison or monthComparison for the matching time range.
- Good answer shape: 1) short verdict, 2) concrete comparison, 3) one or two main drivers in plain prose if useful.
- If you mention drivers, summarize them in natural prose from the relevant topCategories field. Do NOT output the topCategories field verbatim, do NOT use the machine-parsable category list format, and do NOT trigger a list/card unless the user explicitly asks for a breakdown or top categories.
- If comparison data is missing, say that you cannot tell yet whether it is unusually high, then mention the current-period amount if available.

OBLIGATION PAYOFF GUIDANCE:
- If the user asks how to pay obligations and total balance already covers them, say that clearly first. Do not pretend they need cuts to afford them.
- If the user also asks what to cut, turn the obligation amount into a concrete offset plan using discretionary spending categories from the profile. Prefer examples that add up to the actual obligation amount instead of merely naming categories.
- When overdue items exist, separate "pay now" from "future habit change": first name the overdue items to clear, then suggest the simplest spending cuts only if the user asked for cuts or wants help freeing the money.
- Good answer shape for "how can I pay them / what to cut": 1) can you cover them now, 2) which overdue items to clear first, 3) one practical cut plan with exact amounts, 4) no filler question unless a required input is missing.
- If the needed data is present, do not end with vague lines like "these could be good places to review." Give the recommendation.

FIELD-FIRST RULE (Top categories / "what did I spend most on"):
- Apply this rule ONLY when the user explicitly asks for top categories, spend-most breakdowns, or another list-style category request.
- If that list-style request contains "this week" -> you MUST answer using topCategoriesThisWeek.
- If that list-style request contains "last week" -> you MUST answer using topCategoriesLastWeek.
- If that list-style request contains "this month" -> you MUST answer using topCategoriesThisMonth.
- If that list-style request contains "last month" or "previous month" -> you MUST answer using topCategoriesLastMonth.
- If that list-style request contains "last 30 days" -> you MUST answer using topCategories.
- You MUST explicitly state the time range in your FIRST sentence (e.g., "This week...", "Last week...", "This month...", "Last month...", or "In the last 30 days...").
- Ground the answer in the analytics string: preserve the concrete categories and amounts as written (do not paraphrase them away).

LIST-ONLY RULE (Listing requests: recent/top/least/large):
- EXCEPTION: This LIST-ONLY rule applies only when the user's message is a pure list request (one specific list and nothing else). If the same message also asks about other distinct topics, do NOT apply LIST-ONLY. Answer every part of the message in one natural reply, and for the list portion, summarize 2 to 3 representative items inline instead of producing the strict machine-parseable list format.
- If the user asks for ANY list-style output, you MUST output ONLY the list data with NO preface or intro sentence.
- Examples of listing requests: "show my recent transactions", "latest transactions", "top transactions", "least transactions", "largest expenses", "biggest expenses", "top merchants", "spending by day", "top categories", "what did I spend most on", "show my subscriptions", "active subscriptions", "show my bills", "list my bills", "show my debts", "list my debts".
- DO NOT output any preface (no "Got it", no "Here are...", no "Let's take a look", no emojis before the list, no extra commentary).
- Start immediately with the first list line/item.
- If a single header is required for clarity, keep it ultra-minimal and machine-parsable (e.g., "Top categories last month:"), but still no friendly filler.
- Mapping: "recent/latest/last transactions" -> recentTransactions | "top categories/spend most" -> topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth (first items) | "least/smallest categories" -> topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth (last items) | "largest/biggest expenses" -> largestExpenses | "top merchants" -> topMerchants | "spending patterns by day" -> spendingByDay | "smallest transactions" -> recentTransactions (sorted by amount) | "subscriptions/active subscriptions/show subscriptions" -> subscriptionsList | "bills/show bills/list bills/upcoming bills" -> billsList | "debts/show debts/list debts/what debts/remaining debt" -> debtsList.
- If the field is empty (e.g., "No recent transactions"), output ONLY that exact message (no preface).
- DO NOT ask follow-up questions for listing intents unless the requested list literally cannot be produced.
- FORMAT REQUIREMENTS (critical for app parsing):
  * For recent transactions: Output EXACTLY as stored in recentTransactions field (preserve the exact format with amount + currency, type, merchant/description, and (category) structure).
  * For top categories: Output EXACTLY as stored in topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth fields (preserve the exact format with category names, amounts, and percentages).
  * For other lists: Output EXACTLY as stored in the corresponding analytics field.
  * DO NOT reformat, summarize, or paraphrase the list data. Copy it verbatim from the field.
  * DO NOT embed the data in conversational sentences. NO "your top spending categories are X at Y USD, Z at W USD". That format is FORBIDDEN.
  * The app's parser expects specific formats - any deviation will cause the structured UI to fail and show plain text instead.
- EXAMPLES (top categories request):
  * WRONG: "your top spending categories are rent at 1000.00 USD (27%), shopping at 947.00 USD (26%), and fast-food at 860.00 USD (23%)."
  * WRONG: "This month you spent most on: Rent at 1000.00 USD (27%), Shopping at 947.00 USD (26%)"
  * RIGHT: "Top categories this month:\nRent at 1000.00 USD (27%)\nShopping at 947.00 USD (26%)\nFast Food at 860.00 USD (23%)"
  * RIGHT: "Rent at 1000.00 USD (27%)\nShopping at 947.00 USD (26%)\nFast Food at 860.00 USD (23%)"
- QUANTITY FLEXIBILITY:
  * If the user asks for a specific number (e.g., "top 3 categories", "show me 10 transactions"), output ONLY that many items from the list.
  * If no specific number is requested, output the first 5-7 items (a reasonable default).
  * The analytics fields contain up to 15 items, so you can fulfill requests for "top 10", "top 15", etc.
- LEAST/SMALLEST REQUESTS:
  * For categories: If user asks "what did I spend LEAST on" or "smallest categories", take the LAST items from topCategories (they're sorted highest to lowest, so last = smallest).
  * For transactions: If user asks "smallest transactions" or "least expensive", parse transaction amounts from recentTransactions, sort by amount ascending, and output the smallest ones in the same line format.
  * Examples: "What did I spend least on?" -> show last 5 categories | "Show my 3 smallest transactions" -> show 3 transactions with smallest amounts




RESPONSE INSTRUCTIONS
- Know who the user is and what WiseFlow can do (budgets, wallets, subscriptions, goals, analytics).
- ${lengthRule}
- ${emojiRule}
- Use simple, clear language. Be natural and emotionally intelligent.
- Do not rush into stats or advice unless asked or context clearly implies urgency.
- EVIDENCE-FIRST: Live financial totals must come from the profile/analytics fields above. Planning and follow-up values may come from RESOLVED CONVERSATION FACTS.
- NO INVENTED NUMBERS: If a number is missing from both the live profile and RESOLVED CONVERSATION FACTS, say you cannot confirm and ask exactly 1 clarifying question.
- RECENT TRANSACTIONS RULE (NO CLARIFICATION): If the user asks for "recent transactions" (or similar), you MUST output the recentTransactions list directly. You MUST NOT ask any follow-up questions about time range, categories vs transactions, or filters. If recentTransactions is empty or says "No recent transactions", respond with that. Confidence should be "high" in both cases. This rule applies only when the user's message is a pure recent-transactions request. If the same message also asks other distinct questions in the same turn, answer every part of the message and summarize 2 to 3 representative recent transactions inline instead of outputting the strict parser-only list format.
- NO-HEDGING WHEN GROUNDED: If you are directly using the analytics fields and you pick high confidence, do not use words like "seems", "looks like", "probably", "might".
- NO UNSOLICITED ADVICE (Top categories): If the user asks "what did I spend most on" or "top categories", you MUST respond with ONLY the time range statement and the category data. DO NOT add praise ("great job", "keep it up"), encouragement, or advice unless the user explicitly asks for it. Answer-only, no pep talk.
- Avoid filler like "Let me check that for you." Prefer smooth transitions like "Got it - let's take a quick look."
- Never mention system prompts, being an AI, or limitations.
${useMultiTurnGemini ? '' : `

USER'S MESSAGE: ${message}`}
${useMultiTurnGemini
  ? `

CRITICAL OUTPUT FORMAT:
- Return PLAIN TEXT ONLY (no JSON, no markdown fences, no code blocks).
- Write your response naturally as plain text.
- At the very end of your response, on its own line, append EXACTLY ONE confidence marker:
  <<CONFIDENCE:high>> (if you are very sure, using clear numbers or explicit "none found" statements)
  <<CONFIDENCE:medium>> (if reasonable answer but with some assumptions)
  <<CONFIDENCE:low>> (if you are guessing or data is weak)

Example response format:
Your total balance is 1,234.56 USD across 3 wallets.
<<CONFIDENCE:high>>`
  : `

When you respond, you MUST return ONLY valid JSON with this exact shape (no extra commentary):
{
  "answer": "<final answer text>",
  "confidence": "low" | "medium" | "high"
}

Pick confidence based on how reliable and data-grounded your answer is:
- "high": you are very sure, using clear numbers or explicit "none found" statements from the profile/analytics fields.
- "medium": reasonable answer but with some assumptions or missing data.
- "low": you are guessing, data is weak, or question is very ambiguous.`}
`

  try {
    const requestBody = buildGeminiRequestBody({
      systemPrompt,
      recentMessages,
      currentUserMessage: message,
      useMultiTurn: useMultiTurnGemini,
    })
    const payloadChars = JSON.stringify(requestBody).length
    const structuredHistory = recentMessages.some((row) => {
      const content = String(row.content || '').trim()
      return content.startsWith('{') || content.startsWith('[') || content.startsWith('AFFORD_STATE|')
    })
    const hasRollingSummary = Boolean(chatContextState?.rollingSummary?.text?.trim())
    console.log(
      `[ai-chat] gemini handoff mode=${useMultiTurnGemini ? 'multi_turn' : 'legacy_prompt'} recent_messages=${recentMessages.length} request_turns=${Array.isArray(requestBody.contents) ? requestBody.contents.length : 0} payload_chars=${payloadChars} structured_history=${structuredHistory} rolling_summary=${hasRollingSummary}`
    )

    const geminiAttempt = await requestGeminiWithResilience(
      modelToUse,
      GEMINI_API_KEYS,
      (model, key) => fetchGemini(`${model}:generateContent`, requestBody, { apiKey: key }),
      {
        operation: 'generate_content',
        log: logGeminiRetry,
      },
    )

    if (geminiAttempt.outcome === 'exhausted') {
      return {
        text: getWiseyBusyMessage(outputLanguageCode),
        confidence: 'low',
        availabilityFallback: true,
      }
    }

    const response = geminiAttempt.response
    if (!response.ok) {
      await throwGeminiResponseError(response, 'Gemini API error')
    }

    const data = await response.json()
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text

    if (!rawText) throw new Error('No response text from Gemini')

    let answer = rawText
    let confidence: 'low' | 'medium' | 'high' = 'medium'
    if (useMultiTurnGemini) {
      const parsed = extractConfidenceFromPlainTextResponse(rawText, 'non-streaming')
      answer = parsed.answer
      confidence = parsed.confidence
    } else {
      try {
        // Allow for plain JSON or ```json fenced blocks
        const jsonMatch = rawText.match(/```json\s*([\s\S]*?)```/i) || rawText.match(/\{[\s\S]*\}/)
        const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawText
        const parsed = JSON.parse(jsonText)
        answer = (parsed.answer || parsed.response || rawText).toString().trim()
        const c = (parsed.confidence || '').toString().toLowerCase()
        if (c === 'low' || c === 'medium' || c === 'high') {
          confidence = c
        }
      } catch (e) {
        console.warn('Ã¢Å¡Â Ã¯Â¸Â Failed to parse confidence JSON, falling back to medium:', e)
        answer = rawText.trim()
        confidence = 'medium'
      }
    }

    // Phase 2: Hard emoji enforcement (Fix 4)
    const validatedAnswer = enforceEmojiRules(answer, persona)

    return { text: validatedAnswer, confidence }
  } catch (error) {
    const messageText = safeErrorMessage(error, 'Gemini API failed')
    console.error(`Ã¢ÂÅ’ Gemini API failed:`, messageText)
    throw new Error(`Gemini API failed: ${messageText}`)
  }
}

/**
 * Streaming version of getWiseyResponse - streams response chunks via callback
 */
async function getWiseyResponseStreaming(
  message: string,
  context: WiseyFinancialContext,
  chatHistory: string,
  relevantMemories: string,
  relevantMemoryFacts: ChatMemoryFact[] | null | undefined,
  persona: 'coach' | 'companion',
  responseLength: 'short' | 'normal' | 'detailed' = 'normal',
  modelToUse: string = 'gemini-2.5-flash',
  activeDigestHandoff: DigestHandoffV1 | null = null,
  inputMode: string | null = null,
  requestDigestHandoff: DigestHandoffV1 | null = null,
  chatContextState: ChatContextStateV1 | null = null,
  recentMessages: RecentChatMessageRow[] = [],
  onChunk: (chunk: string) => Promise<void>,
  lastAssistantMessage: string | null = null
): Promise<WiseyModelResponse> {
  const digestInteractionMode = detectDigestInteractionMode({
    message,
    inputMode,
    activeDigestHandoff,
    requestDigestHandoff,
  })
  const useMultiTurnGemini = AI_CHAT_MULTI_TURN_ENABLED

  const lengthRule = buildLengthRule(persona, responseLength, digestInteractionMode)
  const emojiRule = buildEmojiRule(persona)
  const outputLanguageCode = normalizeLanguageCode(context.preferredLanguage || 'en')
  const outputLocaleTag = normalizeLocaleTag(context.localeTag, outputLanguageCode)
  const outputNumberFormatMode = normalizeNumberFormatMode(context.numberFormatMode)
  const outputNumberFormatRule = outputNumberFormatMode === 'comma'
    ? 'Use comma decimals and dot thousands (example: 1.234,56).'
    : outputNumberFormatMode === 'period'
      ? 'Use period decimals and comma thousands (example: 1,234.56).'
      : `Use locale-aware formatting for ${outputLocaleTag}.`

  const digestPromptBlock = buildDigestPromptBlock({
    activeDigestHandoff,
    requestDigestHandoff,
    message,
    inputMode,
  })
  const conversationGroundingBlock = buildConversationGroundingPromptBlock({
    chatContextState,
    currencyCode: context.currencyCode || 'USD',
    chatHistory,
    relevantMemories,
    relevantMemoryFacts,
    includeRecentTranscript: !useMultiTurnGemini,
  })
  const conversationContinuityBlock = buildConversationContinuityPromptBlock(
    chatHistory,
    message,
    lastAssistantMessage,
  )
  const digestStyleOverride = digestInteractionMode === 'digest_follow_up'
    ? `DIGEST CONVERSATION STYLE OVERRIDE
- This is an ongoing follow-up inside an already-grounded weekly digest conversation.
- Override the default coach stiffness when needed so the reply feels natural and human.
- Treat the digest as shared context in the background, not as a report that must be re-explained.
- Match the user's phrasing lightly and continue the thread like a real conversation.
- Do not compress the answer into the same recap each turn. One direct answer plus one fresh point is better than another summary.`
    : digestInteractionMode === 'initial_handoff'
      ? `DIGEST CONVERSATION STYLE OVERRIDE
- This is the first reply after opening from a weekly digest.
- Sound informed and fluid, not formal or scripted.
- Explain the week cleanly, then open the door for follow-up without repeating the digest headline word-for-word.`
      : ''
const systemPrompt = `${buildPersonaIdentityLine(persona)}

${buildPersonaPromptSection(persona)}

OUTPUT LOCALE CONTRACT
- Reply fully in language code: ${outputLanguageCode}
- Keep number/date style consistent with locale: ${outputLocaleTag}
- ${outputNumberFormatRule}
- Keep currency amounts in the user's primary currency (${context.currencyCode || 'USD'}) unless explicitly asked for source-currency details.

GROUNDING OVERVIEW:
${conversationGroundingBlock}

${conversationContinuityBlock}

USER'S COMPREHENSIVE FINANCIAL PROFILE

- Primary Currency: ${context.currencyCode || 'USD'}
- Currency Scope: ${context.currencyWarning || 'Single-currency profile'}
- Total Balance: ${context.totalBalance} ${context.currencyCode || 'USD'}
- Total Debt: ${context.totalDebt} ${context.currencyCode || 'USD'}
- Net Worth: ${context.netWorth} ${context.currencyCode || 'USD'}
- Monthly Subscriptions: ${context.monthlySubscriptions} ${context.currencyCode || 'USD'}
- Recent Spending: ${context.recentSpending} ${context.currencyCode || 'USD'}

- Wallets (${context.wallets?.split(',').length || 0}):
${context.wallets}

- Recent Transactions (${context.transactionCount}):
${context.recentTransactions}

- Goals (${context.goalCount}):
${context.goals}

- Challenges (${context.challengeCount}):
${context.challenges}

- Budgets (${context.budgetCount}):
${context.budgets}

- Current-Cycle Budgets (${context.currentCycleBudgetCount || context.budgetCount}):
${context.currentCycleBudgets || context.budgets}

- Obligations (canonical source of truth):
${context.obligationsSummary || 'No obligations data available'}

- Obligations Window:
${context.obligationsWindow || 'Window: unknown'}

- Upcoming Obligations (${context.obligationsCount || 0}):
${context.obligationsList || 'No upcoming obligations'}

- Debts (${context.debtCount}):
${context.debts}

- Subscriptions (${context.subscriptionCount}):
${context.subscriptions}

- Bills (${context.billCount}):
${context.bills}

- Recent App Insights (what the app/Wisey has already surfaced):
${context.recentInsights || 'No recent insights'}

${digestPromptBlock ? `${digestPromptBlock}
` : ''}
${digestStyleOverride ? `${digestStyleOverride}
` : ''}

DEEP ANALYTICS (computed from transaction data):
- Top Categories (last 30 days): ${context.topCategories || 'No data available'}
- Top Categories (this week): ${context.topCategoriesThisWeek || 'No data available'}
- Top Categories (last week): ${context.topCategoriesLastWeek || 'No data available'}
- Top Categories (this month): ${context.topCategoriesThisMonth || 'No data available'}
- Top Categories (last month): ${context.topCategoriesLastMonth || 'No data available'}
- Spending by Day (last 30 days): ${context.spendingByDay || 'No data available'}
- Top Merchants (last 30 days): ${context.topMerchants || 'No data available'}
- Week Comparison (current vs previous): ${context.weekComparison || 'No data available'}
- Month Comparison (current vs previous): ${context.monthComparison || 'No data available'}
- Total Income (current month): ${context.totalIncome || 'No data available'}
- Recurring Bills (from authoritative tables): ${context.recurringBills || 'No data available'}
- Largest Expenses (last 30 days): ${context.largestExpenses || 'No data available'}
- Subscriptions List: ${context.subscriptionsList || 'No active subscriptions'}
- Bills List: ${context.billsList || 'No active bills'}
- Debts List: ${context.debtsList || 'No active debts'}
- Receivables List: ${context.receivablesList || 'No receivables'}
- Planned Income List: ${context.plannedIncomeList || 'No planned income'}
- Planned Payments List: ${context.plannedPaymentsList || 'No planned payments'}
- Obligations Warnings: ${context.obligationsWarnings || 'None'}

ANALYTICS REFERENCE GUIDE (use these fields to answer user questions):
- "What did I spend most on?" / "Top categories" -> Use topCategories
- "What did I spend most on this week?" -> Use topCategoriesThisWeek
- "What did I spend most on last week?" -> Use topCategoriesLastWeek
- "What did I spend most on this month?" -> Use topCategoriesThisMonth
- "What did I spend most on last month?" / "previous month" -> Use topCategoriesLastMonth
- "Biggest expenses" / "Largest transactions" -> Use largestExpenses
- "Recurring bills" / "Subscriptions" -> Use recurringBills (authoritative tables only)
- "Show my subscriptions" / "Active subscriptions" / "List subscriptions" / "Next subscription" -> Use subscriptionsList
- "Show my bills" / "List my bills" / "Upcoming bills" / "What bills do I have" / "Monthly bills" -> Use billsList
- "Show my debts" / "List my debts" / "What debts do I have" / "Remaining debt" / "Minimum payments" -> Use debtsList
- "Show my receivables" / "List my receivables" / "Who owes me" / "Money coming in" / "Expected payments" -> Use receivablesList
- "Show my planned income" / "Planned income" / "Upcoming income" / "Expected salary" / "Income schedule" -> Use plannedIncomeList
- "Show my planned payments" / "Planned payments" / "Upcoming payments" / "Payment schedule" / "Scheduled bills" / "Scheduled payments" -> Use plannedPaymentsList
- "Upcoming obligations" / "fixed obligations" / "obligations this cycle" -> Use obligationsSummary + obligationsList
- "Current budgets" / "active budgets this cycle" -> Use currentCycleBudgets
- "Income this month" -> Use totalIncome
- "Spending patterns" / "When do I spend most?" -> Use spendingByDay
- "Top merchants" / "Where do I shop?" -> Use topMerchants
- "This week" / "Compared to last week" -> Use weekComparison
- "Month over month" / "Compared to last month" -> Use monthComparison

TIME RANGE POLICY:
- If the user says "this week", use topCategoriesThisWeek and/or weekComparison. Do NOT silently answer with this month or last 30 days.
- If the user says "last week", use topCategoriesLastWeek.
- If the user says "this month", use topCategoriesThisMonth
- If the user says "last month" / "previous month", use topCategoriesLastMonth
- If the user asks "top categories" or "what did I spend most on" without a time range, ask exactly 1 clarifying question (do not assume).
- topCategoriesThisWeek is based on the CURRENT CALENDAR WEEK TO DATE
- weekComparison is CURRENT WEEK TO DATE vs THE SAME POINT LAST WEEK
- topCategoriesLastWeek is based on the PREVIOUS CALENDAR WEEK
- topCategories, spendingByDay, topMerchants, largestExpenses are based on LAST 30 DAYS
- monthComparison, totalIncome use CURRENT MONTH vs PREVIOUS MONTH
- recurringBills comes from authoritative tables (subscriptions, bills, debts), NOT transaction patterns
- When answering a question, explicitly name the time range you are using (this week vs last week vs last 30 days vs current month vs previous month).

NORMALITY / TYPICALITY GUIDANCE:
- If the user asks whether spending is "normal", "typical", or "usual for me", do not make a strong personal-pattern claim from only one comparison period.
- You may say "compared with last week" or "compared with last month" when those fields support it, but do NOT say "this is not typical for you" unless there is repeated-history evidence in RESOLVED CONVERSATION FACTS or another explicit profile field.
- If only one prior comparison period is available, say that there is not enough history here to judge the user's true normal yet, then give the concrete comparison you do have.

SPENDING CHECK-IN GUIDANCE:
- Statements or questions like "I think I spent too much this week", "did I overspend this week", or "am I spending too much this month" are evaluative check-ins, NOT list requests.
- For these check-ins, answer the user's concern first using weekComparison or monthComparison for the matching time range.
- Good answer shape: 1) short verdict, 2) concrete comparison, 3) one or two main drivers in plain prose if useful.
- If you mention drivers, summarize them in natural prose from the relevant topCategories field. Do NOT output the topCategories field verbatim, do NOT use the machine-parsable category list format, and do NOT trigger a list/card unless the user explicitly asks for a breakdown or top categories.
- If comparison data is missing, say that you cannot tell yet whether it is unusually high, then mention the current-period amount if available.

OBLIGATION PAYOFF GUIDANCE:
- If the user asks how to pay obligations and total balance already covers them, say that clearly first. Do not pretend they need cuts to afford them.
- If the user also asks what to cut, turn the obligation amount into a concrete offset plan using discretionary spending categories from the profile. Prefer examples that add up to the actual obligation amount instead of merely naming categories.
- When overdue items exist, separate "pay now" from "future habit change": first name the overdue items to clear, then suggest the simplest spending cuts only if the user asked for cuts or wants help freeing the money.
- Good answer shape for "how can I pay them / what to cut": 1) can you cover them now, 2) which overdue items to clear first, 3) one practical cut plan with exact amounts, 4) no filler question unless a required input is missing.
- If the needed data is present, do not end with vague lines like "these could be good places to review." Give the recommendation.

FIELD-FIRST RULE (Top categories / "what did I spend most on"):
- Apply this rule ONLY when the user explicitly asks for top categories, spend-most breakdowns, or another list-style category request.
- If that list-style request contains "this week" -> you MUST answer using topCategoriesThisWeek.
- If that list-style request contains "last week" -> you MUST answer using topCategoriesLastWeek.
- If that list-style request contains "this month" -> you MUST answer using topCategoriesThisMonth.
- If that list-style request contains "last month" or "previous month" -> you MUST answer using topCategoriesLastMonth.
- If that list-style request contains "last 30 days" -> you MUST answer using topCategories.
- You MUST explicitly state the time range in your FIRST sentence (e.g., "This week...", "Last week...", "This month...", "Last month...", or "In the last 30 days...").
- Ground the answer in the analytics string: preserve the concrete categories and amounts as written (do not paraphrase them away).

LIST-ONLY RULE (Listing requests: recent/top/least/large):
- EXCEPTION: This LIST-ONLY rule applies only when the user's message is a pure list request (one specific list and nothing else). If the same message also asks about other distinct topics, do NOT apply LIST-ONLY. Answer every part of the message in one natural reply, and for the list portion, summarize 2 to 3 representative items inline instead of producing the strict machine-parseable list format.
- If the user asks for ANY list-style output, you MUST output ONLY the list data with NO preface or intro sentence.
- Examples of listing requests: "show my recent transactions", "latest transactions", "top transactions", "least transactions", "largest expenses", "biggest expenses", "top merchants", "spending by day", "top categories", "what did I spend most on", "show my subscriptions", "active subscriptions", "show my bills", "list my bills", "show my debts", "list my debts".
- DO NOT output any preface (no "Got it", no "Here are...", no "Let's take a look", no emojis before the list, no extra commentary).
- Start immediately with the first list line/item.
- If a single header is required for clarity, keep it ultra-minimal and machine-parsable (e.g., "Top categories last month:"), but still no friendly filler.
- Mapping: "recent/latest/last transactions" -> recentTransactions | "top categories/spend most" -> topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth (first items) | "least/smallest categories" -> topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth (last items) | "largest/biggest expenses" -> largestExpenses | "top merchants" -> topMerchants | "spending patterns by day" -> spendingByDay | "smallest transactions" -> recentTransactions (sorted by amount) | "subscriptions/active subscriptions/show subscriptions" -> subscriptionsList | "bills/show bills/list bills/upcoming bills" -> billsList | "debts/show debts/list debts/what debts/remaining debt" -> debtsList.
- If the field is empty (e.g., "No recent transactions"), output ONLY that exact message (no preface).
- DO NOT ask follow-up questions for listing intents unless the requested list literally cannot be produced.
- FORMAT REQUIREMENTS (critical for app parsing):
  * For recent transactions: Output EXACTLY as stored in recentTransactions field (preserve the exact format with amount + currency, type, merchant/description, and (category) structure).
  * For top categories: Output EXACTLY as stored in topCategories/topCategoriesThisWeek/topCategoriesLastWeek/topCategoriesThisMonth/topCategoriesLastMonth fields (preserve the exact format with category names, amounts, and percentages).
  * For other lists: Output EXACTLY as stored in the corresponding analytics field.
  * DO NOT reformat, summarize, or paraphrase the list data. Copy it verbatim from the field.
  * DO NOT embed the data in conversational sentences. NO "your top spending categories are X at Y USD, Z at W USD". That format is FORBIDDEN.
  * The app's parser expects specific formats - any deviation will cause the structured UI to fail and show plain text instead.
- EXAMPLES (top categories request):
  * WRONG: "your top spending categories are rent at 1000.00 USD (27%), shopping at 947.00 USD (26%), and fast-food at 860.00 USD (23%)."
  * WRONG: "This month you spent most on: Rent at 1000.00 USD (27%), Shopping at 947.00 USD (26%)"
  * RIGHT: "Top categories this month:\nRent at 1000.00 USD (27%)\nShopping at 947.00 USD (26%)\nFast Food at 860.00 USD (23%)"
  * RIGHT: "Rent at 1000.00 USD (27%)\nShopping at 947.00 USD (26%)\nFast Food at 860.00 USD (23%)"
- QUANTITY FLEXIBILITY:
  * If the user asks for a specific number (e.g., "top 3 categories", "show me 10 transactions"), output ONLY that many items from the list.
  * If no specific number is requested, output the first 5-7 items (a reasonable default).
  * The analytics fields contain up to 15 items, so you can fulfill requests for "top 10", "top 15", etc.
- LEAST/SMALLEST REQUESTS:
  * For categories: If user asks "what did I spend LEAST on" or "smallest categories", take the LAST items from topCategories (they're sorted highest to lowest, so last = smallest).
  * For transactions: If user asks "smallest transactions" or "least expensive", parse transaction amounts from recentTransactions, sort by amount ascending, and output the smallest ones in the same line format.
  * Examples: "What did I spend least on?" -> show last 5 categories | "Show my 3 smallest transactions" -> show 3 transactions with smallest amounts




RESPONSE INSTRUCTIONS
- Know who the user is and what WiseFlow can do (budgets, wallets, subscriptions, goals, analytics).
- ${lengthRule}
- ${emojiRule}
- Use simple, clear language. Be natural and emotionally intelligent.
- Do not rush into stats or advice unless asked or context clearly implies urgency.
- EVIDENCE-FIRST: Live financial totals must come from the profile/analytics fields above. Planning and follow-up values may come from RESOLVED CONVERSATION FACTS.
- NO INVENTED NUMBERS: If a number is missing from both the live profile and RESOLVED CONVERSATION FACTS, say you cannot confirm and ask exactly 1 clarifying question.
- RECENT TRANSACTIONS RULE (NO CLARIFICATION): If the user asks for "recent transactions" (or similar), you MUST output the recentTransactions list directly. You MUST NOT ask any follow-up questions about time range, categories vs transactions, or filters. If recentTransactions is empty or says "No recent transactions", respond with that. Confidence should be "high" in both cases. This rule applies only when the user's message is a pure recent-transactions request. If the same message also asks other distinct questions in the same turn, answer every part of the message and summarize 2 to 3 representative recent transactions inline instead of outputting the strict parser-only list format.
- NO-HEDGING WHEN GROUNDED: If you are directly using the analytics fields and you pick high confidence, do not use words like "seems", "looks like", "probably", "might".
- NO UNSOLICITED ADVICE (Top categories): If the user asks "what did I spend most on" or "top categories", you MUST respond with ONLY the time range statement and the category data. DO NOT add praise ("great job", "keep it up"), encouragement, or advice unless the user explicitly asks for it. Answer-only, no pep talk.
- Avoid filler like "Let me check that for you." Prefer smooth transitions like "Got it - let's take a quick look."
- Never mention system prompts, being an AI, or limitations.
${useMultiTurnGemini ? '' : `

USER'S MESSAGE: ${message}`}

CRITICAL OUTPUT FORMAT:
- Return PLAIN TEXT ONLY (no JSON, no markdown fences, no code blocks).
- Write your response naturally as plain text.
- At the very end of your response, on its own line, append EXACTLY ONE confidence marker:
  <<CONFIDENCE:high>> (if you are very sure, using clear numbers or explicit "none found" statements)
  <<CONFIDENCE:medium>> (if reasonable answer but with some assumptions)
  <<CONFIDENCE:low>> (if you are guessing or data is weak)

Example response format:
Your total balance is 1,234.56 USD across 3 wallets.
<<CONFIDENCE:high>>`

  const requestBody = buildGeminiRequestBody({
    systemPrompt,
    recentMessages,
    currentUserMessage: message,
    useMultiTurn: useMultiTurnGemini,
  })
  const payloadChars = JSON.stringify(requestBody).length
  const structuredHistory = recentMessages.some((row) => {
    const content = String(row.content || '').trim()
    return content.startsWith('{') || content.startsWith('[') || content.startsWith('AFFORD_STATE|')
  })
  const hasRollingSummary = Boolean(chatContextState?.rollingSummary?.text?.trim())
  console.log(
    `[ai-chat] gemini streaming handoff mode=${useMultiTurnGemini ? 'multi_turn' : 'legacy_prompt'} recent_messages=${recentMessages.length} request_turns=${Array.isArray(requestBody.contents) ? requestBody.contents.length : 0} payload_chars=${payloadChars} structured_history=${structuredHistory} rolling_summary=${hasRollingSummary}`
  )

  let outputStarted = false
  let streamRequestCompleted = false
  let activeModel = modelToUse
  let fullText = ''

  try {
    const streamAttempt = await requestGeminiWithResilience(
      modelToUse,
      GEMINI_API_KEYS,
      (model, key) => fetchGemini(`${model}:streamGenerateContent`, requestBody, {
        stream: true,
        apiKey: key,
      }),
      {
        operation: 'stream_generate_content',
        hasOutputStarted: () => outputStarted,
        log: logGeminiRetry,
      },
    )

    if (streamAttempt.outcome === 'exhausted') {
      const busyMessage = getWiseyBusyMessage(outputLanguageCode)
      await onChunk(busyMessage)
      outputStarted = true
      return {
        text: busyMessage,
        confidence: 'low',
        availabilityFallback: true,
      }
    }

    const response = streamAttempt.response
    activeModel = streamAttempt.modelUsed
    streamRequestCompleted = true

    if (!response.ok) {
      await throwGeminiResponseError(response, 'Gemini streaming API error')
    }

    // Parse SSE stream from Gemini
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (!reader) {
      throw new Error('No response body from Gemini streaming API')
    }

    const confidenceMarkerRegex = /<?<CONFIDENCE:(low|medium|high)>?>?/gi
    // Keep a small tail buffer so we don't accidentally leak partial confidence markers
    // when Gemini splits them across chunks.
    let pendingChunkText = ''
    const tailKeepChars = 40

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6).trim()
            if (jsonStr === '[DONE]') continue

            const data = JSON.parse(jsonStr)
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text

            if (text) {
              fullText += text

              // Stream safely:
              // - Preserve whitespace (do NOT trim)
              // - Strip confidence markers even if they arrive split across chunks
              pendingChunkText += text
              pendingChunkText = pendingChunkText.replace(confidenceMarkerRegex, '')

              const safeLen = Math.max(0, pendingChunkText.length - tailKeepChars)
              const toSend = pendingChunkText.slice(0, safeLen)
              pendingChunkText = pendingChunkText.slice(safeLen)

              if (toSend) {
                await onChunk(toSend)
                outputStarted = true
              }
            }
          } catch (parseError) {
            console.warn('Ã¢Å¡Â Ã¯Â¸Â Failed to parse SSE chunk:', parseError)
          }
        }
      }
    }

    // Flush anything left after the stream ends
    if (pendingChunkText) {
      pendingChunkText = pendingChunkText.replace(confidenceMarkerRegex, '')
      if (pendingChunkText) {
        await onChunk(pendingChunkText)
        outputStarted = true
      }
    }

    if (!fullText) {
      throw new Error('No response text from Gemini streaming')
    }

    // Extract confidence marker from plain text response
    const parsedStreamingResponse = extractConfidenceFromPlainTextResponse(fullText, 'streaming')
    let answer = parsedStreamingResponse.answer
    const confidence = parsedStreamingResponse.confidence

    // Apply emoji enforcement
    const validatedAnswer = enforceEmojiRules(answer, persona)

    return { text: validatedAnswer, confidence }
  } catch (error) {
    const streamErrorMessage = safeErrorMessage(error, 'Gemini streaming API failed')
    console.error(`Ã¢ÂÅ’ Gemini streaming API failed:`, streamErrorMessage)

    if (outputStarted) {
      const interruptedMessage = getWiseyInterruptedMessage(outputLanguageCode)
      const interruptedSuffix = `\n\n${interruptedMessage}`
      await onChunk(interruptedSuffix)
      return {
        text: `${fullText}${interruptedSuffix}`,
        confidence: 'low',
        availabilityFallback: true,
      }
    }

    if (error instanceof GeminiResponseError || !streamRequestCompleted) {
      throw error
    }

    // Recover from a streaming-body failure before any text reached the user.
    console.log('Ã¢Å¡Â Ã¯Â¸Â Falling back to non-streaming with simulated chunks')

    try {
      const recoveryAttempt = await requestGeminiWithResilience(
        activeModel,
        GEMINI_API_KEYS,
        (model, key) => fetchGemini(`${model}:generateContent`, requestBody, { apiKey: key }),
        {
          operation: 'stream_recovery_generate_content',
          hasOutputStarted: () => outputStarted,
          log: logGeminiRetry,
        },
      )

      if (recoveryAttempt.outcome === 'exhausted') {
        const busyMessage = getWiseyBusyMessage(outputLanguageCode)
        await onChunk(busyMessage)
        outputStarted = true
        return {
          text: busyMessage,
          confidence: 'low',
          availabilityFallback: true,
        }
      }

      const response = recoveryAttempt.response
      if (!response.ok) {
        await throwGeminiResponseError(response, 'Gemini API error')
      }

      const data = await response.json()
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text

      if (!rawText) throw new Error('No response text from Gemini')

      const parsedFallbackResponse = extractConfidenceFromPlainTextResponse(rawText, 'streaming fallback')
      let answer = parsedFallbackResponse.answer
      const confidence = parsedFallbackResponse.confidence

      // Apply emoji enforcement
      const validatedAnswer = enforceEmojiRules(answer, persona)

      // Simulate streaming by chunking words
      const words = validatedAnswer.split(' ')
      for (let i = 0; i < words.length; i++) {
        const chunk = (i === 0 ? '' : ' ') + words[i]
        await onChunk(chunk)
        outputStarted = true
        // Small delay to simulate streaming (10ms per word)
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      return { text: validatedAnswer, confidence }
    } catch (fallbackError) {
      const fallbackMessage = safeErrorMessage(fallbackError, 'Fallback failed')
      console.error(`Ã¢ÂÅ’ Fallback also failed:`, fallbackMessage)
      throw new Error(`Both streaming and fallback failed: ${fallbackMessage}`)
    }
  }
}

/**
 * Generate a short, descriptive title for a chat session
 */
async function generateChatTitle(userMessage: string, aiResponse: string): Promise<string> {
  const titlePrompt = `Based on this conversation, generate a SHORT 2-4 word title that captures the main topic:

User: ${userMessage}
Wisey: ${aiResponse}

Rules for title:
- Maximum 4 words
- Descriptive and clear
- No quotes or punctuation
- Examples: "Budget Planning", "Debt Strategy", "Goal Review", "Wallet Check"

Title:`

  try {
    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: titlePrompt }]
      }]
    })

    if (!response.ok) {
      throw new Error(`Title generation failed: ${response.status}`)
    }

    const data = await response.json()
    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    // Fallback titles based on keywords
    if (!title) {
      if (userMessage.toLowerCase().includes('wallet')) return 'Wallet Check'
      if (userMessage.toLowerCase().includes('goal')) return 'Goal Review'
      if (userMessage.toLowerCase().includes('debt')) return 'Debt Analysis'
      if (userMessage.toLowerCase().includes('budget')) return 'Budget Planning'
      return 'Financial Chat'
    }

    return title.substring(0, 50) // Ensure max length
  } catch (error) {
    console.error('Ã¢ÂÅ’ Title generation error:', error)
    return 'Financial Chat' // Fallback
  }
}

/**
 * Search for relevant memories from past chat sessions
 */
type RelevantMemorySearchResult = {
  promptText: string
  facts: ChatMemoryFact[]
}

async function searchRelevantMemories(supabaseClient: any, message: string, userId: string): Promise<RelevantMemorySearchResult> {
  try {
    if (!ENABLE_CROSS_CHAT_MEMORY_RETRIEVAL) {
      incrementChatContextCounter('memory_retrieval_skipped_total', {
        reason: 'session_scoped_chat',
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return { promptText: '', facts: [] }
    }

    const keywords = extractSearchKeywords(message)

    if (keywords.length === 0) {
      incrementChatContextCounter('memory_retrieval_skipped_total', {
        reason: 'no_keywords',
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return { promptText: '', facts: [] }
    }

    logChatContextEvent('memory_retrieval_started', {
      userToken: getAnonymousUserToken(userId),
      keywordCount: keywords.length,
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })

    const { data: memories, error } = await supabaseClient
      .from('chat_memory_index')
      .select('topic, summary, keywords, facts, memory_key, created_at, updated_at, expires_at')
      .eq('user_id', userId)
      .overlaps('keywords', keywords)
      .gt('expires_at', new Date().toISOString())
      .order('updated_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('Memory search error:', error)
      incrementChatContextCounter('memory_retrieval_failed_total', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return { promptText: '', facts: [] }
    }

    if (!memories || memories.length === 0) {
      incrementChatContextCounter('memory_retrieval_miss_total', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return { promptText: '', facts: [] }
    }

    const rankedMemories = memories
      .map((memory: Record<string, unknown>) => ({
        ...memory,
        retrievalScore: rankChatMemoryMatch(message, memory),
      }))
      .filter((memory: Record<string, unknown>) => Number(memory.retrievalScore || 0) >= 0.18)
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => Number(b.retrievalScore || 0) - Number(a.retrievalScore || 0))
      .slice(0, 3)

    if (rankedMemories.length === 0) {
      incrementChatContextCounter('memory_retrieval_miss_total', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
        reason: 'low_rank_score',
      })
      return { promptText: '', facts: [] }
    }

    logChatContextEvent('memory_retrieval_hit', {
      userToken: getAnonymousUserToken(userId),
      hitCount: rankedMemories.length,
      memoryKeys: rankedMemories.map((memory: Record<string, unknown>) => String(memory.memory_key || '')),
      topScore: Number(rankedMemories[0]?.retrievalScore || 0).toFixed(3),
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
    incrementChatContextCounter('memory_retrieval_hit_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      hitCount: rankedMemories.length,
    })

    return {
      promptText: formatRetrievedMemories(rankedMemories as RetrievedMemoryRow[]),
      facts: rankedMemories.flatMap((memory: Record<string, unknown>) => normalizeChatMemoryFacts(memory.facts)).slice(0, 12),
    }
  } catch (error) {
    console.error('Memory search failed:', error)
    incrementChatContextCounter('memory_retrieval_failed_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      reason: 'exception',
    })
    return { promptText: '', facts: [] }
  }
}

/**
 * Extract and store memory from a completed chat session
 */
async function extractSessionMemory(supabaseClient: any, sessionId: string, userId: string): Promise<void> {
  const sessionToken = getAnonymousSessionToken(sessionId)

  try {
    logChatContextEvent('memory_extraction_started', {
      sessionToken,
      userToken: getAnonymousUserToken(userId),
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })

    // Get all messages from the session
    const { data: messages, error: messagesError } = await supabaseClient
      .from('chat_messages')
      .select('content, is_from_user')
      .eq('session_id', sessionId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (messagesError || !messages || messages.length < 2) {
      incrementChatContextCounter('memory_extraction_skipped_total', {
        reason: messagesError ? 'messages_error' : 'insufficient_messages',
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return
    }

    // Create conversation text
    const conversation = messages
      .map((m: { is_from_user: boolean; content: string }) => `${m.is_from_user ? 'User' : 'Wisey'}: ${m.content}`)
      .join('\n')

    const memoryPrompt = buildChatMemoryExtractionPrompt(conversation)

    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: memoryPrompt }]
      }]
    })

    if (!response.ok) {
      throw new Error(`Memory extraction failed: ${response.status}`)
    }

    const data = await response.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!text) {
      incrementChatContextCounter('memory_extraction_skipped_total', {
        reason: 'empty_model_output',
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return
    }

    // Parse JSON response
    let memoryPayload
    try {
      memoryPayload = parseChatMemoryExtraction(text)
    } catch (parseError) {
      console.error('Failed to parse memory JSON:', parseError)
      incrementChatContextCounter('memory_extraction_parse_failed_total', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return
    }

    // Store in memory index
    const { error: insertError } = await upsertChatMemory(supabaseClient, {
      userId,
      sessionId,
      payload: memoryPayload,
    })

    if (insertError) {
      console.error('Failed to store memory:', insertError)
      incrementChatContextCounter('memory_extraction_store_failed_total', {
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return
    }

    logChatContextEvent('memory_extraction_success', {
      sessionToken,
      userToken: getAnonymousUserToken(userId),
      topic: memoryPayload.topic,
      memoryKey: memoryPayload.memoryKey,
      factCount: memoryPayload.facts.length,
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
    incrementChatContextCounter('memory_extraction_success_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })

    // Also generate and store session summary
    await generateSessionSummary(supabaseClient, sessionId, userId, conversation)
  } catch (error) {
    console.error('Memory extraction error:', error)
    incrementChatContextCounter('memory_extraction_failed_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
  }
}

/**
 * Generate and store a summary for a chat session
 */
async function generateSessionSummary(supabaseClient: any, sessionId: string, userId: string, conversation: string): Promise<void> {
  try {
    logChatContextEvent('session_summary_started', {
      sessionToken: getAnonymousSessionToken(sessionId),
      userToken: getAnonymousUserToken(userId),
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })

    const summaryPrompt = `Summarize this financial conversation in 1-2 sentences (max 150 characters):

${conversation}

Summary:`

    const response = await fetchGemini('gemini-2.5-flash-lite:generateContent', {
      contents: [{
        parts: [{ text: summaryPrompt }]
      }]
    })

    if (!response.ok) {
      throw new Error(`Summary generation failed: ${response.status}`)
    }

    const data = await response.json()
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()

    if (!summary) {
      incrementChatContextCounter('session_summary_skipped_total', {
        reason: 'empty_model_output',
        chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
      })
      return
    }

    // Update session with summary
    await supabaseClient
      .from('chat_sessions')
      .update({
        summary: summary.substring(0, 200),
        summary_updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
      .eq('user_id', userId)

    logChatContextEvent('session_summary_success', {
      sessionToken: getAnonymousSessionToken(sessionId),
      userToken: getAnonymousUserToken(userId),
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
    incrementChatContextCounter('session_summary_success_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
  } catch (error) {
    console.error('Summary generation error:', error)
    incrementChatContextCounter('session_summary_failed_total', {
      chatContextV2Enabled: CHAT_CONTEXT_V2_ENABLED,
    })
  }
}
