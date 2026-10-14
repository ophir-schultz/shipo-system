import {
  priceOf, sumPriced, combinePriced, totalOrUnknown,
  type Money, type PricedSum,
} from '@/lib/billing/unpriced'
import { warehouseParts } from '@/lib/ledger/pick-date'

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

/**
 * The day the business is currently on, as 'YYYY-MM-DD'.
 *
 * Derived from warehouseParts, which is the function that decides which
 * `charge_date` a pick gets in the first place (pick-date.ts, used at
 * calculate-charges.ts:212). The shared origin is the point: computing "today"
 * any other way -- `new Date().toISOString().slice(0, 10)` being the obvious one
 * -- means that for the hours between warehouse midnight and UTC midnight the
 * day grain asks for a date the ledger is not yet writing, so "today" renders an
 * empty statement while the warehouse is packing. The period boundary and the
 * data's own day boundary have to be the same boundary.
 *
 * Takes `now` so it can be tested, and so a caller can reproduce a statement as
 * of some past moment.
 */
export function statementToday(now: Date = new Date()): string {
  return warehouseParts(now).date
}

/**
 * The grains the statement screen offers.
 *
 * Every one of them is a CALENDAR period containing today, inclusive at both
 * ends. That is the invariant, not an accident of which five happen to be here,
 * and 'half-year' was chosen over the two other readings of "six months" to
 * keep it:
 *
 *   calendar half   Jan 1..Jun 30 / Jul 1..Dec 31   <- this one
 *   trailing six    today - 6 months .. today
 *   last six whole  the six completed months before this one
 *
 * The trailing window is the one a reader assumes, and it is the one that must
 * not exist here. A statement is a document that gets SENT, beside an amount,
 * and a trailing window means two statements both headed "the last six months"
 * sent a week apart cover different, overlapping periods -- neither of which
 * adds up against the monthly invoices the client has already been given. The
 * calendar half is additive with the month grain by construction. "Last six
 * whole months" reconciles too, but it is the only period that would not
 * contain the day it was asked on, which is a property every grain here has and
 * one the tests assert for all of them.
 *
 * The cost of the calendar reading, stated plainly so nobody reports it as a
 * bug: opened in January, 'This half-year' holds a few days. Same as 'This
 * year', which has shipped that way from the start.
 */
export type Grain = 'day' | 'week' | 'month' | 'half-year' | 'year'

export const GRAINS: readonly Grain[] = ['day', 'week', 'month', 'half-year', 'year'] as const

/**
 * What to call each grain in a picker.
 *
 * A `Record<Grain, string>` and not an array of {grain, label} pairs, because
 * the type then REFUSES to compile when a grain has no label. That is the whole
 * point of it: `year` shipped implemented, tested and reachable by URL while
 * the screen's hand-written list of three quietly did not offer it, so the
 * feature existed and nobody could click it. A hand-written list cannot be
 * wrong in a way the compiler notices; this can only be wrong in a way it does.
 *
 * Pickers should render `GRAINS.map(...)` over this, so the order comes from
 * one place too -- shortest period first, which puts the heaviest read last.
 */
export const GRAIN_LABELS: Record<Grain, string> = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
  // Named for what it IS and not for what it was asked for. "Last 6 months"
  // would be a false label on this period: it is the calendar half containing
  // today, so in October it runs forward to December 31 and backward only to
  // July 1. A label promising a trailing six months over a figure covering
  // three and a half is the error this grain was most likely to ship with.
  'half-year': 'This half-year',
  year: 'This year',
}

/**
 * Is this string one of the grains?
 *
 * A guard and not a `as Grain` cast, because the value arrives from a query
 * string. `?grain=weekly` cast to Grain falls through every branch of
 * periodRange and lands on the year arm -- so a typo in a link would produce a
 * TWELVE MONTH statement under a heading the caller believed said week, which is
 * the single worst wrong answer this function can give. The caller is made to
 * decide what an unrecognised grain means instead.
 */
