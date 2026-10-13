import { describe, it, expect } from 'vitest'
import {
  reconcile, combineReconciled, reconciledOrUnknown, marginPct, excludedCount,
  exclusionNote, invoiceableRevenue, otherIncome, type MarginRow,
} from '@/lib/billing/profit-rollup'
// The real renderers, not stand-ins. The point of the on-screen group below is
// that the subtraction survives the trip through the exact two functions the
// dashboard calls, so a local toFixed here would test nothing.
import { formatPrice, formatSignedPrice } from '@/lib/billing/unpriced'

// A shipment row, written as the three money columns only, because those are
// the only three this module reads.
const ship = (rate: unknown, cost: unknown, pl?: unknown): MarginRow =>
  pl === undefined ? { client_rate: rate, actual_cost: cost }
    : { client_rate: rate, actual_cost: cost, profit_loss: pl }

// The identity the whole module exists to guarantee, stated in cents.
//
// NOT `r.revenue - r.cost === r.profit`: that float form is false for ordinary
// inputs -- 30c of revenue against 10c of cost gives 0.19999999999999998, not
// 0.2 -- and asserting it would fail on a correct result. The cent is the unit
// every one of these figures is rendered in, so the cent is the unit the claim
// is made in. See the note on `reconcile`.
//
// The example is checked against node, not assumed. An earlier version of this
// comment (and of the test below) used 1c against 2c, which subtracts EXACTLY
// in IEEE754, so it asserted a discrepancy that was not there.
const subtracts = (r: { revenue: number; cost: number; profit: number }) => {
  const cents = (n: number) => Math.round(n * 100)
  expect(cents(r.revenue) - cents(r.cost)).toBe(cents(r.profit))
}

// The four buckets are a partition of every row offered. A partition that
// stops being total is how a row goes missing from a money figure without
// turning up in any count, which is this module's whole failure mode.
const partitions = (r: ReturnType<typeof reconcile>) => {
  expect(r.reconciled + r.unrated + r.uncosted + r.unmeasured).toBe(r.counted)
}

