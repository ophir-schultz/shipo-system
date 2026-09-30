import { supabaseAdmin } from '@/lib/supabase'
import { classifySku } from '@/lib/billing/classify-sku'
import { warehouseParts } from '@/lib/ledger/pick-date'
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

interface PageResult<T> {
  data: T[] | null
  error: { message: string; code?: string } | null
}

// Which hand-applied file introduces each thing this loader reads. There is no
// migration runner in this project (docs/superpowers/global-constraints.md):
// the files are pasted into the Supabase SQL editor by a human, so "the code is
// deployed" and "the schema exists" are independent facts and the gap between
// them is a normal state, not a corrupt one.
//
// Ordered longest-key-first at the point of use, so `order_number_key` is not
// matched by a shorter key that happens to be its prefix.
const MIGRATION_FOR: ReadonlyArray<readonly [string, string]> = [
  ['shipstation_shipment_id', 'supabase/ledger_03_charges.sql'],
  ['order_number_key',        'supabase/ledger_03_charges.sql'],
  ['effective_from',          'supabase/ledger_03_charges.sql'],
  ['effective_to',            'supabase/ledger_03_charges.sql'],
  ['charge_type',             'supabase/ledger_03_charges.sql'],
  ['cost_rates',              'supabase/ledger_02_cost.sql'],
  ['order_key',               'supabase/ledger_01_orders.sql'],
]

// 42703 undefined_column, 42P01 undefined_table. Both mean the same thing here:
// the migration has not been pasted in yet.
//
// Left to the generic wrapper below, this surfaces as
// `loadChargeInputs: shipments: column shipments.order_number_key does not
// exist` inside a failed sync_run — true, but it reads like a code defect, and
// the person on call has no way to know the remedy is a file they can paste. So
// the one case where the fix is a single known action says so.
function migrationHint(message: string): string | null {
  const hit = MIGRATION_FOR.find(([needle]) => message.includes(needle))
  if (!hit) return null
  return `The charge calculator is running against a database that has not had `
       + `its migration applied: ${message}. There is no migration runner in this `
       + `project — open the Supabase SQL editor and run ${hit[1]} (and any `
       + `earlier ledger_0*.sql it depends on), then re-run the charge sync. No `
       + `charges were written and nothing was deleted.`
}

export async function fetchAllPages<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    // A table whose row count is an exact multiple of PAGE_SIZE gets one more
    // request past the end, because an empty page is the only reliable stop
    // condition (see below). PostgREST answers that request with PGRST103,
    // "requested range not satisfiable", rather than 200 []. That is end of
    // table, not a failure, and treating it as one would fail the entire run on
    // a row count nobody controls.
    if (error?.code === 'PGRST103') return rows
    // A missing column or table is not a transient read failure and it is not a
    // bug in this file — it is a migration that has not been pasted in. Said
    // plainly, with the file to run, because the alternative is an operator
    // reading "column does not exist" and concluding the ledger is broken.
    if (error && (error.code === '42703' || error.code === '42P01')) {
      const hint = migrationHint(error.message)
      if (hint) throw new Error(`loadChargeInputs: ${what}: ${hint}`, { cause: error })
    }
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

/**
 * The warehouse calendar day of a timestamptz, as 'YYYY-MM-DD'.
 *
 * Returns '' for anything unparseable, which buildCharges reads as "no date"
 * and declines to charge — the same outcome as a null column, and better than
 * inventing today's date for a shipment nobody can date.
 */
const warehouseDate = (v: unknown): string => {
  const raw = String(v ?? '').trim()
  if (raw === '') return ''
  const at = new Date(raw)
  if (!Number.isFinite(at.getTime())) return ''
  return warehouseParts(at).date
}

interface OrderRow {
  id: string
  client_id: string | null
  order_key: string
  order_number: string | null
  cancelled: boolean | null
  order_date?: string | null
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
  effective_from: string | null
  effective_to: string | null
}

/** Records a finding for the caller's sync_runs row. */
export type LoadWarn = (context: string, detail: string) => void

