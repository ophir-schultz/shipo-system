import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { resolveZone, resolveZoneRate, weightToLb } =
  await import('@/lib/billing/zones')

// What these tests are about is one distinction, in two functions: a lane the
// rate card does not cover versus a read that did not answer.
//
// It matters here more than almost anywhere else in the repo because of what
// the callers do with a null. In BOTH recalculate.ts and calculator.ts a null
// zone, or a null zone rate, is the signal to reprice the shipment off the
// LEGACY carrier/service rate card -- a different agreement, at a different
// number. So when these functions discarded their query errors, a database
// hiccup did not make a shipment unpriced, which anyone would have seen; it
// made the shipment priced off the wrong card, written by an unattended
// monitor run, formatted to two decimals, and indistinguishable from a
// correct row.
//
// Every test below is therefore paired: the same null, once because there is
// genuinely no row and once because the read failed, asserted to come back
// with different verdicts.

const CID = 'c1'

function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    zone_chart: [],
    client_zone_rates: [],
    ...over,
  })
}

beforeEach(() => seed())

function chart(over: Record<string, unknown> = {}) {
  return { origin_prefix: '191', dest_prefix: '902', zone: 8, ...over }
}

function cell(over: Record<string, unknown> = {}) {
  return {
    client_id: CID, carrier: 'usps', service: 'ground',
    weight_lb: 1, zone: 3, rate: 7.25, ...over,
  }
}

describe('weightToLb', () => {
  // Untested until now, and it decides which matrix ROW a shipment is billed
  // from -- so an off-by-one here is a wrong price on every shipment, not a
  // wrong price on an edge case.
  it('rounds UP to whole pounds', () => {
    expect(weightToLb(16)).toBe(1)
    expect(weightToLb(17)).toBe(2)
    expect(weightToLb(32)).toBe(2)
    expect(weightToLb(33)).toBe(3)
  })

  it('puts any real weight under a pound on the 1 LB row', () => {
    expect(weightToLb(1)).toBe(1)
    expect(weightToLb(0.5)).toBe(1)
  })

  it('names the row the parcel actually weighs, with no ceiling', () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and both halves of the comment
    // justifying it were measured false on 2026-10-05. It read:
    //
    //   it('caps at the top row the matrix has')
    //   // 20 LB is the last column of the chart. Without the cap this would
    //   // ask for a row that cannot exist, miss, and reprice off the legacy
    //   // card.
    //
    // 20 LB is NOT the last column. client_zone_rates holds rows 1..100 for
    // Orcam and 1..27 for Crisp Power, so 640 of Orcam's 800 cells were
    // unreachable and a 25 LB parcel was billed the 20 LB rate while its own
    // agreed cell sat unread. The cap was an under-bill nobody could see,
    // because the figure it produced was a real rate from a real row.
    //
    // And a miss does not reprice wrongly. resolveZoneRate answers a miss as
    // `{ rate: null, error: null }`; the caller falls through to
    // matchLegacyRate, which REFUSES a weight outside every band and names the
    // bands in the reason. So the uncapped failure is an unpriced shipment with
    // an explanation -- the same refusal this whole module exists to preserve.
    expect(weightToLb(320)).toBe(20)
    expect(weightToLb(321)).toBe(21)
    expect(weightToLb(400)).toBe(25)
    expect(weightToLb(1600)).toBe(100)
  })

  it('returns a row past the heaviest card row rather than clamping into a billable one', () => {
    // The case the cap made unreachable, and the one that decides whether
    // removing it is safe. A row no card carries must be ASKED FOR and missed,
    // so the shipment lands unpriced with a reason. Clamping it to the heaviest
    // row anyone agreed is how a 600 LB pallet gets invoiced at the 20 LB rate.
    expect(weightToLb(10_000)).toBe(625)
    expect(weightToLb(1601)).toBe(101)
  })

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -5],
  ])('names no row for a weight that is %s', (_label, weightOz) => {
    // This used to return 1 -- the CHEAPEST row of the matrix -- for every one
    // of these. `Math.ceil((weightOz || 0) / 16)` with `if (lb < 1) return 1`
    // meant an unweighed shipment was not reported as unpriceable, it was
    // billed the 1 LB rate: a real price, correct for a real parcel, and
    // impossible to tell apart from one afterwards.
    //
    // 0 is in this list on purpose. 0 is a decision when it is a RATE -- a lane
    // somebody made free -- and never a measurement when it is a weight, so
    // honouring a stored 0 here is honouring the `?? 0` that replaced a
    // measurement nobody took.
    expect(weightToLb(weightOz)).toBeNull()
  })

  it('coerces a weight that arrived as a string', () => {
    expect(weightToLb('17')).toBe(2)
  })
})

