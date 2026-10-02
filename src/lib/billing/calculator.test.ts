import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { generateWeeklyBill, calculateShipmentProfitLoss } =
  await import('@/lib/billing/calculator')

// Tests for a module NOTHING IMPORTS, which needs saying up front so nobody
// deletes them as dead weight. calculator.ts has never been wired up; it is
// the only draft of "generate a weekly bill" in the repo, and the day it gets
// wired up every one of the refusals below is the difference between a wrong
// invoice and no invoice. Tests are cheaper to keep than a wrong invoice is to
// un-send.
//
// What is tested here is only the choreography -- which reads happen, what is
// refused, and what gets written. The arithmetic decisions it makes
// (matchLegacyRate, shipmentProfit, priceOf) are tested and mutation-checked in
// shipment-rate.test.ts and unpriced.test.ts, and are not re-tested here.

/** Every table generateWeeklyBill reads, so an unseeded one is not a failure. */
function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    shipments: [],
    warehouse_daily_log: [],
    rate_adjustments: [],
    manual_charges: [],
    client_shipping_rates: [],
    client_zone_rates: [],
    zone_chart: [],
    clients: [],
    bills: [],
    ...over,
  })
}

beforeEach(() => seed())

const WEEK = ['2026-09-01', '2026-09-07'] as const
const CID = 'c1'

function shipment(rate: unknown) {
  return {
    client_id: CID, ship_date: '2026-09-03',
    client_rate: rate, profit_loss: 1,
  }
}

describe('generateWeeklyBill: a read that failed', () => {
  it('writes no bill when one of the four reads fails', async () => {
    seed({ shipments: [shipment(10)] })
    h.db.failOn = (c) => c.table === 'rate_adjustments'
      ? { message: 'connection reset' } : null

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.bill).toBeNull()
    expect(r.error).toContain('rate_adjustments')
    expect(r.error).toContain('connection reset')
    // The actual regression this guards: the old version summed the three
    // reads that worked and INSERTED the result as a draft bill.
    expect(h.db.tables.bills).toHaveLength(0)
  })

  it('names every failed table, not just the first', async () => {
    h.db.failOn = (c) =>
      c.table === 'shipments' || c.table === 'manual_charges'
        ? { message: 'down' } : null

    const r = await generateWeeklyBill(CID, ...WEEK)

    // An operator needs to tell one unreachable table from a dead connection.
    expect(r.error).toContain('shipments')
    expect(r.error).toContain('manual_charges')
  })

  it('does not confuse an empty week with a failed read', async () => {
    // Four reads, all succeeding, all empty: that IS a $0 bill and it is
    // correct to write one. The point of the refusal above is that a FAILED
    // read produced the identical row.
    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.error).toBeNull()
    expect(h.db.tables.bills).toHaveLength(1)
    expect(h.db.tables.bills[0].grand_total).toBe(0)
  })
})

describe('generateWeeklyBill: a line nobody priced', () => {
  it('refuses to write a bill that is short by an unknown amount', async () => {
    seed({ shipments: [shipment(10), shipment(null)] })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.unpricedLines).toBe(1)
    expect(r.bill).toBeNull()
    expect(h.db.tables.bills).toHaveLength(0)
  })

  it('counts an unpriced warehouse day too, not only a shipment', async () => {
    // warehouse_daily_log.total went nullable in the same change as
    // client_rate. Both columns feed the same bill.
    seed({
      warehouse_daily_log: [
        { client_id: CID, log_date: '2026-09-03', total: null },
      ],
    })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.unpricedLines).toBe(1)
    expect(h.db.tables.bills).toHaveLength(0)
  })

  it('bills a deliberate 0 rather than refusing it', async () => {
    // The other direction, and the reason this is not just a null check: a
    // shipment somebody priced at 0 is a shipment with an agreed price. A 0
    // that refuses to bill would stop an invoice over a decision that was
    // actually made.
    seed({ shipments: [shipment(0), shipment(10)] })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.unpricedLines).toBe(0)
    expect(r.error).toBeNull()
    expect(h.db.tables.bills[0].shipping_total).toBe(10)
  })

  it('treats a rate that will not parse as unknown, not as 0', async () => {
    seed({ shipments: [shipment('tbd')] })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.unpricedLines).toBe(1)
    expect(h.db.tables.bills).toHaveLength(0)
  })
})

