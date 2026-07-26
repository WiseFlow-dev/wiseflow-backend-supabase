import { assertMatch, assertStringIncludes } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { buildLengthRule } from './wiseyPersona.ts'

// Phase 3: weekly-digest explanations keep a richer floor even when the user's global
// length is "short", but unrelated chat during a digest still respects short mode.

Deno.test('short + initial_handoff keeps a richer floor (ignores the 1-2 sentence cap)', () => {
  const rule = buildLengthRule('companion', 'short', 'initial_handoff')
  assertStringIncludes(rule, '4-6 sentences')
  assertMatch(rule, /precise/i)
})

Deno.test('short + digest_follow_up keeps a richer floor and forbids restating', () => {
  const rule = buildLengthRule('coach', 'short', 'digest_follow_up')
  assertStringIncludes(rule, '3-5 sentences')
  assertMatch(rule, /Never just restate an earlier answer/)
})

Deno.test('short + general_with_digest still respects short mode', () => {
  const rule = buildLengthRule('companion', 'short', 'general_with_digest')
  assertStringIncludes(rule, '1-2 short sentences maximum')
})

Deno.test('detailed variants expand the digest modes', () => {
  assertStringIncludes(buildLengthRule('companion', 'detailed', 'initial_handoff'), '6-8 sentences')
  assertStringIncludes(buildLengthRule('coach', 'detailed', 'digest_follow_up'), '5-7 sentences')
})

Deno.test('non-digest chat falls back to persona-based length', () => {
  assertStringIncludes(buildLengthRule('coach', 'normal', 'none'), '2-4 sentences')
  assertStringIncludes(buildLengthRule('companion', 'normal', 'none'), '3-5 sentences')
})
