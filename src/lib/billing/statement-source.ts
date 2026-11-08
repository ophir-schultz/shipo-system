import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages, type PageResult } from '@/lib/db/page'
import { priceOf } from '@/lib/billing/unpriced'
import { shipmentIdFromChargeKey } from '@/lib/billing/statement-detail'
import type { StatementChargeRow } from '@/lib/billing/statement-charges'
import { money, peakOmissionNote, pricePick } from '@/lib/pricing/engine'
import { isVoidedShipment } from '@/lib/billing/voided-shipment'
import { easternAddDays, easternMidnightIso, rawShipDate, shipCalendarDay } from '@/lib/ledger/eastern-day'
import { zenventorySlug } from '@/lib/zenventory/client-env'
import { FREIGHT_SERVICE, freightColumnMissing, linkedFreightPrice } from '@/lib/billing/manual-freight'
import type { DateRange } from '@/lib/billing/statement'
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

/**
 * Nayax freight with no zone price is not billed at carrier cost.
 *
 * The warehouse log is where staff type the carrier cost and the markup.
 * The client amount is that sum. The statement uses a saved line only when
 * shipment_ref is the ShipStation shipment id and the stored total equals
 * cost plus markup. When those columns are not on the database yet, the
 * read reports the column missing and no manual price is applied.
 *
 * A manual price is used only when the caller already has that shipment id.
 * Two prices for one shipment are left unknown. No zone price and no single
 * manual price leaves the client amount unknown. The ledger row stays; its
 * stored cost is not cleared and not shown.
 */
export function nayaxManualFreight(clientName: string): boolean {
  return zenventorySlug(clientName) === 'NAYAX'
}

export interface ManualFreightPrice {
  shipmentId: string
  /** Full client price: carrier cost plus the markup staff typed. */
  amount: number | null
  /** Staff date on the freight line. Compared with the charge date. */
  logDate: string
}

export interface ManualFreightResult {
  charges: StatementChargeRow[]
  /** Staff-only. A zone price or a date clash was not overridden. */
  reviews: string[]
}

function isAtCostShipmentFreight(charge: StatementChargeRow): boolean {
  if (charge.charge_type !== 'shipping') return false
  if (charge.label !== 'Shipping') return false
  if (priceOf(charge.unit_rate) !== null) return false
  return shipmentIdFromChargeKey(charge.charge_key) !== null
}

function pendingFreight(charge: StatementChargeRow): StatementChargeRow {
  return { ...charge, amount: null, label: 'Shipping (full price pending)' }
}

export function applyManualFullFreight(
  charges: readonly StatementChargeRow[],
  manuals: readonly ManualFreightPrice[],
): ManualFreightResult {
  const byShipment = new Map<string, ManualFreightPrice[]>()
  for (const manual of manuals) {
    const id = manual.shipmentId.trim()
    if (!id) continue
    const list = byShipment.get(id) ?? []
    list.push(manual)
    byShipment.set(id, list)
  }
  const reviews: string[] = []
  const chargesOut = charges.map((charge) => {
    const shipmentId = shipmentIdFromChargeKey(charge.charge_key)
    const links = shipmentId ? byShipment.get(shipmentId) ?? [] : []
    if (links.length > 0 && priceOf(charge.unit_rate) !== null && charge.charge_type === 'shipping') {
      reviews.push(`Shipment ${shipmentId} already has a zone price. The manual freight line was not applied.`)
      return charge
    }
    if (!isAtCostShipmentFreight(charge)) return charge
    if (links.length !== 1) return pendingFreight(charge)
    const full = priceOf(links[0].amount)
    if (full === null) return pendingFreight(charge)
    if (links[0].logDate !== charge.charge_date) {
      reviews.push(`Shipment ${shipmentId} manual date ${links[0].logDate} is not the charge date ${charge.charge_date}. The manual freight line was not billed.`)
      return pendingFreight(charge)
    }
    return { ...charge, amount: full, label: 'Shipping' }
  })
  return { charges: chargesOut, reviews }
}

function sameCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

/**
 * A stored zone rate fills a shipping charge only when the ledger amount is
 * blank. A ledger amount that differs from the stored rate is left as it is:
 * neither figure is chosen as the client price.
 */
