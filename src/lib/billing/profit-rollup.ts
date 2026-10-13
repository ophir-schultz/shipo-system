// Revenue, carrier cost and margin that actually subtract.
//
// THE DEFECT THIS REPLACES.
//
// The dashboard's period card computed its three headline figures as three
// independent sums over three DIFFERENT row subsets:
//
//   revenue = sumPriced(shipments, 'client_rate')
//           + sumPriced(warehouse, 'total') + sumPriced(manual, 'amount')
//   cost    = sumPriced(shipments, 'actual_cost')
//   profit  = sumPriced(shipments, 'profit_loss')
//
// Each one is individually honest. `sumPriced` skips the rows it cannot read
// and hands back the count it withheld, and the card printed that count. The
// lie is not in any figure, it is in the STACK: three numbers in a column with
// a rule above the last one is a subtraction, and this one did not subtract.
//
//   * A shipment with an agreed rate and no carrier invoice yet contributes to
//     revenue and to neither of the other two. The card gained margin.
//   * A shipment we paid for with no agreed rate contributes to cost only. The
//     card lost margin.
//   * Warehouse lines and manual charges were folded into revenue and appear
//     in no cost and no profit at all, so every warehouse dollar widened the
//     gap by a dollar.
//
// Measured on production on 2026-10-13, the three cards read:
//
//   This Week    revenue - cost = -$120.07     profit shown: +$756.37
//   This Month   revenue - cost = -$332.97     profit shown: +$2,611.59
//   This Year    revenue - cost = -$7,252.77   profit shown: +$2,972.36
//
// All three periods were loss-making by their own two figures and all three
// printed a profit in green. This is the first screen anybody opens.
//
// WHAT THIS MODULE DOES INSTEAD.
//
// One row set, chosen as the rows where BOTH sides of the margin are known,
// and all three figures summed over it:
//
//   revenue = SUM(client_rate)   over the reconciled rows
//   cost    = SUM(actual_cost)   over the same rows
//   profit  = revenue - cost     DERIVED, not read from a column
//
// So `revenue - cost === profit` holds by construction rather than by luck, to
// the cent (see `reconcile` for why the identity is stated in cents and not in
// floats). A figure that cannot be wrong is better than a figure that is
// checked.
//
// WHAT IT COSTS, STATED PLAINLY.
//
// Revenue here is NARROWER than billable revenue: a shipment with an agreed
// rate whose carrier invoice has not landed is real money owed, and it is not
// in this revenue figure. That is the deliberate trade -- one reconciling
// triple over a narrower row set, with every excluded row counted and
// attributed to a reason, instead of three wider figures that contradict each
// other. The exclusions are not a footnote: `reconcile` partitions every row
// into exactly one of four buckets and the counts are part of the return type,
// so a caller cannot render the triple without having them in hand. Same design
// rule as `sumPriced` in ./unpriced one level down.
//
// Use `invoiceableRevenue` for the other question -- what to bill -- and label
// it as such. Two figures with two names is honest. One figure doing both jobs
// is what produced the numbers above.
//
// WHY THE BUCKETS ARE SEPARATE AND NOT ONE "incomplete" COUNT.
//
// They send you to three different places, and one of them is urgent:
//
//   unrated     We paid a carrier and nobody agreed a price. Work going out
//               the door unbilled. The production monitor reports 218
//               shipments with a NULL rate, so this bucket is not theoretical.
//   uncosted    A rate exists, the carrier has not billed yet. Nothing to fix;
//               it resolves itself when the invoice lands.
//   unmeasured  Neither. Usually a sync that half-landed.
//
// Collapsing them loses the distinction between "go and write a rate card" and
// "wait".

import { priceOf, type Money, type PricedSum, combinePriced, sumPriced } from './unpriced'

/**
 * The three money columns this module reads off a shipment.
 *
 * `Money` (= `unknown`) rather than `number | null` for the reason given at
 * length in ./unpriced: `number | null` makes `(x ?? 0)` and `s + (x ?? 0)`
 * type-check, so it would bless the exact coercions this file exists to
 * remove. Every value goes through `priceOf` before it is arithmetic.
 *
 * Optional, so a caller can hand over rows selected without `profit_loss` --
 * it is only read to detect a stale stored column and is not load-bearing.
 */
export interface MarginRow {
  client_rate?: Money
  actual_cost?: Money
  profit_loss?: Money
}

/**
 * One period's (or one client's) reconciling triple, and the rows it excluded.
 *
 * `reconciled + unrated + uncosted + unmeasured === counted` always: the four
 * buckets are a partition, not four overlapping filters. Pinned by a test,
 * because a partition that stops being total is how a row goes missing from a
 * money figure without appearing in any count.
 */