describe('reconcile', () => {
  it('sums revenue and cost over the same rows and subtracts to the cent', () => {
    const r = reconcile([ship(10, 7), ship(20, 12.5)])
    expect(r.revenue).toBe(30)
    expect(r.cost).toBe(19.5)
    expect(r.profit).toBe(10.5)
    expect(r.reconciled).toBe(2)
    subtracts(r)
    partitions(r)
  })

  it('subtracts exactly in a case where the float form would NOT', () => {
    // `0.3 - 0.1` is 0.19999999999999998 in IEEE 754. The module accumulates
    // in integer cents and divides once, so profit is exactly 0.2 -- and the
    // float difference of the two returned figures is NOT equal to it. That
    // inequality is the reason `subtracts()` is stated in cents rather than in
    // floats: the float identity is false about a correct result.
    //
    // Checked against node rather than assumed. The first version of this test
    // used 0.01 and 0.02, which do subtract exactly, so it asserted a
    // difference that was not there and failed on correct output.
    const r = reconcile([ship(0.3, 0.1)])
    expect(r.profit).toBe(0.2)
    expect(r.revenue - r.cost).not.toBe(r.profit)
    subtracts(r)
  })

  it('subtracts exactly for the other float case, 0.07 - 0.06', () => {
    const r = reconcile([ship(0.07, 0.06)])
    expect(r.profit).toBe(0.01)
    expect(r.revenue - r.cost).not.toBe(r.profit)
    subtracts(r)
  })

  it('excludes a row whose rate is unknown and calls it unrated', () => {
    // The dangerous bucket: we paid a carrier and nobody agreed a price.
    const r = reconcile([ship(10, 7), ship(null, 9)])
    expect(r.unrated).toBe(1)
    expect(r.reconciled).toBe(1)
    expect(r.revenue).toBe(10)
    // The $9 we paid is NOT in cost. Including it would make the margin wrong
    // in the pessimistic direction instead of the optimistic one -- still
    // wrong, and still a figure that does not subtract over one row set.
    expect(r.cost).toBe(7)
    expect(r.profit).toBe(3)
    subtracts(r)
    partitions(r)
  })

  it('excludes a row whose carrier cost has not landed and calls it uncosted', () => {
    const r = reconcile([ship(10, 7), ship(25, null)])
    expect(r.uncosted).toBe(1)
    expect(r.reconciled).toBe(1)
    // The $25 of agreed revenue is withheld too. This is the trade: narrower
    // revenue, exact subtraction. invoiceableRevenue is the other question.
    expect(r.revenue).toBe(10)
    subtracts(r)
    partitions(r)
  })

  it('excludes a row with neither side known and calls it unmeasured', () => {
    const r = reconcile([ship(null, null)])
    expect(r.unmeasured).toBe(1)
    expect(r.unrated).toBe(0)
    expect(r.uncosted).toBe(0)
    partitions(r)
  })

  it('puts each row in exactly one bucket', () => {
    const r = reconcile([
      ship(10, 7), ship(null, 9), ship(25, null), ship(null, null), ship(1, 1),
    ])
    expect(r.counted).toBe(5)
    expect(r.reconciled).toBe(2)
    expect(r.unrated).toBe(1)
    expect(r.uncosted).toBe(1)
    expect(r.unmeasured).toBe(1)
    partitions(r)
    subtracts(r)
  })

  it('treats a rate of 0 as a price, not as missing', () => {
    // A shipment that ships free is a DECISION. `!row.client_rate` would have
    // thrown this into `unrated` and narrowed the reconciled row set, which is
    // the same null-vs-zero trap the rest of billing/ exists to close.
    const r = reconcile([ship(0, 4)])
    expect(r.reconciled).toBe(1)
    expect(r.unrated).toBe(0)
    expect(r.revenue).toBe(0)
    expect(r.cost).toBe(4)
    expect(r.profit).toBe(-4)
    subtracts(r)
  })

  it('treats a cost of 0 as a price, not as missing', () => {
    const r = reconcile([ship(5, 0)])
    expect(r.reconciled).toBe(1)
    expect(r.uncosted).toBe(0)
    expect(r.profit).toBe(5)
  })

  it('coerces numeric strings, because that is how numeric(10,2) may arrive', () => {
    // `0 + '12.34'` is the string '012.34'. priceOf coerces; this pins that
    // the roll-up goes through it rather than adding raw column values.
    const r = reconcile([ship('12.34', '10.00')])
    expect(r.revenue).toBe(12.34)
    expect(r.cost).toBe(10)
    expect(r.profit).toBe(2.34)
    subtracts(r)
  })

  it('treats an uncoercible value as UNKNOWN, not as 0', () => {
    const r = reconcile([ship('abc', 5), ship(10, ''), ship(undefined, undefined)])
    expect(r.unrated).toBe(1)
    expect(r.uncosted).toBe(1)
    expect(r.unmeasured).toBe(1)
    expect(r.reconciled).toBe(0)
    partitions(r)
  })

  it('is a real zero for no rows at all', () => {
    const r = reconcile([])
    expect(r).toMatchObject({ revenue: 0, cost: 0, profit: 0, counted: 0, reconciled: 0 })
    const n = reconcile(null)
    expect(n.counted).toBe(0)
    expect(reconcile(undefined).counted).toBe(0)
  })

  it('does not accumulate float drift over many rows', () => {
    // 0.1 + 0.2 is the standard reason an all-time figure ends in a stray
    // fraction of a cent. Ten cents of revenue against ten of cost must be
    // exactly zero margin, not 2.7e-17.
    const rows = Array.from({ length: 1000 }, () => ship(0.1, 0.1))
    const r = reconcile(rows)
    expect(r.revenue).toBe(100)
    expect(r.cost).toBe(100)
    expect(r.profit).toBe(0)
    subtracts(r)
  })

  it('does not read profit from the stored profit_loss column', () => {
    // The old card's profit line WAS this column. If the roll-up deferred to
    // it, a stale value would still be published as margin.
    const r = reconcile([ship(10, 7, 999)])
    expect(r.profit).toBe(3)
    subtracts(r)
  })

  it('counts a stored profit_loss that disagrees with the derived margin', () => {
    const r = reconcile([ship(10, 7, 3), ship(10, 7, 3.01), ship(10, 7, 999)])
    expect(r.stale).toBe(2)
    expect(r.profit).toBe(9)
  })

  it('does not call an absent profit_loss stale', () => {
    // Silent is not wrong. A row the carrier has not been reconciled against
    // yet has nothing to disagree with.
    expect(reconcile([ship(10, 7)]).stale).toBe(0)
    expect(reconcile([ship(10, 7, null)]).stale).toBe(0)
  })
})

