/**
 * Activity: what shipped, in units, with no money in it anywhere.
 *
 * Spec: docs/superpowers/specs/2026-10-20-partner-dashboard-v2-design.md §4.1-4.2
 *
 * Finding 2 of that spec: the shipped partner statement printed the amount
 * billed on every individual order, and `amount / quantity` on a line item IS
 * the rate card. Several referral partners are agencies who also resell
 * fulfilment. So the per-order AMOUNT goes away and the per-order UNIT COUNT
 * replaces it. The partner keeps the thing he actually asked for -- proof that
 * his clients are live and busy -- and loses the one thing he was never meant
 * to have.
 *
 * Month-level money does NOT go away; it lives in the statement's own sections,
 * sourced from `partner_client_monthly`. What goes away is money PER ORDER.
 *
 * Two rules this file is built around, both of which this repo has been bitten
 * by in production:
 *
 *   1. `sum` SKIPS NULLS. A month total built by adding up order units reads
 *      LOW when one order's count is unknown, and a low number presented as a
 *      complete total is worse than no number at all. Every total here carries
 *      `unitsUnknownOrders` beside it and the renderer must never print one
 *      without the other.
 *   2. NULL IS NOT ZERO. An FBA month nobody has typed yet and an FBA month
 *      that genuinely shipped nothing are different facts. Collapsing them
 *      tells a partner his month was empty when the truth is that no staff
 *      member has got to it yet.
 */

/** One row of `public.partner_order_units`. There is no amount column. */
export interface OrderUnitsRow {
  period_month: string
  client_id: string
  client_name: string | null
  referral_partner_id: string | null
  order_date: string | null
  order_number: string | null
  units: number | null
  units_estimated: boolean | null
}

export interface ActivityClientMonth {
  clientId: string
  clientName: string
  periodMonth: string
  orders: OrderUnitsRow[]
  /** Sum of the KNOWN unit counts. Meaningless without the counter below. */
  totalUnits: number
  /** True when any order in the group fell back to ordered quantity. */
  unitsEstimated: boolean
  /** How many orders in the group have no readable unit count at all. */
  unitsUnknownOrders: number
}

export interface FbaInvoiceActivity {
  client_id: string
  period: string
  units_shipped: number | null
}

export interface ActivityClient {
  id: string
  name: string | null
}

export interface FbaActivityRow {
  clientId: string
  clientName: string
  period: string
  /** null means nobody has recorded it. 0 means it shipped nothing. */
  unitsShipped: number | null
}

/**
 * How many order rows the statement will read.
 *
 * A partner with a busy client can have more orders in a year than anyone
 * wants on one page, and an unbounded read is a slow page that eventually
 * times out. The cap exists so the truncation can be ADMITTED on screen rather
 * than silently shortening the list.
 */
export const ORDER_UNITS_LIMIT = 2000

const PLACEHOLDER_CLIENT_NAME = 'Unnamed client'

/**
 * Parse a numeric column into a number, or null when it says nothing.
 *
 * `numeric(10,2)` does not arrive as a JS number reliably -- postgrest hands
 * some numerics over as strings. So '0' has to read as 0 and not as nothing.
 * But `Number('')` is 0, and an empty string in a numeric column is a column
 * written wrong, not a zero: reading it as 0 would state a figure nobody
 * entered. Hence the explicit empty check before the coercion.
 */
function toUnits(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Sum of floats, rounded off IEEE754 dust. 0.1 three times is 0.3, not 0.30000000000000004. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

const unitsFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/**
 * Render a unit count for a partner.
 *
 * The only function in this file that is allowed to say "not recorded yet",
 * and it says it for every input that is not a readable number -- including
 * NaN and garbage, because inventing a figure from garbage is the failure this
 * guards.
 */
export function fbaUnitsLabel(units: number | null | undefined): string {
  const n = toUnits(units)
  if (n === null) return 'not recorded yet'
  return unitsFormat.format(n)
}

/**
 * Group order rows into one block per client-month, newest month first.
 *
 * Grouped by client ID and NOT by client name: two real companies can share a
 * name, and merging them would attribute one's volume to the other.
 */
export function groupOrderUnits(rows: readonly OrderUnitsRow[]): ActivityClientMonth[] {
  const groups = new Map<string, ActivityClientMonth>()

  for (const r of rows) {
    const key = `${r.client_id}::${r.period_month}`
    let g = groups.get(key)
    if (!g) {
      g = {
        clientId: r.client_id,
        clientName: r.client_name ?? PLACEHOLDER_CLIENT_NAME,
        periodMonth: r.period_month,
        orders: [],
        totalUnits: 0,
        unitsEstimated: false,
        unitsUnknownOrders: 0,
      }
      groups.set(key, g)
    }
    g.orders.push(r)

    const units = toUnits(r.units)
    if (units === null) {
      // NOT `?? 0`. An order whose count we cannot read is counted here, where
      // the renderer has to acknowledge it, rather than added as a zero that
      // makes the total read low and look finished.
      g.unitsUnknownOrders += 1
    } else {
      g.totalUnits = round2(g.totalUnits + units)
    }

    // Sticky, and `=== true` so a null flag cannot read as estimated -- the
    // word has to mean something in the places it does appear.
    if (r.units_estimated === true) g.unitsEstimated = true
  }

  const out = [...groups.values()]
  for (const g of out) {
    g.orders.sort((a, b) => {
      // An undated order sorts last rather than crashing the comparator or
      // jumping to the top of the list as an empty string would.
      if (a.order_date === b.order_date) return (a.order_number ?? '').localeCompare(b.order_number ?? '')
      if (!a.order_date) return 1
      if (!b.order_date) return -1
      return b.order_date.localeCompare(a.order_date)
    })
  }
  out.sort((a, b) => {
    if (a.periodMonth !== b.periodMonth) return b.periodMonth.localeCompare(a.periodMonth)
    const byName = a.clientName.localeCompare(b.clientName)
    if (byName !== 0) return byName
    return a.clientId.localeCompare(b.clientId)
  })
  return out
}

/**
 * The FBA prep months, which are hand-typed by staff rather than derived.
 *
 * A client id with no entry in `clients` is DROPPED. The loader already scopes
 * both lists to one partner, so this restates the disclosure rule at the point
 * of use -- a helper that takes two lists can be called with mismatched ones,
 * and printing an unknown client with a blank name would still disclose a
 * period and a volume belonging to somebody else's client.
 */
export function fbaActivity(
  invoices: readonly FbaInvoiceActivity[],
  clients: readonly ActivityClient[],
): FbaActivityRow[] {
  const names = new Map(clients.map((c) => [c.id, c.name ?? PLACEHOLDER_CLIENT_NAME]))

  const out: FbaActivityRow[] = []
  for (const inv of invoices) {
    const name = names.get(inv.client_id)
    if (name === undefined) continue
    out.push({
      clientId: inv.client_id,
      clientName: name,
      period: inv.period,
      // null is preserved, not coerced: the month EXISTS because somebody
      // typed the row, and the renderer says "not recorded yet" for it.
      unitsShipped: toUnits(inv.units_shipped),
    })
  }

  out.sort((a, b) => {
    if (a.period !== b.period) return b.period.localeCompare(a.period)
    const byName = a.clientName.localeCompare(b.clientName)
    if (byName !== 0) return byName
    return a.clientId.localeCompare(b.clientId)
  })
  return out
}