export function isGrain(value: string | null | undefined): value is Grain {
  return typeof value === 'string' && (GRAINS as readonly string[]).includes(value)
}

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

  if (grain === 'half-year') {
    // January..June is the first half, July..December the second. `m` is
    // 1-based here, so months 1-6 start at 0-based month index 0 and months
    // 7-12 start at 6 -- and `start + 6` with day 0 is the last day of the
    // half, the same next-month-day-0 trick the month arm uses. Nothing here
    // needs to know that a half is 181, 182 or 184 days long.
    const start = m <= 6 ? 0 : 6
    return { from: fmt(Date.UTC(y, start, 1)), to: fmt(Date.UTC(y, start + 6, 0)) }
  }

  return { from: fmt(Date.UTC(y, 0, 1)), to: fmt(Date.UTC(y, 11, 31)) }
}

/**
 * A period asked for in a query string, in either of the two forms.
 *
 * Strings and not `Grain`/`DateRange`, because this is the UNVALIDATED request.
 * The whole purpose of resolvePeriod is to be the one place that turns these
 * into a period or refuses, so a caller that had already narrowed them would
 * have done the dangerous half of the job somewhere else.
 */
export interface PeriodRequest {
  grain?: string | null
  from?: string | null
  to?: string | null
}

export type PeriodResolution =
  | {
      ok: true
      range: DateRange
      /**
       * The calendar grain the range came from, or null when the caller named
       * explicit dates.
       *
       * Null is not "unknown" here, it is "there isn't one" -- an arbitrary
       * from/to is not a calendar period and must not be labelled as one. A
       * range of 2026-10-01..2026-10-31 asked for explicitly happens to equal
       * 'month', and saying `(month)` on it would be a claim about how it was
       * derived that the next period's boundary will not honour.
       */
      grain: Grain | null
    }
  | { ok: false; error: string }

/**
 * The period a request is asking for: a calendar grain, or two explicit dates.
 *
 * WHY BOTH FORMS EXIST, AND WHY ONE FUNCTION.
 *
 * /statements offers a grain dropdown, because an invoice period is a calendar
 * claim (see the Grain docstring). /reports has free From and To date inputs
 * shared by every tab, and the Statement tab inside it cannot grow its own
 * second period control without the screen asking two different questions at
 * once. So the statement has to accept both -- and the moment two call sites
 * each parse the period their own way, they disagree about a boundary day
 * exactly once, quietly, on the document that gets attached to an invoice.
 *
 * REFUSES ON AMBIGUITY RATHER THAN PICKING.
 *
 * `?grain=week&from=2026-01-01&to=2026-12-31` is two contradictory claims about
 * what period is being requested. Either answer would be defensible and both
 * would be a guess, and the caller gets back a figure headed with a period it
 * did not choose. A precedence rule would make that silent forever; refusing
 * makes the bad link show up the first time anyone follows it.
 *
 * A HALF-SPECIFIED RANGE IS ALSO A REFUSAL.
 *
 * `?from=2026-10-01` with no `to` is the shape a dropped parameter takes.
 * Defaulting the missing end to today, or to the end of time, turns a typo into
 * a plausible-looking statement over the wrong period -- the same failure the
 * Grain guard exists to prevent, arriving through a different parameter.
 *
 * A REVERSED RANGE IS NOT AN EMPTY PERIOD.
 *
 * `from > to` matches no rows in `.gte(from).lte(to)`, so it reads back as a
 * confident $0.00 for a client who was in fact invoiced. That is the single
 * most dangerous wrong answer available here, and it costs one comparison.
 *
 * Deliberately NOT capped in length. An explicit decade would be slow and might
 * exceed the download route's budget, but refusing it would mean inventing a
 * limit nobody asked for and having it reject a legitimate backfill; the route
 * already documents its cost against the 'year' grain and the failure mode of a
 * too-long read is a timeout, not a wrong number.
 */
