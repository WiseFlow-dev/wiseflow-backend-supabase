export type BudgetLockContext = {
  totalBudgets: number
  activeBudgets: any[]
  overlappingBudgets: any[]
  lockedCategoryIds: Set<string>
  lockedCategoryKeys: Set<string>
}

export type BuildBudgetLockContextInput = {
  budgets: any[] | null | undefined
  windowStartISO: string
  windowEndISO: string
  categoryNameById?: Map<string, string> | null
}

export function categoryLookupKeys(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const raw = value.trim().toLowerCase()
  if (!raw) return []
  const slug = raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const compact = raw.replace(/[^a-z0-9]+/g, ' ').trim()
  return Array.from(new Set([raw, slug, compact].filter((k) => k.length > 0)))
}

export function categoryLookupKeysFromBudgetName(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const raw = value.trim()
  if (!raw) return []

  const cleaned = raw
    .replace(/\b(budget|budgets|cap|limit|monthly|weekly|daily|yearly|global|wallet)\b/gi, ' ')
    .replace(/[:\-_/|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const tokens = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0)

  const phraseFragments: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    phraseFragments.push(tokens[i])
    for (let len = 2; len <= 4 && i + len <= tokens.length; len++) {
      phraseFragments.push(tokens.slice(i, i + len).join(' '))
    }
  }

  const keys = [
    ...categoryLookupKeys(raw),
    ...categoryLookupKeys(cleaned),
    ...phraseFragments.flatMap((frag) => categoryLookupKeys(frag)),
  ]
  return Array.from(new Set(keys.filter((k) => k.length > 0)))
}

export function getBudgetLinkedCategoryName(budget: any): string {
  const rel = budget?.categories
  if (rel && typeof rel === 'object' && !Array.isArray(rel) && typeof rel.name === 'string') {
    return rel.name.trim()
  }
  if (Array.isArray(rel)) {
    const row = rel.find((r: any) => typeof r?.name === 'string')
    if (row?.name) return String(row.name).trim()
  }
  return ''
}

export function summarizeBudgetForLog(b: any): string {
  const name = String(b?.name || '').trim() || '(no-name)'
  const categoryId = typeof b?.category_id === 'string' ? b.category_id.trim() : ''
  const categoryName = getBudgetLinkedCategoryName(b) || '(no-category-name)'
  const start = typeof b?.start_date === 'string' ? b.start_date : ''
  const end = typeof b?.end_date === 'string' ? b.end_date : ''
  const walletId = typeof b?.wallet_id === 'string' ? b.wallet_id : 'GLOBAL'
  const active = b?.is_active === false ? 'inactive' : 'active'
  return `${name} | catId=${categoryId || '-'} | catName=${categoryName} | start=${start || '-'} | end=${end || '-'} | wallet=${walletId} | ${active}`
}

export function dateLikeToYmd(value: unknown): string | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const d = new Date(value > 1e12 ? value : value * 1000)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }

  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{13}$/.test(s)) {
    const ms = Number(s)
    if (!Number.isFinite(ms) || ms <= 0) return null
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }
  if (/^\d{10}$/.test(s)) {
    const sec = Number(s)
    if (!Number.isFinite(sec) || sec <= 0) return null
    const d = new Date(sec * 1000)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  }

  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

export function isBudgetOverlappingWindow(
  budget: any,
  windowStartISO: string,
  windowEndISO: string
): boolean {
  if (!budget || budget?.is_active === false) return false
  const startDate = dateLikeToYmd(budget?.start_date)
  const endDate = dateLikeToYmd(budget?.end_date)

  // Be conservative: if date parsing fails, keep budget eligible for dedupe.
  if (startDate && startDate > windowEndISO) return false
  if (endDate && endDate < windowStartISO) return false
  return true
}

export function getActiveBudgetCategoryIds(budgets: any[]): Set<string> {
  const ids = new Set<string>()
  const rows = Array.isArray(budgets) ? budgets : []
  for (const budget of rows) {
    if (!budget || budget?.is_active === false) continue
    const categoryId = typeof budget?.category_id === 'string' ? budget.category_id.trim() : ''
    if (!categoryId) continue
    ids.add(categoryId)
  }
  return ids
}

export function buildBudgetLockContext(input: BuildBudgetLockContextInput): BudgetLockContext {
  const allBudgets = Array.isArray(input.budgets) ? input.budgets : []
  const activeBudgets = allBudgets.filter((b: any) => b && b?.is_active !== false)
  const overlappingBudgets = activeBudgets.filter((b: any) =>
    isBudgetOverlappingWindow(b, input.windowStartISO, input.windowEndISO)
  )

  const lockedCategoryIds = getActiveBudgetCategoryIds(overlappingBudgets)
  const lockedCategoryKeys = new Set<string>()

  for (const budget of overlappingBudgets) {
    for (const key of categoryLookupKeysFromBudgetName(budget?.name)) {
      lockedCategoryKeys.add(key)
    }
    for (const key of categoryLookupKeysFromBudgetName(getBudgetLinkedCategoryName(budget))) {
      lockedCategoryKeys.add(key)
    }
  }

  for (const categoryId of lockedCategoryIds) {
    const categoryName = input.categoryNameById?.get(categoryId)
    if (!categoryName) continue
    for (const key of categoryLookupKeys(categoryName)) {
      lockedCategoryKeys.add(key)
    }
  }

  return {
    totalBudgets: allBudgets.length,
    activeBudgets,
    overlappingBudgets,
    lockedCategoryIds,
    lockedCategoryKeys,
  }
}
