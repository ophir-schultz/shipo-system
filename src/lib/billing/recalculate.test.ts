import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { recalculateShipments } = await import('@/lib/billing/recalculate')

// This is the one repricing path that actually runs, UNATTENDED, from
// api/agent/monitor, over every shipment that has a client. Nothing a human
// looks at stands between what it decides and what `shipments.client_rate`
// says afterwards, so the question each test asks is not "is the number right"
// but "when the inputs could not be read, does it write anything at all".
//
// The answer has to be no, and specifically no rather than a fallback, because
// of the shape of this function: a null zone or a null zone rate is its signal
// to reprice off the LEGACY carrier/service card, which is a different
// agreement at a different price. A failed read that answers null therefore
// did not produce an unpriced row anybody would notice -- it produced a
// confident wrong price, written, formatted to two decimals.
//
// The arithmetic these rows go through (matchLegacyRate, shipmentProfit,
// weightToLb, resolveZone/resolveZoneRate) is tested in shipment-rate.test.ts
// and zones.test.ts and is not re-tested here.

const CID = 'c1'

function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    shipments: [],
    clients: [{ id: CID, origin_zip: '19101' }],
    client_shipping_rates: [],
    client_zone_rates: [],
    zone_chart: [],
    ...over,
  })
}

beforeEach(() => seed())

function shipment(over: Record<string, unknown> = {}) {
  return {
    id: 's1', order_number: 'ORD-1', client_id: CID,
    actual_cost: 5, weight: 10, length: 1, width: 1, height: 1,
    carrier: 'usps', service: 'ground', recipient_zip: '90210',
    zone: null, client_rate: 3, profit_loss: -2, is_loss: true,
    ...over,
  }
}

function legacyCard(over: Record<string, unknown> = {}) {
  return {
    client_id: CID, carrier: 'usps', service: 'ground',
    weight_min: 0, weight_max: 1000, rate: 99, ...over,
  }
}

function zoneCell(over: Record<string, unknown> = {}) {
  return {
    client_id: CID, carrier: 'usps', service: 'ground',
    weight_lb: 1, zone: 3, rate: 7, ...over,
  }
}

/** The row as it stands in the fake table after the run. */
function stored(id = 's1') {
  return h.db.tables.shipments.find((r) => r.id === id)!
}

describe('recalculateShipments: a zone read that failed', () => {
  it('writes nothing for a shipment whose zone chart could not be read', async () => {
    seed({
      shipments: [shipment()],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell()],
      client_shipping_rates: [legacyCard()],
    })
    h.db.failOn = (c) => c.table === 'zone_chart'
      ? { message: 'canceling statement due to statement timeout' } : null

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(1)
    expect(stats.updated).toBe(0)
    // 99 is the legacy card. Writing it here is the defect: a failed chart read
    // is not a shipment with no zone.
    expect(stored().client_rate).toBe(3)
    expect(stats.reasons[0].reason).toContain('statement timeout')
    expect(stats.reasons[0].example).toBe('ORD-1')
  })

  it('writes nothing for a shipment whose zone matrix could not be read', async () => {
    seed({
      shipments: [shipment({ zone: 3 })],
      client_zone_rates: [zoneCell()],
      client_shipping_rates: [legacyCard()],
    })
    h.db.failOn = (c) => c.table === 'client_zone_rates'
      ? { message: 'connection reset' } : null

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(1)
    expect(stats.updated).toBe(0)
    expect(stats.legacy_matched).toBe(0)
    expect(stored().client_rate).toBe(3)
    expect(stats.reasons[0].reason).toContain('connection reset')
  })

  it('leaves the previous price alone rather than nulling it', async () => {
    // Skipping has to mean "no write", not "write UNKNOWN". The row may well
    // carry a correct price from the last good run, and replacing it with a
    // null on the strength of a failed read destroys a good number -- the
    // mirror image of replacing it with a zero.
    seed({
      shipments: [shipment({ client_rate: 42, profit_loss: 37, is_loss: false })],
      client_shipping_rates: [legacyCard()],
    })
    h.db.failOn = (c) => c.table === 'zone_chart' ? { message: 'boom' } : null

    await recalculateShipments()

    expect(stored().client_rate).toBe(42)
    expect(stored().profit_loss).toBe(37)
    expect(stored().is_loss).toBe(false)
    expect(h.db.calls.some((c) => c.verb === 'update')).toBe(false)
  })

  it('skips only the shipment that failed, not the whole run', async () => {
    // One unreadable lane must not stop the other shipments being repriced.
    // The failure is scoped to the ZIP pair, so only the first row's chart read
    // is made to fail.
    seed({
      shipments: [
        shipment({ id: 's1', order_number: 'ORD-1', recipient_zip: '90210' }),
        shipment({ id: 's2', order_number: 'ORD-2', recipient_zip: '10001' }),
      ],
      client_shipping_rates: [legacyCard({ rate: 20 })],
    })
    h.db.failOn = (c) =>
      c.table === 'zone_chart'
        && c.filters.some((f) => f.column === 'dest_prefix' && f.value === '902')
        ? { message: 'timeout' } : null

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(1)
    expect(stats.updated).toBe(1)
    expect(stored('s1').client_rate).toBe(3)
    expect(stored('s2').client_rate).toBe(20)
  })
})

