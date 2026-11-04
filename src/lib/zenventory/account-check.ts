// A read-only look at one client's Zenventory account. No sync, no writes.
// Callers pass the key and secret in; this file never logs them and strips
// them out of any error text before that text leaves.

const PAGE_CAP = 20

export interface ZenventoryCheckResult {
  ok: boolean
  orderCount: number | null
  latestOrderDate: string | null
  inventoryCount: number | null
  error: string | null
}

export function sevenDaysAgo(now: Date): string {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
}

export function orderStamp(order: unknown): string | null {
  if (!order || typeof order !== 'object') return null
  const row = order as Record<string, unknown>
  for (const key of ['orderedDate', 'orderDate', 'order_date']) {
    const value = row[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || Number.isNaN(Date.parse(trimmed))) continue
    return trimmed
  }
  return null
}

/** Orders whose date is on or after `sinceIso`, and the latest of those dates. */
export function summarizeOrders(
  orders: readonly unknown[],
  sinceIso: string,
): { count: number; latestOrderDate: string | null } {
  const since = Date.parse(sinceIso)
  let count = 0
  let latestOrderDate: string | null = null
  let latestMs = Number.NEGATIVE_INFINITY
  for (const order of orders) {
    const stamp = orderStamp(order)
    if (!stamp) continue
    const ms = Date.parse(stamp)
    if (Number.isNaN(since) || ms < since) continue
    count += 1
    if (ms >= latestMs) {
      latestMs = ms
      latestOrderDate = stamp
    }
  }
  return { count, latestOrderDate }
}

export function ordersOnPage(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const row = body as Record<string, unknown>
  const list = row.customerOrders ?? row.orders
  return Array.isArray(list) ? list : []
}

export function totalPagesOf(body: unknown): number {
  if (!body || typeof body !== 'object') return 1
  const meta = (body as Record<string, unknown>).meta
  if (!meta || typeof meta !== 'object') return 1
  const pages = (meta as Record<string, unknown>).totalPages
  return typeof pages === 'number' && pages >= 1 ? pages : 1
}

/** meta.count is the full result size. Without it, the page length is all we have. */
export function inventoryCountOf(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const row = body as Record<string, unknown>
  const meta = row.meta
  if (meta && typeof meta === 'object') {
    const count = (meta as Record<string, unknown>).count
    if (typeof count === 'number' && Number.isFinite(count)) return count
  }
  const list = row.inventory ?? row.items
  return Array.isArray(list) ? list.length : null
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  let out = message
  for (const secret of secrets) {
    const value = secret.trim()
    if (value.length < 4) continue
    out = out.split(value).join('[redacted]')
  }
  return out
}

function failureText(err: unknown, secrets: readonly string[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactSecrets(raw, secrets)
}

export async function runZenventoryCheck(args: {
  now?: Date
  secrets: readonly string[]
  fetchOrders: (page: number, sinceIso: string) => Promise<unknown>
  fetchInventory: () => Promise<unknown>
}): Promise<ZenventoryCheckResult> {
  const sinceIso = sevenDaysAgo(args.now ?? new Date())
  const errors: string[] = []

  let orderCount: number | null = null
  let latestOrderDate: string | null = null
  try {
    const collected: unknown[] = []
    let page = 1
    let totalPages = 1
    while (page <= totalPages && page <= PAGE_CAP) {
      const body = await args.fetchOrders(page, sinceIso)
      collected.push(...ordersOnPage(body))
      totalPages = totalPagesOf(body)
      page += 1
    }
    const summary = summarizeOrders(collected, sinceIso)
    orderCount = summary.count
    latestOrderDate = summary.latestOrderDate
    if (totalPages > PAGE_CAP) {
      errors.push(`Order list stopped after ${PAGE_CAP} pages. The 7-day count may be short.`)
    }
  } catch (err) {
    errors.push(`Orders: ${failureText(err, args.secrets)}`)
  }

  let inventoryCount: number | null = null
  try {
    inventoryCount = inventoryCountOf(await args.fetchInventory())
    if (inventoryCount === null) errors.push('Inventory response did not include a count.')
  } catch (err) {
    errors.push(`Inventory: ${failureText(err, args.secrets)}`)
  }

  return {
    ok: errors.length === 0,
    orderCount,
    latestOrderDate,
    inventoryCount,
    error: errors.length === 0 ? null : errors.join(' '),
  }
}
