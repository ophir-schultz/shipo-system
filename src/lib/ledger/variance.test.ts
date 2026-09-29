import { describe, it, expect } from 'vitest'
import { labourVariance } from '@/lib/ledger/variance'

describe('labourVariance', () => {
  // THE LOAD-BEARING TEST. An implementation that derives the standard rate
  // from actualCost / quantity returns 0 here. It must return 400.
  it('is non-zero when payroll and the held standard disagree', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.absorbed).toBeCloseTo(4600, 6)
    expect(r.variance).toBeCloseTo(400, 6)
    expect(r.basis).toBe('measured')
  })

  it('reports a negative variance when we spent less than standard', () => {
    const r = labourVariance({
      actualCost: 4000,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.variance).toBeCloseTo(-600, 6)
  })

  it('is exactly zero only when the two genuinely agree', () => {
    const r = labourVariance({
      actualCost: 4600,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.variance).toBe(0)
    expect(r.basis).toBe('measured')
  })

  // The payroll figure is one of the four inputs that arrive later. Until it
  // does, the honest answer is null, not zero. Zero would read on the
  // dashboard as "no labour leak", which is a claim we cannot make yet.
  it('returns null variance, not zero, when payroll has not arrived', () => {
    const r = labourVariance({
      actualCost: null,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.absorbed).toBeCloseTo(4600, 6)
    expect(r.variance).toBeNull()
    expect(r.basis).toBe('unavailable')
  })

  // Symmetric case: the rate card has not been baselined yet.
  it('returns null absorbed and null variance when the standard is missing', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: null,
      quantity: 20000,
    })
    expect(r.absorbed).toBeNull()
    expect(r.variance).toBeNull()
    expect(r.basis).toBe('unavailable')
  })

  // A held standard of exactly zero is a real, deliberate value — a free
  // operation — and is NOT the same as an absent one. This is the scalar
  // half of Review Focus item 4; Task 13 covers the database half.
  it('treats a standard rate of zero as a real rate, not a missing one', () => {
    const r = labourVariance({
      actualCost: 500,
      standardRate: 0,
      quantity: 20000,
    })
    expect(r.absorbed).toBe(0)
    expect(r.variance).toBe(500)
    expect(r.basis).toBe('measured')
  })

  // A month with no picks absorbs nothing, so every dollar of payroll is
  // variance. That is the correct answer and must not be special-cased away.
  it('reports all payroll as variance in a month with no picks', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: 0.23,
      quantity: 0,
    })
    expect(r.absorbed).toBe(0)
    expect(r.variance).toBeCloseTo(5000, 6)
  })

  it('refuses a negative quantity rather than inventing negative absorption', () => {
    expect(() => labourVariance({
      actualCost: 5000, standardRate: 0.23, quantity: -5,
    })).toThrow(/quantity/i)
  })
})