describe('generateWeeklyBill: the totals', () => {
  it('splits the four sections and sums them to the grand total', async () => {
    seed({
      shipments: [shipment(10), shipment(5.5)],
      warehouse_daily_log: [
        { client_id: CID, log_date: '2026-09-03', total: 20 },
      ],
      rate_adjustments: [
        {
          client_id: CID, adjustment_date: '2026-09-03',
          status: 'approved', adjustment_amount: 1.25,
        },
      ],
      manual_charges: [
        {
          client_id: CID, charge_date: '2026-09-03',
          approved: true, amount: 3,
        },
      ],
    })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.error).toBeNull()
    const b = h.db.tables.bills[0]
    expect(b.shipping_total).toBe(15.5)
    expect(b.warehouse_total).toBe(20)
    expect(b.adjustments_total).toBe(1.25)
    expect(b.manual_charges_total).toBe(3)
    expect(b.grand_total).toBe(39.75)
  })

  it('does not drift the grand total by a fraction of a cent', async () => {
    // Chosen so float and cent accumulation DISAGREE. 0.1+0.1+0.1 sums to
    // exactly 0.3 either way and would assert nothing: 1.1 + 2.2 is
    // 3.3000000000000007 as floats.
    seed({ shipments: [shipment(1.1), shipment(2.2)] })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(h.db.tables.bills[0].grand_total).toBe(3.3)
    expect(r.error).toBeNull()
  })

  it('coerces a numeric that arrived as a string', async () => {
    // numeric(10,2) over PostgREST can arrive as '12.34', and `0 + '12.34'` is
    // the string '012.34' -- which would be stored as a bill total.
    seed({ shipments: [shipment('12.34'), shipment(1)] })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(h.db.tables.bills[0].grand_total).toBe(13.34)
    expect(typeof h.db.tables.bills[0].grand_total).toBe('number')
    expect(r.error).toBeNull()
  })

  it('leaves another client and another week out of the bill', async () => {
    seed({
      shipments: [
        shipment(10),
        { client_id: 'other', ship_date: '2026-09-03', client_rate: 999, profit_loss: 0 },
        { client_id: CID, ship_date: '2026-10-03', client_rate: 777, profit_loss: 0 },
      ],
    })

    await generateWeeklyBill(CID, ...WEEK)

    expect(h.db.tables.bills[0].grand_total).toBe(10)
  })

  it('leaves an unapproved adjustment and charge out of the bill', async () => {
    seed({
      rate_adjustments: [{
        client_id: CID, adjustment_date: '2026-09-03',
        status: 'pending', adjustment_amount: 50,
      }],
      manual_charges: [{
        client_id: CID, charge_date: '2026-09-03',
        approved: false, amount: 60,
      }],
    })

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.error).toBeNull()
    expect(h.db.tables.bills[0].grand_total).toBe(0)
  })
})

describe('generateWeeklyBill: the insert', () => {
  it('reports a failed insert instead of answering as if it wrote one', async () => {
    seed({ shipments: [shipment(10)] })
    h.db.failOn = (c) => c.table === 'bills' ? { message: 'readonly' } : null

    const r = await generateWeeklyBill(CID, ...WEEK)

    expect(r.bill).toBeNull()
    expect(r.error).toContain('readonly')
    // Distinguishable from the refusals above: the total WAS computed.
    expect(r.error).toContain('not stored')
  })
})