describe('recalculateShipments: a zone that is genuinely absent', () => {
  it('still falls back to the legacy card when no chart row covers the lane', async () => {
    // The other half of every pair above. The fallback is correct behaviour and
    // has to survive the refusal being added beside it, or the fix has simply
    // broken repricing.
    seed({
      shipments: [shipment()],
      client_shipping_rates: [legacyCard({ rate: 20 })],
    })

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(0)
    expect(stats.updated).toBe(1)
    expect(stats.legacy_matched).toBe(1)
    expect(stored().client_rate).toBe(20)
  })

  it('prices off the zone matrix when the chart does answer', async () => {
    seed({
      shipments: [shipment()],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell({ rate: 7 })],
      client_shipping_rates: [legacyCard({ rate: 20 })],
    })

    const stats = await recalculateShipments()

    expect(stats.zone_matched).toBe(1)
    expect(stats.updated).toBe(1)
    expect(stored().client_rate).toBe(7)
    expect(stored().zone).toBe(3)
  })

  it('reports a shipment no card can price as unmatched, with the reason', async () => {
    seed({ shipments: [shipment()], client_shipping_rates: [] })

    const stats = await recalculateShipments()

    expect(stats.unmatched).toBe(1)
    expect(stats.skipped).toBe(0)
    expect(stats.updated).toBe(1)
    // Unpriced is written as NULL, which is the point of the earlier fix: not
    // 0, which fifteen surfaces render as $0.00.
    expect(stored().client_rate).toBeNull()
    expect(stored().profit_loss).toBeNull()
    expect(stored().is_loss).toBe(false)
    expect(stats.reasons).toHaveLength(1)
  })
})

describe('recalculateShipments: a shipment nobody weighed', () => {
  // The end-to-end consequence of the weightToLb fix, asserted here rather than
  // only in the unit tests, because the failure was never visible in either
  // function on its own. `weight ?? 0` at the top of the loop turned an absent
  // weight into 0; weightToLb sent 0 to matrix row 1 and matchLegacyRate let it
  // into any band open at the bottom. Both answers are the CHEAPEST row of the
  // card in question, and both are real prices that look correct.
  //
  // It must come out `unmatched` and NOT `skipped`. An unreadable input is
  // skipped so the next run can try again -- right for a dropped connection.
  // A missing weight will still be missing next run, so skipping would leave
  // the stale price in place forever with nothing on screen about it; the row
  // has to be written UNPRICED with the weight named as the reason.
  it.each([
    ['absent', null],
    ['zero', 0],
  ])('writes an unpriced row for a %s weight instead of the lightest band',
    async (_label, weight) => {
      seed({
        shipments: [shipment({ weight, length: 0, width: 0, height: 0 })],
        client_shipping_rates: [legacyCard({ weight_min: 0, rate: 99 })],
      })

      const stats = await recalculateShipments()

      expect(stats.unmatched).toBe(1)
      expect(stats.skipped).toBe(0)
      expect(stats.updated).toBe(1)
      // 99 is the lightest band, open at the bottom, and it is the figure the
      // old code billed.
      expect(stored().client_rate).toBeNull()
      expect(stored().profit_loss).toBeNull()
      expect(stored().is_loss).toBe(false)
      expect(stats.reasons[0].reason).toContain('billed weight is')
    })

  it('does not price an unweighed shipment off the 1 LB zone matrix row', async () => {
    // The zone card's half of the same defect, and the one the fix was filed
    // for: weightToLb floored every unusable weight to 1, so a shipment nobody
    // weighed was billed the 1 LB cell -- the smallest row of the matrix.
    seed({
      shipments: [shipment({ weight: null, length: 0, width: 0, height: 0, zone: 3 })],
      client_zone_rates: [zoneCell({ weight_lb: 1, zone: 3, rate: 7 })],
      client_shipping_rates: [],
    })

    const stats = await recalculateShipments()

    expect(stats.zone_matched).toBe(0)
    expect(stats.unmatched).toBe(1)
    expect(stored().client_rate).toBeNull()
  })

  it('stores no billed weight for a shipment nobody weighed', async () => {
    // The weight column has to agree with the price column. 0 is finite, so
    // this used to store `billed_weight: 0` beside the null rate -- the one
    // field an operator would check to find out why, reading as a parcel that
    // weighs nothing rather than one that was never weighed.
    seed({
      shipments: [shipment({ weight: null, length: 0, width: 0, height: 0 })],
      client_shipping_rates: [legacyCard()],
    })

    await recalculateShipments()

    expect(stored().billed_weight).toBeNull()
  })

  it('still prices a real weight under a pound', async () => {
    // The pair. The guard rejects "no measurement", not "small": a 1oz parcel
    // is a measurement, it rounds up to the 1 LB matrix row, and it has an
    // agreed price there.
    seed({
      shipments: [shipment({ weight: 1, length: 0, width: 0, height: 0, zone: 3 })],
      client_zone_rates: [zoneCell({ weight_lb: 1, zone: 3, rate: 7 })],
      client_shipping_rates: [],
    })

    const stats = await recalculateShipments()

    expect(stats.zone_matched).toBe(1)
    expect(stored().client_rate).toBe(7)
    expect(stored().billed_weight).toBe(1)
  })
})

