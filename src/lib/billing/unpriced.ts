// Telling an UNPRICED line from a free one, on screen and in a total.
//
// lib/billing/recalculate.ts now writes `client_rate: null` when the rate card
// does not cover a shipment, instead of the billable 0 it used to write. The
// point of that change was that the two things stop looking alike. They still
// look alike, because every read site in the app does one of exactly two
// things with the column:
//
//   ${(s.client_rate ?? 0).toFixed(2)}        -> renders UNKNOWN as "$0.00"
//   rows.reduce((s, r) => s + (r.client_rate ?? 0), 0)
//                                             -> drops UNKNOWN from the total
//
// Neither is a regression: the stored value used to BE 0, so the arithmetic is
// unchanged and no figure on any screen moves. But the first prints a price
// nobody agreed, and the second quietly understates revenue -- and because the
// row count above the total still includes the unpriced rows, the total and
// the count disagree with nothing to say why. Today the only place that
// mentions it at all is the monitor's email, which nobody reads at the moment
// they are looking at a revenue figure.
//
// A sum therefore returns the count it withheld along with the total, so the
// caller has to have the number in hand to render the total at all. That is
// the whole design: `sumPriced` cannot be used without being told what it left
// out, where `?? 0` could be used without ever knowing.
//
// Pure, and in one place rather than inlined at the ~15 call sites, because two
// copies of this rule would drift and the drift would be in money. Component
// files cannot be tested here at all -- vitest.config.ts excludes `.test.tsx`
// -- which is the other reason the decision belongs in a .ts module.

/** Rendered in place of a price for a line nobody has priced. */
export const UNPRICED_DASH = '—'

/**
 * The same thing in a spreadsheet or PDF cell, spelled out.
 *
 * A dash is legible on screen next to a column of dollar figures; in a
 * downloaded workbook it reads as a formatting artefact. It is also
 * deliberately text rather than a number, so SUM() over the column skips it --
 * which is the honest arithmetic -- instead of quietly adding a zero.
 */
export const UNPRICED_CELL = 'UNPRICED'

/**
 * A money column's value as a number, or null for UNKNOWN.
 *
 * `numeric(10,2)` over PostgREST is not a shape worth betting a money figure
 * on, so a string is coerced rather than trusted -- `0 + '12.34'` is the
 * string '012.34', which would survive a `typeof === 'number'` check nowhere
 * and silently corrupt a total everywhere. Anything that will not coerce to a
 * finite number is UNKNOWN, not 0: a column holding something unreadable has
 * not told us the price is nothing.
 */
/**
 * A money column as it arrives from a read: `unknown`, deliberately.
 *
 * An alias rather than writing `unknown` at each of the forty-odd declaration
 * sites, so the reason lives in one place -- and the reason is that every
 * narrower type anyone would reach for here is a lie that compiles.
 *
 * Probed against a real `tsc --strict` run, on the three shapes these columns
 * are actually read with:
 *
 *                              (x ?? 0).toFixed(2)   s + (x ?? 0)   x != null && x.toFixed(2)
 *   number | null                     compiles         compiles         compiles
 *   number | string | null            TS2339           TS2365           TS2339
 *   unknown                           TS2339           TS2365           TS2339
 *
 * `number | null` is the tempting one and the dangerous one: it makes all three
 * broken forms type-check, so it would have silently blessed every defect this
 * module exists to remove. It is only defensible if `numeric(10,2)` is
 * guaranteed to arrive as a JS number, which is exactly the thing not verified
 * against this database.
 *
 * `unknown` is chosen over `number | string | null` because they reject the
 * same three forms and `unknown` claims less. Asserting the union would be
 * recording an unverified guess about the wire format in the type system, where
 * it reads as established fact; `unknown` records what is actually known, which
 * is that the value must pass through `priceOf` before anything is done with
 * it. If the shape is ever pinned down against the live database, narrowing
 * this one alias is the whole change.
 */
export type Money = unknown

export function priceOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** True when the column holds a price -- including a deliberate 0. */
export function isPriced(value: unknown): boolean {
  return priceOf(value) !== null
}

/**
 * '$12.34' for a price, including '$0.00' for a deliberate 0, and a dash for
 * UNKNOWN. The 0 is NOT dashed: 0 is a decision somebody made, and hiding it
 * behind the same mark as "we do not know" loses the distinction in the other
 * direction.
 */
