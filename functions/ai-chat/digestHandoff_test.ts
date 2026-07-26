import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  buildDigestContextSummary,
  buildDigestPromptBlock,
  detectDigestInteractionMode,
  evaluateDigestHandoffTrust,
  normalizeDigestHandoff,
} from './digestHandoff.ts'

const rawHandoff = {
  handoff_version: 'v1',
  source: 'weekly_digest',
  digest_type: 'pressure',
  scenario_code: 'overdue_pressure',
  week_start: '2026-03-05',
  week_end: '2026-03-10',
  headline: 'What is overdue is still pulling this week down.',
  summary: 'You spent less than last week overall, but overdue obligations are still creating pressure.',
  bullets: [
    'Spent $429 vs $1,132 last week.',
    '$80 in overdue obligations is still open.',
    'Shopping added $65 more than last week.',
  ],
  next_move: 'Clear overdue obligations before adding new spending.',
  confidence: 0.86,
  primary_driver: 'overdue_obligations',
  secondary_driver: 'shopping_drift',
  proof_points: [
    'Spent $429 vs $1,132 last week.',
    '$80 in overdue obligations is still open.',
  ],
  starter_prompt: 'Walk me through why this week is under pressure and what I should do first.',
  obligation_facts: {
    currency: 'USD',
    overdue_amount: 80,
    fixed_obligations_amount: 320,
    obligation_count: 3,
    obligations_available: true,
    obligations_covered: false,
  },
  spend_facts: {
    currency: 'USD',
    current_week_spend: 429,
    previous_week_spend: 1132,
    current_week_income: 0,
    previous_week_income: 1200,
    week_over_week_spend_delta_pct: -0.621,
    weekend_spend_ratio: 0.38,
    late_week_spend_ratio: 0.41,
    top_category: 'Shopping',
    largest_increase_category: 'Shopping',
    largest_increase_amount: 65,
    largest_expense_amount: 220,
    largest_expense_label: 'Laptop',
    essentials_delta: -69,
    discretionary_delta: 65,
  },
}

Deno.test('normalizeDigestHandoff accepts valid v1 weekly digest payload', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)

  assert(handoff)
  assertEquals(handoff.scenario_code, 'overdue_pressure')
  assertEquals(handoff.digest_type, 'pressure')
  assertEquals(handoff.obligation_facts.overdue_amount, 80)
  assertEquals(handoff.spend_facts.current_week_spend, 429)
})

Deno.test('detectDigestInteractionMode marks preset handoff turn as initial', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const mode = detectDigestInteractionMode({
    message: handoff.starter_prompt,
    inputMode: 'preset',
    requestDigestHandoff: handoff,
  })

  assertEquals(mode, 'initial_handoff')
})

Deno.test('detectDigestInteractionMode treats short why follow-ups as digest follow-ups', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const mode = detectDigestInteractionMode({
    message: 'why?',
    inputMode: 'manual',
    activeDigestHandoff: handoff,
  })

  assertEquals(mode, 'digest_follow_up')
})

Deno.test('detectDigestInteractionMode treats natural clarification follow-ups as digest follow-ups', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const mode = detectDigestInteractionMode({
    message: 'What do you mean by this?',
    inputMode: 'manual',
    activeDigestHandoff: handoff,
  })

  assertEquals(mode, 'digest_follow_up')
})

Deno.test('detectDigestInteractionMode treats broad advice follow-ups as digest follow-ups while digest is active', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const mode = detectDigestInteractionMode({
    message: 'Any other advice?',
    inputMode: 'manual',
    activeDigestHandoff: handoff,
  })

  assertEquals(mode, 'digest_follow_up')
})

Deno.test('detectDigestInteractionMode does not force unrelated short questions into digest follow-up', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const mode = detectDigestInteractionMode({
    message: 'can i transfer?',
    inputMode: 'manual',
    activeDigestHandoff: handoff,
  })

  assertEquals(mode, 'general_with_digest')
})

Deno.test('evaluateDigestHandoffTrust only accepts preset starter-prompt handoff turns', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const trusted = evaluateDigestHandoffTrust({
    requestDigestHandoff: handoff,
    message: handoff.starter_prompt,
    inputMode: 'preset',
  })
  assertEquals(trusted, { trusted: true, reason: 'ok' })

  const rejected = evaluateDigestHandoffTrust({
    requestDigestHandoff: handoff,
    message: handoff.starter_prompt,
    inputMode: 'manual',
  })
  assertEquals(rejected, { trusted: false, reason: 'input_mode_not_preset' })
})

Deno.test('buildDigestContextSummary keeps digest summary compact', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  assertEquals(
    buildDigestContextSummary(handoff),
    'Weekly digest | type=pressure | scenario=overdue_pressure | week=2026-03-05..2026-03-10',
  )
})

Deno.test('buildDigestPromptBlock includes digest facts and first-turn contract', () => {
  const handoff = normalizeDigestHandoff(rawHandoff)
  assert(handoff)

  const promptBlock = buildDigestPromptBlock({
    activeDigestHandoff: handoff,
    requestDigestHandoff: handoff,
    message: handoff.starter_prompt,
    inputMode: 'preset',
  })

  assertMatch(promptBlock, /Digest interaction mode: initial_handoff/)
  assertMatch(promptBlock, /Week window: 2026-03-05 to 2026-03-10/)
  assertMatch(promptBlock, /Overdue amount: \$80/)
  assertMatch(promptBlock, /Current week spend: \$429/)
  assertMatch(promptBlock, /For the initial digest handoff turn/)
  assertMatch(promptBlock, /Move the conversation forward\. The digest is background context, not a script to repeat\./)
  assertMatch(promptBlock, /sound like a natural assistant who already understands this week/)
  assertMatch(promptBlock, /answer the user's actual question first, directly/)
  // Guard the precise + additive contract.
  assertMatch(promptBlock, /Be precise, not vague\./)
  assertMatch(promptBlock, /Every reply must add something the user has not already heard/)
  assertMatch(promptBlock, /go one level deeper instead of repeating/)
  assertMatch(promptBlock, /Do not keep starting replies with phrases like "This week is under pressure"/)
  assertMatch(promptBlock, /Do not use corporate helper phrases like "I am here to support your financial well-being\."/)
  assertMatch(promptBlock, /Do not jump to generic savings-goal advice/)
})