export function applyZonePrices(
  charges: readonly StatementChargeRow[],
  clientRateByShipmentId: ReadonlyMap<string, number | null>,
): StatementChargeRow[] {
  return charges.map((charge) => {
    if (charge.charge_type !== 'shipping') return charge
    if (charge.label === 'Shipping (full price pending)') return charge
    const id = shipmentIdFromChargeKey(charge.charge_key)
    if (id === null || !clientRateByShipmentId.has(id)) return charge
    const rate = clientRateByShipmentId.get(id)
    if (rate === null || rate === undefined) return charge
    const ledger = priceOf(charge.amount)
    if (ledger === null) return { ...charge, amount: rate, unit_rate: rate }
    if (sameCents(ledger, rate)) {
      return charge.unit_rate == null ? { ...charge, unit_rate: rate } : charge
    }
    return charge
  })
}

/** Staff-only. Both figures, because they were not selected as the client price. */
export function shippingDisagreements(
  charges: readonly StatementChargeRow[],
  clientRateByShipmentId: ReadonlyMap<string, number | null>,
): string[] {
  const notes: string[] = []
  for (const charge of charges) {
    if (charge.charge_type !== 'shipping') continue
    const id = shipmentIdFromChargeKey(charge.charge_key)
    if (id === null || !clientRateByShipmentId.has(id)) continue
    const rate = clientRateByShipmentId.get(id)
    const ledger = priceOf(charge.amount)
    if (rate == null || ledger == null || sameCents(ledger, rate)) continue
    notes.push(
      `Shipment ${id}: ledger shipping amount ${ledger.toFixed(2)} and stored rate ${rate.toFixed(2)} disagree. Neither is the client charge.`,
    )
  }
  return notes
}

/**
 * After freight, a disagreed ledger amount is not the client price.
 * A freight full price that replaced it is kept. A pending line stays pending.
 */
export function withholdDisagreedShipping(
  before: readonly StatementChargeRow[],
  after: readonly StatementChargeRow[],
  clientRateByShipmentId: ReadonlyMap<string, number | null>,
): StatementChargeRow[] {
  const prior = new Map(before.map((charge) => [charge.charge_key, charge]))
  return after.map((charge) => {
    if (charge.charge_type !== 'shipping') return charge
    if (charge.label === 'Shipping (full price pending)') return charge
    const id = shipmentIdFromChargeKey(charge.charge_key)
    if (id === null) return charge
    const rate = clientRateByShipmentId.get(id)
    const ledger = priceOf(prior.get(charge.charge_key)?.amount)
    if (rate == null || ledger == null || sameCents(ledger, rate)) return charge
    const now = priceOf(charge.amount)
    if (now != null && !sameCents(now, ledger)) return charge
    return { ...charge, amount: null, unit_rate: null, label: 'Shipping (price not final)' }
  })
}

/** A parcel in the period with no ledger shipping charge. Amount stays unknown. */
export function uncoveredShipmentCharges(
  rows: readonly (ShipmentForStatement & { id: string })[],
  coveredKeys: ReadonlySet<string>,
  fallbackDate: string,
): StatementChargeRow[] {
  const out: StatementChargeRow[] = []
  for (const row of rows) {
    if (isVoidedShipment(row.raw_data)) continue
    const sid = row.shipstation_shipment_id
    const keyed = sid != null && String(sid) !== '' ? `shipment:${sid}` : ''
    if (keyed && coveredKeys.has(keyed)) continue
    const key = keyed || `coverage:${row.id}`
    if (coveredKeys.has(key)) continue
    const day = shipCalendarDay(row.ship_date, rawShipDate(row.raw_data)) || fallbackDate
    out.push({
      charge_type: 'shipping',
      label: 'Shipping (not on the ledger)',
      quantity: 1,
      unit_rate: null,
      amount: null,
      is_estimate: false,
      charge_date: day,
      order_id: null,
      charge_key: key,
    })
  }
  return out
}

export interface ShipmentForStatement {
  shipstation_shipment_id: number | string | null
  order_number: string | null
  ship_date: string | null
  client_rate: unknown
  raw_data?: unknown
}

/**
 * Shipping lines from the same rows Profit reads, for a client whose ledger
 * has no shipping charges in the period. A voided label is omitted. A parcel
 * with no zone price stays unpriced rather than becoming $0.
 */