export function formatPrice(value: unknown): string {
  const n = priceOf(value)
  return n === null ? UNPRICED_DASH : `$${n.toFixed(2)}`
}

/**
 * '+$12.34' / '$-12.34' for a price, and a dash for UNKNOWN.
 *
 * The sign is only meaningful once there IS a number: the profit column renders
 * with a leading '+' when it is not a loss, and `(x ?? 0) >= 0 ? '+' : ''`
 * decided that on a value that was never read, so an unpriced shipment showed
 * as a confident '+$0.00' break-even. The negative form keeps the existing
 * '$-12.34' placement rather than '-$12.34' so no figure already on screen
 * changes shape.
 */
export function formatSignedPrice(value: unknown): string {
  const n = priceOf(value)
  if (n === null) return UNPRICED_DASH
  return `${n >= 0 ? '+' : ''}${formatPrice(n)}`
}

/**
 * Several money columns on ONE row added together, or null if ANY of them is
 * UNKNOWN.
 *
 * For a figure assembled from parts, where a missing part makes the whole
 * meaningless rather than smaller. The P&L's campaign spend is
 * `monthly_cost + one_time_cost`, and `(c.monthly_cost ?? 0) + (c.one_time_cost
 * ?? 0)` reported a campaign nobody had costed as a campaign that cost
 * nothing -- then divided by it, producing an ROI percentage and a CAC of
 * $0.00 per client won. Those are not flattering estimates, they are fabricated
 * ones, and they are what decides next month's budget.
 *
 * Note the difference from `sumPriced`, which is deliberate. That one sums a
 * column DOWN many rows and reports a partial total beside the count it
 * withheld, because two of five shipments priced is still a real figure about
 * those two. This one sums ACROSS the parts of a single figure, where there is
 * no honest partial: half of a campaign's spend is not a smaller spend.
 *
 * No arguments is 0, not unknown -- the sum over an empty set, the same
 * distinction `totalOrUnknown` draws for `counted === 0`.
 */
export function sumAllOrUnknown(...values: unknown[]): number | null {
  let cents = 0
  for (const value of values) {
    const n = priceOf(value)
    if (n === null) return null
    cents += Math.round(n * 100)
  }
  return cents / 100
}

export interface PricedSum {
  /** Sum of the rows that have a price. Rounded to the cent. */
  total: number
  /** How many rows were left out because their price is UNKNOWN. */
  unpriced: number
  /** How many rows were considered. `priced + unpriced === counted`. */
  counted: number
}

/**
 * A sum's total, or null when the sum excluded EVERY row it counted.
 *
 * `sumPriced` returns `total: 0` for a column of nothing but nulls, which is
 * arithmetically right and, rendered, is a lie: a client whose three shipments
 * are all waiting on a carrier invoice had `+$0.00` printed in green beside a
 * ✓ on the dashboard. Zero priced rows is not a total of zero. It is the same
 * distinction the rest of this module exists for, one level up -- `priceOf`
 * separates an unknown price from a price of 0, and this separates an unknown
 * total from a total of 0.
 *
 * `counted === 0` is NOT unknown. A client with no shipments at all genuinely
 * has $0.00 of shipping revenue; that is a fact about an empty set, not a gap
 * in the data, and dashing it would hide a real zero behind the mark for
 * UNKNOWN -- the error this module was written to stop.
 *
 * A PARTIAL sum still returns its total, deliberately. Two of five rows priced
 * is a real figure about those two, and the caller is already obliged to
 * render `unpriced` beside it; collapsing partials to a dash would throw away
 * information the operator can act on.
 */
export function totalOrUnknown(sum: PricedSum): number | null {
  if (sum.counted > 0 && sum.unpriced === sum.counted) return null
  return sum.total
}

/**
 * The total of one money column, and what it left out.
 *
 * Returning the count is the point. A caller cannot render this total without
 * the number of rows missing from it being right there in the same object, so
 * "the total understates revenue and nothing says so" has to be a deliberate
 * choice rather than the default.
 */
export function sumPriced(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
  key: string,
): PricedSum {
  return sumMapped(rows, key, n => n)
}

/**
 * The same, over the MAGNITUDE of each value.
 *
 * For the loss report, whose figures are all "how much did we lose" -- a
 * positive number read off a negative column. That was five copies of
 * `s + Math.abs(r.profit_loss ?? 0)`, one per breakdown, which is the shape
 * this module exists to delete: `?? 0` cannot tell a loss of nothing from a
 * loss nobody has measured, and `Math.abs('')` is 0, so a column arriving
 * empty became a confident $0.00 loss in the middle of a loss total.
 *
 * Taking |n| AFTER priceOf rather than before is the whole point: the decision
 * about whether there is a number at all is made first, and only then is its
 * sign discarded.
 */