describe('the claim as it appears on screen', () => {
  // The invariant tests above are about the returned numbers. This one is
  // about the three strings the dashboard card actually prints, because that
  // is the form the claim is made in: an operator reading
  // "$12,345.67 / −$9,876.54 / +$2,469.13" is doing the subtraction by eye,
  // and what has to hold is that the subtraction comes out.
  //
  // So: render the figures the way the card renders them, parse the rendered
  // text back, and subtract. formatPrice and formatSignedPrice are the real
  // ones from ./unpriced, not reimplemented here -- a copy would pass while
  // the page printed something else.
  const parse = (s: string) => Math.round(parseFloat(s.replace(/[$+−,]/g, '')) * 100)

  const rendersSubtracting = (rows: MarginRow[]) => {
    const r = reconcile(rows)
    const k = reconciledOrUnknown(r)

    // Positive control, NOT `if (null) return`. Every caller below passes rows
    // that do reconcile, so UNKNOWN here means the module broke -- and an
    // early return would turn that into a silent pass. The dash case has its
    // own test; this helper's job is to prove figures were rendered AND that
    // they subtract. Without this line a mutant that made reconciledOrUnknown
    // always answer UNKNOWN would satisfy four of the five tests vacuously.
    expect(k.revenue, 'these rows should reconcile').not.toBeNull()

    const rev = formatPrice(k.revenue)
    const cost = `−${formatPrice(k.cost)}`
    const margin = formatSignedPrice(k.profit)
    expect(rev).not.toBe('—')
    expect(margin).not.toBe('—')
    expect(parse(rev) - parse(cost), `${rev} − ${cost} should be ${margin}`)
      .toBe(parse(margin))
  }

  it('prints three figures that subtract', () => {
    rendersSubtracting([ship(12345.67, 9876.54), ship(100, 80)])
  })

  it('prints figures that subtract when rows were excluded', () => {
    rendersSubtracting([
      ship(12345.67, 9876.54), ship(null, 500), ship(900, null), ship(null, null),
    ])
  })

  it('prints figures that subtract for a loss-making period', () => {
    rendersSubtracting([ship(10, 7000.01)])
  })

  it('prints figures that subtract at cent-level values', () => {
    rendersSubtracting([ship(0.07, 0.06), ship(0.3, 0.1), ship(0.01, 0.02)])
  })

  it('renders a dash and no figures when nothing reconciled', () => {
    // The case that used to print '+$0.00' in green. Checked here rather than
    // only in reconciledOrUnknown, because this is the rendered consequence.
    const k = reconciledOrUnknown(reconcile([ship(10, null), ship(20, null)]))
    expect(formatPrice(k.revenue)).toBe('—')
    expect(formatSignedPrice(k.profit)).toBe('—')
    expect(formatSignedPrice(k.profit)).not.toBe('+$0.00')
  })
})

describe('both invariants hold for arbitrary inputs', () => {
  // The hand-picked cases above each pin a specific decision. This one is the
  // general claim, over inputs nobody chose: whatever the rows, the triple
  // subtracts to the cent and the four buckets account for every row.
  //
  // Deterministic generator, seeded, so a failure is reproducible -- a random
  // test that cannot be re-run is a test that gets deleted the first time it
  // goes red.
  const rand = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  it('subtracts and partitions across 500 random row sets', () => {
    const next = rand(20261013)
    // A value generator that produces the full three-state range these
    // columns actually hold: a price, a deliberate 0, UNKNOWN as null, UNKNOWN
    // as undefined, UNKNOWN as '', a numeric string off the wire, and junk.
    const value = () => {
      const r = next()
      if (r < 0.12) return null
      if (r < 0.18) return undefined
      if (r < 0.22) return ''
      if (r < 0.26) return 'not a number'
      if (r < 0.32) return 0
      if (r < 0.42) return (next() * 500).toFixed(2) // string off the wire
      return Math.round(next() * 50000) / 100
    }

    for (let i = 0; i < 500; i++) {
      const rows: MarginRow[] = Array.from(
        { length: Math.floor(next() * 12) },
        () => ({ client_rate: value(), actual_cost: value(), profit_loss: value() }),
      )
      const r = reconcile(rows)
      subtracts(r)
      partitions(r)
      // And the figures must be finite. A NaN reaching toFixed(2) renders as
      // 'NaN' without throwing, which is how a junk column would otherwise
      // arrive on screen looking like a figure.
      expect(Number.isFinite(r.revenue)).toBe(true)
      expect(Number.isFinite(r.cost)).toBe(true)
      expect(Number.isFinite(r.profit)).toBe(true)
      const pct = marginPct(r)
      if (pct !== null) expect(Number.isFinite(pct)).toBe(true)
    }
  })

  it('survives recombination across 200 random splits', () => {
    // The property the per-client footer rests on, over inputs nobody chose:
    // split the rows any way at all, reconcile each part, combine, and the
    // answer must equal reconciling the whole.
    const next = rand(99991)
    for (let i = 0; i < 200; i++) {
      const rows: MarginRow[] = Array.from({ length: Math.floor(next() * 15) }, () => ({
        client_rate: next() < 0.2 ? null : Math.round(next() * 10000) / 100,
        actual_cost: next() < 0.2 ? null : Math.round(next() * 10000) / 100,
      }))
      const cut = Math.floor(next() * (rows.length + 1))
      const combined = combineReconciled(
        reconcile(rows.slice(0, cut)), reconcile(rows.slice(cut)))
      expect(combined).toEqual(reconcile(rows))
      subtracts(combined)
      partitions(combined)
    }
  })
})

