import { describe, it, expect, vi } from 'vitest'

// zones.ts imports `@/lib/supabase` at module scope. Stubbed rather than
// loaded: `weightToLb` is pure and touches no client, and a diagnostic-parity
// test should not depend on service-role env vars being present.
vi.mock('@/lib/supabase', () => ({ supabaseAdmin: {} }))

const { weightToLb: real } = await import('@/lib/billing/zones')
// The .mjs helper the read-only diagnostic scripts share. Vitest resolves the
// `@/*` alias above via vite-tsconfig-paths; plain Node cannot, which is the
// whole reason scripts/zone-weight.mjs exists instead of the scripts importing
// zones.ts directly. See the header of that file.
const { weightToLb: script, MAX_WEIGHT_LB } = await import('../../../scripts/zone-weight.mjs')

// This file exists for one reason: scripts/diag-zone-rate-delta.mjs and
// scripts/diag-zone-rate-lookup.mjs each carried their own hand-written copy of
// this rule -- `Math.ceil((oz||0)/16)` floored to 1 -- and commit 8ed5bf6
// changed the real one to answer null instead of flooring. The copies did not
// change with it, so both scripts reported "1 LB, zone N, rate X" for shipments
// the live biller refuses to price.
//
// The two copies are now one, and this pins that one to the real function.
//
// Each case asserts BOTH that the two agree AND what the answer should be. A
// parity-only assertion passes vacuously if the helper and zones.ts drift
// together in the same direction, which is precisely the regression that would
// put the cheapest-row bug back.

/** [input, expected row or null, what the case is for] */
const CASES: Array<[unknown, number | null, string]> = [
  // The cases commit 8ed5bf6 changed. Every one of these answered 1 -- the
  // cheapest cell on the matrix -- under the old rule and under the copies the
  // two scripts carried.
  [undefined, null, 'absent weight (column is nullable)'],
  [null, null, 'explicit null weight'],
  [0, null, 'zero: the `?? 0` standing in for a measurement nobody took'],
  [-1, null, 'negative weight'],
  [NaN, null, 'NaN, which makes every band comparison false'],
  [Infinity, null, 'Infinite weight'],
  [-Infinity, null, 'negative Infinity'],
  ['', null, 'empty string, which Number() turns into 0'],
  ['heavy', null, 'unparseable string'],
  [{}, null, 'not a number or a string at all'],

  // Ordinary rows, to prove the arithmetic restated in the helper is the same
  // arithmetic -- rounding UP, not to nearest.
  [1, 1, 'one ounce still needs a whole pound row'],
  [15, 1, 'just under a pound'],
  [16, 1, 'exactly one pound'],
  [17, 2, 'one ounce over rounds UP to the next row'],
  [32, 2, 'exactly two pounds'],
  [33, 3, 'rounds up again'],
  [0.5, 1, 'a fraction of an ounce is a real weight, so row 1'],

  // numeric(10,2) arrives over PostgREST as a quoted string.
  ['17', 2, 'numeric weight as a string'],
  ['12.34', 1, 'fractional string weight'],

  // The cap.
  [320, 20, 'exactly the top row (20 LB)'],
  [321, 20, 'one ounce over the top row is capped, not refused'],
  [100000, 20, 'far above the chart is still the top row'],
]

describe('scripts/zone-weight.mjs matches the real weightToLb', () => {
  it.each(CASES)('%j -> %j (%s)', (input, expected) => {
    expect(real(input)).toBe(expected)
    expect(script(input)).toBe(expected)
  })

  it('agrees with zones.ts across every whole ounce up to twice the cap', () => {
    // Exhaustive over the range that matters, so a boundary moved by one in
    // either file is caught without anybody having to think of the ounce.
    for (let oz = 1; oz <= 640; oz++) {
      expect(script(oz)).toBe(real(oz))
    }
  })

  it('caps at the same row zones.ts caps at', () => {
    expect(MAX_WEIGHT_LB).toBe(20)
    expect(script(99999)).toBe(MAX_WEIGHT_LB)
    expect(real(99999)).toBe(MAX_WEIGHT_LB)
  })

  it('never answers 0 or a negative row for any input', () => {
    // Row 0 would be as wrong as row 1 and harder to spot: no such cell exists,
    // so it would read as a miss rather than as an absent weight.
    for (const [input] of CASES) {
      const answer = script(input)
      if (answer !== null) expect(answer).toBeGreaterThanOrEqual(1)
    }
  })
})