export function sumAbsPriced(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
  key: string,
): PricedSum {
  return sumMapped(rows, key, Math.abs)
}

/**
 * Shared body of the two sums above.
 *
 * Extracted rather than copied because the cents rule below is the one piece
 * of arithmetic in this module that is easy to get subtly wrong, and the
 * header's warning about two copies drifting applies most of all to it.
 */
function sumMapped(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
  key: string,
  map: (n: number) => number,
): PricedSum {
  let cents = 0
  let unpriced = 0
  let counted = 0
  for (const row of rows ?? []) {
    counted++
    const n = priceOf(row?.[key])
    // Accumulated in cents, because adding dollars as floats drifts: the
    // all-time revenue figure on the dashboard is a sum over every shipment
    // the business has ever made, and `0.1 + 0.2` is the standard reason a
    // figure like that ends in a stray fraction of a cent.
    if (n === null) unpriced++
    else cents += Math.round(map(n) * 100)
  }
  return { total: cents / 100, unpriced, counted }
}

/**
 * A PricedSum assembled one figure at a time.
 *
 * `sumPriced` covers the common shape: one column, many rows, all in hand at
 * once. This covers the other one -- a figure built from several columns of
 * several tables, visited in several loops. /pnl's per-client revenue is
 * shipping plus warehouse plus inbound, three separate reads with a loop each,
 * so there is no single array to hand to `sumPriced`.
 *
 * Written out by hand that becomes `a.rev += n` beside a separate
 * `a.unpriced++`, two statements that have to be kept in step by whoever edits
 * the loop next, and the one that gets forgotten is the count -- which is
 * exactly the figure `totalOrUnknown` needs to tell a revenue of zero from a
 * revenue nobody could read. `take` makes the addition and the count one
 * statement, so forgetting the count is no longer possible.
 *
 * `counted` goes up for every figure offered, readable or not, which is what
 * makes "every figure was withheld" distinguishable from "there were no
 * figures". A tally nothing was offered to is a real $0: the sum over an empty
 * set, the same distinction `totalOrUnknown` draws.
 */
export interface PricedTally {
  /** Record one figure, readable or not. */
  take(value: unknown): void
  /** What has been recorded so far. */
  sum(): PricedSum
}

export function pricedTally(): PricedTally {
  let cents = 0
  let unpriced = 0
  let counted = 0
  return {
    take(value: unknown) {
      counted++
      const n = priceOf(value)
      // Cents, for the reason given in sumMapped: these totals are sums over
      // every shipment a client has ever had, and dollars added as floats
      // drift. Keeping the rule identical to the other accumulator in this
      // module is the point -- two sums of the same money that round
      // differently would disagree in the last cent on screen.
      if (n === null) unpriced++
      else cents += Math.round(n * 100)
    },
    sum() {
      return { total: cents / 100, unpriced, counted }
    },
  }
}

/**
 * Add two or more incomplete totals without losing what they left out.
 *
 * The dashboard's weekly revenue is shipment revenue plus warehouse revenue
 * plus manual charges, and the first two columns are BOTH nullable now
 * (`client_rate` from recalculate.ts, `warehouse_daily_log.total` from the
 * daily-log route). Writing `a.total + b.total` is where the counts would get
 * dropped -- the sums each know what they withheld and the addition throws it
 * away. So the addition is here, with the counts carried through it.
 */
export function combinePriced(...parts: PricedSum[]): PricedSum {
  let cents = 0
  let unpriced = 0
  let counted = 0
  for (const p of parts) {
    cents += Math.round(p.total * 100)
    unpriced += p.unpriced
    counted += p.counted
  }
  return { total: cents / 100, unpriced, counted }
}

/**
 * One short clause naming what a total leaves out, or '' when it leaves out
 * nothing.
 *
 * '' and not 'all priced', so that a surface showing this renders nothing at
 * all in the ordinary case. A permanent all-clear next to every total is how a
 * real warning stops being read.
 */
export function unpricedNote(unpriced: number, noun = 'shipment'): string {
  if (unpriced <= 0) return ''
  return `${unpriced} unpriced ${unpriced === 1 ? noun : `${noun}s`} `
    + `not included`
}