export interface Reconciled {
  /** SUM(client_rate) over the rows where rate AND cost are both known. */
  revenue: number
  /** SUM(actual_cost) over those same rows. */
  cost: number
  /** `revenue - cost`, to the cent. Never read from `profit_loss`. */
  profit: number
  /** How many rows all three figures above are built from. */
  reconciled: number
  /** How many rows were offered, readable or not. */
  counted: number
  /** Excluded: carrier cost known, no agreed rate. Unbilled work. */
  unrated: number
  /** Excluded: rate agreed, carrier has not billed yet. */
  uncosted: number
  /** Excluded: neither side known. */
  unmeasured: number
  /**
   * Of the reconciled rows, how many have a stored `profit_loss` that
   * disagrees with `client_rate - actual_cost` by a cent or more.
   *
   * Diagnostic only -- nothing above is derived from the stored column. A
   * non-zero count means `profit_loss` was written against a rate or a cost
   * that has since changed, which is worth knowing precisely because the old
   * card's profit line WAS that column. A row with no stored `profit_loss` is
   * not stale, it is silent, and is not counted here.
   */
  stale: number
}

const EMPTY: Reconciled = {
  revenue: 0, cost: 0, profit: 0,
  reconciled: 0, counted: 0,
  unrated: 0, uncosted: 0, unmeasured: 0, stale: 0,
}

/**
 * Reduce shipment rows to a triple that subtracts.
 *
 * THE CENTS RULE, AND WHY THE IDENTITY IS NOT `revenue - cost === profit`.
 *
 * Everything accumulates in integer cents and is divided by 100 once at the
 * end, the same rule as `sumMapped` in ./unpriced, so two sums over the same
 * money cannot disagree in the last cent. The identity this guarantees is:
 *
 *   Math.round(revenue * 100) - Math.round(cost * 100) === Math.round(profit * 100)
 *
 * and NOT the float form `revenue - cost === profit`, which is false for
 * perfectly ordinary inputs: with 30 cents of revenue against 10 of cost,
 * `0.3 - 0.1` is 0.19999999999999998 while `(30 - 10) / 100` is exactly 0.2.
 * The cent is the unit every one of these figures is rendered in
 * (`toFixed(2)`), so the cent is the unit the claim is made in. Asserting the
 * float form would be asserting something untrue about a true result.
 *
 * Which pairs actually drift was checked against node, not reasoned about: the
 * first draft of the test named 0.01 and 0.02, which subtract exactly, so it
 * asserted a discrepancy that was not there.
 */
export function reconcile(rows: readonly MarginRow[] | null | undefined): Reconciled {
  if (!rows || rows.length === 0) return { ...EMPTY }

  let revCents = 0
  let costCents = 0
  let reconciled = 0
  let counted = 0
  let unrated = 0
  let uncosted = 0
  let unmeasured = 0
  let stale = 0

  for (const row of rows) {
    counted++
    // `priceOf` and not a truthiness or null check: a rate of 0 is a PRICE --
    // somebody decided this shipment ships free -- and belongs in the
    // reconciled set. `!row.client_rate` would have thrown it into `unrated`
    // and quietly narrowed the row set that the margin is built from.
    const rate = priceOf(row.client_rate)
    const cost = priceOf(row.actual_cost)

    if (rate === null && cost === null) { unmeasured++; continue }
    if (rate === null) { unrated++; continue }
    if (cost === null) { uncosted++; continue }

    const rateCents = Math.round(rate * 100)
    const costCents_ = Math.round(cost * 100)
    revCents += rateCents
    costCents += costCents_
    reconciled++

    const stored = priceOf(row.profit_loss)
    if (stored !== null && Math.round(stored * 100) !== rateCents - costCents_) stale++
  }

  return {
    revenue: revCents / 100,
    cost: costCents / 100,
    // Subtracted in cents and divided once, so the rendered figures reconcile
    // exactly. `revCents / 100 - costCents / 100` would not -- see above.
    profit: (revCents - costCents) / 100,
    reconciled, counted, unrated, uncosted, unmeasured, stale,
  }
}

/**
 * Several reconciliations added into one, keeping every count.
 *
 * For a footer under a per-client table. The alternative is reducing over the
 * numbers already rendered in the rows -- `rows.reduce((s, c) => s + c.profit)`
 * -- which needs a `?? 0` the moment a row's margin can be UNKNOWN, and that
 * coercion is the whole reason this file and ./unpriced exist. Combining the
 * reconciliations instead carries the four exclusion buckets through the
 * addition, so the total can say how many rows it is blind to.
 *
 * Both invariants survive the combination and both are pinned by tests: the
 * sum still subtracts to the cent, and the four buckets still partition the
 * combined `counted`. They survive because every field is additive and
 * `profit` is re-derived from the combined revenue and cost rather than being
 * summed as a figure in its own right.
 *
 * No parts is a real zero -- the sum over an empty set, the same distinction
 * `reconciledOrUnknown` draws for `counted === 0`.
 */
export function combineReconciled(...parts: readonly Reconciled[]): Reconciled {
  let revCents = 0
  let costCents = 0
  const out: Reconciled = { ...EMPTY }
  for (const p of parts) {
    revCents += Math.round(p.revenue * 100)
    costCents += Math.round(p.cost * 100)
    out.reconciled += p.reconciled
    out.counted += p.counted
    out.unrated += p.unrated
    out.uncosted += p.uncosted
    out.unmeasured += p.unmeasured
    out.stale += p.stale
  }
  out.revenue = revCents / 100
  out.cost = costCents / 100
  // Re-derived, not accumulated. Adding the parts' `profit` figures would be
  // arithmetically identical here and would stop being so the moment anything
  // upstream rounded differently; deriving keeps the identity true by the same
  // construction as `reconcile` rather than by coincidence.
  out.profit = (revCents - costCents) / 100
  return out
}

