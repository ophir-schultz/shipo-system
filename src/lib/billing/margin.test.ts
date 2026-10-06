import { describe, it, expect } from 'vitest'
import { pnlFigures, marginOf, campaignFigures, attributedRevenue } from './margin'
import { pricedTally, combinePriced, type PricedSum } from './unpriced'

// Built through pricedTally rather than written as literals, so these tests
// exercise the same path /pnl does -- the sums it passes in are accumulated
// figure by figure out of six reads, and a test that hand-wrote
// `{ total: 0, unpriced: 3, counted: 3 }` would not notice if the accumulator
// stopped producing that shape.
const sumOf = (...figures: unknown[]): PricedSum => {
  const t = pricedTally()
  for (const f of figures) t.take(f)
  return t.sum()
}
/** No figures offered at all: a client with no rows in that table. */
const NONE = combinePriced()

describe('pnlFigures', () => {
  it('reports the ordinary case unchanged', () => {
    const r = pnlFigures(sumOf(100, 50), sumOf(60, 30))
    expect(r).toEqual({ revenue: 150, cost: 90, profit: 60, margin: 40, unread: 0 })
  })

  // The defect this module exists for, stated as the four figures that were
  // wrong at once.
  it('does not report a client with no readable figures as breaking even', () => {
    const r = pnlFigures(sumOf(null, null), sumOf(null, null))
    expect(r.revenue).toBeNull()
    expect(r.cost).toBeNull()
    expect(r.profit).toBeNull()
    expect(r.margin).toBeNull()
    // Each of these is what the old expression produced, and each of them is
    // rendered: $0.00, $0.00, +$0.00 in green, 0%.
    expect(r.profit).not.toBe(0)
    expect(r.margin).not.toBe(0)
    expect(r.unread).toBe(4)
  })

  // The other half of every pair in this suite: a real zero must survive.
  it('reports a client whose figures are genuinely zero as zero', () => {
    const r = pnlFigures(sumOf(0, 0), sumOf(0))
    expect(r).toEqual({ revenue: 0, cost: 0, profit: 0, margin: null, unread: 0 })
    // Revenue of 0 has no margin -- a percentage of zero is undefined, not 0 --
    // but the revenue, cost and profit are real zeros and must not be dashed.
    expect(r.revenue).toBe(0)
    expect(r.profit).toBe(0)
  })

  it('reports a client with no rows at all as zero, not unknown', () => {
    // An empty set is a fact, not a gap. Dashing it would hide a real zero
    // behind the mark for UNKNOWN, which is the error the module it composes
    // with was written to stop.
    const r = pnlFigures(NONE, NONE)
    expect(r).toEqual({ revenue: 0, cost: 0, profit: 0, margin: null, unread: 0 })
  })

  it('withholds the profit when only the cost is unknown', () => {
    const r = pnlFigures(sumOf(100), sumOf(null, null))
    expect(r.revenue).toBe(100)
    expect(r.cost).toBeNull()
    // Not 100. An unknown cost read as zero OVERSTATES profit, which is the
    // dangerous direction: it is the figure nobody double-checks.
    expect(r.profit).toBeNull()
    expect(r.margin).toBeNull()
    expect(r.unread).toBe(2)
  })

  it('withholds the profit when only the revenue is unknown', () => {
    const r = pnlFigures(sumOf(null, null, null), sumOf(60))
    expect(r.revenue).toBeNull()
    expect(r.cost).toBe(60)
    // Not -60. A revenue nobody could read is not a revenue of nothing, and a
    // loss equal to the whole carrier cost is fabricated rather than cautious.
    expect(r.profit).toBeNull()
    expect(r.profit).not.toBe(-60)
    expect(r.unread).toBe(3)
  })

  it('keeps a partial figure and counts what it left out', () => {
    // Two of three shipments priced is a real revenue figure about those two,
    // and the row renders the count beside it. Collapsing partials to a dash
    // would throw away something the operator can act on.
    const r = pnlFigures(sumOf(80, null, 20), sumOf(50, null))
    expect(r).toEqual({ revenue: 100, cost: 50, profit: 50, margin: 50, unread: 2 })
  })

  it('is unknown only when no part of a combined revenue could be read', () => {
    // /pnl's revenue is shipping + warehouse + inbound, three tallies. The
    // empty ones must not rescue the figure from UNKNOWN...
    const blindShip = sumOf(null, null)
    expect(pnlFigures(combinePriced(blindShip, NONE, NONE), sumOf(10)).revenue)
      .toBeNull()
    // ...and one readable figure anywhere must.
    expect(pnlFigures(combinePriced(blindShip, sumOf(40), NONE), sumOf(10)).revenue)
      .toBe(40)
  })

  it('counts figures, not rows', () => {
    // One inbound line with neither amount readable has withheld two numbers.
    expect(pnlFigures(sumOf(null), sumOf(null)).unread).toBe(2)
  })

  it('reads the numerics PostgREST sends as strings', () => {
    const r = pnlFigures(sumOf('100.00'), sumOf('25.00'))
    expect(r).toEqual({ revenue: 100, cost: 25, profit: 75, margin: 75, unread: 0 })
  })
})