describe('resolveZone: the sources that cannot fail', () => {
  it('uses a zone already on the shipment without reading anything', async () => {
    const r = await resolveZone({ zone: 5 }, '19101')
    expect(r).toEqual({ zone: 5, error: null })
    expect(h.db.calls).toHaveLength(0)
  })

  it('ignores an out-of-range zone on the shipment and keeps looking', async () => {
    seed({ zone_chart: [chart({ zone: 4 })] })
    const r = await resolveZone({ zone: 99, recipient_zip: '90210' }, '19101')
    expect(r.zone).toBe(4)
  })

  it('reads a zone out of the ShipStation payload', async () => {
    for (const raw of [
      { zone: 3 },
      { shippingZone: '4' },
      { advancedOptions: { zone: 5 } },
      { shipTo: { zone: 6 } },
    ]) {
      const r = await resolveZone({ raw_data: raw })
      expect(r.error).toBeNull()
      expect(r.zone).not.toBeNull()
    }
  })

  it('falls past a payload zone that is not usable, rather than failing', async () => {
    // A junk candidate is not an error: nothing was read, so nothing failed,
    // and the chart below must still be tried.
    seed({ zone_chart: [chart({ zone: 2 })] })
    const r = await resolveZone(
      { raw_data: { zone: 'not a zone' }, recipient_zip: '90210' }, '19101')
    expect(r).toEqual({ zone: 2, error: null })
  })
})

