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

export function costOf(lookup: CostLookup, quantity: number): number | null {
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
    if (v === null || v === undefined) unknownCount++
    else total += v
  }
  return { total, unknownCount }
}
