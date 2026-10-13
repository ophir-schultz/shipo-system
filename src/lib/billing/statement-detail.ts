import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages, type PageResult } from '@/lib/db/page'
import { priceOf, type Money } from '@/lib/billing/unpriced'

// The two lookups that turn a statement from a total into a document a client
// can CHECK.
//
// A statement that says "Shipping $4,823.33" and nothing else asks the client to
// take our arithmetic on trust. The two questions anyone actually asks of an
// invoice are "which orders?" and, for freight, "which parcel, what weight,
// going where?" -- and neither was answerable from the exported file, because
// `order_charges` carries the order as a UUID and the parcel not at all.
//
// WHY THE MONEY DOES NOT COME FROM HERE.
//
// `shipments.client_rate` looks like the per-parcel billed amount and is not
// safe to use as one. The ledger prices a shipping charge off the client's RATE
// CARD -- `rate.rate`, or the carrier cost when the card says at_cost
// (calculate-charges.ts:361-364) -- while `client_rate` is the legacy
// calculator's own figure for the same parcel. Two pricing paths, one parcel. A
// workbook carrying both would state two different amounts for one shipment and
// give a client disputing the bill no way to tell which of OUR numbers was
// meant, which is worse than carrying no parcel detail at all.
//
// So everything in this file is a FACT ABOUT a charge, never an amount. The
// amounts on every sheet come from `order_charges` and nowhere else, which is
// why the sheets cannot disagree.

/**
 * The parcel a shipping charge billed, from its `charge_key`.
 *
 * `chargeKey` writes `shipment:<shipstation_shipment_id>` for charge_type
 * 'shipping' (charge-key.ts:74-75), and `shipstation_shipment_id` carries a
 * unique index (ledger_03_charges.sql:25-26). That makes this an exact 1:1
 * route from a billed freight line to its parcel -- which matching on
 * `order_number` is NOT, because an order that ships in three boxes has three
 * shipments and three shipping charges, and nothing in the order number says
 * which belongs to which.
 *
 * DELIBERATELY STRICT. Two neighbouring key namespaces must not match here:
 *
 *   `return:<id>`          a return is not the shipment it reverses, and
 *                          charge-key.ts:77-94 records the collision that
 *                          proved it -- a return silently overwriting the
 *                          outbound shipping charge it was meant to sit beside.
 *   `shipment:<id>:<code>` a carrier surcharge on that parcel. Real money, but
 *                          its own line with its own label; folding it into the
 *                          parcel's shipping row would make the freight figure
 *                          on the shipments sheet disagree with the same
 *                          parcel's lines on the charges sheet.
 *
 * Both appear on the Charges sheet with their order number, like any other
 * charge. Only the parcel's own shipping line drives the Shipments sheet.
 */
const SHIPMENT_KEY = /^shipment:(\d+)$/

export function shipmentIdFromChargeKey(chargeKey: string): string | null {
  const matched = SHIPMENT_KEY.exec(chargeKey)
  return matched === null ? null : matched[1]
}

/**
 * Ids per `.in()` request.
 *
 * PostgREST puts filters in the QUERY STRING, so `.in('id', ids)` with a few
 * thousand UUIDs builds a URL that the server rejects outright. That failure
 * does not exist on a small client and appears, without any code changing, on
 * the first client big enough to produce it -- the same shape of latent defect
 * as the 1000-row read cap this module's pager exists for.
 *
 * 150 UUIDs is roughly 5.5 KB of URL, well inside every limit in the path.
 */
export const IN_CHUNK = 150

/**
 * One read per chunk of ids, with the pages of each chunk collected.
 *
 * Returns the same `PageResult` shape as a single read, so a failure here
 * refuses the whole export exactly like a failed charges read. Rows already
 * gathered are DISCARDED on error rather than returned: a prefix of the join
 * would render as a sheet where some parcels simply have no carrier, which
 * reads as missing data about the shipment rather than a failed read.
 */
async function readChunked<T>(
  ids: string[],
  read: (chunk: string[]) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = []
  // No ids means no request. `.in('id', [])` is a round trip whose answer is
  // known, and on an empty period there is nothing to look up at all.
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + IN_CHUNK))
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
  }
  return { data: rows, error: null }
}

export interface OrderNumberRow {
  id: string
  order_number: string
}

/** The client-facing order number for each order id, deduplicated. */
export function readOrderNumbers(
  orderIds: string[],
): Promise<PageResult<OrderNumberRow>> {
  const unique = [...new Set(orderIds)]
  return readChunked(unique, chunk => readAllPages((from, to) => supabaseAdmin
    .from('orders')
    .select('id, order_number')
    .in('id', chunk)
    .order('id')
    .range(from, to)))
}

export interface ShipmentFactsRow {
  shipstation_shipment_id: number | string | null
  ship_date: string | null
  carrier: string | null
  service: string | null
  tracking_number: string | null
  weight: Money
  recipient_city: string | null
  recipient_state: string | null
  recipient_zip: string | null
}

/**
 * Carrier, service, tracking, weight and destination for each parcel.
 *
 * NOT filtered by client_id, on purpose. The ids arrive from the `charge_key`
 * of a charge that `order_charges.client_id` already attributes to this client,
 * and `shipstation_shipment_id` is unique, so the charge is the stronger link.
 * Adding `.eq('client_id', ...)` would blank the carrier and tracking for any
 * parcel whose `shipments` row is unattributed -- and 241 shipments from nine
 * unmapped stores are in exactly that state right now, so the filter would
 * quietly strip detail from freight the client is genuinely being billed for.
 *
 * `actual_cost` and `profit_loss` are absent and must stay absent. This file
 * feeds a workbook that gets emailed to the client; what we paid the carrier
 * and what we made on the parcel are not theirs to read.
 */
