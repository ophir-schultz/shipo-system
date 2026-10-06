import { describe, it, expect } from 'vitest'
import { billedOz, weightBracket, WEIGHT_UNKNOWN } from './weight-bracket'

describe('billedOz', () => {
  it('prefers billed_weight, which is what the carrier charged on', () => {
    expect(billedOz({ billed_weight: 32, weight: 8 })).toBe(32)
  })

  it('falls back to weight when billed_weight is absent', () => {
    expect(billedOz({ billed_weight: null, weight: 8 })).toBe(8)
  })

  // The `??` chain this replaced fell through on null and undefined only, so a
  // billed_weight of 0 was used instead of the real weight sitting next to it.
  it('falls back when billed_weight is present but unusable, not merely absent', () => {
    expect(billedOz({ billed_weight: 0, weight: 8 })).toBe(8)
    expect(billedOz({ billed_weight: '', weight: 8 })).toBe(8)
    expect(billedOz({ billed_weight: -4, weight: 8 })).toBe(8)
  })

  it('reads a numeric that arrived as a string over PostgREST', () => {
    expect(billedOz({ billed_weight: '12.50' })).toBe(12.5)
    expect(billedOz({ billed_weight: null, weight: '7.25' })).toBe(7.25)
  })

  it('is null when neither column holds a usable measurement', () => {
    expect(billedOz({})).toBeNull()
    expect(billedOz({ billed_weight: null, weight: null })).toBeNull()
    expect(billedOz({ billed_weight: 0, weight: 0 })).toBeNull()
    expect(billedOz({ billed_weight: 'heavy', weight: null })).toBeNull()
  })
})

describe('weightBracket', () => {
  // The defect this module exists for. `Math.ceil(0 / 16)` is 0, 0 satisfies
  // `lb <= 1`, so an unmeasured shipment was reported as a sub-one-pound
  // parcel on the panel that decides which weights to investigate.
  it('does not report an unmeasured shipment as the lightest bracket', () => {
    expect(weightBracket({})).toBe(WEIGHT_UNKNOWN)
    expect(weightBracket({})).not.toBe('≤1 lb')
    expect(weightBracket({ billed_weight: null, weight: null })).toBe(WEIGHT_UNKNOWN)
  })

  it('does not let a zero or negative weight pass as the lightest bracket', () => {
    expect(weightBracket({ billed_weight: 0, weight: 0 })).toBe(WEIGHT_UNKNOWN)
    expect(weightBracket({ billed_weight: -20 })).toBe(WEIGHT_UNKNOWN)
  })

  it('does not let an unreadable weight pass as the lightest bracket', () => {
    // Every comparison against NaN is false, so a chain of `<=` guards falls
    // through to the final branch -- which would file this as 20+ lb.
    expect(weightBracket({ billed_weight: 'heavy' })).toBe(WEIGHT_UNKNOWN)
    expect(weightBracket({ billed_weight: '' })).toBe(WEIGHT_UNKNOWN)
  })

  // Boundaries pinned on both sides, so a change to any one comparison fails a
  // test rather than moving a bar by one bracket.
  it('buckets on whole pounds, rounded up, at the existing boundaries', () => {
    expect(weightBracket({ billed_weight: 1 })).toBe('≤1 lb')
    expect(weightBracket({ billed_weight: 16 })).toBe('≤1 lb')
    expect(weightBracket({ billed_weight: 17 })).toBe('2–5 lb')
    expect(weightBracket({ billed_weight: 80 })).toBe('2–5 lb')
    expect(weightBracket({ billed_weight: 81 })).toBe('6–10 lb')
    expect(weightBracket({ billed_weight: 160 })).toBe('6–10 lb')
    expect(weightBracket({ billed_weight: 161 })).toBe('11–20 lb')
    expect(weightBracket({ billed_weight: 320 })).toBe('11–20 lb')
    expect(weightBracket({ billed_weight: 321 })).toBe('20+ lb')
  })

  it('buckets a weight that arrived as a string', () => {
    expect(weightBracket({ billed_weight: '250.00' })).toBe('11–20 lb')
    expect(weightBracket({ billed_weight: null, weight: '17' })).toBe('2–5 lb')
  })

  it('uses billed_weight over weight when both are usable', () => {
    // 320oz billed against 16oz actual is the dim-weight case, and the bracket
    // has to follow the figure the surcharge was applied to.
    expect(weightBracket({ billed_weight: 320, weight: 16 })).toBe('11–20 lb')
  })
})
