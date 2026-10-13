import {
  priceOf, sumPriced, combinePriced, totalOrUnknown,
  type Money, type PricedSum,
} from '@/lib/billing/unpriced'

// What a client is owed for a period, assembled from the charges the ledger
// already priced.
//
// This does NOT re-price anything. `order_charges` is the ledger's output: one
// row per billable line, with `quantity`, the `unit_rate` taken from that
// client's rate card, and `amount` already computed (calculate-charges.ts:203
// for pick, :236 for pack, :370 for shipping, :430 for surcharges). Re-deriving
// a price here would be a second pricing implementation that silently disagrees
// with the one that writes the ledger, and the disagreement would surface as two
// screens quoting different figures for the same week.
//
// So the only arithmetic in this file is a GROUPED SUM, and even that defers to
// sumPriced for the cents rule and the unknown-handling.
//
// WHY `amount` MAY BE NULL, AND WHY THAT IS NOT ZERO.
//
// order_charges.amount is nullable on purpose (ledger_03_charges.sql:66-71): an
// at-cost freight line is billed at whatever the carrier charged, so until the
// carrier reports, the revenue is UNKNOWN. Summing those as 0 does not make the
// statement smaller, it makes it WRONG and confident -- and this is the document
// that gets attached to an invoice. Every total here therefore carries the count
// of rows it could not include, and the screen is obliged to render it.
//
// PERIODS ARE CALENDAR PERIODS, NOT TRAILING WINDOWS.
//
// "What he made this month" means the 1st to today's month end, not the last 30
// days. An invoice period is a calendar claim -- it has to line up with the one
// the client's own books use, and with the next period's, or two consecutive
// statements double-count their overlap or leave a gap.

/** The grains the statement screen offers. */
export type Grain = 'day' | 'week' | 'month' | 'year'

export const GRAINS: readonly Grain[] = ['day', 'week', 'month', 'year'] as const

export interface DateRange {
  /** Inclusive 'YYYY-MM-DD'. */
  from: string
  /** Inclusive 'YYYY-MM-DD'. Matches the .gte/.lte the export route runs. */
  to: string
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse 'YYYY-MM-DD' to a UTC timestamp, or throw.
 *
 * UTC throughout, and never `new Date('2026-10-13')` plus local getters. A local
 * -timezone read of a date-only string is a different calendar day west of
 * Greenwich for most of the UTC day, so "today" on a machine in Los Angeles
 * would start the month on the 30th of the previous one. The server this runs on
 * is not in the operator's timezone and neither is Vercel's.
 *
 * Throwing rather than returning a fallback: a period is the claim the whole
 * statement makes, and computing one from an unparseable date would put a real
 * -looking figure under the wrong heading. Refusing is the doctrine everywhere
 * else in this codebase and it applies hardest here.
 */
function parseDay(day: string): { y: number; m: number; d: number; ms: number } {
  const m = DATE.exec(day)
  if (!m) throw new Error(`statement period: '${day}' is not a YYYY-MM-DD date`)
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  // Catches '2026-02-30' and '2026-13-01', which Date.UTC rolls over into a
  // different real day rather than rejecting.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new Error(`statement period: '${day}' is not a real date`)
  }
  return { y, m: mo, d, ms }
}

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const DAY_MS = 86_400_000

/**
 * The calendar period of `grain` that contains `today`.
 *
 * Weeks run Monday to Sunday. Not a preference: `getUTCDay()` calls Sunday 0,
 * and taking that as the start would split every working week across two
 * statements.
 */
export function periodRange(grain: Grain, today: string): DateRange {
  const { y, m, ms } = parseDay(today)

  if (grain === 'day') return { from: today, to: today }

  if (grain === 'week') {
    // Sunday (0) is 6 days from Monday, every other day is `dow - 1`.
    const dow = new Date(ms).getUTCDay()
    const start = ms - ((dow + 6) % 7) * DAY_MS
    return { from: fmt(start), to: fmt(start + 6 * DAY_MS) }
  }

  if (grain === 'month') {
    // Day 0 of the NEXT month is the last day of this one, which is how the
    // leap-year and 30/31 cases are got right without a table of month lengths.
    return { from: fmt(Date.UTC(y, m - 1, 1)), to: fmt(Date.UTC(y, m, 0)) }
  }

  return { from: fmt(Date.UTC(y, 0, 1)), to: fmt(Date.UTC(y, 11, 31)) }
}

