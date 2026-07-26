export type DigestType = 'stability' | 'pressure' | 'recovery'

export type DigestHandoffV1 = {
  handoff_version: 'v1'
  source: 'weekly_digest'
  digest_type: DigestType
  scenario_code: string
  week_start: string
  week_end: string
  headline: string
  summary: string
  bullets: string[]
  next_move: string
  confidence: number
  primary_driver: string | null
  secondary_driver: string | null
  proof_points: string[]
  starter_prompt: string
  obligation_facts: {
    currency: string
    overdue_amount: number
    fixed_obligations_amount: number
    obligation_count: number
    obligations_available: boolean
    obligations_covered: boolean
  }
  spend_facts: {
    currency: string
    current_week_spend: number
    previous_week_spend: number
    current_week_income: number
    previous_week_income: number
    week_over_week_spend_delta_pct: number
    weekend_spend_ratio: number
    late_week_spend_ratio: number
    top_category: string | null
    largest_increase_category: string | null
    largest_increase_amount: number
    largest_expense_amount: number
    largest_expense_label: string | null
    essentials_delta: number
    discretionary_delta: number
  }
}

export type DigestInteractionMode =
  | 'none'
  | 'initial_handoff'
  | 'digest_follow_up'
  | 'general_with_digest'

export type DigestHandoffTrustDecision = {
  trusted: boolean
  reason:
    | 'ok'
    | 'absent'
    | 'input_mode_not_preset'
    | 'starter_prompt_mismatch'
    | 'invalid_week_bounds'
    | 'missing_digest_evidence'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clampNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = normalizeString(value)
  return normalized.length > 0 ? normalized : null
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeString(item))
    .filter((item) => item.length > 0)
    .slice(0, limit)
}

function normalizeBoolean(value: unknown): boolean {
  return value === true
}

function normalizeDigestType(value: unknown): DigestType | null {
  if (value === 'stability' || value === 'pressure' || value === 'recovery') return value
  return null
}

function formatDigestMoney(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 0,
  }).format(Math.max(0, amount))
}

function formatDigestPct(value: number): string {
  return `${Math.round(value * 100)}%`
}

export function normalizeDigestHandoff(raw: unknown): DigestHandoffV1 | null {
  if (!isPlainObject(raw)) return null
  if (normalizeString(raw.handoff_version) !== 'v1') return null
  if (normalizeString(raw.source) !== 'weekly_digest') return null

  const digestType = normalizeDigestType(raw.digest_type)
  if (!digestType) return null

  const scenarioCode = normalizeString(raw.scenario_code)
  const weekStart = normalizeString(raw.week_start)
  const weekEnd = normalizeString(raw.week_end)
  const headline = normalizeString(raw.headline)
  const summary = normalizeString(raw.summary)
  const nextMove = normalizeString(raw.next_move)
  const starterPrompt = normalizeString(raw.starter_prompt)

  if (!scenarioCode || !weekStart || !weekEnd || !headline || !summary || !nextMove || !starterPrompt) {
    return null
  }

  const obligationFacts = isPlainObject(raw.obligation_facts) ? raw.obligation_facts : {}
  const spendFacts = isPlainObject(raw.spend_facts) ? raw.spend_facts : {}

  return {
    handoff_version: 'v1',
    source: 'weekly_digest',
    digest_type: digestType,
    scenario_code: scenarioCode,
    week_start: weekStart,
    week_end: weekEnd,
    headline,
    summary,
    bullets: normalizeStringArray(raw.bullets, 4),
    next_move: nextMove,
    confidence: Math.max(0, Math.min(1, clampNumber(raw.confidence, 0.5))),
    primary_driver: normalizeOptionalString(raw.primary_driver),
    secondary_driver: normalizeOptionalString(raw.secondary_driver),
    proof_points: normalizeStringArray(raw.proof_points, 6),
    starter_prompt: starterPrompt,
    obligation_facts: {
      currency: normalizeString(obligationFacts.currency, 'USD') || 'USD',
      overdue_amount: clampNumber(obligationFacts.overdue_amount),
      fixed_obligations_amount: clampNumber(obligationFacts.fixed_obligations_amount),
      obligation_count: Math.max(0, Math.trunc(clampNumber(obligationFacts.obligation_count))),
      obligations_available: normalizeBoolean(obligationFacts.obligations_available),
      obligations_covered: normalizeBoolean(obligationFacts.obligations_covered),
    },
    spend_facts: {
      currency: normalizeString(spendFacts.currency, 'USD') || 'USD',
      current_week_spend: clampNumber(spendFacts.current_week_spend),
      previous_week_spend: clampNumber(spendFacts.previous_week_spend),
      current_week_income: clampNumber(spendFacts.current_week_income),
      previous_week_income: clampNumber(spendFacts.previous_week_income),
      week_over_week_spend_delta_pct: clampNumber(spendFacts.week_over_week_spend_delta_pct),
      weekend_spend_ratio: clampNumber(spendFacts.weekend_spend_ratio),
      late_week_spend_ratio: clampNumber(spendFacts.late_week_spend_ratio),
      top_category: normalizeOptionalString(spendFacts.top_category),
      largest_increase_category: normalizeOptionalString(spendFacts.largest_increase_category),
      largest_increase_amount: clampNumber(spendFacts.largest_increase_amount),
      largest_expense_amount: clampNumber(spendFacts.largest_expense_amount),
      largest_expense_label: normalizeOptionalString(spendFacts.largest_expense_label),
      essentials_delta: clampNumber(spendFacts.essentials_delta),
      discretionary_delta: clampNumber(spendFacts.discretionary_delta),
    },
  }
}

