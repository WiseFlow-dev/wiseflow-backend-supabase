import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { getServiceSupabaseClient } from './_shared/supabaseClient.ts'
import { log, logError } from './_shared/logger.ts'

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void
}

const DEFAULT_PER_PAGE = 100
const DEFAULT_PAGE_BUDGET = 5
const DEFAULT_POLICY_BATCH_SIZE = 25
const DEFAULT_MAX_CHAIN_DEPTH = 24
const COOLDOWN_WINDOW_MS = 10 * 60 * 1000

type CronRequestBody = {
  startPage?: unknown
  perPage?: unknown
  pageBudget?: unknown
  policyBatchSize?: unknown
  chainDepth?: unknown
  maxChainDepth?: unknown
  includeProcessed?: unknown
}

type ProcessedUser = {
  user_id: string
  skipped: boolean
  reason?: string
  created?: string[]
  error?: string
}

type PolicyEvalBatchUser = {
  user_id: string
  period_key?: string | null
  created?: string[]
  error?: string
}

type PolicyEvalBatchResponse = {
  ok?: boolean
  users?: PolicyEvalBatchUser[]
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, X-Cron-Secret, X-Run-As'
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } })
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  const min = options.min ?? 1
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, Math.max(min, parsed))
}

function parseNonNegativeInt(
  value: unknown,
  fallback: number,
  options: { max?: number } = {},
): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  return Math.min(max, parsed)
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function normalizePolicyEvalUsers(
  requestedUserIds: string[],
  rawUsers: unknown,
): PolicyEvalBatchUser[] {
  const byUserId = new Map<string, PolicyEvalBatchUser>()

  if (Array.isArray(rawUsers)) {
    for (const rawUser of rawUsers) {
      const userId = String((rawUser as PolicyEvalBatchUser | undefined)?.user_id ?? '').trim()
      if (!userId || byUserId.has(userId)) continue
      const entry = rawUser as PolicyEvalBatchUser
      byUserId.set(userId, {
        user_id: userId,
        period_key: entry?.period_key ?? null,
        created: Array.isArray(entry?.created) ? entry.created : [],
        error: entry?.error ? String(entry.error) : undefined,
      })
    }
  }

  return requestedUserIds.map((userId) => {
    return byUserId.get(userId) ?? { user_id: userId, created: [], error: 'missing_batch_result' }
  })
}

async function fetchCooldownUserIds(
  supabase: any,
  userIds: string[],
  sinceIso: string,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set<string>()

  const { data, error } = await supabase
    .from('action_proposals')
    .select('user_id')
    .in('user_id', userIds)
    .gte('created_at', sinceIso)

  if (error) {
    logError('policy_eval_cron.cooldown_lookup_failed', {
      error: error.message,
      user_count: userIds.length,
    })
    return new Set<string>()
  }

  const cooldownUserIds = new Set<string>()
  for (const row of data ?? []) {
    const userId = String((row as { user_id?: unknown } | null)?.user_id ?? '').trim()
    if (userId) cooldownUserIds.add(userId)
  }
  return cooldownUserIds
}

async function invokePolicyEvalBatch(
  projectUrl: string,
  anonKey: string,
  cronSecret: string,
  userIds: string[],
): Promise<PolicyEvalBatchUser[]> {
  const response = await fetch(projectUrl + '/functions/v1/policy-eval', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
      'X-Cron-Secret': cronSecret,
    },
    body: JSON.stringify({
      userIds,
      includePerUserResults: true,
    }),
  })

  if (!response.ok) {
    logError('policy_eval_cron.batch_failed', {
      status: response.status,
      requested_user_count: userIds.length,
    })
    return userIds.map((userId) => ({
      user_id: userId,
      created: [],
      error: `http_${response.status}`,
    }))
  }

  const payload = await response.json().catch(() => null) as PolicyEvalBatchResponse | null
  return normalizePolicyEvalUsers(userIds, payload?.users)
}

