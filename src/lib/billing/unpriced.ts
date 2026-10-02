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

export interface PricedSum {
  /** Sum of the rows that have a price. Rounded to the cent. */
  total: number
  /** How many rows were left out because their price is UNKNOWN. */
  unpriced: number
  /** How many rows were considered. `priced + unpriced === counted`. */
  counted: number
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
    else cents += Math.round(n * 100)
  }
  return { total: cents / 100, unpriced, counted }
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
