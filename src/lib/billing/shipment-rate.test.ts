import { describe, it, expect } from 'vitest'
import {
  matchLegacyRate, shipmentProfit, cardRowCovers, bandCovers,
  type ShippingRateRow,
} from './shipment-rate'

// The function under test replaced two fallbacks in lib/billing/recalculate.ts
// that ran UNATTENDED over every shipment in the table:
//
//   - when no card row matched the carrier/service, the pool became the
//     client's entire card, so a USPS parcel could be billed from a UPS row
//   - when no weight band matched, it billed the HEAVIEST band
//
// and, failing both, wrote `client_rate: 0`.
//
// So the tests come in two kinds. The refusals assert BOTH that `rate` is null
// and that `reason` is non-empty, because a null with no reason is a line that
// vanishes from revenue with nothing on screen to say why. The anti-fallback
// tests assert the specific wrong numbers are NOT returned -- a refusal that
// happens to return the heaviest band would satisfy a `rate !== null` check
// and reintroduce the whole defect.

function row(over: Partial<ShippingRateRow> = {}): ShippingRateRow {
  return { rate: 5, weight_min: 0, weight_max: 16, carrier: 'usps', service: 'ground', ...over }
}

describe('matchLegacyRate', () => {
  // --- the priced case ------------------------------------------------------

  it('prices from the one band that covers the weight', () => {
    const r = matchLegacyRate([
      row({ rate: 4, weight_min: 0, weight_max: 16 }),
      row({ rate: 9, weight_min: 17, weight_max: 32 }),
    ], 'usps', 'ground', 20)
    expect(r).toEqual({ rate: 9, reason: null })
  })

  it('reads a numeric column that arrives as a string', () => {
    const r = matchLegacyRate([row({ rate: '7.25' })], 'usps', 'ground', 8)
    expect(r).toEqual({ rate: 7.25, reason: null })
  })

  it('keeps a rate of exactly 0 as 0, not as unknown', () => {
    // A card row with a 0 on it is one somebody wrote a 0 on. Converting that
    // to null raises an alert about a decision that was actually made.
    const r = matchLegacyRate([row({ rate: 0 })], 'usps', 'ground', 8)
    expect(r).toEqual({ rate: 0, reason: null })
  })

  it('treats a blank carrier and service on the card row as any', () => {
    // How the blanket rate card is expressed. If this stopped matching, every
    // client on a blanket card would go unpriced at once.
    const r = matchLegacyRate(
      [row({ carrier: '', service: '', rate: 3 })], 'fedex', 'overnight', 8)
    expect(r).toEqual({ rate: 3, reason: null })
  })

  it('treats null carrier and service on the card row as any', () => {
    const r = matchLegacyRate(
      [row({ carrier: null, service: null, rate: 3 })], 'fedex', 'overnight', 8)
    expect(r).toEqual({ rate: 3, reason: null })
  })

  it('treats null weight bounds as unbounded', () => {
    const r = matchLegacyRate(
      [row({ weight_min: null, weight_max: null, rate: 2 })], 'usps', 'ground', 9999)
    expect(r).toEqual({ rate: 2, reason: null })
  })

  it('matches a shipment carrier that extends the card row carrier', () => {
    // The bidirectional substring rule is preserved exactly as it was. This
    // module's job was to remove the fallbacks, not to reprice shipments that
    // match today -- a stricter rule would change live numbers for a reason
    // unrelated to the defect.
    const r = matchLegacyRate(
      [row({ carrier: 'usps', service: 'ground', rate: 6 })],
      'usps_priority_mail', 'ground_advantage', 8)
    expect(r).toEqual({ rate: 6, reason: null })
  })

  it('accepts two covering rows that agree on the rate', () => {
    // Overlapping bands are only a problem when they disagree. Refusing a card
    // that says the same thing twice would make a harmless redundancy
    // unpriceable.
    const r = matchLegacyRate([
      row({ rate: 5, weight_min: 0, weight_max: 16 }),
      row({ rate: 5, weight_min: 8, weight_max: 24 }),
    ], 'usps', 'ground', 10)
    expect(r).toEqual({ rate: 5, reason: null })
  })

  it('does not call 5 and "5.00" two different rates', () => {
    // numeric(10,2) can come back quoted from one row and bare from another.
    // Compared as strings those are an ambiguity, and the shipment would be
    // refused over a card that agrees with itself.
    const r = matchLegacyRate([
      row({ rate: 5, weight_min: 0, weight_max: 16 }),
      row({ rate: '5.00', weight_min: 8, weight_max: 24 }),
    ], 'usps', 'ground', 10)
    expect(r).toEqual({ rate: 5, reason: null })
  })

  // --- no card at all ------------------------------------------------------

  it('refuses when the client has no rate card', () => {
    const r = matchLegacyRate([], 'usps', 'ground', 8)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/no legacy shipping rate card/)
  })

  // --- the carrier fallback that billed another carrier's rate --------------

  it('refuses when no card row covers the carrier or service', () => {
    const r = matchLegacyRate(
      [row({ carrier: 'ups', service: 'ground', rate: 12 })], 'dhl', 'express', 8)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/no rate-card row covers carrier 'dhl'/)
    // Must list what the card DOES cover, or the reader cannot tell what to
    // add without opening the card.
    expect(r.reason).toMatch(/ups\/ground/)
  })

  it('does not fall back to another carrier row when the carrier misses', () => {
    // The exact old behaviour: `pool = rates` when the carrier filter emptied
    // the pool. It billed a real, plausible amount from an agreement that does
    // not apply, which nothing downstream can question.
    const r = matchLegacyRate(
      [row({ carrier: 'ups', service: 'ground', rate: 12 })], 'dhl', 'express', 8)
    expect(r.rate).not.toBe(12)
    expect(r.rate).toBeNull()
  })

  // --- the band fallback that billed the heaviest band ----------------------

  it('refuses a parcel below every band instead of billing the heaviest', () => {
    // The worst case of the old fallback. An 8oz parcel against a card
    // starting at 16oz was billed `sorted[sorted.length - 1]`, the 20lb rate.
    const card = [
      row({ rate: 10, weight_min: 16, weight_max: 160 }),
      row({ rate: 40, weight_min: 161, weight_max: 320 }),
    ]
    const r = matchLegacyRate(card, 'usps', 'ground', 8)
    expect(r.rate).toBeNull()
    expect(r.rate).not.toBe(40)
    expect(r.rate).not.toBe(10)
    expect(r.reason).toMatch(/falls below every weight band/)
    // The direction matters: below the lightest band overcharges, so the
    // message says which way it missed.
    expect(r.reason).toMatch(/overcharges/)
  })

  it('refuses a parcel above every band instead of billing the heaviest', () => {
    const card = [row({ rate: 10, weight_min: 0, weight_max: 160 })]
    const r = matchLegacyRate(card, 'usps', 'ground', 500)
    expect(r.rate).toBeNull()
    expect(r.rate).not.toBe(10)
    expect(r.reason).toMatch(/falls outside every weight band/)
    // And it has to show the bands it checked, or "outside every band" is not
    // actionable.
    expect(r.reason).toMatch(/0-160oz/)
  })

  it('does not resolve a band miss by picking any row on the card', () => {
    const card = [
      row({ rate: 1, weight_min: 16, weight_max: 32 }),
      row({ rate: 2, weight_min: 33, weight_max: 64 }),
      row({ rate: 3, weight_min: 65, weight_max: 128 }),
    ]
    const r = matchLegacyRate(card, 'usps', 'ground', 4)
    for (const wrong of [1, 2, 3]) expect(r.rate).not.toBe(wrong)
  })

  // --- ambiguity -----------------------------------------------------------

  it('refuses when two covering rows disagree on the rate', () => {
    const r = matchLegacyRate([
      row({ rate: 5, weight_min: 0, weight_max: 16 }),
      row({ rate: 50, weight_min: 8, weight_max: 24 }),
    ], 'usps', 'ground', 10)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/2 rate-card rows cover 10oz with different rates/)
    expect(r.reason).toMatch(/5/)
    expect(r.reason).toMatch(/50/)
  })

  it('does not break an ambiguity by taking the first or the cheapest', () => {
    const card = [
      row({ rate: 5, weight_min: 0, weight_max: 16 }),
      row({ rate: 50, weight_min: 8, weight_max: 24 }),
    ]
    const r = matchLegacyRate(card, 'usps', 'ground', 10)
    expect(r.rate).not.toBe(5)
    expect(r.rate).not.toBe(50)
  })

  // --- unusable values -----------------------------------------------------

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a non-numeric string', 'TBD'],
  ])('refuses a covering row whose rate is %s', (_label, rate) => {
    const r = matchLegacyRate([row({ rate })], 'usps', 'ground', 8)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/carries no usable rate/)
  })

  it('names the band of the unusable row, not just that one exists', () => {
    const r = matchLegacyRate(
      [row({ rate: null, weight_min: 4, weight_max: 12 })], 'usps', 'ground', 8)
    expect(r.reason).toMatch(/4-12oz/)
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('refuses to price from a billed weight of %s', (_label, weight) => {
    // Not hypothetical: billed weight is computed from dim weight, and every
    // `>=`/`<=` comparison against NaN is false -- which is precisely how a
    // shipment reached the heaviest-band fallback with no band matching.
    const r = matchLegacyRate([row()], 'usps', 'ground', weight)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/billed weight is/)
  })
})