describe('resolveZone: the zone chart', () => {
  it('resolves a lane the chart covers', async () => {
    seed({ zone_chart: [chart()] })
    const r = await resolveZone({ recipient_zip: '90210-1234' }, '19101')
    expect(r).toEqual({ zone: 8, error: null })
  })

  it('distinguishes a lane the chart does not cover from a failed read', async () => {
    // THE test. Both answer `zone: null`; only one of them is a fact about the
    // chart. The caller reprices off the legacy card on the first and must
    // refuse on the second.
    seed({ zone_chart: [chart({ dest_prefix: '100' })] })
    const missing = await resolveZone({ recipient_zip: '90210' }, '19101')

    seed({ zone_chart: [chart()] })
    h.db.failOn = (c) => c.table === 'zone_chart'
      ? { message: 'canceling statement due to statement timeout' } : null
    const broken = await resolveZone({ recipient_zip: '90210' }, '19101')

    expect(missing.zone).toBeNull()
    expect(missing.error).toBeNull()

    expect(broken.zone).toBeNull()
    expect(broken.error).toContain('statement timeout')
    expect(missing.error === broken.error).toBe(false)
  })

  it('names the lane in the message, because the caller loops over every shipment', async () => {
    seed({ zone_chart: [chart()] })
    h.db.failOn = () => ({ message: 'fetch failed' })
    const r = await resolveZone({ recipient_zip: '90210' }, '19101')
    expect(r.error).toContain('191->902')
  })

  it('reports several chart rows for one lane as unreadable, not as absent', async () => {
    // supabase-js answers .maybeSingle() with PGRST116 -- an error, not a throw
    // -- when more than one row matches. The unique constraint that would make
    // this impossible lives in supabase/zone_rates.sql, which has never been
    // executed from this repo, so the code must not rely on it. Two chart rows
    // disagreeing about a lane is the last situation in which to pick one.
    seed({ zone_chart: [chart({ zone: 2 }), chart({ zone: 7 })] })
    const r = await resolveZone({ recipient_zip: '90210' }, '19101')
    expect(r.zone).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it('reports a chart row outside 1..8 as unreadable, not as no zone', async () => {
    // The old code let this fall through to `return null`, so a corrupt chart
    // row silently became "this lane has no zone" and the shipment was repriced
    // off the legacy card.
    seed({ zone_chart: [chart({ zone: 99 })] })
    const r = await resolveZone({ recipient_zip: '90210' }, '19101')
    expect(r.zone).toBeNull()
    expect(r.error).toContain('99')
  })

  it('does not read the chart at all without both ZIPs', async () => {
    seed({ zone_chart: [chart()] })
    expect(await resolveZone({ recipient_zip: '90210' })).toEqual({ zone: null, error: null })
    expect(await resolveZone({}, '19101')).toEqual({ zone: null, error: null })
    expect(await resolveZone({ recipient_zip: 'ab' }, '19101')).toEqual({ zone: null, error: null })
    expect(h.db.calls).toHaveLength(0)
  })
})

describe('resolveZone: the chart is a US chart, so only US addresses may consult it', () => {
  // Found in production 2026-10-13. zone_chart maps a US ZIP PREFIX to a zone.
  // The dest prefix was derived as `recipient_zip.replace(/\D/g,'').slice(0,3)`,
  // which does not ask whether the parcel is going to the US -- it just strips
  // non-digits and takes three. Foreign postcodes survive that:
  //
  //   B2Y 1M9  (Nova Scotia)  -> '219' -> a real chart row -> zone 2
  //   15172    (Spain)        -> '151' -> a real chart row -> zone 3
  //   2292     (Australia)    -> '229' -> a real chart row -> zone 3
  //
  // So a parcel to Canada was being priced on the Maryland lane. Nothing had
  // been MIS-billed yet only because the affected clients happened to miss on
  // the rate card for other reasons -- and the carrier/service match was
  // loosened in the same file the same day, which removed that accident.
  //
  // `{ zone: null, error: null }` and not an error: "no DOMESTIC zone applies"
  // is a fact about the lane, not a failed read. The shipment then falls
  // through to the legacy card, where a genuinely agreed international row
  // prices it correctly, and where matchLegacyRate already says exactly what
  // is missing if there is no such row.

  it('does not turn a Canadian postcode into a US zone', async () => {
    // The letters strip out and leave three digits that ARE a real US prefix.
    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '219', zone: 2 })] })
    const r = await resolveZone(
      { recipient_zip: 'B2Y 1M9', raw_data: { shipTo: { country: 'CA' } } }, '19801')
    expect(r).toEqual({ zone: null, error: null })
  })

  it('does not turn a numeric foreign postcode into a US zone', async () => {
    // Spain and Australia: no letters to save us, nothing about the digits
    // themselves says which country they belong to.
    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '151', zone: 3 })] })
    const es = await resolveZone(
      { recipient_zip: '15172', raw_data: { shipTo: { country: 'ES' } } }, '19801')
    expect(es).toEqual({ zone: null, error: null })

    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '229', zone: 3 })] })
    const au = await resolveZone(
      { recipient_zip: '2292', raw_data: { shipTo: { country: 'AU' } } }, '19801')
    expect(au).toEqual({ zone: null, error: null })
  })

  it('the seeded chart really would have answered, but for the country', async () => {
    // The positive control for the three tests above. Without it they pass
    // whenever the fixture simply fails to cover the lane -- which is exactly
    // how they passed the first time I ran them, against an unfixed
    // resolveZone, because the chart defaults to a different origin prefix.
    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '219', zone: 2 })] })
    const sameZipAsUS = await resolveZone({ recipient_zip: '21901' }, '19801')
    expect(sameZipAsUS).toEqual({ zone: 2, error: null })
  })

  it('does not read the chart at all for a foreign address', async () => {
    // Not merely discarding the answer afterwards: the lookup never happens.
    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '219', zone: 2 })] })
    await resolveZone(
      { recipient_zip: 'B2Y 1M9', raw_data: { shipTo: { country: 'CA' } } }, '19801')
    expect(h.db.calls).toHaveLength(0)
  })

  it('still resolves a US address that says so', async () => {
    seed({ zone_chart: [chart()] })
    const r = await resolveZone(
      { recipient_zip: '90210', raw_data: { shipTo: { country: 'US' } } }, '19101')
    expect(r).toEqual({ zone: 8, error: null })
  })

  it('still resolves when no country is recorded at all', async () => {
    // The regression that matters. Almost every domestic row reaching this
    // function has no country in raw_data, and an absent country must not be
    // read as "not the US" -- that would stop pricing the whole book.
    seed({ zone_chart: [chart()] })
    expect(await resolveZone({ recipient_zip: '90210' }, '19101'))
      .toEqual({ zone: 8, error: null })
    expect(await resolveZone({ recipient_zip: '90210', raw_data: {} }, '19101'))
      .toEqual({ zone: 8, error: null })
    expect(await resolveZone(
      { recipient_zip: '90210', raw_data: { shipTo: { country: null } } }, '19101'))
      .toEqual({ zone: 8, error: null })
  })

  it('reads the country however ShipStation spelled it', async () => {
    // Lowercase, padded, and the top-level key the payload sometimes uses
    // instead of nesting it under shipTo.
    seed({ zone_chart: [chart()] })
    expect(await resolveZone(
      { recipient_zip: '90210', raw_data: { shipTo: { country: ' us ' } } }, '19101'))
      .toEqual({ zone: 8, error: null })

    seed({ zone_chart: [chart({ origin_prefix: '198', dest_prefix: '219', zone: 2 })] })
    expect(await resolveZone(
      { recipient_zip: 'B2Y 1M9', raw_data: { country: 'ca' } }, '19801'))
      .toEqual({ zone: null, error: null })
  })

  it('still trusts a zone the carrier itself returned', async () => {
    // Only the ZIP-PREFIX INFERENCE is unsound abroad. A zone already on the
    // row, or one the carrier put in the payload, is somebody's assertion
    // rather than our guess, and this change is not the place to overrule it.
    seed({ zone_chart: [] })
    const r = await resolveZone(
      { recipient_zip: 'B2Y 1M9', zone: 5, raw_data: { shipTo: { country: 'CA' } } }, '19801')
    expect(r).toEqual({ zone: 5, error: null })
  })
})