export function resolvePeriod(
  req: PeriodRequest,
  today: string = statementToday(),
): PeriodResolution {
  // '' is treated as absent throughout. `searchParams.get('from')` returns ''
  // for `?from=` and null for a parameter that is not there, and those are the
  // same request as far as anyone typing a link is concerned -- so they must
  // not take different paths. Same rule isReportType applies.
  const has = (v: string | null | undefined): v is string =>
    typeof v === 'string' && v !== ''

  const grain = has(req.grain) ? req.grain : null
  const from = has(req.from) ? req.from : null
  const to = has(req.to) ? req.to : null

  if (grain !== null && (from !== null || to !== null)) {
    return {
      ok: false,
      error: `A period was asked for twice: grain ${JSON.stringify(grain)} and `
        + `dates ${JSON.stringify(from)}..${JSON.stringify(to)}. Send one or `
        + `the other, because picking between them would head a figure with a `
        + `period the caller did not choose.`,
    }
  }

  if (grain !== null) {
    if (!isGrain(grain)) {
      return {
        ok: false,
        error: `Unknown period ${JSON.stringify(grain)}. Expected one of `
          + `${GRAINS.join(', ')}. An unrecognised grain would otherwise fall `
          + `through to a year, and a year of revenue under a heading that says `
          + `week is the worst wrong answer this can give.`,
      }
    }
    return { ok: true, range: periodRange(grain, today), grain }
  }

  if (from === null && to === null) {
    return {
      ok: false,
      error: `No period was asked for. Send either grain=<${GRAINS.join('|')}> `
        + `or both from= and to= as YYYY-MM-DD.`,
    }
  }
  if (from === null || to === null) {
    return {
      ok: false,
      error: `Half a period: ${from === null ? 'from' : 'to'} is missing. Both `
        + `ends are required, because defaulting the other one would turn a `
        + `dropped parameter into a statement over a period nobody asked for.`,
    }
  }

  // parseDay throws on a malformed or non-real date ('2026-02-30'). Caught
  // rather than propagated: this function's contract is to return a refusal a
  // route can render as a 400, and a thrown error from a query-string read
  // lands as a 500, which reads as "the server is broken" rather than "the
  // link is wrong".
  try {
    parseDay(from)
    parseDay(to)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (from > to) {
    // Lexicographic on YYYY-MM-DD is chronological, which is why these are
    // compared as strings and no Date is constructed.
    return {
      ok: false,
      error: `The period runs backwards: from ${from} is after to ${to}. That `
        + `matches no charges at all, which would render as a confident $0.00 `
        + `rather than as the bad request it is.`,
    }
  }

  return { ok: true, range: { from, to }, grain: null }
}

/** One row of `order_charges`, as the statement reads it. */
export interface StatementCharge {
  charge_type: string
  label: string
  quantity: Money
  amount: Money
  /** The rate off the client's price list that this one row was priced at. */
  unit_rate?: Money
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
  /**
   * The rate off the price list that EVERY row on this line shares, or null when
   * they do not share one.
   *
   * The rate is the column a client checks first -- it is the one figure on the
   * statement they can compare against the agreement they signed. Rows grouped
   * into one line need not agree about it: a rate card edited mid-period prices
   * Monday's picks at one rate and Friday's at another, and both land on the
   * same line. Printing `rows[0].unit_rate` there would state a rate that
   * produced only some of the amount beside it, and the arithmetic would not
   * check out for the client doing exactly what the column invites.
   *
   * So a disagreement is reported as a disagreement. `rates` below says how big
   * one it is, and the screen prints that instead of a number.
   */
  unit_rate: number | null
  /**
   * How many DISTINCT rates the rows on this line were priced at.
   *
   * 0 -- no row carries a rate at all. Normal for an at-cost freight line,
   *      which is billed at whatever the carrier charged.
   * 1 -- one rate, in `unit_rate`.
   * 2+ -- the rate changed inside the period. Worth surfacing rather than
   *      averaging away: it is either a deliberate price change the client
   *      should see on the statement that straddles it, or a rate card edit
   *      nobody meant to backdate.
   */
  rates: number
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
    // Collected as a set, so the answer to "what rate is this" is derived from
    // every row rather than from whichever one the ledger happened to write
    // first. Values are compared as they were parsed and not rounded: two rates
    // that differ in the fourth decimal (unit_rate is numeric(10,4)) are two
    // rates, and rounding them together to print one would be the same lie in a
    // smaller font.
    const rates = new Set<number>()
    for (const r of rows) {
      const n = priceOf(r.quantity)
      if (n !== null) qty = (qty ?? 0) + n
      const rate = priceOf(r.unit_rate)
      if (rate !== null) rates.add(rate)
    }

    lines.push({
      charge_type: rows[0].charge_type,
      label: rows[0].label,
      quantity: qty === null ? null : Math.round(qty * 100) / 100,
      unit_rate: rates.size === 1 ? [...rates][0] : null,
      rates: rates.size,
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
