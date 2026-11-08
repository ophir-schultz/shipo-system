// How a legacy Zenventory list is matched to the order number the
// operator typed.
//
// The measured legacy GET /customerorders returns open orders only
// (completed: false). A shipped or fully picked order is left off that
// list. That is not the same as a failed read, and it is not proof the
// number was never an order. Matching stays exact after trimming and
// case-folding, plus the documented "number - client" suffix. A
// substring of some other order is not a match.

export type LegacyMatch =
  | { kind: 'unreadable' }
  | { kind: 'none'; ordersSeen: number }
  | { kind: 'many'; ordersSeen: number }
  | { kind: 'one'; order: Record<string, unknown>; ordersSeen: number }

const NUMBER_KEYS = ['ordernumber', 'orderNumber', 'order_number', 'customerordernumber', 'customerOrderNumber'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function legacyOrderNumber(order: Record<string, unknown>): string {
  for (const key of NUMBER_KEYS) {
    const value = text(order[key])
    if (value) return value
  }
  const nested = asRecord(order.order)
  if (!nested) return ''
  for (const key of NUMBER_KEYS) {
    const value = text(nested[key])
    if (value) return value
  }
  return ''
}

export function legacyOrderId(order: Record<string, unknown>): string | null {
  for (const key of ['customerorderid', 'customerOrderId', 'id'] as const) {
    const value = order[key]
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return value.trim()
  }
  return null
}

function orderRows(body: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(body)) {
    return body.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
  }
  const record = asRecord(body)
  if (!record) return null
  for (const key of ['customerorders', 'customerOrders', 'orders', 'shippingorders', 'shippingOrders']) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    }
  }
  if (legacyOrderNumber(record)) return [record]
  return null
}

function sameOrder(stored: string, wanted: string): boolean {
  const left = stored.trim().toLowerCase().replace(/^#/, '')
  const right = wanted.trim().toLowerCase().replace(/^#/, '')
  if (!left || !right) return false
  if (left === right) return true
  const head = left.split(' - ')[0]?.trim()
  return head === right
}

export function matchLegacyOrders(body: unknown, orderRef: string): LegacyMatch {
  const rows = orderRows(body)
  if (!rows) return { kind: 'unreadable' }
  const matched = rows.filter((order) => sameOrder(legacyOrderNumber(order), orderRef))
  if (matched.length === 1) return { kind: 'one', order: matched[0], ordersSeen: rows.length }
  if (matched.length > 1) return { kind: 'many', ordersSeen: rows.length }
  return { kind: 'none', ordersSeen: rows.length }
}

export function legacyMissReason(orderRef: string, customer: LegacyMatch, shipping: LegacyMatch | null): string {
  if (customer.kind === 'many' || shipping?.kind === 'many') {
    return `More than one Zenventory order matches ${orderRef}. Nothing was loaded and nothing was billed.`
  }
  if (customer.kind === 'unreadable' && (!shipping || shipping.kind === 'unreadable')) {
    return 'The legacy order list came back but its records could not be read. This is not a finding that the order is absent. Nothing was billed or stored.'
  }
  const openCount = customer.kind === 'none' ? customer.ordersSeen : 0
  const shipCount = shipping?.kind === 'none' ? shipping.ordersSeen : 0
  return `The legacy open-order list was read (${openCount} orders) and did not include ${orderRef}. `
    + `That list is open orders only; a completed or fully picked order is left off it. `
    + `A shipping-order read ${shipping ? `saw ${shipCount} orders and also did not include it` : 'was not used'}. `
    + `Line SKU, quantity, and picked quantity were not in the read. Nothing was billed or stored.`
}