export function readShipmentFacts(
  shipmentIds: string[],
): Promise<PageResult<ShipmentFactsRow>> {
  const unique = [...new Set(shipmentIds)]
  return readChunked(unique, chunk => readAllPages((from, to) => supabaseAdmin
    .from('shipments')
    // ONE string literal, not a concatenation. supabase-js infers the row shape
    // by parsing this select as a LITERAL type, and `'a' + 'b'` widens to
    // `string` in TypeScript -- so splitting it across lines to keep the line
    // short silently collapses the inferred row to GenericStringError and every
    // field read off it becomes an error instead of a column. Kept on one line
    // for that reason; the return annotation above is what catches it.
    .select('shipstation_shipment_id, ship_date, carrier, service, tracking_number, weight, recipient_city, recipient_state, recipient_zip')
    .in('shipstation_shipment_id', chunk)
    .order('shipstation_shipment_id')
    .order('id')
    .range(from, to)))
}

/** `shipstation_shipment_id` as the string form `charge_key` uses. */
export function factsByShipmentId(
  rows: ShipmentFactsRow[],
): Map<string, ShipmentFactsRow> {
  const out = new Map<string, ShipmentFactsRow>()
  for (const row of rows) {
    // The column is a bigint, which arrives from PostgREST as a number or a
    // string depending on magnitude. Keyed as a string so the join does not
    // depend on which, and skipped when null -- a parcel with no ShipStation id
    // (the stamps_com rows) cannot be matched to a charge key that is built
    // from one, and a `'null'` key would match nothing while looking like it
    // might.
    if (row.shipstation_shipment_id === null) continue
    out.set(String(row.shipstation_shipment_id), row)
  }
  return out
}

/** `city, ST zip`, skipping whatever the carrier did not report. */
export function destinationOf(row: ShipmentFactsRow): string {
  const city = (row.recipient_city ?? '').trim()
  const state = (row.recipient_state ?? '').trim()
  const zip = (row.recipient_zip ?? '').trim()
  const tail = [state, zip].filter(p => p !== '').join(' ')
  return [city, tail].filter(p => p !== '').join(', ')
}

/** A shipping charge, with the parcel it billed where we could find it. */
export interface ShipmentLine {
  ship_date: string
  order_number: string
  carrier: string
  service: string
  tracking_number: string
  weight: number | null
  destination: string
  /** Straight off the charge. The only money on this sheet. */
  amount: Money
  /** False when no `shipments` row matched, so the blanks can be explained. */
  matched: boolean
}

/** The minimum of a charge row this join needs. Keeps the test honest. */
export interface JoinableCharge {
  charge_type: string
  charge_date: string
  order_id: string | null
  charge_key: string
  amount: Money
}

/**
 * One row per shipping charge, in charge order, with parcel facts attached.
 *
 * Driven by the CHARGES and not by the shipments table, which is what keeps
 * this sheet's total equal to the statement's shipping line. A sheet built by
 * reading every shipment in the date window would include parcels the ledger
 * has not billed and exclude billed ones whose ship date straddles the period
 * boundary in the warehouse's timezone -- so it would be a different claim
 * about the period than the total it sits beside, in the same file.
 *
 * `unmatched` is returned rather than logged. A row with no carrier and no
 * tracking looks like a parcel we failed to record, and the file has to be able
 * to say the honest thing instead: the charge is real, and the parcel behind it
 * could not be found.
 */
export function buildShipmentLines(
  charges: JoinableCharge[],
  orderNumbers: Map<string, string>,
  facts: Map<string, ShipmentFactsRow>,
): { lines: ShipmentLine[]; unmatched: number } {
  const lines: ShipmentLine[] = []
  let unmatched = 0

  for (const charge of charges) {
    if (charge.charge_type !== 'shipping') continue
    const shipmentId = shipmentIdFromChargeKey(charge.charge_key)
    const parcel = shipmentId === null ? undefined : facts.get(shipmentId)
    if (parcel === undefined) unmatched += 1

    lines.push({
      // The CHARGE's date, not the parcel's `ship_date`. They are the same fact
      // -- the ledger stamps charge_date from the ship date
      // (calculate-charges.ts:384-385) -- but only charge_date is what the
      // period was filtered on, so only it is guaranteed to fall inside the
      // period this sheet is headed with.
      ship_date: charge.charge_date,
      order_number: charge.order_id === null
        ? ''
        : orderNumbers.get(charge.order_id) ?? '',
      carrier: parcel?.carrier ?? '',
      service: parcel?.service ?? '',
      tracking_number: parcel?.tracking_number ?? '',
      weight: parcel === undefined ? null : priceOf(parcel.weight),
      destination: parcel === undefined ? '' : destinationOf(parcel),
      amount: charge.amount,
      matched: parcel !== undefined,
    })
  }

  return { lines, unmatched }
}

/**
 * The sentence that explains blank carrier columns, or '' when none are blank.
 *
 * Worded as a statement about OUR records rather than about the shipment,
 * because that is which of the two we actually know. Mirrors the coverage and
 * unpriced notes the statement already carries.
 */
export function unmatchedParcelNote(unmatched: number): string {
  if (unmatched <= 0) return ''
  const s = unmatched === 1
    ? '1 shipping charge'
    : `${unmatched} shipping charges`
  const its = unmatched === 1 ? 'its' : 'their'
  return `${s} could not be matched to a parcel record, so ${its} carrier, `
    + `tracking and weight are blank. The amount charged is unaffected and is `
    + `included in the total.`
}