describe('calculateShipmentProfitLoss', () => {
  function card(over: Record<string, unknown> = {}) {
    return {
      client_id: CID, carrier: 'usps', service: 'ground',
      weight_min: 0, weight_max: 100, rate: 8, ...over,
    }
  }

  it('prices off the legacy card when there is no zone', async () => {
    seed({ client_shipping_rates: [card()] })

    const r = await calculateShipmentProfitLoss(CID, 'usps', 'ground', 10, 5)

    expect(r.clientRate).toBe(8)
    expect(r.profitLoss).toBe(3)
    expect(r.isLoss).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('returns UNKNOWN, not 0, when the card does not cover the shipment', async () => {
    // The old version returned clientRate: 0 here, and
    // profit_loss: 0 - actual_cost with is_loss: true -- a billable zero that
    // fifteen surfaces rendered as "$0.00".
    seed({ client_shipping_rates: [card({ weight_min: 500, weight_max: 900 })] })

    const r = await calculateShipmentProfitLoss(CID, 'usps', 'ground', 10, 5)

    expect(r.clientRate).toBeNull()
    expect(r.clientRate).not.toBe(0)
    expect(r.profitLoss).toBeNull()
    expect(r.isLoss).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('returns UNKNOWN, not 0, when the rate card cannot be read', async () => {
    seed({ client_shipping_rates: [card()] })
    h.db.failOn = (c) => c.table === 'client_shipping_rates'
      ? { message: 'timeout' } : null

    const r = await calculateShipmentProfitLoss(CID, 'usps', 'ground', 10, 5)

    expect(r.clientRate).toBeNull()
    expect(r.reason).toContain('timeout')
    // "Could not read the card" must not read as "the client has no card".
    expect(r.reason).not.toContain('has no legacy shipping rate card')
  })

  it('distinguishes having no card at all from a failed read', async () => {
    seed({ client_shipping_rates: [] })

    const r = await calculateShipmentProfitLoss(CID, 'usps', 'ground', 10, 5)

    expect(r.clientRate).toBeNull()
    expect(r.reason).toContain('no legacy shipping rate card')
  })

  it('honours a deliberately free card row as 0 rather than a miss', async () => {
    seed({ client_shipping_rates: [card({ rate: 0 })] })

    const r = await calculateShipmentProfitLoss(CID, 'usps', 'ground', 10, 5)

    expect(r.clientRate).toBe(0)
    expect(r.reason).toBeNull()
    expect(r.profitLoss).toBe(-5)
    expect(r.isLoss).toBe(true)
  })

  it('prefers a zone rate, including a zone rate of 0', async () => {
    // `if (clientRate === 0)` was the old "not found yet" test, so a zone cell
    // holding a deliberate 0 fell through and got repriced off the legacy card
    // -- a different agreement, at a real-looking price.
    seed({
      client_zone_rates: [{
        client_id: CID, carrier: 'usps', service: 'ground',
        zone: 3, weight_lb: 1, rate: 0,
      }],
      client_shipping_rates: [card({ rate: 99 })],
    })

    const r = await calculateShipmentProfitLoss(
      CID, 'usps', 'ground', 10, 5, { zone: 3 },
    )

    expect(r.zone).toBe(3)
    expect(r.clientRate).toBe(0)
    expect(r.clientRate).not.toBe(99)
  })

  it('refuses rather than repricing off the legacy card when the chart fails', async () => {
    // A failed zone-chart read used to answer "no zone", which is this
    // function's signal to use the legacy card -- so a one-second hiccup
    // returned 99 as the agreed price instead of returning nothing.
    seed({
      zone_chart: [{ origin_prefix: '191', dest_prefix: '902', zone: 3 }],
      client_zone_rates: [{
        client_id: CID, carrier: 'usps', service: 'ground',
        zone: 3, weight_lb: 1, rate: 4,
      }],
      client_shipping_rates: [card({ rate: 99 })],
    })
    h.db.failOn = (c) => c.table === 'zone_chart' ? { message: 'timeout' } : null

    const r = await calculateShipmentProfitLoss(
      CID, 'usps', 'ground', 10, 5, { recipient_zip: '90210' }, '19101',
    )

    expect(r.clientRate).toBeNull()
    expect(r.clientRate).not.toBe(99)
    expect(r.profitLoss).toBeNull()
    expect(r.isLoss).toBe(false)
    expect(r.reason).toContain('timeout')
  })

  it('refuses rather than repricing off the legacy card when the matrix fails', async () => {
    seed({
      client_zone_rates: [{
        client_id: CID, carrier: 'usps', service: 'ground',
        zone: 3, weight_lb: 1, rate: 4,
      }],
      client_shipping_rates: [card({ rate: 99 })],
    })
    h.db.failOn = (c) =>
      c.table === 'client_zone_rates' ? { message: 'connection reset' } : null

    const r = await calculateShipmentProfitLoss(
      CID, 'usps', 'ground', 10, 5, { zone: 3 },
    )

    expect(r.clientRate).toBeNull()
    expect(r.clientRate).not.toBe(99)
    expect(r.zone).toBe(3)
    expect(r.reason).toContain('connection reset')
  })

  it('still uses the legacy card when the matrix genuinely has no cell', async () => {
    // The other half of the pair above: the fallback is correct behaviour, and
    // it has to survive the refusal being added next to it.
    seed({
      client_zone_rates: [],
      client_shipping_rates: [card({ rate: 99 })],
    })

    const r = await calculateShipmentProfitLoss(
      CID, 'usps', 'ground', 10, 5, { zone: 3 },
    )

    expect(r.clientRate).toBe(99)
    expect(r.reason).toBeNull()
  })

  it('reports an unknown carrier cost as unknown profit, not as full profit', async () => {
    seed({ client_shipping_rates: [card()] })

    const r = await calculateShipmentProfitLoss(
      CID, 'usps', 'ground', 10, null as unknown as number,
    )

    expect(r.clientRate).toBe(8)
    // `8 - (null ?? 0)` would report the whole rate as profit.
    expect(r.profitLoss).toBeNull()
    expect(r.isLoss).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})
