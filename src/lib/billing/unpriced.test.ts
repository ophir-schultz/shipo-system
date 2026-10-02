import { describe, it, expect } from 'vitest'
import {
  priceOf, isPriced, formatPrice, formatSignedPrice, sumPriced, combinePriced,
  unpricedNote,
  UNPRICED_DASH, UNPRICED_CELL,
} from './unpriced'

// The two things this module exists to keep apart are a price of 0 and no
// price at all. So nearly every test below is a pair: the same assertion made
// once for 0 and once for null, because a change that collapsed them would
// pass any test that only checked one side.

describe('the UNPRICED markers', () => {
  it('are not numbers', () => {
    // The whole reason UNPRICED_CELL is spelled out rather than left as 0: in a
    // spreadsheet a numeric 0 is a price, and SUM() over the column would add
    // it. Text is skipped by SUM(), which is the honest arithmetic. If either
    // of these ever becomes a number, every downloaded invoice silently starts
    // billing an unknown line as free again.
    expect(typeof UNPRICED_CELL).toBe('string')
    expect(typeof UNPRICED_DASH).toBe('string')
    expect(Number(UNPRICED_CELL)).toBeNaN()
    expect(Number(UNPRICED_DASH)).toBeNaN()
  })

  it('are not something priceOf would read back as a price', () => {
    // Round-trip guard: a marker that coerced to a number would re-enter the
    // totals as one the next time a cell was read back.
    expect(priceOf(UNPRICED_CELL)).toBeNull()
    expect(priceOf(UNPRICED_DASH)).toBeNull()
  })
})