export function shippingChargesFromShipments(
  rows: readonly ShipmentForStatement[],
  orderIdByNumber: ReadonlyMap<string, string> = new Map(),
): StatementChargeRow[] {
  const charges: StatementChargeRow[] = []
  for (const row of rows) {
    if (isVoidedShipment(row.raw_data)) continue
    if (row.shipstation_shipment_id === null || row.shipstation_shipment_id === '') continue
    const rate = priceOf(row.client_rate)
    const orderNumber = row.order_number?.trim() ?? ''
    charges.push({
      charge_type: 'shipping',
      label: 'Shipping',
      quantity: 1,
      unit_rate: rate,
      amount: rate,
      is_estimate: false,
      charge_date: shipCalendarDay(row.ship_date, rawShipDate(row.raw_data)),
      order_id: orderNumber === '' ? null : orderIdByNumber.get(orderNumber) ?? null,
      charge_key: `shipment:${row.shipstation_shipment_id}`,
    })
  }
  return charges
}

export interface PickCardRow {
  service_type?: string | null
  rate?: unknown
  effective_from?: string | null
  effective_to?: string | null
}

/**
 * A warehouse-card service_type that is the per-order pick & pack line.
 *
 * The cards do not share one name. The template and schema comment say
 * `pick_pack`. Suteka's line is `pick_n_pack`. SitnStand's is
 * `orders_(picks_n_pack)`. Other cards use `picks` or a pick_n_pack variant
 * (`orders_(pick_n_pack)`, `pick_n_pack_(per_order)`). Parentheses and spaces
 * are punctuation, not a different service. Storage, additional items, and
 * Nayax's structured charge_type `pick` (service_type null) are not this line.
 */
export function isPickPackService(serviceType: string | null | undefined): boolean {
  if (!serviceType) return false
  const name = serviceType.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!name) return false
  // Before the generic pick_pack match. That match allows a trailing
  // underscore, so pick_pack_additional_item would count as a second
  // per-order pick rate. Additional items stay a separate per-unit price.
  if (/(^|_)additional(_|$)/.test(name)) return false
  if (name === 'pick' || name === 'picks' || name === 'pick_pack' || name === 'pick_n_pack' || name === 'picks_n_pack') {
    return true
  }
  return /(^|_)picks?_n_pack($|_)/.test(name)
    || /(^|_)picks?_and_pack($|_)/.test(name)
    || /(^|_)pick_pack($|_)/.test(name)
    || /(^|_)picks($|_)/.test(name)
}

export interface PickPackDecision {
  billed: boolean
  rate: number | null
  reason: string
}