/** One row of `order_charges`, as the statement reads it. */
export interface StatementCharge {
  charge_type: string
  label: string
  quantity: Money
  amount: Money
  is_estimate?: boolean
}

export interface StatementLine {
  charge_type: string
  label: string
  /**
   * Units billed on this line -- the pick and pack COUNTS the operator asked to
   * see -- or null when no charge of this kind carries a quantity.
   *
   * Null rather than 0 for the same reason as everywhere else: a peak surcharge
   * is a percentage of a basis and has `quantity: null`
   * (calculate-charges.ts:432). Rendering that as a quantity of 0 states that
   * nothing was handled, beside a charge for handling it.
   */
  quantity: number | null
  /** The money, and the rows it had to leave out. */
  sum: PricedSum
  /** How many of these rows the ledger flagged as an estimate, not a measure. */
  estimated: number
}

export interface Statement extends DateRange {
  lines: StatementLine[]
  /** Every line combined. */
  sum: PricedSum
  estimated: number
}

/**
 * Charges grouped into the lines a client sees, for a period.
 *
 * Grouped by `charge_type` AND `label`, because the label carries the variant
 * the rate card priced -- 'Pick — single' and 'Pick — multi' are different rates
 * and collapsing them hides the thing the client is being asked to check.
 *
 * Rows are NOT filtered by date here. The caller selects the period in SQL, so
 * filtering again in JS would be a second implementation of the range rule and
 * the two would disagree about a boundary day exactly once, quietly. The same
 * argument date-range.ts settles for the screens.
 */
export function buildStatement(
  charges: ReadonlyArray<StatementCharge> | null | undefined,
  range: DateRange,
): Statement {
  const groups = new Map<string, StatementCharge[]>()
  for (const c of charges ?? []) {
    // Joined on an escaped NUL, which no charge_type or label can contain, so
    // two different (type, label) pairs cannot collide into one key. Written
    // as \u0000 and not as a literal byte: a raw NUL makes this a binary file
    // to git, grep and every editor, which is how a money-path source file
    // quietly stops being searchable.
    const key = `${c.charge_type}\u0000${c.label}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(c)
    else groups.set(key, [c])
  }

  const lines: StatementLine[] = []
  for (const [, rows] of groups) {
    // Quantities are summed only over rows that HAVE one. A line where some
    // rows carry a quantity and others do not still reports the units it knows
    // about; a line where none do reports null.
    let qty: number | null = null
    for (const r of rows) {
      const n = priceOf(r.quantity)
      if (n !== null) qty = (qty ?? 0) + n
    }

    lines.push({
      charge_type: rows[0].charge_type,
      label: rows[0].label,
      quantity: qty === null ? null : Math.round(qty * 100) / 100,
      sum: sumPriced(rows, 'amount'),
      estimated: rows.filter(r => r.is_estimate === true).length,
    })
  }

  // Stable and meaningful: charge type first so pick/pack/shipping stay in
  // blocks, then label alphabetically. Map iteration order would otherwise make
  // the line order depend on which charge happened to be written first, so two
  // statements for the same client could list the same lines differently.
  lines.sort((a, b) =>
    a.charge_type.localeCompare(b.charge_type) || a.label.localeCompare(b.label))

  return {
    from: range.from,
    to: range.to,
    lines,
    sum: combinePriced(...lines.map(l => l.sum)),
    estimated: lines.reduce((n, l) => n + l.estimated, 0),
  }
}

/**
 * The statement's grand total, or null when every row in it is UNKNOWN.
 *
 * A thin pass-through to totalOrUnknown, named here so a caller reaching for
 * `statement.sum.total` has to walk past the thing that tells it the total may
 * be a lie. `sum.total` of 0 means either "nothing was billed" or "nothing could
 * be priced", and those must not render the same on a document sent to a client.
 */
export function statementTotal(s: Statement): number | null {
  return totalOrUnknown(s.sum)
}