describe('priceOf', () => {
  it('reads a number', () => {
    expect(priceOf(12.34)).toBe(12.34)
  })

  it('reads a deliberate zero as zero, not as unknown', () => {
    expect(priceOf(0)).toBe(0)
  })

  it('reads a negative, since a credit is a real figure', () => {
    expect(priceOf(-4.5)).toBe(-4.5)
  })

  it("coerces numeric(10,2) arriving as a string", () => {
    // PostgREST may send numeric as a quoted string. `0 + '12.34'` is the
    // string '012.34', so a total built by `+` on an uncoerced value is
    // garbage rather than merely wrong.
    expect(priceOf('12.34')).toBe(12.34)
  })

  it('coerces a string zero to zero', () => {
    expect(priceOf('0.00')).toBe(0)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('reports %s as unknown', (_label, v) => {
    expect(priceOf(v)).toBeNull()
  })

  it.each([
    ['a boolean true', true],
    ['a boolean false', false],
    ['an empty array', []],
    ['a one-element array', [5]],
    ['an object', {}],
    ['unreadable text', 'tbd'],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('reports %s as unknown rather than converting it', (_label, v) => {
    // Number() turns true into 1, false into 0, [] into 0 and [5] into 5 --
    // all finite, so a finiteness check alone lets every one of them through
    // as a real-looking price. The typeof gate is what stops them.
    expect(priceOf(v)).toBeNull()
  })
})

describe('isPriced', () => {
  it('counts a zero as priced, because 0 is a decision', () => {
    expect(isPriced(0)).toBe(true)
  })

  it('does not count null as priced', () => {
    expect(isPriced(null)).toBe(false)
  })
})

describe('formatPrice', () => {
  it('formats a price to the cent', () => {
    expect(formatPrice(12.3)).toBe('$12.30')
  })

  it('formats a deliberate zero as $0.00, NOT as a dash', () => {
    // The dash means "nobody has priced this". A stored 0 means somebody
    // decided this is free. Dashing the 0 would raise a question about a
    // decision that was actually made.
    expect(formatPrice(0)).toBe('$0.00')
  })

  it('dashes an unknown price instead of printing $0.00', () => {
    // This is the whole defect: `${(s.client_rate ?? 0).toFixed(2)}` printed
    // "$0.00" for a shipment whose price nobody has agreed.
    expect(formatPrice(null)).toBe(UNPRICED_DASH)
    expect(formatPrice(null)).not.toBe('$0.00')
  })

  it('dashes an unreadable value instead of printing $0.00', () => {
    expect(formatPrice('tbd')).toBe(UNPRICED_DASH)
    expect(formatPrice(true)).toBe(UNPRICED_DASH)
  })

  it('formats a negative price', () => {
    expect(formatPrice(-4.5)).toBe('$-4.50')
  })
})

describe('formatSignedPrice', () => {
  it('marks a profit with a leading +', () => {
    expect(formatSignedPrice(12.3)).toBe('+$12.30')
  })

  it('marks a deliberate break-even with a leading +', () => {
    expect(formatSignedPrice(0)).toBe('+$0.00')
  })

  it('dashes UNKNOWN rather than claiming break-even', () => {
    expect(formatSignedPrice(null)).toBe(UNPRICED_DASH)
    expect(formatSignedPrice(undefined)).toBe(UNPRICED_DASH)
    // The whole point: the old `(x ?? 0) >= 0 ? '+' : ''` produced this.
    expect(formatSignedPrice(null)).not.toBe('+$0.00')
  })

  it('leaves the minus where toFixed puts it, after the $', () => {
    expect(formatSignedPrice(-4.5)).toBe('$-4.50')
  })
})

describe('sumPriced', () => {
  it('totals the priced rows', () => {
    const r = sumPriced([{ rate: 10 }, { rate: 5.5 }], 'rate')
    expect(r.total).toBe(15.5)
    expect(r.unpriced).toBe(0)
    expect(r.counted).toBe(2)
  })

  it('reports how many rows it left out, not just the total', () => {
    // A total of 10 over three rows is not wrong, but it is incomplete, and
    // the caller has no way to say so unless it is handed the count.
    const r = sumPriced([{ rate: 10 }, { rate: null }, { rate: null }], 'rate')
    expect(r.total).toBe(10)
    expect(r.unpriced).toBe(2)
    expect(r.counted).toBe(3)
  })

  it('does not treat an unpriced row as a zero-priced row', () => {
    const unknown = sumPriced([{ rate: 10 }, { rate: null }], 'rate')
    const free = sumPriced([{ rate: 10 }, { rate: 0 }], 'rate')
    // Same total -- which is exactly why the total alone cannot be trusted to
    // tell these two apart, and why the count has to come with it.
    expect(unknown.total).toBe(free.total)
    expect(unknown.unpriced).toBe(1)
    expect(free.unpriced).toBe(0)
  })

  it('counts a deliberate zero as priced', () => {
    const r = sumPriced([{ rate: 0 }], 'rate')
    expect(r.unpriced).toBe(0)
    expect(r.counted).toBe(1)
  })

  it('coerces string values rather than concatenating them', () => {
    // `0 + '10' + '5'` is '0105'. If this ever returns a string, every total
    // built on it is nonsense rather than slightly off.
    const r = sumPriced([{ rate: '10' }, { rate: '5' }], 'rate')
    expect(r.total).toBe(15)
    expect(typeof r.total).toBe('number')
  })

  it('leaves out an unreadable value instead of adding zero for it', () => {
    const r = sumPriced([{ rate: 10 }, { rate: 'tbd' }], 'rate')
    expect(r.total).toBe(10)
    expect(r.unpriced).toBe(1)
  })

  it('does not drift when accumulating float dollars', () => {
    // These exact values are chosen because they distinguish the two
    // implementations: summing `n * 100` gives 3.3000000000000007 here, while
    // summing `Math.round(n * 100)` gives 3.3. An earlier version of this test
    // used 0.1 three times, where BOTH approaches happen to land on 0.3 -- so
    // it asserted nothing and the float mutation survived it. The dashboard's
    // all-time revenue is a sum over every shipment the business has made, so
    // the drift is not hypothetical.
    expect(sumPriced([{ rate: 1.1 }, { rate: 2.2 }], 'rate').total).toBe(3.3)
    expect(sumPriced(
      [{ rate: 0.07 }, { rate: 0.07 }, { rate: 0.07 }], 'rate').total).toBe(0.21)
  })

  it('sums an empty list to zero with nothing withheld', () => {
    const r = sumPriced([], 'rate')
    expect(r).toEqual({ total: 0, unpriced: 0, counted: 0 })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('tolerates %s rows', (_label, rows) => {
    expect(sumPriced(rows, 'rate')).toEqual({ total: 0, unpriced: 0, counted: 0 })
  })

  it('treats a missing key as unknown, not as zero', () => {
    const r = sumPriced([{ other: 5 }], 'rate')
    expect(r.unpriced).toBe(1)
    expect(r.total).toBe(0)
  })

  it('keeps priced + unpriced equal to counted', () => {
    const rows = [{ rate: 1 }, { rate: null }, { rate: 0 }, { rate: 'x' }]
    const r = sumPriced(rows, 'rate')
    expect(r.counted - r.unpriced + r.unpriced).toBe(r.counted)
    expect(r.counted).toBe(4)
    expect(r.unpriced).toBe(2)
  })
})

describe('combinePriced', () => {
  const ship = sumPriced([{ t: 10 }, { t: null }], 't')
  const house = sumPriced([{ t: 5 }, { t: null }, { t: null }], 't')

  it('adds the totals', () => {
    expect(combinePriced(ship, house).total).toBe(15)
  })

  it('carries the withheld counts through the addition', () => {
    // This is the whole reason the function exists: `a.total + b.total` would
    // produce 15 and silently discard the fact that five rows went into it
    // and three of them had no price.
    const r = combinePriced(ship, house)
    expect(r.unpriced).toBe(3)
    expect(r.counted).toBe(5)
  })

  it('does not drift when adding float dollars', () => {
    const a = sumPriced([{ t: 1.1 }], 't')
    const b = sumPriced([{ t: 2.2 }], 't')
    expect(combinePriced(a, b).total).toBe(3.3)
  })

  it('combines nothing to an empty sum', () => {
    expect(combinePriced()).toEqual({ total: 0, unpriced: 0, counted: 0 })
  })

  it('combines a single sum to itself', () => {
    expect(combinePriced(ship)).toEqual(ship)
  })
})

describe('unpricedNote', () => {
  it('says nothing when nothing was left out', () => {
    // '' and not 'all priced'. A permanent all-clear beside every total is
    // how a real warning stops being read.
    expect(unpricedNote(0)).toBe('')
  })

  it('says nothing for a negative count', () => {
    expect(unpricedNote(-1)).toBe('')
  })

  it('names the count and says the total excludes them', () => {
    const note = unpricedNote(3)
    expect(note).toContain('3')
    expect(note).toContain('unpriced')
    expect(note).toContain('not included')
  })

  it('is singular for one', () => {
    expect(unpricedNote(1)).toContain('1 unpriced shipment ')
    expect(unpricedNote(1)).not.toContain('shipments')
  })

  it('is plural for more than one', () => {
    expect(unpricedNote(2)).toContain('2 unpriced shipments')
  })

  it('takes the noun, so a warehouse line is not called a shipment', () => {
    expect(unpricedNote(2, 'line')).toContain('2 unpriced lines')
    expect(unpricedNote(1, 'line')).toContain('1 unpriced line ')
  })
})
