// Standard-cost variance, per spec §5.3.2.
//
// `standardRate` is HELD: it is baselined once into cost_rates and read from
// there. It is never computed as actualCost / quantity. Deriving it that way
// makes variance identically zero for every input, which is the failure this
// module was written to prevent — see the first test in variance.test.ts.
//
// Null in, null out. A missing payroll figure or a missing held rate means the
// answer is not yet known, which is a different claim from "no leak". The
// callers render null as "not yet known".

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

  // `== null` is deliberate: it catches null and undefined while letting a
  // genuine 0 through as a real rate.
  const absorbed = standardRate == null ? null : standardRate * quantity

  if (absorbed == null || actualCost == null) {
    return { absorbed, variance: null, basis: 'unavailable' }
  }

  return { absorbed, variance: actualCost - absorbed, basis: 'measured' }
}