describe('recalculateShipments: the other unreadable inputs', () => {
  it('skips a client whose legacy rate card could not be read', async () => {
    seed({ shipments: [shipment()], client_shipping_rates: [legacyCard()] })
    h.db.failOn = (c) => c.table === 'client_shipping_rates'
      ? { message: 'timeout' } : null

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(1)
    expect(stats.updated).toBe(0)
    expect(stats.reasons[0].reason).toContain('shipping rate card')
  })

  it('counts a write that failed as failed, not as updated', async () => {
    seed({ shipments: [shipment()], client_shipping_rates: [legacyCard()] })
    h.db.failOn = (c) =>
      c.table === 'shipments' && c.verb === 'update' ? { message: 'denied' } : null

    const stats = await recalculateShipments()

    expect(stats.failed).toBe(1)
    expect(stats.updated).toBe(0)
    expect(stats.reasons[0].reason).toContain('denied')
  })

  it('throws rather than reporting zero work when the shipment list fails', async () => {
    seed({ shipments: [shipment()] })
    h.db.failOn = (c) =>
      c.table === 'shipments' && c.verb === 'select' ? { message: 'unreachable' } : null

    // A run that could not list the shipments has not repriced nothing; it has
    // not run. Returning zeroed stats would be reported by the monitor as a
    // clean pass over an empty table.
    await expect(recalculateShipments()).rejects.toThrow('unreachable')
  })
})

describe('recalculateShipments: why a shipment came out unpriced', () => {
  // Production, 2026-10-13. Orcam: 800 zone-matrix cells, all UPS/Ground, no
  // legacy card at all. Eleven shipments on USPS lanes came out unpriced --
  // correctly, nobody had agreed a USPS price -- and the only reason the
  // monitor emailed was the legacy card's "this client has no legacy shipping
  // rate card". For a client holding a complete matrix that reads as "the
  // matrix was never consulted" and sends the operator to fix the wrong thing.
  //
  // The matrix miss is now reported alongside it. The shipment is still
  // unpriced and the price is still not written -- only the account changes.

  it('says the matrix was consulted and what it covers, not just that there is no card', async () => {
    seed({
      shipments: [shipment({
        carrier: 'STAMPS_COM', service: 'usps_parcel_select', client_rate: null,
      })],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell({ carrier: 'UPS', service: 'Ground' })],
      client_shipping_rates: [],
    })

    const stats = await recalculateShipments()

    expect(stats.unmatched).toBe(1)
    expect(stored().client_rate).toBeNull()

    const all = stats.reasons.map((r) => r.reason).join(' | ')
    // The fact that was missing: the matrix answered, and this is what it holds.
    expect(all).toContain('UPS/Ground')
    // The fact that was already there, and is still true, and is still useful.
    expect(all).toContain('no legacy shipping rate card')
  })

  it('does not report a matrix miss when no zone was resolved at all', async () => {
    // Orcam's other five: Puerto Rico and Canada, where resolveZone returns no
    // zone, so the matrix is never consulted. Claiming it was consulted and
    // found wanting would be a different and false story about those rows.
    seed({
      shipments: [shipment({
        carrier: 'STAMPS_COM', service: 'usps_parcel_select', client_rate: null,
      })],
      zone_chart: [],
      client_zone_rates: [zoneCell({ carrier: 'UPS', service: 'Ground' })],
      client_shipping_rates: [],
    })

    const stats = await recalculateShipments()

    const all = stats.reasons.map((r) => r.reason).join(' | ')
    expect(all).toContain('no legacy shipping rate card')
    expect(all).not.toContain('UPS/Ground')
  })

  it('says nothing extra when the matrix priced the shipment', async () => {
    seed({
      shipments: [shipment({ client_rate: null })],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell()],
      client_shipping_rates: [],
    })

    const stats = await recalculateShipments()

    expect(stats.zone_matched).toBe(1)
    expect(stored().client_rate).toBe(7)
    expect(stats.reasons.map((r) => r.reason).join(' | ')).not.toContain('matrix')
  })
})

