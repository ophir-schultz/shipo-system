import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages, type PageResult } from '@/lib/db/page'
import { priceOf } from '@/lib/billing/unpriced'
import { shipmentIdFromChargeKey } from '@/lib/billing/statement-detail'
import type { StatementChargeRow } from '@/lib/billing/statement-charges'
import { pricePick } from '@/lib/pricing/engine'
import { parsePriceList } from '@/lib/pricing/parse-price-list'
import { loadRepoPriceList } from '@/lib/pricing/repo-price-lists'
import type { PriceListDocument, SkuQty } from '@/lib/pricing/types'

// Shipping on a statement used to come only from order_charges. Orcam's
// ledger rows are unpriced: that client has no shipping line on the warehouse
// rate card. Profit and Shipments already price the same parcels from the
// zone matrix, and that price is stored on shipments.client_rate. The
// statement uses that figure, which is what the client is charged. It is not
// the carrier cost and not the margin.
//
// Pick & pack is the other half. The price list (uploaded, or the repo list
// for Nayax and Orcam) prices an order. A ledger that never wrote a pick row
// was omitting it from the statement entirely.

const IN_CHUNK = 150

export function applyZonePrices(
  charges: readonly StatementChargeRow[],
  clientRateByShipmentId: ReadonlyMap<string, number | null>,
): StatementChargeRow[] {
  return charges.map((charge) => {
    if (charge.charge_type !== 'shipping') return charge
    const id = shipmentIdFromChargeKey(charge.charge_key)
    if (id === null || !clientRateByShipmentId.has(id)) return charge
    const rate = clientRateByShipmentId.get(id)
    if (rate === null || rate === undefined) return charge
    return { ...charge, amount: rate, unit_rate: rate }
  })
}

export function hasPricedPick(charges: readonly StatementChargeRow[]): boolean {
  return charges.some((charge) =>
    (charge.charge_type === 'pick' || charge.charge_type === 'pack')
    && priceOf(charge.amount) !== null)
}

/** Picked count when the sync recorded one, otherwise the quantity ordered. */
export function lineQty(ordered: unknown, picked: unknown): number | null {
  const pickedN = priceOf(picked)
  if (pickedN !== null && pickedN > 0) return pickedN
  const orderedN = priceOf(ordered)
  if (orderedN !== null && orderedN > 0) return orderedN
  return null
}

export interface PickOrder {
  orderId: string
  chargeDate: string
  lines: SkuQty[]
}

export function pickPackRows(
  orders: readonly PickOrder[],
  list: PriceListDocument | null,
): StatementChargeRow[] {
  if (!list) return []
  const rows: StatementChargeRow[] = []
  for (const order of orders) {
    if (order.lines.length === 0) continue
    const priced = pricePick(list, order.lines)
    if (priced.amount === null) continue
    const items = order.lines.reduce((sum, line) => sum + line.qty, 0)
    rows.push({
      charge_type: 'pick',
      label: 'Pick & pack',
      quantity: items,
      unit_rate: null,
      amount: priced.amount,
      is_estimate: false,
      charge_date: order.chargeDate,
      order_id: order.orderId,
      charge_key: `pickpack:${order.orderId}`,
    })
  }
  return rows
}

async function readChunked<T>(
  ids: string[],
  read: (chunk: string[]) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + IN_CHUNK))
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
  }
  return { data: rows, error: null }
}

async function priceListFor(clientId: string, clientName: string): Promise<PriceListDocument | null> {
  const uploaded = await supabaseAdmin
    .from('client_price_lists')
    .select('document')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (!uploaded.error) {
    const document = uploaded.data?.[0]?.document
    if (document) {
      const parsed = parsePriceList(document)
      if (parsed.ok) return parsed.list
    }
  } else {
    console.error('[statement] price list read failed', uploaded.error.message)
  }
  return loadRepoPriceList(clientName).list
}

/**
 * Shipping amounts from the zone-matrix price, plus pick & pack from the
 * price list when the ledger did not already price a pick or a pack.
 */
export async function priceStatementCharges(
  clientId: string,
  clientName: string,
  charges: StatementChargeRow[],
): Promise<{ charges: StatementChargeRow[]; error: { message: string } | null }> {
  const shipmentIds = [...new Set(charges.flatMap((charge) => {
    if (charge.charge_type !== 'shipping') return []
    const id = shipmentIdFromChargeKey(charge.charge_key)
    return id === null ? [] : [id]
  }))]

  const rates = new Map<string, number | null>()
  if (shipmentIds.length > 0) {
    const priced = await readChunked(shipmentIds, (chunk) => readAllPages((from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('shipstation_shipment_id, client_rate')
        .in('shipstation_shipment_id', chunk)
        .order('shipstation_shipment_id')
        .order('id')
        .range(from, to)))
    if (priced.error) return { charges, error: priced.error }
    for (const row of priced.data ?? []) {
      const record = row as { shipstation_shipment_id: number | string | null; client_rate: unknown }
      if (record.shipstation_shipment_id === null) continue
      rates.set(String(record.shipstation_shipment_id), priceOf(record.client_rate))
    }
  }

  let next = applyZonePrices(charges, rates)
  if (hasPricedPick(next)) return { charges: next, error: null }

  const orderIds = [...new Set(next.flatMap((charge) => charge.order_id === null ? [] : [charge.order_id]))]
  if (orderIds.length === 0) return { charges: next, error: null }

  const items = await readChunked(orderIds, (chunk) => readAllPages((from, to) =>
    supabaseAdmin
      .from('order_items')
      .select('order_id, sku, quantity_ordered, quantity_picked')
      .in('order_id', chunk)
      .order('order_id')
      .order('id')
      .range(from, to)))
  if (items.error) return { charges: next, error: items.error }

  const linesByOrder = new Map<string, SkuQty[]>()
  for (const row of items.data ?? []) {
    const record = row as {
      order_id: string | null
      sku: string | null
      quantity_ordered: unknown
      quantity_picked: unknown
    }
    if (!record.order_id) continue
    const qty = lineQty(record.quantity_ordered, record.quantity_picked)
    if (qty === null) continue
    const list = linesByOrder.get(record.order_id) ?? []
    list.push({ sku: record.sku ?? '', qty })
    linesByOrder.set(record.order_id, list)
  }

  const dateByOrder = new Map<string, string>()
  for (const charge of next) {
    if (!charge.order_id) continue
    const current = dateByOrder.get(charge.order_id)
    if (!current || charge.charge_date < current) dateByOrder.set(charge.order_id, charge.charge_date)
  }

  const list = await priceListFor(clientId, clientName)
  const picks = pickPackRows([...linesByOrder.entries()].map(([orderId, lines]) => ({
    orderId,
    chargeDate: dateByOrder.get(orderId) ?? next[0]?.charge_date ?? '',
    lines,
  })), list)
  next = [...next, ...picks]
  return { charges: next, error: null }
}