describe('resolveZoneRate', () => {
  it('returns the cell for an exact carrier/service match', async () => {
    seed({ client_zone_rates: [cell()] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r).toEqual({ rate: 7.25, error: null })
  })

  it('honours a cell holding 0 as the agreed price', async () => {
    // A lane somebody priced at nothing on purpose. A truthiness test here
    // would miss it and reprice off a different card.
    seed({ client_zone_rates: [cell({ rate: 0 })] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r.rate).toBe(0)
    expect(r.error).toBeNull()
  })

  it('coerces a numeric that arrived over PostgREST as a string', async () => {
    // `numeric(10,2)` comes back quoted. The old code used Number(); priceOf
    // does the same job and answers null for the values Number() turns into NaN.
    seed({ client_zone_rates: [cell({ rate: '12.34' })] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r.rate).toBe(12.34)
  })

  it('falls back to the blanket card when no specific cell exists', async () => {
    seed({ client_zone_rates: [cell({ carrier: '', service: '', rate: 5 })] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r).toEqual({ rate: 5, error: null })
  })

  it('prefers the specific cell over the blanket card', async () => {
    seed({
      client_zone_rates: [
        cell({ rate: 9 }),
        cell({ carrier: '', service: '', rate: 5 }),
      ],
    })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r.rate).toBe(9)
  })

  it('distinguishes no matrix cell at all from a failed read', async () => {
    seed({ client_zone_rates: [cell({ zone: 1 })] })
    const missing = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    seed({ client_zone_rates: [cell()] })
    h.db.failOn = (c) => c.table === 'client_zone_rates'
      ? { message: 'fetch failed' } : null
    const broken = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    // Asserted field-by-field rather than by deep equality: a miss now also
    // carries a `reason` explaining itself. What this test is about is
    // unchanged -- `error` null on one and set on the other is the whole
    // distinction, and `reason` must never stand in for it.
    expect(missing.rate).toBeNull()
    expect(missing.error).toBeNull()

    expect(broken.rate).toBeNull()
    expect(broken.error).toContain('fetch failed')
  })

  it('does not answer with the blanket rate when the read failed', async () => {
    // This test used to pin a guard against a TWO-READ hazard: the specific
    // carrier/service read failing while the blanket read succeeded, so that
    // answering with the blanket rate billed a price the client never agreed
    // for THIS carrier. There is now one read per lane, so that state cannot
    // arise -- the hazard was removed rather than guarded, and the assertion
    // on 'usps/ground' went with it because there are no longer two reads to
    // tell apart.
    //
    // What survives is the invariant the guard existed to protect, which was
    // never really about how many reads there are: a read that did not answer
    // must not produce a rate, even with a blanket cell sitting right there.
    seed({ client_zone_rates: [cell({ carrier: '', service: '', rate: 5 })] })
    h.db.failOn = (c) =>
      c.table === 'client_zone_rates' ? { message: 'timeout' } : null

    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    expect(r.rate).toBeNull()
    expect(r.rate).not.toBe(5)
    expect(r.error).toContain('timeout')
  })

  it('reports a failed read as unreadable rather than calling it a miss', async () => {
    // Paired, like the rest of this file: both answer `rate: null`, only one
    // of them is a fact about the rate card, and the caller reprices off the
    // legacy card on that one.
    seed({ client_zone_rates: [] })
    const missing = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    seed({ client_zone_rates: [] })
    h.db.failOn = (c) =>
      c.table === 'client_zone_rates' ? { message: 'timeout' } : null
    const broken = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    expect(missing.rate).toBeNull()
    expect(missing.error).toBeNull()
    expect(broken.rate).toBeNull()
    expect(broken.error).toContain('timeout')
    // Named, because the caller loops over every shipment in the table.
    expect(broken.error).toContain('zone 3')
  })

  it('reports a cell that does not hold a number as unreadable, not as a miss', async () => {
    // The cell EXISTS. Calling it "no agreed rate" sends the shipment to a
    // different card at a real-looking price; calling it unreadable stops.
    seed({ client_zone_rates: [cell({ rate: 'N/A' })] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r.rate).toBeNull()
    expect(r.error).toContain('N/A')
  })

  it('looks up the row the billed weight rounds to', async () => {
    seed({ client_zone_rates: [cell({ weight_lb: 2, rate: 11 })] })
    // 17 oz is 2 LB, not 1.
    expect((await resolveZoneRate(CID, 'usps', 'ground', 17, 3)).rate).toBe(11)
    expect((await resolveZoneRate(CID, 'usps', 'ground', 16, 3)).rate).toBeNull()
  })

  it('reports the weight and zone it asked for', async () => {
    seed({ client_zone_rates: [cell()] })
    h.db.failOn = () => ({ message: 'boom' })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 17, 4)
    expect(r.error).toContain('2 LB')
    expect(r.error).toContain('zone 4')
  })
})

describe('resolveZoneRate: matching the carrier the shipment actually carries', () => {
  // Production, 2026-10-13. Orcam's 800-cell zone matrix is keyed carrier 'UPS',
  // service 'Ground'. Its shipments arrive from ShipStation carrying
  // 'UPS_WALLET' / 'ups_ground_saver'. The lookup compared with .eq(), so not one
  // of those 800 cells could ever be reached; the shipment fell through to the
  // legacy card, Orcam has no legacy card, and 46 shipments were written UNPRICED
  // while a complete and correct matrix sat one string comparison away.
  //
  // The legacy path would have matched them the whole time -- cardRowCovers does
  // case-insensitive bidirectional substring, and 'ups_wallet'.includes('ups').
  // So the two pricing paths disagreed about what "this row covers this shipment"
  // means, and the STRICTER one ran first. These tests pin the two paths to the
  // same rule.

  it('matches a ShipStation carrier code against a matrix keyed on the display name', async () => {
    seed({ client_zone_rates: [cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 })] })
    const r = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground_saver', 10, 3)
    expect(r).toEqual({ rate: 9.5, error: null })
  })

  it('still refuses a carrier the matrix does not cover', async () => {
    // Orcam also ships USPS via Stamps.com and has agreed no USPS price. Neither
    // string contains the other in either direction, so this must stay UNPRICED
    // rather than be billed from the UPS matrix. Widening the pool to "any row
    // on the card" is the exact failure matchLegacyRate was written to stop.
    seed({ client_zone_rates: [cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 })] })
    const r = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_parcel_select', 10, 3)
    expect(r.rate).toBeNull()
    // Null and NOT an error: the shipment still falls through to the legacy
    // card. The refusal explains itself without changing that.
    expect(r.error).toBeNull()
    expect(r.rate).not.toBe(9.5)
  })

  it('refuses when two covering cells disagree on the rate', async () => {
    // Substring matching can cover more than one cell, which .maybeSingle()
    // could not express. Picking one by row order would bill a real amount from
    // an arbitrary agreement.
    seed({ client_zone_rates: [
      cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 }),
      cell({ carrier: 'ups', service: 'ground_saver', rate: 11 }),
    ] })
    const r = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground_saver', 10, 3)
    expect(r.rate).toBeNull()
    expect(r.error).toContain('9.5')
    expect(r.error).toContain('11')
  })

  it('accepts two covering cells that agree, rather than calling them ambiguous', async () => {
    // numeric(10,2) arrives as 9.5 from one row and '9.50' from another. On
    // strings those are two different rates and the shipment would be refused
    // as ambiguous when the matrix in fact agrees with itself.
    seed({ client_zone_rates: [
      cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 }),
      cell({ carrier: 'ups', service: 'ground_saver', rate: '9.50' }),
    ] })
    const r = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground_saver', 10, 3)
    expect(r).toEqual({ rate: 9.5, error: null })
  })

  it('still prefers a covering specific cell over the blanket card', async () => {
    seed({ client_zone_rates: [
      cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 }),
      cell({ carrier: '', service: '', rate: 5 }),
    ] })
    const r = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground_saver', 10, 3)
    expect(r.rate).toBe(9.5)
  })

  it('uses the blanket card for a carrier no specific cell covers', async () => {
    seed({ client_zone_rates: [
      cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 }),
      cell({ carrier: '', service: '', rate: 5 }),
    ] })
    const r = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_parcel_select', 10, 3)
    expect(r.rate).toBe(5)
  })

  it('does not treat the blanket card as ambiguous with a covering specific cell', async () => {
    // A blanket row covers everything by definition, so a naive "all covering
    // cells" pool would call every specific match ambiguous against it. The
    // tiers exist to stop that.
    seed({ client_zone_rates: [
      cell({ carrier: 'UPS', service: 'Ground', rate: 9.5 }),
      cell({ carrier: '', service: '', rate: 5 }),
      cell({ carrier: '', service: '', rate: 6 }),
    ] })
    const r = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground_saver', 10, 3)
    expect(r).toEqual({ rate: 9.5, error: null })
  })
})