describe('combineReconciled', () => {
  it('adds the figures and keeps both invariants', () => {
    const a = reconcile([ship(10, 7)])
    const b = reconcile([ship(20, 25), ship(null, 3)])
    const c = combineReconciled(a, b)
    expect(c.revenue).toBe(30)
    expect(c.cost).toBe(32)
    expect(c.profit).toBe(-2)
    expect(c.reconciled).toBe(2)
    expect(c.counted).toBe(3)
    expect(c.unrated).toBe(1)
    subtracts(c)
    partitions(c)
  })

  it('equals reconciling the concatenated rows', () => {
    // The property that makes a per-client footer trustworthy: splitting rows
    // by client and recombining must give the same figures as not splitting
    // them. If this ever stops holding, the table and its total disagree.
    const rowsA = [ship(10, 7), ship(null, 9), ship(0.07, 0.06)]
    const rowsB = [ship(25, null), ship(null, null), ship(3.33, 1.11)]
    const split = combineReconciled(reconcile(rowsA), reconcile(rowsB))
    const whole = reconcile([...rowsA, ...rowsB])
    expect(split).toEqual(whole)
  })

  it('carries the exclusion buckets through the addition', () => {
    const c = combineReconciled(
      reconcile([ship(null, 9)]),
      reconcile([ship(25, null)]),
      reconcile([ship(null, null)]),
    )
    expect(c.unrated).toBe(1)
    expect(c.uncosted).toBe(1)
    expect(c.unmeasured).toBe(1)
    expect(c.reconciled).toBe(0)
    expect(excludedCount(c)).toBe(3)
    partitions(c)
  })

  it('does not drift when combining many cent-level parts', () => {
    const parts = Array.from({ length: 300 }, () => reconcile([ship(0.07, 0.06)]))
    const c = combineReconciled(...parts)
    expect(c.revenue).toBe(21)
    expect(c.cost).toBe(18)
    expect(c.profit).toBe(3)
    subtracts(c)
  })

  it('is a real zero for no parts', () => {
    const c = combineReconciled()
    expect(c).toEqual({
      revenue: 0, cost: 0, profit: 0, reconciled: 0, counted: 0,
      unrated: 0, uncosted: 0, unmeasured: 0, stale: 0,
    })
  })

  it('is UNKNOWN when every part was unreconcilable', () => {
    const c = combineReconciled(reconcile([ship(10, null)]), reconcile([ship(null, 5)]))
    expect(reconciledOrUnknown(c)).toEqual({ revenue: null, cost: null, profit: null })
  })

  it('does not mutate its arguments', () => {
    // `out = { ...EMPTY }` and not `out = EMPTY`: a shared mutable module-level
    // object would accumulate across every call on the page.
    const a = reconcile([ship(10, 7)])
    const before = { ...a }
    combineReconciled(a, a)
    expect(a).toEqual(before)
    // And the second call must not see the first call's accumulation.
    expect(combineReconciled(a).revenue).toBe(10)
    expect(combineReconciled(a).revenue).toBe(10)
  })
})

describe('reconciledOrUnknown', () => {
  it('passes a real triple through', () => {
    const { revenue, cost, profit } = reconciledOrUnknown(reconcile([ship(10, 7)]))
    expect(revenue).toBe(10)
    expect(cost).toBe(7)
    expect(profit).toBe(3)
  })

  it('is UNKNOWN when rows existed and none could be reconciled', () => {
    // The case that used to print +$0.00 in green: a period whose shipments
    // are all waiting on carrier invoices has no measured margin.
    const r = reconciledOrUnknown(reconcile([ship(10, null), ship(20, null)]))
    expect(r).toEqual({ revenue: null, cost: null, profit: null })
  })

  it('is a real zero when there were no rows', () => {
    // A quiet week genuinely made $0.00 at $0.00 for $0.00. Dashing it would
    // hide a real zero behind the mark for UNKNOWN.
    const r = reconciledOrUnknown(reconcile([]))
    expect(r).toEqual({ revenue: 0, cost: 0, profit: 0 })
  })

  it('publishes a PARTIAL reconciliation rather than collapsing it', () => {
    const r = reconciledOrUnknown(reconcile([ship(10, 7), ship(50, null)]))
    expect(r.profit).toBe(3)
  })
})