function normalizeMessage(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function isIsoDateYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function daysBetweenInclusive(startYmd: string, endYmd: string): number | null {
  const start = new Date(`${startYmd}T00:00:00Z`)
  const end = new Date(`${endYmd}T00:00:00Z`)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null
  const ms = end.getTime() - start.getTime()
  if (ms < 0) return null
  return Math.floor(ms / 86400000) + 1
}

export function evaluateDigestHandoffTrust(params: {
  requestDigestHandoff?: DigestHandoffV1 | null
  message: string
  inputMode?: string | null
}): DigestHandoffTrustDecision {
  const requestDigest = params.requestDigestHandoff || null
  if (!requestDigest) return { trusted: false, reason: 'absent' }

  const inputMode = normalizeMessage(params.inputMode)
  if (inputMode !== 'preset') {
    return { trusted: false, reason: 'input_mode_not_preset' }
  }

  const message = normalizeMessage(params.message)
  const starterPrompt = normalizeMessage(requestDigest.starter_prompt)
  if (!starterPrompt || message !== starterPrompt) {
    return { trusted: false, reason: 'starter_prompt_mismatch' }
  }

  if (!isIsoDateYmd(requestDigest.week_start) || !isIsoDateYmd(requestDigest.week_end)) {
    return { trusted: false, reason: 'invalid_week_bounds' }
  }

  const digestSpanDays = daysBetweenInclusive(requestDigest.week_start, requestDigest.week_end)
  if (digestSpanDays == null || digestSpanDays < 1 || digestSpanDays > 14) {
    return { trusted: false, reason: 'invalid_week_bounds' }
  }

  if (requestDigest.bullets.length === 0 && requestDigest.proof_points.length === 0) {
    return { trusted: false, reason: 'missing_digest_evidence' }
  }

  return { trusted: true, reason: 'ok' }
}

export function detectDigestInteractionMode(params: {
  message: string
  inputMode?: string | null
  activeDigestHandoff?: DigestHandoffV1 | null
  requestDigestHandoff?: DigestHandoffV1 | null
}): DigestInteractionMode {
  const activeDigest = params.requestDigestHandoff || params.activeDigestHandoff || null
  if (!activeDigest) return 'none'

  const message = normalizeMessage(params.message)
  const inputMode = normalizeMessage(params.inputMode)
  const starterPrompt = normalizeMessage(activeDigest.starter_prompt)

  if (params.requestDigestHandoff && (inputMode === 'preset' || message === starterPrompt)) {
    return 'initial_handoff'
  }

  // Treat action JSON payloads as non-digest conversational turns.
  if (message.startsWith('{') && message.includes('"action"')) {
    return 'general_with_digest'
  }

  const digestCue = /\b(this week|weekly digest|digest|last week|what happened this week|what matters most|what should i do first|which bill|which category|what can wait|am i doing better|better than last week|can i still spend|what improved|what did i do right|what is overdue|overdue|obligation|obligations|weekend|late week|pressure|stability|recovery)\b/i
  const shortDigestFollowUpCue = /^(why|how|which one|what now|what first|what can wait|and then|next)\??$/i
  const conversationalDigestFollowUpCue = /\b(what do you mean|say more|explain that|explain more|remind me why|why again|what's driving this|what is driving this|under pressure again|prevent this|avoid this|how do i prevent this|how do i avoid this|any other advice|anything else|show me the overdue items|show the overdue items)\b/i

  if (digestCue.test(message) || shortDigestFollowUpCue.test(message) || conversationalDigestFollowUpCue.test(message)) {
    return 'digest_follow_up'
  }

  return 'general_with_digest'
}

export function buildDigestContextSummary(handoff: DigestHandoffV1 | null): string {
  if (!handoff) return ''
  return [
    'Weekly digest',
    `type=${handoff.digest_type}`,
    `scenario=${handoff.scenario_code}`,
    `week=${handoff.week_start}..${handoff.week_end}`,
  ].join(' | ').slice(0, 300)
}

export function buildDigestPromptBlock(params: {
  activeDigestHandoff?: DigestHandoffV1 | null
  requestDigestHandoff?: DigestHandoffV1 | null
  message: string
  inputMode?: string | null
}): string {
  const handoff = params.requestDigestHandoff || params.activeDigestHandoff || null
  if (!handoff) return ''

  const mode = detectDigestInteractionMode({
    message: params.message,
    inputMode: params.inputMode,
    activeDigestHandoff: params.activeDigestHandoff,
    requestDigestHandoff: params.requestDigestHandoff,
  })

  const obligationCurrency = handoff.obligation_facts.currency || handoff.spend_facts.currency || 'USD'
  const spendCurrency = handoff.spend_facts.currency || handoff.obligation_facts.currency || 'USD'
  const weeklyDeltaPct = `${Math.round(handoff.spend_facts.week_over_week_spend_delta_pct * 100)}%`

  return `ACTIVE WEEKLY DIGEST HANDOFF
Digest interaction mode: ${mode}
- Treat this weekly digest as active session context for questions about this week.
- Never ask the user to restate the digest.
- If the user asks about this week, the digest, why, what happened, what matters, what to do first, whether they are doing better than last week, which bill/category drove it, or whether they can still spend, answer from this digest evidence first.
- If live financial profile data conflicts with the stored digest framing, live data wins and you should say so plainly.
- If the user changes to an unrelated topic, answer it normally without overwriting or contradicting the active digest context.
- If a detail is not present in the digest facts or live profile, do not invent it.

DIGEST FACTS
- Week window: ${handoff.week_start} to ${handoff.week_end}
- Digest type: ${handoff.digest_type}
- Scenario code: ${handoff.scenario_code}
- Headline: ${handoff.headline}
- Summary: ${handoff.summary}
- Primary driver: ${handoff.primary_driver || 'none'}
- Secondary driver: ${handoff.secondary_driver || 'none'}
- Bullets: ${handoff.bullets.join(' | ') || 'none'}
- Proof points: ${handoff.proof_points.join(' | ') || 'none'}
- Next move: ${handoff.next_move}
- Starter prompt: ${handoff.starter_prompt}
- Confidence: ${handoff.confidence.toFixed(2)}

OBLIGATION FACTS
- Overdue amount: ${formatDigestMoney(handoff.obligation_facts.overdue_amount, obligationCurrency)}
- Fixed obligations amount: ${formatDigestMoney(handoff.obligation_facts.fixed_obligations_amount, obligationCurrency)}
- Obligation count: ${handoff.obligation_facts.obligation_count}
- Obligations available: ${handoff.obligation_facts.obligations_available}
- Obligations covered: ${handoff.obligation_facts.obligations_covered}

SPEND FACTS
- Current week spend: ${formatDigestMoney(handoff.spend_facts.current_week_spend, spendCurrency)}
- Previous week spend: ${formatDigestMoney(handoff.spend_facts.previous_week_spend, spendCurrency)}
- Current week income: ${formatDigestMoney(handoff.spend_facts.current_week_income, spendCurrency)}
- Previous week income: ${formatDigestMoney(handoff.spend_facts.previous_week_income, spendCurrency)}
- Week-over-week spend delta: ${weeklyDeltaPct}
- Weekend spend ratio: ${formatDigestPct(handoff.spend_facts.weekend_spend_ratio)}
- Late-week spend ratio: ${formatDigestPct(handoff.spend_facts.late_week_spend_ratio)}
- Top category: ${handoff.spend_facts.top_category || 'none'}
- Largest increase category: ${handoff.spend_facts.largest_increase_category || 'none'}
- Largest increase amount: ${formatDigestMoney(handoff.spend_facts.largest_increase_amount, spendCurrency)}
- Largest expense: ${handoff.spend_facts.largest_expense_label || 'none'} at ${formatDigestMoney(handoff.spend_facts.largest_expense_amount, spendCurrency)}
- Essentials delta: ${formatDigestMoney(Math.abs(handoff.spend_facts.essentials_delta), spendCurrency)} (${handoff.spend_facts.essentials_delta >= 0 ? 'up' : 'down'})
- Discretionary delta: ${formatDigestMoney(Math.abs(handoff.spend_facts.discretionary_delta), spendCurrency)} (${handoff.spend_facts.discretionary_delta >= 0 ? 'up' : 'down'})

DIGEST REPLY CONTRACT
- Your job is to sound like a natural assistant who already understands this week, not a system that keeps re-reading a report.
- Move the conversation forward. The digest is background context, not a script to repeat.
- Be precise, not vague. When a number, category, day, or merchant answers the question, name the real one from the digest facts (for example "$240 on weekends, 58% of the week"), not a soft gesture like "a bit more than usual." Concrete beats generic every time.
- Every reply must add something the user has not already heard in this conversation: a new figure, a cause, a consequence, a tradeoff, or a specific next step. Never answer a follow-up by restating an earlier point in different words.
- If the user asks about something you already covered, go one level deeper instead of repeating: break the number down, give the cause behind the cause, or turn it into a concrete action. Repeating the same point is a failure even if the wording is fresh.
- Do not reuse the same opening sentence or replay the same headline, overdue amount, and spend comparison across consecutive turns unless the user explicitly asks for a recap. Track how you opened your last reply and start differently.
- Do not keep starting replies with phrases like "This week is under pressure" or "This week reads as...".
- For the initial digest handoff turn:
  1) explain the situation naturally
  2) name the main cause
  3) support it with 2-3 concrete facts, using the real numbers from the digest
  4) explain what it means for them and what matters most now
  5) end with a natural invitation to keep talking about this week
- For digest follow-ups:
  1) answer the user's actual question first, directly
  2) speak conversationally, as if this is an ongoing exchange
  3) back the answer with the specific figure, category, or day that proves it — precision is the priority, not brevity
  4) then add one fresh angle: an implication, a tradeoff, an option, or a next step that has not come up yet
  5) vary your wording and sentence openings so consecutive replies never sound templated
- When the user asks "why?", explain in plain steps: the cause, the evidence (with the real number), what it means for them, and what they can do about it.
- If the user asks for clarification like "what do you mean?" or "why again?", explain the last idea in simpler language and with a concrete example, instead of replaying the full digest summary.
- If the user asks for prevention or future guidance, convert the digest into 2-3 specific behaviors for the next week or cycle.
- If the user asks a broad follow-up like "any other advice?" while the digest is active, stay inside this week's situation and offer one or two specific angles that were not already stated.
- If the user asks for line-item detail that the digest does not contain, say what the digest does confirm, then give the next best action.
- If the user expresses gratitude or emotion, reply briefly and naturally. Do not use corporate helper phrases like "I am here to support your financial well-being."
- Do not jump to generic savings-goal advice unless the user clearly changes topic or asks for broader planning.
- For short follow-ups like "why?", "which bill?", "what can wait?", or "am I doing better?", assume the user means this digest unless the message clearly changes topic.
- Avoid sounding like a report summary, diagnosis template, or scripted coaching bot.`
}
