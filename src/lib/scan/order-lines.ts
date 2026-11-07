// A customer order as the scan station may show it.
//
// Built from a Zenventory API 2.0 read. A missing serialized flag or a
// missing quantity stays null. Neither is guessed, and a null never
// counts as "this line is done".

export interface CustomerOrderLine {
  sku: string
  serialized: boolean | null
  requiredQty: number | null
  /** Units already picked on the order line. Null when the read did not say. */
  pickedQty: number | null
}

export interface OrderLineRead {
  ok: true
  orderNumber: string
  lines: CustomerOrderLine[]
}

export interface OrderLineMiss {
  ok: false
  reason: string
}

const SERIAL_KEYS = ['serialized', 'isSerialized', 'requiresSerial', 'serialTracking'] as const
const QTY_KEYS = ['quantityOrdered', 'orderquantity', 'quantity', 'allocatedquantity', 'allocatedQuantity'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function flag(record: Record<string, unknown>): boolean | null {
  for (const key of SERIAL_KEYS) {
    if (!(key in record)) continue
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return null
  }
  return null
}

function pickedQty(record: Record<string, unknown>): number | null {
  for (const key of ['pickedQuantity', 'pickedquantity'] as const) {
    if (!(key in record) || record[key] === null || record[key] === '') continue
    const n = typeof record[key] === 'number' ? record[key] : Number(record[key])
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
    return null
  }
  return null
}

function qty(record: Record<string, unknown>): number | null {
  for (const key of QTY_KEYS) {
    if (record[key] === undefined || record[key] === null || record[key] === '') continue
    const n = typeof record[key] === 'number' ? record[key] : Number(record[key])
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n
    return null
  }
  return null
}

function ordersIn(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
  }
  const record = asRecord(body)
  if (!record) return []
  for (const key of ['customerOrders', 'orders', 'customerorders']) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    }
  }
  const number = firstText(record, ['orderNumber', 'order_number', 'ordernumber'])
  return number ? [record] : []
}

function lineRows(order: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ['items', 'orderItems', 'orderitems', 'lineItems']) {
    if (Array.isArray(order[key])) {
      return (order[key] as unknown[]).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    }
  }
  return []
}

function skuOf(row: Record<string, unknown>): string | null {
  const direct = firstText(row, ['sku'])
  if (direct) return direct
  const nested = asRecord(row.item) ?? asRecord(row.itemmaster)
  return nested ? firstText(nested, ['sku']) : null
}

export function readCustomerOrder(body: unknown, orderRef: string): OrderLineRead | OrderLineMiss {
  const want = orderRef.trim()
  if (!want) return { ok: false, reason: 'Enter an order reference.' }
  const orders = ordersIn(body)
  const exact = orders.filter((order) => {
    const number = firstText(order, ['orderNumber', 'order_number', 'ordernumber'])
    return number === want || number?.toLowerCase() === want.toLowerCase()
  })
  const strict = exact.filter((order) => firstText(order, ['orderNumber', 'order_number', 'ordernumber']) === want)
  const matched = strict.length > 0 ? strict : exact
  if (matched.length > 1) return { ok: false, reason: `More than one order matches ${want}.` }
  if (matched.length === 0) return { ok: false, reason: `No order matches ${want}.` }
  const order = matched[0]
  const orderNumber = firstText(order, ['orderNumber', 'order_number', 'ordernumber']) ?? want
  const lines: CustomerOrderLine[] = []
  for (const row of lineRows(order)) {
    const sku = skuOf(row)
    if (!sku) continue
    lines.push({ sku, serialized: flag(row), requiredQty: qty(row), pickedQty: pickedQty(row) })
  }
  return { ok: true, orderNumber, lines }
}

export interface CoveredLine extends CustomerOrderLine {
  scanned: number
  lineComplete: boolean
}

export function scanCoverage(
  lines: readonly CustomerOrderLine[],
  scanned: readonly { sku: string; count: number }[],
): { lines: CoveredLine[]; allSerializedComplete: boolean } {
  const counts = new Map<string, number>()
  for (const row of scanned) {
    const key = row.sku.trim().toLowerCase()
    if (!key || !Number.isFinite(row.count) || row.count < 0) continue
    counts.set(key, (counts.get(key) ?? 0) + row.count)
  }
  const covered = lines.map((line) => {
    const count = counts.get(line.sku.trim().toLowerCase()) ?? 0
    const lineComplete = line.serialized === true
      && line.requiredQty != null
      && line.requiredQty > 0
      && count === line.requiredQty
    return { ...line, scanned: count, lineComplete }
  })
  const serialized = covered.filter((line) => line.serialized === true)
  const blocked = covered.some((line) => line.serialized === null)
    || serialized.some((line) => line.requiredQty == null || line.requiredQty <= 0 || line.scanned !== line.requiredQty)
  return {
    lines: covered,
    allSerializedComplete: serialized.length > 0 && !blocked,
  }
}

export function queueDecision(input: {
  loaded: OrderLineRead | OrderLineMiss
  sku: string
  serialCount: number
}): { record: boolean; queue: boolean; reason: string } {
  if (!input.loaded.ok) {
    return {
      record: true,
      queue: false,
      reason: `${input.loaded.reason} The scan can be stored, but it is not queued for a pick.`,
    }
  }
  const line = input.loaded.lines.find((row) => row.sku.trim().toLowerCase() === input.sku.trim().toLowerCase())
  if (!line) {
    return {
      record: true,
      queue: false,
      reason: `${input.sku} is not a line on order ${input.loaded.orderNumber}. The scan is not queued for a pick.`,
    }
  }
  if (line.serialized !== true || line.requiredQty == null || line.requiredQty <= 0) {
    return {
      record: true,
      queue: false,
      reason: `${line.sku} has no verified serialized quantity. The scan is not queued for a pick.`,
    }
  }
  if (input.serialCount > line.requiredQty) {
    return {
      record: false,
      queue: false,
      reason: `${line.sku} requires ${line.requiredQty}. ${input.serialCount} serials were scanned. Nothing was recorded and nothing was sent.`,
    }
  }
  return { record: true, queue: true, reason: '' }
}