describe('marginPct', () => {
  it('is profit over revenue', () => {
    expect(marginPct(reconcile([ship(100, 80)]))).toBeCloseTo(20, 10)
  })

  it('is negative for a loss-making period', () => {
    expect(marginPct(reconcile([ship(100, 120)]))).toBeCloseTo(-20, 10)
  })

  it('is null rather than Infinity when revenue is zero', () => {
    // `profit / 0` is -Infinity here, and 'Infinity%' renders through
    // toFixed(1) without complaint.
    const r = marginPct(reconcile([ship(0, 5)]))
    expect(r).toBeNull()
  })

  it('is null rather than NaN when nothing reconciled', () => {
    expect(marginPct(reconcile([ship(10, null)]))).toBeNull()
    expect(marginPct(reconcile([]))).toBeNull()
  })
})

describe('exclusionNote', () => {
  it('is empty when every row reconciled', () => {
    // '' and not an all-clear: a permanent note under every figure is how a
    // real one stops being read.
    expect(exclusionNote(reconcile([ship(10, 7)]))).toBe('')
    expect(exclusionNote(reconcile([]))).toBe('')
  })

  it('names the unbilled bucket first, because it is the actionable one', () => {
    const note = exclusionNote(reconcile([
      ship(10, 7), ship(null, 9), ship(25, null), ship(null, null),
    ]))
    expect(note).toContain('3 of 4 shipments not in these figures')
    expect(note.indexOf('no agreed rate')).toBeLessThan(note.indexOf('awaiting carrier cost'))
    expect(note).toContain('1 with neither')
  })

  it('omits a bucket that is empty', () => {
    const note = exclusionNote(reconcile([ship(10, 7), ship(25, null)]))
    expect(note).toContain('awaiting carrier cost')
    expect(note).not.toContain('no agreed rate')
    expect(note).not.toContain('neither')
  })

  it('takes a noun, so a warehouse line is not called a shipment', () => {
    expect(exclusionNote(reconcile([ship(null, 9)]), 'line')).toContain('1 of 1 line ')
  })

  it('pluralizes on the counts it actually prints', () => {
    expect(exclusionNote(reconcile([ship(null, 9), ship(10, 7)]))).toContain('1 of 2 shipments')
  })
})

describe('excludedCount', () => {
  it('adds the three excluded buckets and not the reconciled one', () => {
    const r = reconcile([ship(10, 7), ship(null, 9), ship(25, null), ship(null, null)])
    expect(excludedCount(r)).toBe(3)
  })
})

describe('invoiceableRevenue', () => {
  it('counts a rate whose cost has not landed, which reconcile deliberately does not', () => {
    // The whole reason both functions exist. A shipment with an agreed rate is
    // owed whether or not the carrier has billed us.
    const rows = [ship(10, 7), ship(25, null)]
    expect(invoiceableRevenue(rows).total).toBe(35)
    expect(reconcile(rows).revenue).toBe(10)
  })

  it('still withholds a row with no agreed rate, and says how many', () => {
    const s = invoiceableRevenue([ship(10, 7), ship(null, 9)])
    expect(s.total).toBe(10)
    expect(s.unpriced).toBe(1)
    expect(s.counted).toBe(2)
  })
})

describe('otherIncome', () => {
  it('adds warehouse totals to manual charge amounts', () => {
    const s = otherIncome([{ total: 100 }, { total: 50 }], [{ amount: 25 }])
    expect(s.total).toBe(175)
    expect(s.counted).toBe(3)
  })

  it('carries both withheld counts through the addition', () => {
    // `a.total + b.total` is where these would be dropped.
    const s = otherIncome([{ total: null }, { total: 50 }], [{ amount: null }])
    expect(s.total).toBe(50)
    expect(s.unpriced).toBe(2)
  })

  it('is a counted-nothing when either source is absent', () => {
    expect(otherIncome(null, undefined)).toEqual({ total: 0, unpriced: 0, counted: 0 })
  })

  it('reads the right column from each source', () => {
    // These were once positional (`i === 0 ? 'total' : 'amount'`), which summed
    // the WRONG column if a caller passed manual charges first -- silently,
    // since both columns hold money. Named parameters make that unexpressible;
    // this pins it.
    expect(otherIncome([{ amount: 999, total: 1 }], [{ total: 999, amount: 2 }]).total).toBe(3)
  })
})
