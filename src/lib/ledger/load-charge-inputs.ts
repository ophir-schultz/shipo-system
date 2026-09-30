import { supabaseAdmin } from '@/lib/supabase'
import { classifySku } from '@/lib/billing/classify-sku'
import type { ChargeInput } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

// Assembles ChargeInput[] for every order touched in the window. One query per
// table rather than one per order: a 30-day window is a few thousand orders,
// and a per-order round trip would take minutes and time the cron out.
//
// Two limits of PostgREST shape everything below, and both fail SILENTLY —
// which is the only reason they are worth this much code:
//
//   1. A select returns at most `db-max-rows` rows (1000 by default) with no
//      error and no flag. Unpaginated, a 30-day window would calculate charges
//      for the first thousand orders and quietly ignore the rest.
//   2. `.in(col, [...])` is serialised into the URL. A few thousand UUIDs is a
//      six-figure byte count and the request is rejected outright.
//
// So: every read is paginated, and every `.in()` is chunked.

const PAGE_SIZE = 1000
const IN_CHUNK = 200

interface PageResult<T> { data: T[] | null; error: { message: string } | null }

async function fetchAllPages<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    // Wrapped rather than rethrown so the message says which read failed, with
    // the original kept on `cause`. Without the table name, every one of these
    // reads produces the same opaque PostgREST string.
    if (error) throw new Error(`loadChargeInputs: ${what}: ${error.message}`, { cause: error })
    const batch = data ?? []
    rows.push(...batch)
    // Advance by what came back, not by what was asked for. PostgREST caps a
    // response at its own `db-max-rows`, so a server configured below PAGE_SIZE
    // returns a short page on the FIRST request — and a `length < PAGE_SIZE`
    // stop condition would read that as "end of table" and silently drop every
    // remaining row. An empty page is the only reliable end marker.
    if (batch.length === 0) return rows
    from += batch.length
  }
}

function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** Order numbers are compared case-insensitively; see the shipment join below. */
const norm = (v: unknown) => String(v ?? '').trim().toUpperCase()

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

interface OrderRow {
  id: string
  client_id: string | null
  order_key: string
  order_number: string | null
  cancelled: boolean | null
}
interface ItemRow {
  id: string
  order_id: string
  sku: string | null
  quantity_picked: number | string | null
  is_component: boolean | null
  pick_date: string | null
}
interface ShipmentRow {
  id: string
  client_id: string | null
  shipstation_shipment_id: number | string | null
  order_number: string | null
  ship_date: string | null
  actual_cost: number | string | null
  raw_data: Record<string, unknown> | null
}
interface RateRow {
  id: string
  client_id: string | null
  charge_type: string | null
  variant: string | null
  rate: number | string | null
  rate_type: string | null
}