describe('marginOf', () => {
  it('is the profit as a percentage of revenue', () => {
    expect(marginOf(25, 100)).toBe(25)
    expect(marginOf(-50, 100)).toBe(-50)
  })

  // Three separate reasons to have no margin, all of which used to be 0.
  it('has no margin when the profit is unknown', () => {
    expect(marginOf(null, 100)).toBeNull()
  })

  it('has no margin when the revenue is unknown', () => {
    expect(marginOf(50, null)).toBeNull()
  })

  it('has no margin on a revenue of zero', () => {
    // A percentage of zero is undefined, not zero. `profit / 0` is Infinity,
    // and `Infinity.toFixed(0)` is the string 'Infinity' in a cell headed
    // "Margin"; 0 was the old guard against that, and it reads as break-even.
    expect(marginOf(-5, 0)).toBeNull()
    expect(marginOf(0, 0)).toBeNull()
  })

  it('has no margin on a negative revenue', () => {
    // Refunds can take a client's revenue below zero, and the percentage then
    // has the wrong sign: a profit of -10 on a revenue of -100 is +10%, which
    // would print in green.
    expect(marginOf(-10, -100)).toBeNull()
  })

  it('reports a real zero margin as zero, not as unknown', () => {
    // Trading exactly at cost is a fact about this client, and the dash is
    // reserved for figures nobody could read.
    expect(marginOf(0, 100)).toBe(0)
  })
})

describe('attributedRevenue', () => {
  it('attributes a client with no fulfillment rows as a real zero', () => {
    // Winning a client who never shipped is a real outcome, and the campaign
    // should wear the zero rather than have it skipped.
    expect(attributedRevenue(undefined)).toBe(0)
  })

  it('does not attribute a client whose revenue could not be read', () => {
    // The whole point, and the case `?? 0` could not express: `??` falls
    // through on null as well as undefined, so it would re-merge exactly the
    // two states this function exists to separate.
    expect(attributedRevenue(null)).toBeNull()
    expect(attributedRevenue(null)).not.toBe(0)
  })

  it('attributes a real figure as itself, zero included', () => {
    expect(attributedRevenue(1200.5)).toBe(1200.5)
    expect(attributedRevenue(0)).toBe(0)
    expect(attributedRevenue(-40)).toBe(-40)
  })

  it('feeds a tally that tells an unattributed campaign from an unread one', () => {
    // End to end on the shape /pnl uses: two clients tagged to a campaign.
    const unread = pricedTally()
    unread.take(attributedRevenue(null))
    unread.take(attributedRevenue(null))
    expect(pnlFigures(unread.sum(), NONE).revenue).toBeNull()

    const neverShipped = pricedTally()
    neverShipped.take(attributedRevenue(undefined))
    neverShipped.take(attributedRevenue(undefined))
    expect(pnlFigures(neverShipped.sum(), NONE).revenue).toBe(0)
  })
})

describe('campaignFigures', () => {
  it('reports the ordinary case unchanged', () => {
    expect(campaignFigures(300, 100, 4)).toEqual({ profit: 200, roi: 200, cac: 25 })
  })

  it('withholds profit and ROI when the spend was never entered', () => {
    const r = campaignFigures(300, null, 4)
    // `(monthly ?? 0) + (one_time ?? 0)` made this a profit of 300 and an ROI
    // of Infinity -- a campaign that earned its whole revenue for free.
    expect(r.profit).toBeNull()
    expect(r.roi).toBeNull()
    expect(r.cac).toBeNull()
  })

  it('withholds profit and ROI when the attributed revenue is unknown', () => {
    const r = campaignFigures(null, 100, 4)
    // The number this test exists for: revenue read as 0 against a real spend
    // of 100 is an ROI of -100%, "this campaign lost its entire budget", which
    // is an argument for cancelling it made out of figures nobody read.
    expect(r.roi).toBeNull()
    expect(r.roi).not.toBe(-100)
    expect(r.profit).toBeNull()
    expect(r.profit).not.toBe(-100)
  })

  it('still reports CAC when only the revenue is unknown', () => {
    // CAC is spend per client won and does not touch revenue. Withholding it
    // would hide a figure that is genuinely known.
    expect(campaignFigures(null, 100, 4).cac).toBe(25)
  })

  it('has no ROI on a spend of zero, and says so rather than reporting 0%', () => {
    // A real, entered spend of 0 is a division by zero, not a break-even.
    expect(campaignFigures(300, 0, 4).roi).toBeNull()
    // ...but the profit on a free campaign is real and is the whole revenue.
    expect(campaignFigures(300, 0, 4).profit).toBe(300)
  })

  it('has no CAC before any client has been won', () => {
    expect(campaignFigures(0, 500, 0).cac).toBeNull()
    expect(campaignFigures(0, 500, 0).profit).toBe(-500)
  })

  it('reports a real zero revenue as a real loss', () => {
    // A campaign that has been spent on and attributed nothing HAS lost its
    // budget, and that is the one case where the alarming figure is correct.
    expect(campaignFigures(0, 100, 0)).toEqual({ profit: -100, roi: -100, cac: null })
  })
})