export async function loadChargeInputs(
  windowStart: string,
  warn?: LoadWarn,
): Promise<ChargeInput[]> {
  const orders = await fetchAllPages<OrderRow>('orders', (from, to) =>
    supabaseAdmin
      .from('orders')
      .select('id, client_id, order_key, order_number, cancelled, order_date')
      // Null order_date rows are INCLUDED, and the `.or` is the only way to get
      // them: `.gte` is SQL `>=`, and `null >= '2026-08-31'` is NULL, not TRUE.
      // Excluded, such an order is invisible for ever — no future window would
      // ever pick it up either — so every pick and every label on it is unbilled
      // revenue with no trace in any counter. They are chargeable regardless:
      // charge_date derives from pick_date and ship_date, never from order_date,
      // so their charges are dated correctly. The count is warned on below,
      // because a missing order date is still a data-quality defect to fix in
      // the Zenventory sync.
      .or(`order_date.gte.${windowStart},order_date.is.null`)
      // Paging is only stable under an explicit order. Without it Postgres may
      // return rows in a different order per page and a row can be both
      // duplicated and skipped across the page boundary.
      .order('id', { ascending: true })
      .range(from, to))

  if (orders.length === 0) return []

  const undated = orders.filter((o) => o.order_date == null).length
  if (undated > 0) {
    warn?.('orders with no order_date', `${undated} orders have a null order_date. `
      + `They are charged (charge_date comes from pick and ship dates) but they `
      + `are outside every date window, so fix the source in sync/zenventory.ts.`)
  }

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
  // Both spellings are collected, and matching is case-insensitive, because
  // orders.order_key is upper-cased at write time while shipments.order_number
  // is whatever the carrier sent. Matching order_key against order_number
  // directly loses every order whose number is not already upper case, and
  // loses it as missing shipping revenue rather than as an error.
  //
  // The numbers are NORMALISED here, not after the fetch, and the query below
  // filters on shipments.order_number_key — the stored generated
  // upper(btrim(order_number)) added by ledger_03_charges.sql. PostgREST's
  // `.in()` is a case-SENSITIVE SQL `IN`, so normalising only in memory left the
  // fetch and the join disagreeing: a label in a third casing was never
  // retrieved and the revenue was lost silently.
  const numbers = Array.from(new Set(
    orders.flatMap((o) => [o.order_key, o.order_number])
      .map(norm)
      .filter((v) => v !== ''),
  ))

  const shipments: ShipmentRow[] = []
  for (const batch of chunk(numbers, IN_CHUNK)) {
    shipments.push(...await fetchAllPages<ShipmentRow>('shipments', (from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('id, client_id, shipstation_shipment_id, order_number, ship_date, actual_cost, raw_data')
        .in('order_number_key', batch)
        .order('id', { ascending: true })
        .range(from, to)))
  }

  // Every order that claims one of these numbers, WHATEVER ITS DATE. Detecting
  // ambiguity only among windowed orders is not a weaker check, it is a wrong
  // one: order #1001 for client A dated 45 days ago and order #1001 for client B
  // dated 3 days ago both exist happily under unique (client_id, order_key), and
  // with only B loaded the claimant set has size 1 and A's label is billed to B.
  // A charge on the wrong client is worse than a missing charge — it is
  // invisible in both clients' numbers and it corrupts the per-client margins
  // the whole system exists to produce.
  //
  // orders.order_key is the normalised spelling by construction: sync/zenventory
  // writes orderNumber.toUpperCase() and is the only writer of this table.
  const claimantOrders: OrderRow[] = []
  for (const batch of chunk(numbers, IN_CHUNK)) {
    claimantOrders.push(...await fetchAllPages<OrderRow>('orders (claimants)', (from, to) =>
      supabaseAdmin
        .from('orders')
        .select('id, client_id, order_key, order_number, cancelled')
        .in('order_key', batch)
        .order('id', { ascending: true })
        .range(from, to)))
  }

  const rates = await fetchAllPages<RateRow>('client_warehouse_rates', (from, to) =>
    supabaseAdmin
      .from('client_warehouse_rates')
      // effective_from / effective_to are added by ALTER TABLE in
      // ledger_03_charges.sql rather than appearing in a CREATE TABLE, which is
      // how they came to be dropped from this select. Without them the rate
      // lookup is a bare .find() and a superseded rate wins by array order.
      .select('id, client_id, charge_type, variant, rate, rate_type, effective_from, effective_to')
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

  // A shipment is attached to an order only when EXACTLY ONE order ANYWHERE
  // claims it. orders is unique on (client_id, order_key), so two clients can
  // hold the same order number; attaching the label to whichever order was seen
  // first would put one client's carrier cost in another client's P&L, and it
  // would look entirely plausible. When attribution is not provably unique we
  // do not attribute: the label is left off every order and warned about.
  //
  // The spend is then reported by `leaks_monthly.unpriced_shipments`, NOT by
  // `unattributed_label_spend` as this comment used to claim. Leak 1's predicate
  // is a blank order number OR a null client_id, and an ambiguously-claimed
  // shipment has neither -- it has a perfectly good order number (that is what
  // made it ambiguous) and, where the loader had one, a populated client_id. It
  // satisfies no disjunct of leak 1 and never appears there. It lands in leak 3
  // instead, because no charge is ever keyed for it and leak 3 looks for a
  // carrier cost with no matching shipping charge.
  //
  // That only holds while `actual_cost is not null`, which is leak 3's own
  // precondition: an ambiguous shipment whose carrier cost has not been reported
  // is invisible to all six leaks. Dropping it here is still right -- guessing
  // the claimant would put one client's freight in another's P&L -- but it is
  // dropped into a blind spot, not into coverage.
  const orderNumberKeys = (o: OrderRow) =>
    Array.from(new Set([norm(o.order_key), norm(o.order_number)])).filter((k) => k !== '')

  const claimants = new Map<string, Set<string>>()   // shipment id -> order ids
  const shipmentById = new Map<string, ShipmentRow>()
  for (const s of shipments) shipmentById.set(s.id, s)

  // The claimant pool is every order sharing the number, in the window or not.
  // Windowed orders are unioned in so that an order whose order_key spelling
  // differs from the claimant query's (a hypothetical non-normalised writer)
  // still claims its own label.
  const byId = new Map<string, OrderRow>()
  for (const o of [...claimantOrders, ...orders]) byId.set(o.id, o)

  for (const o of byId.values()) {
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

  const windowedOrderIds = new Set(orders.map((o) => o.id))
  const shipmentsForOrder = new Map<string, ShipmentRow[]>()
  let ambiguousShipments = 0
  for (const [shipmentId, orderIds] of claimants) {
    if (orderIds.size !== 1) { ambiguousShipments++; continue }
    const orderId = [...orderIds][0]
    // The sole claimant may be outside the window, in which case there is
    // nothing to attach the label to on this run — and, importantly, nothing to
    // MISattach it to either. That is the point of the wider pool.
    if (!windowedOrderIds.has(orderId)) continue
    const s = shipmentById.get(shipmentId)
    if (!s) continue
    const list = shipmentsForOrder.get(orderId) ?? []
    list.push(s)
    shipmentsForOrder.set(orderId, list)
  }
  if (ambiguousShipments > 0) {
    warn?.('ambiguous shipment attribution', `${ambiguousShipments} shipments are `
      + `claimed by more than one order and were left unattributed. Their carrier `
      + `spend is reported as unattributed label spend rather than guessed onto a `
      + `client.`)
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
        // ship_date is timestamptz, so slicing the first ten characters would
        // read the UTC calendar day. charge_date is what every monthly boundary
        // in Task 15 groups on, and a label bought at 20:00 ET on the 31st
        // belongs to that month, not the next. Resolved through Intl in
        // America/New_York, never a hardcoded offset.
        shipDate: warehouseDate(s.ship_date),
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
        // Passed through as null when null. buildCharges reads a null
        // effective_from as "has always been in effect", which is what every
        // row in the table today needs: the columns were added by ALTER TABLE
        // after the rows existed.
        effectiveFrom: r.effective_from ?? null,
        effectiveTo: r.effective_to ?? null,
      })),
      costRates: costRates as CostRateRow[],
      peakSurchargePct: num(peak?.rate) ?? 0,
    }
  })
}