describe('resolveZoneRate: a miss says what the matrix DOES cover', () => {
  // Production, 2026-10-13, found while decomposing Orcam's 16 unpriced rows.
  //
  // Eleven of them were correct refusals: Orcam's matrix is 800 cells of
  // UPS/Ground and the shipments were USPS, or UPS Next Day Air. Refusing is
  // right -- pricing a Next Day Air parcel off the Ground cell sitting at the
  // same weight and zone would have undercharged, invisibly.
  //
  // What was wrong was the ACCOUNT of the refusal. A matrix miss is silent, so
  // the only reason reaching the monitor email came from the legacy card:
  // "this client has no legacy shipping rate card". True -- Orcam has none --
  // and badly misleading for a client holding a complete 800-cell matrix. It
  // reads as "the matrix was never consulted", and sends the operator to fix
  // the wrong thing.
  //
  // So the miss now carries a `reason`. It is NOT an `error`: the caller must
  // still fall through to the legacy card, because a lane the matrix does not
  // cover is a fact about the agreement, not a failed read. Only the wording
  // changes -- which is the entire point of keeping `reason` separate from
  // `error` rather than reusing the field that already exists.

  it('names the lane, the shipment carrier, and what the cells cover', async () => {
    seed({ client_zone_rates: [cell({ carrier: 'UPS', service: 'Ground' })] })
    const r = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_parcel_select', 10, 3)

    expect(r.rate).toBeNull()
    // Still a miss and not a read failure, so the legacy card is still tried.
    expect(r.error).toBeNull()

    expect(r.reason).toContain('UPS/Ground')
    expect(r.reason).toContain('STAMPS_COM')
    expect(r.reason).toContain('usps_parcel_select')
    expect(r.reason).toContain('1 LB / zone 3')
  })

  it('distinguishes a lane with no cell at all from a lane whose cells do not cover', async () => {
    // Different operator actions. "No cell for 9 LB / zone 3" means the matrix
    // has a hole; "the cells here cover UPS/Ground" means it has a lane nobody
    // agreed a price on. Reporting both as "no rate" loses that.
    seed({ client_zone_rates: [cell({ carrier: 'UPS', service: 'Ground' })] })
    const noCell = await resolveZoneRate(CID, 'UPS_WALLET', 'ups_ground', 10, 7)
    const notCovered = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_ground_advantage', 10, 3)

    // 'no cell' alone does NOT tell these apart -- it is a prefix of 'no cell
    // covering', and the first draft of this test asserted it in both
    // directions and could never have failed on the second. The assertions
    // below are on the phrases that actually differ.
    expect(noCell.reason).toContain('no cell for')
    expect(noCell.reason).toContain('zone 7')
    expect(noCell.reason).not.toContain('UPS/Ground')

    expect(notCovered.reason).toContain('UPS/Ground')
    expect(notCovered.reason).toContain('no cell covering')
    expect(notCovered.reason).not.toContain('no cell for')
  })

  it('attaches no reason when a cell was found -- there is nothing to explain', async () => {
    seed({ client_zone_rates: [cell()] })
    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)
    expect(r.rate).toBe(7.25)
    expect(r.reason).toBeUndefined()
  })

  it('attaches no reason to a failed read, which already says what happened', async () => {
    // A `reason` alongside an `error` would invite a caller to print the
    // reassuring one. The read did not answer; there is nothing to report
    // about coverage because coverage was never established.
    seed({ client_zone_rates: [cell({ carrier: 'UPS', service: 'Ground' })] })
    h.db.failOn = (c) =>
      c.table === 'client_zone_rates' ? { message: 'timeout' } : null
    const r = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_parcel_select', 10, 3)

    expect(r.error).toContain('timeout')
    expect(r.reason).toBeUndefined()
  })

  it('names the blanket card as covering everything rather than as a carrier', async () => {
    // A blanket cell can never be the thing that missed -- it covers by
    // definition -- so reaching the no-cover branch with one present would mean
    // the tiers were broken. Pinned so the message cannot quietly start
    // claiming the matrix "covers /" for a client whose card is blanket.
    seed({ client_zone_rates: [cell({ carrier: '', service: '', rate: 5 })] })
    const r = await resolveZoneRate(CID, 'STAMPS_COM', 'usps_parcel_select', 10, 3)
    expect(r.rate).toBe(5)
    expect(r.reason).toBeUndefined()
  })
})
