// Effective-dated cost rate lookup.
//
// The distinction this module exists to protect:
//
//   rate = 0     the operation is FREE. cost is 0. It counts.
//   no rate      the cost is UNKNOWN. cost is null. It must not count.
//
// Conflating them reports unknown costs as pure profit, which is the exact
// error this whole project exists to stop, and it fails in the flattering
// direction so nobody files a bug about it.
//
// The result is a discriminated union rather than `number | null` so that a
// caller cannot write `cost || 0` without noticing what they are doing.
//
// Lookup is by charge_date, never by now(): a rate change must not rewrite
// last month's margin. effective_from is inclusive and effective_to exclusive,
// matching the '[)' daterange in the cost_rates exclusion constraint.

// cost_type is deliberately NOT constrained, here or in ledger_02_cost.sql,
// and that is a decision rather than an omission -- `basis` immediately below
// IS constrained, so the difference needs stating.
//
// Two different sets get confused into one when you try. The cost types the
// CODE looks up are closed and tiny: 'pick' and 'pack' (calculate-charges.ts)
// and 'storage' (storage-charges.ts). The cost types the TABLE may legitimately
// hold are open, because the point of this table is to record an agreed cost
// before anything bills against it -- ledger_06 seeds two 'material' rows that
// nothing looks up, exactly as ledger_05 seeds twelve rate lines that are not
// yet billable. A check constraint listing the code's three values would
// reject those; one listing everything currently seeded would be a list of
// whatever happens to be in the file, constraining nothing.
//
// And the failure it would guard against is already announced. A cost_type
// nobody can match -- typo'd in a seed file, or typo'd at a call site -- makes
// findCostRate return `{ known: false }`, which writes cost null, which
// pnl_client_monthly counts as cost_unknown_charges and pnl_monthly's
// net_profit refuses to compute a month from at all. The unknown-versus-zero
// machinery this module exists for IS the guard. Compare charge_type in
// order_charges, which has no such backstop: a typo there is billed in full
// and simply vanishes from the leak views, with nothing anywhere saying so.
// That one is constrained (ledger_03_charges.sql).
export interface CostRateRow {
  id: string
  cost_type: string
  variant: string | null
  unit: string
  rate: number
  effective_from: string   // 'YYYY-MM-DD'
  effective_to: string | null
  basis: 'measured' | 'derived' | 'estimated'
}

export type CostLookup =
  | { known: true;  rateId: string; rate: number; basis: CostRateRow['basis'] }
  | { known: false; rateId: null;   rate: null;   basis: null; reason: string }

export function findCostRate(
  rates: CostRateRow[],
  query: { costType: string; variant?: string | null; chargeDate: string },
): CostLookup {
  const variant = query.variant ?? null

  const match = (rates ?? []).find((r) =>
    r.cost_type === query.costType
    && (r.variant ?? null) === variant
    && r.effective_from <= query.chargeDate
    && (r.effective_to === null || query.chargeDate < r.effective_to)
  )

  if (!match) {
    return {
      known: false, rateId: null, rate: null, basis: null,
      reason: `No cost rate for ${query.costType}`
            + `/${variant ?? 'none'} on ${query.chargeDate}`,
    }
  }

  return { known: true, rateId: match.id, rate: match.rate, basis: match.basis }
}

// The quantity guard matters more here than it looks. This module's whole job
// is stopping an unknown cost from being counted as zero, and `NaN` walks
// straight past that defence from the other side: `costOf(known, NaN)` is a
// number by type, so it is not null, so sumKnownCosts adds it -- and one NaN
// turns the whole total into NaN. That is a worse outcome than the null it was
// protecting against, because it destroys the known costs too. Quantities reach
// here from parsed database columns and API payloads, so the input is real.
// Throwing matches labourVariance() in variance.ts, which guards identically.
export function costOf(lookup: CostLookup, quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError(`costOf: quantity must be >= 0 and finite, got ${quantity}`)
  }
  if (!lookup.known) return null
  return lookup.rate * quantity
}

export function sumKnownCosts(values: Array<number | null>): {
  total: number
  unknownCount: number
} {
  let total = 0
  let unknownCount = 0
  for (const v of values ?? []) {
    // A non-finite value counts as unknown rather than throwing. costOf() has
    // already refused to produce one, so a NaN here came from somewhere else --
    // a null numeric column, a bad cast. This is an aggregate over many rows
    // feeding a report, and one corrupt row should show up in unknownCount, not
    // take the other rows' totals down with it: `total += NaN` makes every
    // known cost in the batch vanish into NaN.
    if (v === null || v === undefined || !Number.isFinite(v)) unknownCount++
    else total += v
  }
  return { total, unknownCount }
}