export async function loadChargeInputs(windowStart: string): Promise<ChargeInput[]> {
  const orders = await fetchAllPages<OrderRow>('orders', (from, to) =>
    supabaseAdmin
      .from('orders')
      .select('id, client_id, order_key, order_number, cancelled')
      .gte('order_date', windowStart)
      // Paging is only stable under an explicit order. Without it Postgres may
      // return rows in a different order per page and a row can be both
      // duplicated and skipped across the page boundary.
      .order('id', { ascending: true })
      .range(from, to))

  if (orders.length === 0) return []

  const items: ItemRow[] = []
  for (const ids of chunk(orders.map((o) => o.id), IN_CHUNK)) {
    items.push(...await fetchAllPages<ItemRow>('order_items', (from, to) =>
      supabaseAdmin
        .from('order_items')
        .select('id, order_id, sku, quantity_picked, is_component, pick_date')
        .in('order_id', ids)
        .order('id', { ascending: true })
        .range(from, to)))
  }

  // Shipments are keyed to orders by order_number, which is the ONLY join
  // available — shipments carry no order_id. Blank order numbers therefore
  // match nothing and stay unattributed, which is correct: that spend is
  // reported by leaks_monthly.unattributed_label_spend, not guessed onto an
  // order.
  //
  // Both spellings are queried, and matching is case-insensitive, because
  // orders.order_key is upper-cased at write time while shipments.order_number
  // is whatever the carrier sent. Matching order_key against order_number
  // directly loses every order whose number is not already upper case, and
  // loses it as missing shipping revenue rather than as an error.
  const numbers = Array.from(new Set(
    orders.flatMap((o) => [o.order_key, o.order_number])
      .map((v) => String(v ?? '').trim())
      .filter((v) => v !== ''),
  ))

  const shipments: ShipmentRow[] = []
  for (const batch of chunk(numbers, IN_CHUNK)) {
    shipments.push(...await fetchAllPages<ShipmentRow>('shipments', (from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('id, client_id, shipstation_shipment_id, order_number, ship_date, actual_cost, raw_data')
        .in('order_number', batch)
        .order('id', { ascending: true })
        .range(from, to)))
  }

  const rates = await fetchAllPages<RateRow>('client_warehouse_rates', (from, to) =>
    supabaseAdmin
      .from('client_warehouse_rates')
      .select('id, client_id, charge_type, variant, rate, rate_type')
      .not('charge_type', 'is', null)
      .order('id', { ascending: true })
      .range(from, to))

  const costRates = await fetchAllPages<CostRateRow>('cost_rates', (from, to) =>
    supabaseAdmin
      .from('cost_rates')
      .select('id, cost_type, variant, unit, rate, effective_from, effective_to, basis')
      .order('id', { ascending: true })
      .range(from, to))

  const itemsByOrder = new Map<string, ItemRow[]>()
  for (const it of items) {
    const list = itemsByOrder.get(it.order_id) ?? []
    list.push(it)
    itemsByOrder.set(it.order_id, list)
  }

  const shipmentsByNumber = new Map<string, ShipmentRow[]>()
  for (const s of shipments) {
    const key = norm(s.order_number)
    if (key === '') continue
    const list = shipmentsByNumber.get(key) ?? []
    list.push(s)
    shipmentsByNumber.set(key, list)
  }

  const ratesByClient = new Map<string, RateRow[]>()
  for (const r of rates) {
    if (!r.client_id) continue
    const list = ratesByClient.get(r.client_id) ?? []
    list.push(r)
    ratesByClient.set(r.client_id, list)
  }

  // A shipment is attached to an order only when EXACTLY ONE order in the
  // window claims it. orders is unique on (client_id, order_key), so two
  // clients can hold the same order number; attaching the label to whichever
  // order was seen first would put one client's carrier cost in another
  // client's P&L, and it would look entirely plausible. An unclaimed label is
  // already accounted for by leaks_monthly.unattributed_label_spend.
  const orderNumberKeys = (o: OrderRow) =>
    Array.from(new Set([norm(o.order_key), norm(o.order_number)])).filter((k) => k !== '')

  const claimants = new Map<string, Set<string>>()   // shipment id -> order ids
  const shipmentById = new Map<string, ShipmentRow>()
  for (const s of shipments) shipmentById.set(s.id, s)

  for (const o of orders) {
    for (const key of orderNumberKeys(o)) {
      for (const s of shipmentsByNumber.get(key) ?? []) {
        // Client attribution, where both sides have it, settles the ambiguity
        // rather than creating it: a label already assigned to client A is not
        // a candidate for client B's identically-numbered order.
        if (s.client_id && o.client_id && s.client_id !== o.client_id) continue
        const set = claimants.get(s.id) ?? new Set<string>()
        set.add(o.id)
        claimants.set(s.id, set)
      }
    }
  }

  const shipmentsForOrder = new Map<string, ShipmentRow[]>()
  for (const [shipmentId, orderIds] of claimants) {
    if (orderIds.size !== 1) continue
    const orderId = [...orderIds][0]
    const s = shipmentById.get(shipmentId)
    if (!s) continue
    const list = shipmentsForOrder.get(orderId) ?? []
    list.push(s)
    shipmentsForOrder.set(orderId, list)
  }

  return orders.map((o) => {
    const card = (o.client_id ? ratesByClient.get(o.client_id) : null) ?? []
    // The surcharge percentage is a rate card line like any other, not a
    // constant. Reading it here means a client who does not charge peak simply
    // has no line and gets 0, with no special case anywhere.
    const peak = card.find((r) => r.charge_type === 'surcharge' && r.variant === 'peak')

    return {
      order: {
        id: o.id,
        clientId: o.client_id,
        // A cancelled order earns nothing and costs nothing. The column
        // defaults to false, so a null here means "not cancelled", not
        // "unknown" — there is no third state to preserve.
        cancelled: o.cancelled === true,
      },
      items: (itemsByOrder.get(o.id) ?? []).map((it) => ({
        id: it.id,
        sku: it.sku,
        quantityPicked: num(it.quantity_picked),
        // is_component is null for lines synced before Task 12. Rather than
        // defaulting every one of them to a single class, the SKU is
        // reclassified with the same rule Task 5 uses, so R- and D-prefixed
        // readers keep the device rate. A blanket default would silently
        // mis-bill the two highest-volume SKUs, and mis-bill them in a way that
        // never surfaces as an error.
        isComponent: it.is_component ?? (
          classifySku({ sku: it.sku ?? '' }).skuClass === 'component'),
        pickDate: it.pick_date,
      })),
      shipments: (shipmentsForOrder.get(o.id) ?? []).map((s) => ({
        id: s.id,
        // NaN when the column is null. buildCharges refuses it rather than
        // keying the charge on the string 'null'; see the comment there.
        shipmentId: Number(s.shipstation_shipment_id),
        shipDate: String(s.ship_date ?? '').slice(0, 10),
        actualCost: num(s.actual_cost),
        // ShipStation reports a void on the shipment payload. There is no
        // column for it yet, so it is read from raw_data. Presence, not
        // truthiness, for the date fields: they hold a date string when voided
        // and null when not. Both spellings of the date field are checked
        // because nothing in this repo writes or reads it yet, so the exact key
        // is unverified against live data — see the report for Task 14.
        voided: s.raw_data?.voided === true
             || s.raw_data?.voidDate != null
             || s.raw_data?.voideDate != null,
      })),
      rateCard: card.map((r) => ({
        id: r.id,
        chargeType: String(r.charge_type ?? ''),
        variant: r.variant,
        rate: num(r.rate),
        rateType: String(r.rate_type ?? ''),
      })),
      costRates: costRates as CostRateRow[],
      peakSurchargePct: num(peak?.rate) ?? 0,
    }
  })
}