/**
 * The triple, or three nulls when NOT ONE row could be reconciled.
 *
 * Same distinction `totalOrUnknown` draws in ./unpriced, one level up. A month
 * in which 200 shipments are all waiting on carrier invoices has no known
 * margin; `reconcile` reports `profit: 0` for it, which is the correct sum over
 * an empty set and, rendered, is a lie -- `+$0.00` in green beside a tick, for
 * a period whose margin is entirely unmeasured.
 *
 * `counted === 0` is NOT unknown. A period with no shipments at all genuinely
 * made $0.00 of shipping revenue at $0.00 of cost for $0.00 of margin. That is
 * a fact about an empty set, and dashing it would hide a real zero behind the
 * mark for UNKNOWN.
 *
 * A PARTIAL reconciliation returns its figures, deliberately: 1,200 of 1,400
 * shipments reconciled is a real margin over those 1,200, and the caller is
 * already holding the four exclusion counts it has to render beside them.
 */
export function reconciledOrUnknown(
  r: Reconciled,
): { revenue: number | null; cost: number | null; profit: number | null } {
  if (r.counted > 0 && r.reconciled === 0) {
    return { revenue: null, cost: null, profit: null }
  }
  return { revenue: r.revenue, cost: r.cost, profit: r.profit }
}

/**
 * Margin as a percentage of revenue, or null when there is no revenue to be a
 * percentage of.
 *
 * Zero revenue is not zero percent margin, it is an undefined ratio, and
 * `profit / 0` is Infinity or NaN -- both of which render through `toFixed(1)`
 * without complaint ("Infinity%", "NaN%"). Returning null makes the caller
 * decide, which on this screen means printing nothing.
 */
export function marginPct(r: Reconciled): number | null {
  if (r.reconciled === 0 || r.revenue === 0) return null
  return (r.profit / r.revenue) * 100
}

/** How many rows the triple left out, for whatever reason. */
export function excludedCount(r: Reconciled): number {
  return r.unrated + r.uncosted + r.unmeasured
}

/**
 * One clause naming what the triple left out and why, or '' when it left out
 * nothing.
 *
 * '' and not "all reconciled", for the reason given on `unpricedNote`: a
 * permanent all-clear under every figure is how a real warning stops being
 * read.
 *
 * The urgent bucket is named FIRST. `unrated` is work that went out the door
 * with nobody billed for it; `uncosted` resolves itself when the carrier
 * invoices. An operator scanning this should hit the actionable one first.
 */
export function exclusionNote(r: Reconciled, noun = 'shipment'): string {
  const excluded = excludedCount(r)
  if (excluded <= 0) return ''
  const reasons: string[] = []
  if (r.unrated > 0) reasons.push(`${r.unrated} with no agreed rate`)
  if (r.uncosted > 0) reasons.push(`${r.uncosted} awaiting carrier cost`)
  if (r.unmeasured > 0) reasons.push(`${r.unmeasured} with neither`)
  return `${excluded} of ${r.counted} ${excluded === 1 && r.counted === 1 ? noun : `${noun}s`} `
    + `not in these figures: ${reasons.join(', ')}`
}

/**
 * What the period is worth BILLING, which is a different question.
 *
 * `reconcile`'s revenue is deliberately narrow -- it only counts rows whose
 * cost is also known, so that the margin subtracts. That makes it the wrong
 * number to invoice from: a shipment with an agreed rate is owed whether or
 * not the carrier has billed us yet.
 *
 * So this is the wide one: every row with an agreed rate, no matter the state
 * of its cost, carrying the count of rows it still had to withhold. The two
 * figures are different on purpose and must be labelled differently on screen.
 * Collapsing them back into one "Revenue" row is the defect at the top of this
 * file.
 */
export function invoiceableRevenue(
  rows: readonly MarginRow[] | null | undefined,
): PricedSum {
  return sumPriced(rows as ReadonlyArray<object> | null | undefined, 'client_rate')
}

/**
 * Warehouse lines plus approved manual charges: income that has no carrier
 * cost and therefore no place in a margin.
 *
 * This is the line that used to be added into shipping revenue, where it
 * widened the revenue-minus-cost gap by its own full value and made the card's
 * profit row look that much more wrong. It is income, it is real, and it
 * belongs under the rule with its own label rather than inside a subtraction it
 * is not part of.
 *
 * `combinePriced` rather than `+` because both columns are nullable and a bare
 * addition is exactly where the two withheld counts get dropped.
 */
export function otherIncome(
  warehouse: ReadonlyArray<object> | null | undefined,
  manual: ReadonlyArray<object> | null | undefined,
): PricedSum {
  return combinePriced(
    sumPriced(warehouse, 'total'),
    sumPriced(manual, 'amount'),
  )
}
