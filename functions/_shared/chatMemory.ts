export type ChatMemoryFact = {
  intent: string
  slotName: string
  value: unknown
  updatedAt?: string | null
  confidence?: number | null
  sourceScope?: string | null
  status?: string | null
  scope?: string | null
}

export type RetrievedMemoryRow = {
  topic?: string | null
  summary?: string | null
  keywords?: string[] | null
  facts?: ChatMemoryFact[] | null
  memory_key?: string | null
  created_at?: string | null
  updated_at?: string | null
  expires_at?: string | null
}

export type ChatMemoryExtractionPayload = {
  topic: string
  summary: string
  keywords: string[]
  facts: ChatMemoryFact[]
  memoryKey: string
  expiresAt: string
  sourceContextVersion: number
  relevanceScore: number
}

const MEMORY_RETENTION_DAYS = 90
const MEMORY_KEY_MAX_LENGTH = 180
const KEYWORD_LIMIT = 12
const FACT_LIMIT = 12
const TOKEN_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'have', 'with', 'from', 'would', 'could',
  'should', 'there', 'their', 'about', 'your', 'you', 'into', 'than', 'then', 'them', 'they',
  'just', 'like', 'plan', 'same', 'make', 'need', 'want', 'will', 'show', 'tell', 'give', 'check',
  'chat', 'wisey', 'wiseflow', 'really', 'also', 'only', 'more', 'less', 'after', 'before',
])

function slugify(value: string): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeScalarValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeScalarValue(item))
      .filter((item) => item.length > 0)
      .join('-')
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, item]) => `${key}-${normalizeScalarValue(item)}`)
      .filter((item) => item.length > 0)
      .join('-')
  }
  return ''
}

function tokenizeText(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TOKEN_STOPWORDS.has(token))
}

export function extractSearchKeywords(text: string, extras: string[] = []): string[] {
  const combined = [...tokenizeText(text), ...extras.flatMap((item) => tokenizeText(item))]
  const unique: string[] = []
  for (const token of combined) {
    if (!unique.includes(token)) unique.push(token)
    if (unique.length >= KEYWORD_LIMIT) break
  }
  return unique
}

export function buildChatMemoryExtractionPrompt(conversation: string): string {
  return `Analyze this financial conversation and extract only durable financial memory for future follow-up.

Conversation:
${conversation}

Rules:
1. Store only financial facts that matter across sessions: targets, amounts, timeframes, obligations, plan choices, budget choices.
2. Ignore greetings, filler, emotional chatter, and generic advice.
3. Summary must be 1-2 sentences and under 180 characters.
4. Keywords must be short searchable tokens.
5. Facts must be financial only.

Return JSON only:
{
  "topic": "Vacation Savings Goal",
  "summary": "User wants a September vacation plan and discussed monthly savings changes.",
  "keywords": ["vacation", "september", "savings", "monthly"],
  "facts": [
    {
      "intent": "vacation_affordability",
      "slotName": "targetMonth",
      "value": "2026-09",
      "confidence": 0.92
    },
    {
      "intent": "save_more_plan",
      "slotName": "targetSavingsCents",
      "value": 50000,
      "confidence": 0.88
    }
  ]
}`
}

function normalizeFactEntry(input: unknown): ChatMemoryFact | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const intent = String(raw.intent || '').trim()
  const slotName = String(raw.slotName || '').trim()
  if (!intent || !slotName) return null

  return {
    intent,
    slotName,
    value: raw.value ?? null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    confidence: typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null,
    sourceScope: typeof raw.sourceScope === 'string' ? raw.sourceScope : null,
    status: typeof raw.status === 'string' ? raw.status : null,
    scope: typeof raw.scope === 'string' ? raw.scope : null,
  }
}

export function normalizeChatMemoryFacts(input: unknown): ChatMemoryFact[] {
  if (!Array.isArray(input)) return []
  const normalized: ChatMemoryFact[] = []
  for (const item of input) {
    const fact = normalizeFactEntry(item)
    if (!fact) continue
    normalized.push(fact)
    if (normalized.length >= FACT_LIMIT) break
  }
  return normalized
}

export function buildChatMemoryKey(topic: string, facts: ChatMemoryFact[], keywords: string[]): string {
  const factParts = facts
    .slice()
    .sort((a, b) => `${a.intent}:${a.slotName}`.localeCompare(`${b.intent}:${b.slotName}`))
    .slice(0, 6)
    .map((fact) => {
      const normalizedValue = slugify(normalizeScalarValue(fact.value)).slice(0, 24)
      const base = `${slugify(fact.intent)}:${slugify(fact.slotName)}`
      return normalizedValue ? `${base}:${normalizedValue}` : base
    })
    .filter((item) => item.length > 0)

  const keywordPart = keywords
    .slice(0, 4)
    .map((item) => slugify(item))
    .filter((item) => item.length > 0)
    .join('|')

  const pieces = factParts.length > 0
    ? factParts
    : [slugify(topic).slice(0, 48), keywordPart].filter((item) => item.length > 0)

  const raw = pieces.join('|') || `topic:${slugify(topic).slice(0, 48) || 'financial-chat'}`
  return raw.slice(0, MEMORY_KEY_MAX_LENGTH)
}

export function buildChatMemoryExpiry(baseDate = new Date()): string {
  const expiresAt = new Date(baseDate.getTime())
  expiresAt.setUTCDate(expiresAt.getUTCDate() + MEMORY_RETENTION_DAYS)
  return expiresAt.toISOString()
}