function calendarDay(value: unknown): string {
  if (typeof value !== 'string') return ''
  const day = value.trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

/** Half-open [from, to), the same window client_warehouse_rates_no_overlap uses. */
function rateLineInEffect(row: PickCardRow, onDate: string): boolean {
  if (!onDate) return true
  const from = calendarDay(row.effective_from)
  const to = calendarDay(row.effective_to)
  if (from && from > onDate) return false
  if (to && to <= onDate) return false
  return true
}

function dollars(rate: number): string {
  return `$${rate.toFixed(2)}`
}

function describeLine(row: PickCardRow): string {
  const name = row.service_type?.trim() || '(unnamed)'
  const rate = priceOf(row.rate)
  const from = calendarDay(row.effective_from) || 'open'
  const to = calendarDay(row.effective_to) || 'open'
  return `${name} ${rate === null ? 'no rate' : dollars(rate)} (${from} to ${to})`
}

/**
 * Why this card does or does not supply a per-order pick rate.
 *
 * A second live rate is a refusal. Kivema has orders_(picks_n_pack) at $1.20
 * and pick_n_pack at $1.75, and picking one would be a guess. A line whose
 * effective_to is the statement date is already over; the window is [from, to).
 */
export function decidePickRate(rows: readonly PickCardRow[], onDate: string): PickPackDecision {
  const named = rows.filter((row) => isPickPackService(row.service_type))
  if (named.length === 0) {
    return { billed: false, rate: null, reason: 'Pick & pack skipped: the rate card has no pick & pack line.' }
  }
  const live = named.filter((row) => rateLineInEffect(row, onDate))
  const priced = live.filter((row) => {
    const rate = priceOf(row.rate)
    return rate !== null && rate > 0
  })
  const amounts = [...new Set(priced.map((row) => priceOf(row.rate) as number))]
  if (amounts.length > 1) {
    const when = onDate || 'this date'
    return {
      billed: false,
      rate: null,
      reason: `Pick & pack skipped: more than one live rate on ${when}: ${priced.map(describeLine).join('; ')}.`,
    }
  }
  if (amounts.length === 1) {
    const names = [...new Set(priced.map((row) => row.service_type?.trim() || '(unnamed)'))]
    return {
      billed: true,
      rate: amounts[0],
      reason: `Pick & pack billed at ${dollars(amounts[0])} per order from ${names.join(', ')}.`,
    }
  }
  if (live.length === 0) {
    const when = onDate || 'this date'
    return {
      billed: false,
      rate: null,
      reason: `Pick & pack skipped: not in effect on ${when}: ${named.map(describeLine).join('; ')}.`,
    }
  }
  return {
    billed: false,
    rate: null,
    reason: `Pick & pack skipped: the live line has no rate: ${live.map(describeLine).join('; ')}.`,
  }
}

/** The one live pick rate, or null when the card does not say. */
export function pickRateOnCard(rows: readonly PickCardRow[], onDate: string): number | null {
  const decision = decidePickRate(rows, onDate)
  return decision.billed ? decision.rate : null
}

export interface ShipmentPickOrder {
  orderId: string | null
  orderNumber: string
  chargeDate: string
}

/**
 * One pick per order number on the shipments, whether or not `orders` has a
 * row for this client. The join is client_id plus order_number. A miss used
 * to skip the rate card entirely, which is how Creative Pea stayed at none
 * while SitnStand, with the same service name, billed.
 */
export function pickOrdersFromShipments(
  rows: readonly ShipmentForStatement[],
  orderIdByNumber: ReadonlyMap<string, string> = new Map(),
): ShipmentPickOrder[] {
  const byKey = new Map<string, ShipmentPickOrder>()
  for (const row of rows) {
    if (isVoidedShipment(row.raw_data)) continue
    const orderNumber = row.order_number?.trim() ?? ''
    if (!orderNumber) continue
    const orderId = orderIdByNumber.get(orderNumber) ?? null
    const key = orderId ?? `number:${orderNumber}`
    const chargeDate = shipCalendarDay(row.ship_date, rawShipDate(row.raw_data))
    const current = byKey.get(key)
    if (!current || (chargeDate && chargeDate < current.chargeDate)) {
      byKey.set(key, { orderId, orderNumber, chargeDate })
    }
  }
  return [...byKey.values()]
}

/** One pick & pack line per order, at the rate-card price. */
export function pickRowsFromCard(
  orders: readonly { orderId: string | null; orderNumber?: string; chargeDate: string }[],
  rate: number,
): StatementChargeRow[] {
  return orders.map((order) => ({
    charge_type: 'pick',
    label: 'Pick & pack',
    quantity: 1,
    unit_rate: rate,
    amount: money(rate),
    is_estimate: false,
    charge_date: order.chargeDate,
    order_id: order.orderId,
    charge_key: `pick:card:${order.orderId ?? order.orderNumber ?? order.chargeDate}`,
  }))
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

function baseCharge(
  order: PickOrder,
  over: Partial<StatementChargeRow>,
): StatementChargeRow {
  return {
    charge_type: 'pick',
    label: 'Pick & pack',
    quantity: null,
    unit_rate: null,
    amount: null,
    is_estimate: false,
    charge_date: order.chargeDate,
    order_id: order.orderId,
    charge_key: `pickpack:${order.orderId}`,
    ...over,
  }
}

/**
 * Order pick is two rates: one charge per order, then each item past the
 * included count. One combined row hid that (39 items, rate "see amount").
 * The two labels group across the period, so the statement reads as orders
 * times the order rate, and extra items times the additional rate.
 */
export function pickPackRows(
  orders: readonly PickOrder[],
  list: PriceListDocument | null,
): StatementChargeRow[] {
  if (!list) return []
  const rows: StatementChargeRow[] = []
  for (const order of orders) {
    if (order.lines.length === 0) continue
    const tier = list.orderPick
    if (tier && !list.devicePick && !list.accessoryPick) {
      let items = 0
      let bad = false
      for (const line of order.lines) {
        if (!Number.isFinite(line.qty)) { bad = true; break }
        items += line.qty
      }
      if (bad || !Number.isInteger(items) || items <= 0) continue
      rows.push(baseCharge(order, {
        label: 'Pick & pack',
        quantity: 1,
        unit_rate: tier.orderRate,
        amount: tier.orderRate,
        charge_key: `pickpack:${order.orderId}`,
      }))
      const extra = Math.max(0, items - tier.includedItems)
      if (extra > 0) {
        rows.push(baseCharge(order, {
          label: 'Additional items',
          quantity: extra,
          unit_rate: tier.additionalRate,
          amount: money(extra * tier.additionalRate),
          charge_key: `pickpack-extra:${order.orderId}`,
        }))
      }
      continue
    }
    const priced = pricePick(list, order.lines)
    if (priced.amount === null) continue
    const items = order.lines.reduce((sum, line) => sum + line.qty, 0)
    rows.push(baseCharge(order, {
      quantity: items,
      amount: priced.amount,
    }))
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
async function readLinkedFreight(
  clientId: string,
  range?: DateRange,
): Promise<{ rows: ManualFreightPrice[]; error: { message: string } | null }> {
  const result = await supabaseAdmin
    .from('warehouse_daily_log')
    .select('shipment_ref, total, log_date, client_id, service_type, freight_cost, freight_markup')
    .eq('client_id', clientId)
    .eq('service_type', FREIGHT_SERVICE)
  if (freightColumnMissing(result.error)) return { rows: [], error: null }
  if (result.error) return { rows: [], error: { message: result.error.message } }
  const rows: ManualFreightPrice[] = []
  for (const raw of result.data ?? []) {
    const linked = linkedFreightPrice(raw as {
      shipment_ref?: string | null
      total?: unknown
      log_date?: string | null
      client_id?: string | null
      service_type?: string | null
      freight_cost?: unknown
      freight_markup?: unknown
    }, clientId, range)
    if (linked) rows.push(linked)
  }
  return { rows, error: null }
}

const UNREAD_PICK: PickPackDecision = {
  billed: false,
  rate: null,
  reason: 'Pick & pack skipped: a read failed before the rate card could be checked.',
}

export interface PickOrderDetail {
  orderId: string | null
  orderNumber: string
  chargeDate: string
  quantity: number | null
  amount: number | null
  label: string
  /** Where the amount came from. Not a commercial approval. */
  source: 'ledger' | 'price-list' | 'rate-card' | 'unknown'
}

export function pickOrderDetails(
  rows: readonly StatementChargeRow[],
  source: PickOrderDetail['source'],
  orderNumbers: ReadonlyMap<string, string> = new Map(),
): PickOrderDetail[] {
  return rows
    .filter((row) => row.charge_type === 'pick' || row.charge_type === 'pack')
    .map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_id ? orderNumbers.get(row.order_id) ?? '' : '',
      chargeDate: row.charge_date,
      quantity: priceOf(row.quantity),
      amount: priceOf(row.amount),
      label: row.label,
      source,
    }))
}

export async function priceStatementCharges(
  clientId: string,
  clientName: string,
  charges: StatementChargeRow[],
  range?: DateRange,
): Promise<{
  charges: StatementChargeRow[]
  pickPack: PickPackDecision
  error: { message: string } | null
  freightReviews: string[]
  /** Staff only. Not written into a client file. */
  basisReviews: string[]
  pickDetails: PickOrderDetail[]
}> {
  const shipmentIds = [...new Set(charges.flatMap((charge) => {
    if (charge.charge_type !== 'shipping') return []
    const id = shipmentIdFromChargeKey(charge.charge_key)
    return id === null ? [] : [id]
  }))]

  const rates = new Map<string, number | null>()
  const voidedIds = new Set<string>()
  if (shipmentIds.length > 0) {
    const priced = await readChunked(shipmentIds, (chunk) => readAllPages((from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('shipstation_shipment_id, client_rate, raw_data')
        .in('shipstation_shipment_id', chunk)
        .order('shipstation_shipment_id')
        .order('id')
        .range(from, to)))
    if (priced.error) return { charges, pickPack: UNREAD_PICK, error: priced.error, freightReviews: [], basisReviews: [], pickDetails: [] }
    for (const row of priced.data ?? []) {
      const record = row as { shipstation_shipment_id: number | string | null; client_rate: unknown; raw_data?: unknown }
      if (record.shipstation_shipment_id === null) continue
      const id = String(record.shipstation_shipment_id)
      if (isVoidedShipment(record.raw_data)) {
        voidedIds.add(id)
        continue
      }
      rates.set(id, priceOf(record.client_rate))
    }
  }

  const openCharges = charges.filter((charge) => {
    if (charge.charge_type !== 'shipping') return true
    const id = shipmentIdFromChargeKey(charge.charge_key)
    return id === null || !voidedIds.has(id)
  })
  const basisReviews = shippingDisagreements(openCharges, rates)
  let next = applyZonePrices(openCharges, rates)
  let freightReviews: string[] = []
  if (nayaxManualFreight(clientName)) {
    const linked = await readLinkedFreight(clientId, range)
    if (linked.error) return { charges: next, pickPack: UNREAD_PICK, error: linked.error, freightReviews, basisReviews, pickDetails: [] }
    const applied = applyManualFullFreight(next, linked.rows)
    next = applied.charges
    freightReviews = applied.reviews
  }
  next = withholdDisagreedShipping(openCharges, next, rates)
  if (range) {
    const windowRows = await readAllPages((from, to) => supabaseAdmin
      .from('shipments')
      .select('id, shipstation_shipment_id, order_number, ship_date, client_rate, raw_data')
      .eq('client_id', clientId)
      .gte('ship_date', easternMidnightIso(range.from))
      .lt('ship_date', easternMidnightIso(easternAddDays(range.to, 1)))
      .order('ship_date')
      .order('id')
      .range(from, to))
    if (windowRows.error) {
      return { charges: next, pickPack: UNREAD_PICK, error: windowRows.error, freightReviews, basisReviews, pickDetails: [] }
    }
    const covered = new Set(next.filter((charge) => charge.charge_type === 'shipping').map((charge) => charge.charge_key))
    const missing = uncoveredShipmentCharges(
      (windowRows.data ?? []) as (ShipmentForStatement & { id: string })[],
      covered,
      range.from,
    )
    if (missing.length > 0) {
      basisReviews.push(
        `${missing.length} shipment${missing.length === 1 ? '' : 's'} in this period ${missing.length === 1 ? 'has' : 'have'} no ledger shipping charge. ${missing.length === 1 ? 'It is' : 'They are'} unknown, not a client charge.`,
      )
    }
    next = [...next, ...missing]
  }

  let shipmentOrders: ShipmentPickOrder[] = []
  if (range && !next.some((charge) => charge.charge_type === 'shipping')) {
    const shipped = await readAllPages((from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('shipstation_shipment_id, order_number, ship_date, client_rate, raw_data')
        .eq('client_id', clientId)
        .gte('ship_date', easternMidnightIso(range.from))
        .lt('ship_date', easternMidnightIso(easternAddDays(range.to, 1)))
        .order('ship_date')
        .order('id')
        .range(from, to))
    if (shipped.error) return { charges: next, pickPack: UNREAD_PICK, error: shipped.error, freightReviews, basisReviews, pickDetails: [] }
    const rows = (shipped.data ?? []) as ShipmentForStatement[]
    const numbers = [...new Set(rows.flatMap((row) => {
      const number = row.order_number?.trim() ?? ''
      return number === '' ? [] : [number]
    }))]
    const orderIdByNumber = new Map<string, string>()
    if (numbers.length > 0) {
      const orders = await readChunked(numbers, (chunk) => readAllPages((from, to) =>
        supabaseAdmin
          .from('orders')
          .select('id, order_number')
          .eq('client_id', clientId)
          .in('order_number', chunk)
          .order('order_number')
          .order('id')
          .range(from, to)))
      if (orders.error) return { charges: next, pickPack: UNREAD_PICK, error: orders.error, freightReviews, basisReviews, pickDetails: [] }
      for (const row of orders.data ?? []) {
        const record = row as { id: string | null; order_number: string | null }
        if (!record.id || !record.order_number || orderIdByNumber.has(record.order_number)) continue
        orderIdByNumber.set(record.order_number, record.id)
      }
    }
    shipmentOrders = pickOrdersFromShipments(rows, orderIdByNumber)
    next = [...next, ...shippingChargesFromShipments(rows, orderIdByNumber)]
  }

  if (hasPricedPick(next)) {
    return {
      charges: next,
      pickPack: { billed: true, rate: null, reason: 'Pick & pack was already priced on the ledger.' },
      error: null,
      freightReviews,
      basisReviews,
      pickDetails: [],
    }
  }

  const orderIds = [...new Set(next.flatMap((charge) => charge.order_id === null ? [] : [charge.order_id]))]
  const dateByOrder = new Map<string, string>()
  for (const charge of next) {
    if (!charge.order_id) continue
    const current = dateByOrder.get(charge.order_id)
    if (!current || charge.charge_date < current) dateByOrder.set(charge.order_id, charge.charge_date)
  }
  const joinedOrders: ShipmentPickOrder[] = orderIds.map((orderId) => ({
    orderId,
    orderNumber: '',
    chargeDate: dateByOrder.get(orderId) ?? range?.from ?? '',
  }))
  // A ledger charge already names its order. Otherwise use the shipment's
  // order number, including the ones that never joined to `orders`.
  const unmatchedShipments = shipmentOrders.filter((order) => order.orderId === null)
  const pickOrders = joinedOrders.length > 0
    ? [...joinedOrders, ...unmatchedShipments]
    : shipmentOrders
  if (pickOrders.length === 0) {
    return {
      charges: next,
      pickPack: {
        billed: false,
        rate: null,
        reason: 'Pick & pack skipped: no order in this period to attach it to. Shipments did not join to an orders row for this client.',
      },
      error: null,
      freightReviews,
      basisReviews,
      pickDetails: [],
    }
  }

  const items = await readChunked(orderIds, (chunk) => readAllPages((from, to) =>
    supabaseAdmin
      .from('order_items')
      .select('order_id, sku, quantity_ordered, quantity_picked')
      .in('order_id', chunk)
      .order('order_id')
      .order('id')
      .range(from, to)))
  if (items.error) return { charges: next, pickPack: UNREAD_PICK, error: items.error, freightReviews, basisReviews, pickDetails: [] }

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

  const list = await priceListFor(clientId, clientName)
  let picks = pickPackRows([...linesByOrder.entries()].map(([orderId, lines]) => ({
    orderId,
    chargeDate: dateByOrder.get(orderId) ?? next[0]?.charge_date ?? '',
    lines,
  })), list)
  const orderNumbers = new Map(pickOrders.flatMap((order) => order.orderId ? [[order.orderId, order.orderNumber] as const] : []))
  if (hasPricedPick(picks)) {
    const covered = new Set(picks.map((row) => row.order_id).filter((id): id is string => id != null))
    const missed = pickOrders.filter((order) => order.orderId != null && !covered.has(order.orderId))
    const unknownPicks: StatementChargeRow[] = missed.map((order) => ({
      charge_type: 'pick',
      label: 'Pick & pack (not priced)',
      quantity: null,
      unit_rate: null,
      amount: null,
      is_estimate: false,
      charge_date: order.chargeDate || range?.from || '',
      order_id: order.orderId,
      charge_key: `pickpack-unknown:${order.orderId}`,
    }))
    const peakNote = peakOmissionNote(list, picks.map((row) => row.charge_date))
    if (peakNote) basisReviews.push(peakNote)
    return {
      charges: [...next, ...picks, ...unknownPicks],
      pickPack: { billed: true, rate: null, reason: 'Pick & pack came from the price list, one order at a time, not from a stored ledger pick charge. An order the list does not price is unknown. The price-list peak is not included.' },
      error: null,
      freightReviews,
      basisReviews,
      pickDetails: [
        ...pickOrderDetails(picks, 'price-list', orderNumbers),
        ...pickOrderDetails(unknownPicks, 'unknown', orderNumbers),
      ],
    }
  }

  const card = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('*')
    .eq('client_id', clientId)
  if (card.error) return { charges: next, pickPack: UNREAD_PICK, error: card.error, freightReviews, basisReviews, pickDetails: [] }
  const onDate = [...pickOrders.map((order) => order.chargeDate)].sort()[0] ?? range?.from ?? ''
  const decision = decidePickRate((card.data ?? []) as PickCardRow[], onDate)
  if (!decision.billed || decision.rate === null) {
    return { charges: next, pickPack: decision, error: null, freightReviews, basisReviews, pickDetails: [] }
  }
  const missingJoin = pickOrders.filter((order) => order.orderId === null).length
  const reason = missingJoin === 0
    ? `${decision.reason.replace(/\.$/, '')} (${pickOrders.length} orders).`
    : `${decision.reason.replace(/\.$/, '')} (${pickOrders.length} orders). ${missingJoin} order number${missingJoin === 1 ? '' : 's'} had no orders row for this client, so pick & pack was billed from the shipment order number.`
  const cardPicks = pickRowsFromCard(pickOrders, decision.rate)
  next = [...next, ...cardPicks]
  return {
    charges: next,
    pickPack: { billed: true, rate: decision.rate, reason },
    error: null,
    freightReviews,
    basisReviews,
    pickDetails: pickOrderDetails(cardPicks, 'rate-card', orderNumbers),
  }
}