describe('recalculateShipments: reading the whole book, not the first page of it', () => {
  // Production, 2026-10-23. The read was a bare `.select(...)` with no range.
  // PostgREST caps every select at `db-max-rows` and says nothing about it --
  // a 200, `error: null`, and a full-looking page -- so this function could
  // not tell the book from the first thousand rows of it.
  //
  // It fit in one page until that morning, when attributing 833 orphaned
  // shipments took the table from 867 rows with a client to 1700. Seven
  // hundred went unpriced, and every count this function returns was computed
  // over the truncated set, so the run reported clean totals and a short gap
  // list while $8,536 of carrier cost sat unbilled. It was found from the
  // database side, because nothing in this process could see the rows it had
  // not read.
  //
  // These tests use a cap of 2 against 3 shipments. The size is irrelevant --
  // crossing the cap is the whole experiment -- and readAllPages advances by
  // the rows it GOT rather than the rows it asked for precisely so a cap
  // smaller than PAGE_SIZE still terminates.

  function threeOnOneCard() {
    seed({
      shipments: [
        shipment({ id: 's1', order_number: 'ORD-1', client_rate: null }),
        shipment({ id: 's2', order_number: 'ORD-2', client_rate: null }),
        shipment({ id: 's3', order_number: 'ORD-3', client_rate: null }),
      ],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell()],
      client_shipping_rates: [],
    })
  }

  it('prices the shipments past the server cap, not just the ones on the first page', async () => {
    threeOnOneCard()
    h.db.maxRows = 2

    const stats = await recalculateShipments()

    // The assertion that fails against an unpaged read: it would report 2.
    expect(stats.updated).toBe(3)
    expect(stats.zone_matched).toBe(3)
    for (const id of ['s1', 's2', 's3']) {
      expect(stored(id).client_rate).toBe(7)
    }
  })

  it('leaves no shipment on its old rate because it fell past the cap', async () => {
    // The same truncation told as the operator experiences it. s3 keeps a
    // stale price rather than showing up as unpriced, so nothing on any screen
    // marks it as a row the run never considered -- it reads as priced, and
    // the figure is from whenever it was last seen.
    seed({
      shipments: [
        shipment({ id: 's1', order_number: 'ORD-1', client_rate: null }),
        shipment({ id: 's2', order_number: 'ORD-2', client_rate: null }),
        shipment({ id: 's3', order_number: 'ORD-3', client_rate: 999 }),
      ],
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [zoneCell()],
      client_shipping_rates: [],
    })
    h.db.maxRows = 2

    await recalculateShipments()

    expect(stored('s3').client_rate).toBe(7)
  })

  it('counts a skip past the cap, so the stats describe the book and not the page', async () => {
    // `skipped` is the count the dashboard panel reads to decide whether to
    // warn. A row the run never fetched is invisible to every one of these
    // counters, which is what made the truncation look like a clean run.
    threeOnOneCard()
    h.db.maxRows = 2
    h.db.failOn = (c) => c.table === 'client_zone_rates'
      ? { message: 'connection reset' } : null

    const stats = await recalculateShipments()

    expect(stats.skipped).toBe(3)
    expect(stats.updated).toBe(0)
  })

  it('orders the paged read by a unique column', async () => {
    // Required by readAllPages' contract, and not cosmetic: Postgres promises
    // nothing about row order across two OFFSET queries, so an unordered page
    // loop can hand back the same shipment twice and skip another. Here that
    // is one parcel repriced twice and one left stale, with the run's totals
    // still adding up. Deleting the .order('id') leaves every other test in
    // this file green, which is why this one asserts on the call itself.
    threeOnOneCard()
    h.db.maxRows = 2

    await recalculateShipments()

    const reads = h.db.calls.filter((c) => c.table === 'shipments' && c.verb === 'select')
    expect(reads.length).toBeGreaterThan(1)
    for (const r of reads) {
      expect(r.sort.at(-1)?.column).toBe('id')
      expect(r.range).toBeDefined()
    }
  })
})
