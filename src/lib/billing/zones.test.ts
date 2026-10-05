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

    expect(missing).toEqual({ rate: null, error: null })

    expect(broken.rate).toBeNull()
    expect(broken.error).toContain('fetch failed')
  })

  it('does not answer with the blanket rate when the specific read failed', async () => {
    // The attempts are ordered by precedence. If the specific carrier/service
    // read failed we do not know whether such a cell exists, so continuing to
    // the blanket card would bill a price the client did not agree for THIS
    // carrier -- the same wrong-price-rather-than-no-price failure as falling
    // through to the legacy card.
    seed({ client_zone_rates: [cell({ carrier: '', service: '', rate: 5 })] })
    h.db.failOn = (c) =>
      c.filters.some((f) => f.column === 'carrier' && f.value === 'usps')
        ? { message: 'timeout' } : null

    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    expect(r.rate).toBeNull()
    expect(r.rate).not.toBe(5)
    expect(r.error).toContain('timeout')
    // Named so an operator can tell which of the two reads went wrong.
    expect(r.error).toContain('usps/ground')
  })

  it('reports a failed blanket read rather than calling it a miss', async () => {
    seed({ client_zone_rates: [] })
    h.db.failOn = (c) =>
      c.filters.some((f) => f.column === 'carrier' && f.value === '')
        ? { message: 'timeout' } : null

    const r = await resolveZoneRate(CID, 'usps', 'ground', 10, 3)

    expect(r.rate).toBeNull()
    expect(r.error).toContain('blanket rate card')
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
