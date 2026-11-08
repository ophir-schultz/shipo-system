// What /losses may say about a recorded shipping charge.
//
// The bars on that page are the rate-card shortfall: stored client_rate
// below stored actual_cost. A recorded shipping charge is a different fact.
// It lives on order_charges, and the only allocation this file treats as
// proved is charge_key `shipment:<shipstation_shipment_id>` for charge_type
// shipping on the same client. Order number is not that key: one order can
// have several parcels and several shipping charges.
//
// A missing charge is not $0. An unreadable amount is not $0. Another
// client's charge is not used. Manual freight and adjustments are not read
// here, and this file does not invent a number for them.

import { priceOf } from '@/lib/billing/unpriced'

export const COVERAGE_CHUNK = 150

export type CoverageKind =
  | 'recorded'
  | 'no_shipment_id'
  | 'no_order'
  | 'order_without_shipping_charge'
  | 'ambiguous_order'
  | 'ambiguous_charges'
  | 'charge_unpriced'
  | 'cost_unknown'
  | 'client_mismatch'
  | 'charges_unreadable'
  | 'orders_unreadable'

export interface LossParcel {
  clientId: string | null
  orderNumber: string | null
  shipstationShipmentId: unknown
  carrierCost: unknown
}

export interface ShippingChargeRow {
  client_id: string | null
  charge_key: string | null
  charge_type: string | null
  amount: unknown
}

export interface CoverageOrder {
  client_id: string | null
  order_key: string | null
}

export interface Coverage {
  kind: CoverageKind
  recordedAmount: number | null
  carrierCost: number | null
  recordedMinusCost: number | null
}

export interface CoverageReads {
  charges: 'ok' | 'failed'
  orders: 'ok' | 'failed'
}

function unknown(kind: CoverageKind, carrierCost: number | null = null): Coverage {
  return { kind, recordedAmount: null, carrierCost, recordedMinusCost: null }
}

/** `shipment:<digits>`, or null when the id cannot be proved. */
export function shippingChargeKey(id: unknown): string | null {
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id) || id < 0) return null
    return `shipment:${id}`
  }
  if (typeof id === 'string' && /^\d+$/.test(id.trim())) return `shipment:${id.trim()}`
  return null
}

/** The same spelling orders.order_key uses: trimmed, upper case. */
export function orderKeyOf(orderNumber: unknown): string | null {
  if (typeof orderNumber !== 'string') return null
  const key = orderNumber.trim().toUpperCase()
  return key === '' ? null : key
}

export function centsBetween(amount: number, cost: number): number {
  return (Math.round(amount * 100) - Math.round(cost * 100)) / 100
}

/**
 * Width of one bar as a percent of the largest amount in the group.
 *
 * The zone panel used to divide by the first label after an A–Z sort, so
 * Zone 2's small shortfall made every later zone a full bar.
 */
export function barShare(amount: number, max: number): number {
  if (!(max > 0) || !(amount > 0)) return 0
  return Math.min(100, (amount / max) * 100)
}

export function classifyParcel(
  parcel: LossParcel,
  charges: readonly ShippingChargeRow[],
  orders: readonly CoverageOrder[],
  reads: CoverageReads,
): Coverage {
  if (reads.charges === 'failed') return unknown('charges_unreadable')

  const key = shippingChargeKey(parcel.shipstationShipmentId)
  if (key == null) return unknown('no_shipment_id')

  const sameKey = charges.filter((row) =>
    row.charge_type === 'shipping' && row.charge_key === key)
  if (sameKey.length > 1) return unknown('ambiguous_charges')
  if (sameKey.length === 1) {
    const row = sameKey[0]
    if (row.client_id == null || row.client_id !== parcel.clientId) {
      return unknown('client_mismatch')
    }
    const amount = priceOf(row.amount)
    if (amount === null) return unknown('charge_unpriced')
    const cost = priceOf(parcel.carrierCost)
    if (cost === null) return unknown('cost_unknown')
    return {
      kind: 'recorded',
      recordedAmount: amount,
      carrierCost: cost,
      recordedMinusCost: centsBetween(amount, cost),
    }
  }

  if (reads.orders === 'failed') return unknown('orders_unreadable')
  const orderKey = orderKeyOf(parcel.orderNumber)
  if (orderKey == null || parcel.clientId == null) return unknown('no_order')
  const matched = orders.filter((row) =>
    row.client_id === parcel.clientId && row.order_key === orderKey)
  if (matched.length > 1) return unknown('ambiguous_order')
  if (matched.length === 1) return unknown('order_without_shipping_charge')
  return unknown('no_order')
}

export interface CoverageSummary {
  /** Parcels with one proved shipping charge and a readable carrier cost. */
  matched: number
  /**
   * Sum of recorded charge minus carrier cost over those parcels.
   * Null when none matched, including when the list is empty. Zero is only
   * returned when at least one matched parcel differs by zero.
   */
  recordedMinusCost: number | null
  unknown: number
  reasons: Partial<Record<Exclude<CoverageKind, 'recorded'>, number>>
}

export function summarizeCoverage(rows: readonly Coverage[]): CoverageSummary {
  let matched = 0
  let cents = 0
  let unknownCount = 0
  const reasons: CoverageSummary['reasons'] = {}
  for (const row of rows) {
    if (row.kind === 'recorded' && row.recordedMinusCost != null) {
      matched++
      cents += Math.round(row.recordedMinusCost * 100)
      continue
    }
    unknownCount++
    const kind = row.kind === 'recorded' ? 'cost_unknown' : row.kind
    reasons[kind] = (reasons[kind] ?? 0) + 1
  }
  return {
    matched,
    recordedMinusCost: matched === 0 ? null : cents / 100,
    unknown: unknownCount,
    reasons,
  }
}

export const COVERAGE_REASON: Record<Exclude<CoverageKind, 'recorded'>, string> = {
  no_shipment_id: 'No ShipStation shipment id, so a shipping charge cannot be tied to this parcel.',
  no_order: 'No order for this client and order number.',
  order_without_shipping_charge: 'An order exists, and no shipping charge is keyed to this parcel.',
  ambiguous_order: 'More than one order matches this client and order number.',
  ambiguous_charges: 'More than one shipping charge matches this parcel.',
  charge_unpriced: 'The matching shipping charge has no amount. That is not $0.',
  cost_unknown: 'Carrier cost is unreadable, so the difference is unknown.',
  client_mismatch: 'The shipping charge for this parcel belongs to a different client.',
  charges_unreadable: 'Shipping charges could not be read. Nothing was treated as $0.',
  orders_unreadable: 'Orders could not be read, so a missing charge was not called “no order”.',
}

export async function readIdChunks<T>(
  ids: readonly string[],
  read: (chunk: readonly string[]) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const unique = [...new Set(ids)]
  const rows: T[] = []
  for (let i = 0; i < unique.length; i += COVERAGE_CHUNK) {
    const result = await read(unique.slice(i, i + COVERAGE_CHUNK))
    if (result.error) return { rows: [], error: result.error.message }
    rows.push(...(result.data ?? []))
  }
  return { rows, error: null }
}