export function parseChatMemoryExtraction(text: string): ChatMemoryExtractionPayload {
  const rawText = String(text || '').trim()
  const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/i) || rawText.match(/\{[\s\S]*\}/)
  const jsonText = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : rawText
  const parsed = JSON.parse(jsonText) as Record<string, unknown>

  const topic = String(parsed.topic || 'Financial Chat').trim() || 'Financial Chat'
  const summary = String(parsed.summary || 'No summary available').trim() || 'No summary available'
  const facts = normalizeChatMemoryFacts(parsed.facts)
  const keywords = extractSearchKeywords(
    [topic, summary].join(' '),
    [
      ...(Array.isArray(parsed.keywords) ? parsed.keywords.map((item) => String(item || '')) : []),
      ...facts.map((fact) => `${fact.intent} ${fact.slotName} ${normalizeScalarValue(fact.value)}`),
    ],
  )

  return {
    topic,
    summary,
    keywords,
    facts,
    memoryKey: buildChatMemoryKey(topic, facts, keywords),
    expiresAt: buildChatMemoryExpiry(),
    sourceContextVersion: 1,
    relevanceScore: Math.min(1.5, 0.7 + (facts.length * 0.08) + (keywords.length * 0.02)),
  }
}

function candidateTokens(memory: RetrievedMemoryRow): string[] {
  const factTokens = normalizeChatMemoryFacts(memory.facts).flatMap((fact) =>
    tokenizeText(`${fact.intent} ${fact.slotName} ${normalizeScalarValue(fact.value)}`)
  )

  return [
    ...tokenizeText(String(memory.topic || '')),
    ...tokenizeText(String(memory.summary || '')),
    ...(Array.isArray(memory.keywords) ? memory.keywords.flatMap((keyword) => tokenizeText(keyword)) : []),
    ...factTokens,
  ]
}

function computeRecencyScore(memory: RetrievedMemoryRow): number {
  const dateValue = memory.updated_at || memory.created_at
  if (!dateValue) return 0
  const timestamp = new Date(dateValue).getTime()
  if (!Number.isFinite(timestamp)) return 0
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24))
  if (ageDays <= 7) return 1
  if (ageDays <= 30) return 0.7
  if (ageDays <= 60) return 0.4
  if (ageDays <= 90) return 0.2
  return 0
}

function computeIntentRelevance(messageKeywords: string[], memory: RetrievedMemoryRow): number {
  const facts = normalizeChatMemoryFacts(memory.facts)
  if (facts.length === 0) return 0

  const intentTokens = facts.flatMap((fact) => tokenizeText(`${fact.intent} ${fact.slotName}`))
  const uniqueIntents = new Set(intentTokens)
  const overlapCount = messageKeywords.filter((keyword) => uniqueIntents.has(keyword)).length
  if (overlapCount <= 0) return 0
  return Math.min(1, overlapCount / Math.max(1, uniqueIntents.size))
}

export function rankChatMemoryMatch(message: string, memory: RetrievedMemoryRow): number {
  const messageKeywords = extractSearchKeywords(message)
  if (messageKeywords.length === 0) return 0

  const candidate = candidateTokens(memory)
  const candidateSet = new Set(candidate)
  const overlapCount = messageKeywords.filter((keyword) => candidateSet.has(keyword)).length
  const overlapScore = overlapCount / Math.max(1, messageKeywords.length)
  const recencyScore = computeRecencyScore(memory)
  const intentScore = computeIntentRelevance(messageKeywords, memory)

  return (overlapScore * 0.55) + (recencyScore * 0.25) + (intentScore * 0.20)
}

export function formatRetrievedMemories(memories: RetrievedMemoryRow[]): string {
  if (!Array.isArray(memories) || memories.length === 0) {
    return ''
  }

  return memories
    .map((memory) => {
      const facts = normalizeChatMemoryFacts(memory.facts)
      const factsText = facts.length > 0
        ? ` Facts: ${facts
            .slice(0, 4)
            .map((fact) => `${fact.intent}.${fact.slotName}=${normalizeScalarValue(fact.value)}`)
            .join('; ')}`
        : ''
      return `[${String(memory.topic || 'Financial Chat').trim()}]: ${String(memory.summary || '').trim()}${factsText}`
    })
    .join('\n')
}

export async function upsertChatMemory(
  supabaseClient: any,
  params: {
    userId: string
    sessionId: string
    payload: ChatMemoryExtractionPayload
  }
): Promise<{ error: any }> {
  const { userId, sessionId, payload } = params
  const nowIso = new Date().toISOString()
  const baseRow = {
    user_id: userId,
    topic: payload.topic,
    summary: payload.summary,
    keywords: payload.keywords,
    facts: payload.facts,
    memory_key: payload.memoryKey,
    expires_at: payload.expiresAt,
    source_context_version: payload.sourceContextVersion,
    relevance_score: payload.relevanceScore,
    updated_at: nowIso,
  }

  const { data: existingRow, error: existingError } = await supabaseClient
    .from('chat_memory_index')
    .select('id')
    .eq('user_id', userId)
    .eq('memory_key', payload.memoryKey)
    .maybeSingle()

  if (existingError) {
    return { error: existingError }
  }

  if (existingRow?.id) {
    const { error } = await supabaseClient
      .from('chat_memory_index')
      .update(baseRow)
      .eq('id', existingRow.id)
      .eq('user_id', userId)

    return { error }
  }

  const { error } = await supabaseClient
    .from('chat_memory_index')
    .insert([{
      ...baseRow,
      session_id: sessionId,
    }])

  return { error }
}