describe('shipmentProfit', () => {
  it('computes profit and rounds to the cent', () => {
    expect(shipmentProfit(10.555, 3.33))
      .toEqual({ profitLoss: 7.23, isLoss: false, reason: null })
  })

  it('reports a loss when the cost exceeds the rate', () => {
    const r = shipmentProfit(5, 8)
    expect(r.profitLoss).toBe(-3)
    expect(r.isLoss).toBe(true)
  })

  it('does not call a break-even shipment a loss', () => {
    expect(shipmentProfit(5, 5)).toEqual({ profitLoss: 0, isLoss: false, reason: null })
  })

  it('reads an actual_cost that arrives as a string', () => {
    expect(shipmentProfit(10, '4.00').profitLoss).toBe(6)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['unreadable text', 'pending'],
  ])('refuses to treat an actual_cost of %s as free carriage', (_label, cost) => {
    // `clientRate - (actual_cost ?? 0)` reported the entire rate as profit on
    // a shipment whose carrier invoice had simply not arrived -- the most
    // flattering possible reading of the one number that says whether the
    // business is making money.
    const r = shipmentProfit(10, cost)
    expect(r.profitLoss).toBeNull()
    expect(r.reason).toMatch(/actual_cost is/)
    expect(r.reason).toMatch(/would report the whole rate as profit/)
  })

  it('does not report profit for a shipment with no rate', () => {
    const r = shipmentProfit(null, 5)
    expect(r.profitLoss).toBeNull()
    expect(r.reason).toMatch(/no rate/)
  })

  it('leaves is_loss false when profit is unknown', () => {
    // is_loss drives the loss report. A shipment of unknown profit is not
    // evidence of a loss, and filling that report with unknowns is how a real
    // loss stops being noticed.
    expect(shipmentProfit(null, 5).isLoss).toBe(false)
    expect(shipmentProfit(10, null).isLoss).toBe(false)
  })

  it('does not treat a zero cost as missing', () => {
    // 0 is a real carrier cost -- a free label, a test shipment -- and has to
    // stay distinguishable from no invoice yet.
    expect(shipmentProfit(10, 0)).toEqual({ profitLoss: 10, isLoss: false, reason: null })
  })
})

