import { describe, it, expect } from 'vitest'
import {
  findCostRate, costOf, sumKnownCosts, type CostRateRow,
} from '@/lib/ledger/cost-rate'

const rates: CostRateRow[] = [
  { id: 'r1', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.23, effective_from: '2026-01-01', effective_to: '2026-06-01',
    basis: 'derived' },
  { id: 'r2', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.27, effective_from: '2026-06-01', effective_to: null,
    basis: 'derived' },
  { id: 'r3', cost_type: 'pick', variant: 'component', unit: 'per_unit',
    rate: 0.20, effective_from: '2026-01-01', effective_to: null,
    basis: 'estimated' },
  { id: 'r4', cost_type: 'receiving', variant: null, unit: 'per_order',
    rate: 0, effective_from: '2026-01-01', effective_to: null,
    basis: 'measured' },
]

describe('findCostRate', () => {
  it('finds the rate in force on the charge date', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-15',
    })
    expect(r).toMatchObject({ known: true, rateId: 'r1', rate: 0.23 })
  })

  it('does not let a later rate rewrite an earlier month', () => {
    const march = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-15' })
    const july = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-07-15' })
    expect(march).toMatchObject({ rate: 0.23 })
    expect(july).toMatchObject({ rate: 0.27, rateId: 'r2' })
  })

  // effective_from inclusive, effective_to exclusive — matching the '[)'
  // daterange in the Task 8 constraint. If these disagreed, exactly one day
  // per rate change would behave differently in code than in the database.
  it('treats effective_from as inclusive', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-06-01',
    })).toMatchObject({ rateId: 'r2' })
  })

  it('treats effective_to as exclusive', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-05-31',
    })).toMatchObject({ rateId: 'r1' })
  })

  it('matches an open-ended rate with no effective_to', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'component', chargeDate: '2030-01-01',
    })).toMatchObject({ known: true, rateId: 'r3' })
  })

  it('matches a null variant against a null-variant rate', () => {
    expect(findCostRate(rates, {
      costType: 'receiving', chargeDate: '2026-03-01',
    })).toMatchObject({ known: true, rateId: 'r4' })
  })

  // REVIEW FOCUS 4, first half. A rate of exactly zero is a real rate. It is
  // `known`, and it makes the cost 0 — an operation that is genuinely free.
  it('returns known for a rate of zero', () => {
    const r = findCostRate(rates, { costType: 'receiving', chargeDate: '2026-03-01' })
    expect(r.known).toBe(true)
    expect(r.rate).toBeCloseTo(0, 6)
    expect(costOf(r, 10)).toBe(0)
  })

  // REVIEW FOCUS 4, second half. No rate at all is unknown, and unknown is
  // null. If this returned 0, every cost we have not yet loaded would appear
  // on the P&L as pure profit.
  it('returns unknown, not zero, when no rate covers the date', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2025-12-31' })
    expect(r.known).toBe(false)
    expect(r.rate).toBeNull()
    expect(costOf(r, 10)).toBeNull()
  })

  it('returns unknown for a cost type that has no rates', () => {
    const r = findCostRate(rates, { costType: 'gift_wrap', chargeDate: '2026-03-01' })
    expect(r.known).toBe(false)
    expect((r as { reason: string }).reason).toContain('gift_wrap')
  })

  it('does not fall back to a different variant', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'pallet', chargeDate: '2026-03-01' })
    expect(r.known).toBe(false)
  })

  it('carries the basis through, so estimates can be labelled', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'component', chargeDate: '2026-03-01',
    })).toMatchObject({ basis: 'estimated' })
  })
})

describe('costOf', () => {
  it('multiplies a known rate by quantity', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-01' })
    expect(costOf(r, 100)).toBeCloseTo(23, 6)
  })

  it('stays null for an unknown rate whatever the quantity', () => {
    const r = findCostRate(rates, { costType: 'nope', chargeDate: '2026-03-01' })
    expect(costOf(r, 0)).toBeNull()
    expect(costOf(r, 1000)).toBeNull()
  })
})

describe('sumKnownCosts', () => {
  // The aggregation half of the same hazard. `values.reduce((a,b) => a + (b??0))`
  // would return 8 here and report no problem, which reads as "these three
  // charges cost us $8" when one of them is simply not known yet.
  it('excludes unknowns from the total and counts them separately', () => {
    expect(sumKnownCosts([5, null, 3])).toEqual({ total: 8, unknownCount: 1 })
  })

  it('distinguishes a zero cost from an unknown one', () => {
    expect(sumKnownCosts([5, 0, 3])).toEqual({ total: 8, unknownCount: 0 })
  })

  it('reports an all-unknown set as total 0 with every entry counted', () => {
    expect(sumKnownCosts([null, null])).toEqual({ total: 0, unknownCount: 2 })
  })

  it('handles an empty set', () => {
    expect(sumKnownCosts([])).toEqual({ total: 0, unknownCount: 0 })
  })
})
