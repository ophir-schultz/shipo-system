// Which weight bracket a shipment belongs in, and the UNKNOWN case the old
// expression had no way to say.
//
// /losses breaks its losses down by weight, and picked the bucket from
// `s.billed_weight ?? s.weight ?? 0`. Three separate things went wrong in that
// one expression:
//
//   1. `Math.ceil(0 / 16)` is 0, and 0 satisfies `lb <= 1`, so every shipment
//      whose weight nobody recorded was filed under `≤1 lb`. On the one panel
//      whose job is to say WHICH WEIGHTS lose money, that points the
//      investigation at the lightest bracket -- while heavy parcels, where the
//      dim-weight surcharges bite, are the likelier cause of the loss being
//      investigated. It is not a missing bar on a chart, it is a bar in the
//      wrong place.
//   2. `??` falls through on null and undefined only, so a `billed_weight` of 0
//      was USED rather than falling back to `weight`. The fallback was written
//      for exactly that row and did not fire for it.
//   3. Both columns are `numeric(8,2)`, which is not a shape worth betting on
//      over PostgREST -- the same reason priceOf exists for the money columns.
//
// `billedWeightOf` already answers all three: it takes a number or a string,
// rejects anything non-finite, and rejects <= 0 on the stated grounds that "a
// weight of 0 or less is the `weight ?? 0` standing in for a measurement nobody
// took". Composing with it rather than restating the rule is the point -- the
// pricing path refuses an unusable weight, and this makes the reporting path
// refuse the same ones, rather than having two opinions about which weights are
// real.

import { billedWeightOf } from './shipment-rate'

/** The bucket a shipment with no usable weight goes in. */
export const WEIGHT_UNKNOWN = 'Weight unknown'

/**
 * The weight a shipment was billed on, or null when neither column holds a
 * usable measurement.
 *
 * `billed_weight` wins when it is usable, because that is the figure the
 * carrier actually charged on, dim weight included. The fallback to `weight`
 * fires when billed_weight is UNUSABLE rather than merely absent, which is the
 * difference between this and the `??` chain it replaces.
 */
export function billedOz(s: { billed_weight?: unknown; weight?: unknown }): number | null {
  return billedWeightOf(s.billed_weight) ?? billedWeightOf(s.weight)
}

/**
 * The bracket label, or WEIGHT_UNKNOWN for a shipment with no usable weight.
 *
 * A named bucket rather than dropping the row: the shipment IS a loss and its
 * amount belongs in the total, so omitting it would make the panel disagree
 * with the headline figure above it for no stated reason. A bucket that names
 * itself is the same choice the zone panel on that page already makes with
 * 'Zone unknown'.
 *
 * The boundaries are unchanged from the expression this replaces, so no bar
 * already on the screen moves: ceil to whole pounds, then 1 / 5 / 10 / 20.
 */
export function weightBracket(s: { billed_weight?: unknown; weight?: unknown }): string {
  const oz = billedOz(s)
  if (oz === null) return WEIGHT_UNKNOWN
  const lb = Math.ceil(oz / 16)
  return lb <= 1 ? '≤1 lb'
    : lb <= 5 ? '2–5 lb'
      : lb <= 10 ? '6–10 lb'
        : lb <= 20 ? '11–20 lb'
          : '20+ lb'
}