describe('cardRowCovers', () => {
  it.each([
    ['exact', 'usps', 'ground', 'usps', 'ground', true],
    ['card row is a prefix of the shipment', 'usps', 'ground', 'usps_priority', 'ground_advantage', true],
    ['shipment is a prefix of the card row', 'usps_priority', 'ground_advantage', 'usps', 'ground', true],
    ['blank card row matches anything', '', '', 'dhl', 'express', true],
    ['different carrier', 'ups', 'ground', 'dhl', 'ground', false],
    ['right carrier, wrong service', 'usps', 'express', 'usps', 'ground', false],
  ])('%s', (_label, rowCarrier, rowService, carrier, service, expected) => {
    expect(cardRowCovers(
      { rate: 1, carrier: rowCarrier, service: rowService }, carrier, service,
    )).toBe(expected)
  })
})

describe('bandCovers', () => {
  const r: ShippingRateRow = { rate: 1, weight_min: 16, weight_max: 32 }

  it.each([
    ['the lower bound, inclusive', 16, true],
    ['the upper bound, inclusive', 32, true],
    ['inside', 24, true],
    ['one below', 15, false],
    ['one above', 33, false],
  ])('covers %s', (_label, weight, expected) => {
    expect(bandCovers(r, weight)).toBe(expected)
  })

  it('treats a missing lower bound as unbounded below', () => {
    expect(bandCovers({ rate: 1, weight_max: 32 }, 0)).toBe(true)
  })

  it('treats a missing upper bound as unbounded above', () => {
    expect(bandCovers({ rate: 1, weight_min: 16 }, 99999)).toBe(true)
  })

  it('does not cover a NaN weight', () => {
    // Every comparison against NaN is false, so a band must not report that it
    // covers one. The old code's band filter returned nothing for a NaN weight
    // and then billed the heaviest band anyway.
    expect(bandCovers(r, NaN)).toBe(false)
  })
})
