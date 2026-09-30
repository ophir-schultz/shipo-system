// Standard-cost variance, per spec §5.3.2.
//
// `standardRate` is HELD: it is baselined once into cost_rates and read from
// there. It is never computed as actualCost / quantity. Deriving it that way
// makes variance identically zero for every input, which is the failure this
// module was written to prevent — see the first test in variance.test.ts.
//
// Null in, null out — with one exception. A missing payroll figure or a
// missing held rate means the answer is not yet known, which is a different
// claim from "no leak". The callers render null as "not yet known".
//
// Exception: when quantity is 0, absorbed is 0 regardless of the rate.
// standardRate × 0 = 0 for every finite rate, so the missing rate is not an
// input to the answer. Returning null there would delete a number we actually
// know. This is not a violation of the doctrine: the doctrine says "null in,
// null out" when the missing input could change the answer — here it cannot.

export interface VarianceInput {
  actualCost: number | null
  standardRate: number | null
  quantity: number
}

export interface VarianceResult {
  absorbed: number | null
  variance: number | null
  basis: 'measured' | 'estimated' | 'unavailable'
}

export function labourVariance(input: VarianceInput): VarianceResult {
  const { actualCost, standardRate, quantity } = input

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError(`labourVariance: quantity must be >= 0, got ${quantity}`)
  }

  // Short-circuit: nothing was picked, so nothing was absorbed. The rate is
  // not an input to this answer — standardRate × 0 = 0 for every finite rate.
  // actualCost must still be present: a null here means payroll was never
  // entered, which is UNKNOWN regardless of the zero quantity.
  if (quantity === 0) {
    if (actualCost == null) return { absorbed: 0, variance: null, basis: 'unavailable' }
    return { absorbed: 0, variance: actualCost, basis: 'measured' }
  }

  // `== null` is deliberate: it catches null and undefined while letting a
  // genuine 0 through as a real rate.
  const absorbed = standardRate == null ? null : standardRate * quantity

  if (absorbed == null || actualCost == null) {
    return { absorbed, variance: null, basis: 'unavailable' }
  }

  return { absorbed, variance: actualCost - absorbed, basis: 'measured' }
}