async function scheduleContinuation(
  projectUrl: string,
  anonKey: string,
  cronSecret: string,
  body: Record<string, unknown>,
) {
  try {
    const response = await fetch(projectUrl + '/functions/v1/policy-eval-cron', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'X-Cron-Secret': cronSecret,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      logError('policy_eval_cron.continuation_failed', {
        status: response.status,
        body: detail.slice(0, 500),
        start_page: body.startPage,
        chain_depth: body.chainDepth,
      })
      return
    }

    log('policy_eval_cron.continuation_started', {
      start_page: body.startPage,
      chain_depth: body.chainDepth,
    })
  } catch (error) {
    logError('policy_eval_cron.continuation_error', {
      error: String(error),
      start_page: body.startPage,
      chain_depth: body.chainDepth,
    })
  }
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders() })

  try {
    const secret = Deno.env.get('WISEY_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
    const incoming = req.headers.get('X-Cron-Secret') ?? req.headers.get('x-cron-secret') ?? ''
    if (!secret || !incoming || secret !== incoming) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }

    let requestBody: CronRequestBody = {}
    try {
      requestBody = (await req.json()) as CronRequestBody
    } catch {
      requestBody = {}
    }

    const startPage = parsePositiveInt(requestBody.startPage, 1, { min: 1, max: 1_000_000 })
    const perPage = parsePositiveInt(requestBody.perPage, DEFAULT_PER_PAGE, { min: 1, max: 100 })
    const pageBudget = parsePositiveInt(requestBody.pageBudget, DEFAULT_PAGE_BUDGET, { min: 1, max: 50 })
    const policyBatchSize = parsePositiveInt(requestBody.policyBatchSize, DEFAULT_POLICY_BATCH_SIZE, { min: 1, max: 100 })
    const maxChainDepth = parseNonNegativeInt(requestBody.maxChainDepth, DEFAULT_MAX_CHAIN_DEPTH, { max: 200 })
    const chainDepth = parseNonNegativeInt(requestBody.chainDepth, 0, { max: maxChainDepth })
    const includeProcessed = parseBoolean(requestBody.includeProcessed)

    const supabase = getServiceSupabaseClient()
    const projectUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '') ?? ''
    const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    if (!projectUrl || !anon) return json({ ok: false, error: 'Missing SUPABASE_URL or ANON KEY' }, 500)

    const now = Date.now()
    const tenMinAgoISO = new Date(now - COOLDOWN_WINDOW_MS).toISOString()
    const processed: ProcessedUser[] = []
    let currentPage = startPage
    let pagesProcessed = 0
    let usersSeen = 0
    let cooldownSkipped = 0
    let submittedForEval = 0
    let failedUsers = 0
    let hasMoreUsers = false

    while (pagesProcessed < pageBudget) {
      const { data, error } = await (supabase as any).auth.admin.listUsers({ page: currentPage, perPage })
      if (error) return json({ ok: false, error: error.message }, 500)

      const batch = data?.users ?? []
      if (batch.length === 0) {
        hasMoreUsers = false
        break
      }

      hasMoreUsers = batch.length === perPage
      const userIds: string[] = batch
        .map((user: { id?: unknown }) => String(user?.id ?? '').trim())
        .filter((userId: string) => userId.length > 0)

      usersSeen += userIds.length

      const cooldownUserIds = await fetchCooldownUserIds(supabase, userIds, tenMinAgoISO)
      cooldownSkipped += cooldownUserIds.size

      if (includeProcessed) {
        for (const userId of cooldownUserIds) {
          processed.push({ user_id: userId, skipped: true, reason: 'cooldown' })
        }
      }

      const eligibleUserIds: string[] = userIds.filter((userId: string) => !cooldownUserIds.has(userId))
      submittedForEval += eligibleUserIds.length

      for (const userIdChunk of chunkArray(eligibleUserIds, policyBatchSize)) {
        const batchResults = await invokePolicyEvalBatch(projectUrl, anon, secret, userIdChunk)
        const batchFailures = batchResults.filter((entry) => Boolean(entry.error)).length
        failedUsers += batchFailures

        if (includeProcessed) {
          for (const entry of batchResults) {
            processed.push({
              user_id: entry.user_id,
              skipped: Boolean(entry.error),
              reason: entry.error ? 'policy_eval_failed' : undefined,
              created: Array.isArray(entry.created) ? entry.created : [],
              error: entry.error,
            })
          }
        }
      }

      pagesProcessed += 1
      currentPage += 1

      if (batch.length < perPage) {
        hasMoreUsers = false
        break
      }
    }

    const nextPage = hasMoreUsers ? currentPage : null
    const continuationScheduled = nextPage !== null && chainDepth < maxChainDepth

    if (continuationScheduled) {
      EdgeRuntime.waitUntil(
        scheduleContinuation(projectUrl, anon, secret, {
          startPage: nextPage,
          perPage,
          pageBudget,
          policyBatchSize,
          chainDepth: chainDepth + 1,
          maxChainDepth,
          includeProcessed: false,
        }),
      )
    }

    log('policy_eval_cron.completed', {
      start_page: startPage,
      next_page: nextPage,
      pages_processed: pagesProcessed,
      users_seen: usersSeen,
      cooldown_skipped: cooldownSkipped,
      submitted_for_eval: submittedForEval,
      failed_users: failedUsers,
      continuation_scheduled: continuationScheduled,
      chain_depth: chainDepth,
      max_chain_depth: maxChainDepth,
      per_page: perPage,
      page_budget: pageBudget,
      policy_batch_size: policyBatchSize,
    })

    return json({
      ok: true,
      startPage,
      nextPage,
      perPage,
      pageBudget,
      policyBatchSize,
      chainDepth: chainDepth,
      maxChainDepth,
      continuationScheduled,
      usersSeen,
      cooldownSkipped,
      submittedForEval,
      failedUsers,
      processed: includeProcessed ? processed : undefined,
    })
  } catch (e) {
    logError('policy_eval_cron.error', { error: String(e) })
    return json({ ok: false, error: String(e) }, 500)
  }
})
