import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// The subject here is the sync_runs ROW, not the shipment rows. A run that
// dies mid-pull used to leave its row at status 'running' with a null
// finished_at for ever, which threw away every fail() and wrote() the run had
// recorded: the pull that died on page 6 of 11 was indistinguishable from the
// pull that never started. close() is now in a finally.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  getShipments: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/api/shipstation', () => ({ getShipments: h.getShipments }))

const { syncShipments } = await import('@/lib/sync/shipstation')

const runs = () => (h.db.tables.sync_runs ?? []) as FakeRow[]
const theRun = () => {
  expect(runs()).toHaveLength(1)
  return runs()[0]
}

beforeEach(() => {
  h.db = createFakeSupabase({
    sync_runs: [], shipments: [], carriers: [], rate_adjustments: [],
  })
  h.getShipments.mockReset()
})

const shipments = () => (h.db.tables.shipments ?? []) as FakeRow[]
const adjustments = () => (h.db.tables.rate_adjustments ?? []) as FakeRow[]

/**
 * One ShipStation label, in the shape the real payload arrives in.
 *
 * `shipmentId` is the identity; `orderNumber` is deliberately NOT, and the
 * tests below depend on being able to repeat it.
 */
function label(shipmentId: number, orderNumber: string, over: Partial<{
  shipmentCost: unknown; carrierCode: string; trackingNumber: string
}> = {}) {
  return {
    shipmentId,
    orderNumber,
    orderDate: '2026-09-01',
    shipDate: '2026-09-02',
    carrierCode: over.carrierCode ?? 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    trackingNumber: over.trackingNumber ?? `TRK${shipmentId}`,
    shipmentCost: 'shipmentCost' in over ? over.shipmentCost : 7.25,
    weight: { value: 16, units: 'ounces' },
    dimensions: { length: 6, width: 4, height: 2, units: 'inches' },
    shipTo: { name: 'A Person', city: 'Dover', state: 'DE', postalCode: '19901' },
  }
}

/**
 * A shipment row that already exists AND already belongs to a client.
 *
 * Needed because syncShipments never assigns client_id -- it only reads it, and
 * attribution happens in the zenventory sync. So a row this file creates by
 * running the sync has client_id null, and `&& existingShipment.client_id`
 * silently disables the entire rate-adjustment branch. Any test asserting
 * something about rate_adjustments without seeding attribution first is
 * asserting about dead code.
 */
function seedAttributed(shipmentId: number, orderNumber: string, cost: number | null) {
  (h.db.tables.shipments as FakeRow[]).push({
    id: `seed-${shipmentId}`,
    client_id: 'c-known',
    shipstation_shipment_id: shipmentId,
    order_number: orderNumber,
    actual_cost: cost,
    source: 'stamps',
  })
}

describe('syncShipments: the run row outlives the failure', () => {
  it('closes the run row when the pull throws, and still rethrows', async () => {
    h.getShipments.mockRejectedValue(new Error('ShipStation 401: key rotated'))

    await expect(syncShipments(30)).rejects.toThrow(/401/)

    const run = theRun()
    // Not 'running'. A row stuck at 'running' is the actual defect: it is the
    // state that says "a run is in progress" to anyone reading the table,
    // indefinitely, about a run that is long dead.
    expect(run.status).not.toBe('running')
    expect(run.finished_at).toBeTruthy()
  })

  it('records the throw, so the closed row does not read as a clean pass', async () => {
    h.getShipments.mockRejectedValue(new Error('ShipStation 401: key rotated'))

    await expect(syncShipments(30)).rejects.toThrow()

    const run = theRun()
    // This is the half that a bare `finally { close() }` would get wrong.
    // close() derives the status from the error list, so closing WITHOUT
    // recording the throw first resolves to 'ok' -- a finished, green row
    // sitting on top of an ingest that never happened. Worse than no row.
    expect(run.status).toBe('failed')
    const errors = run.errors as Array<{ kind: string; message: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('error')
    expect(errors[0].message).toContain('401')
  })

  it('still closes a clean run as ok, so the finally has not flattened everything to failed', async () => {
    h.getShipments.mockResolvedValue({ shipments: [], pages: 1 })

    await expect(syncShipments(30)).resolves.toMatchObject({ errors: 0 })

    const run = theRun()
    expect(run.status).toBe('ok')
    expect(run.finished_at).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// SPEC §8: "Running the sync twice over the same window changes no row count.
// The single most important test in this file: three crons a day make
// non-idempotency compound. It covers shipments and order_charges together."
//
// The order_charges half has existed since persist-charges.test.ts was written
// ('recalculateCharges — running it twice'). This is the shipments half, which
// did not exist, and shipments is where the defect actually shipped: the old
// code matched on order_number, which is not the identity of a label.
//
// WHAT THE MUTATION CHECK ESTABLISHED, AND WHAT IT CORRECTED. Reverting
// sync/shipstation.ts to `.eq('order_number', ...)` turns two of these tests
// red, so they do bite. But the failure is not the one DEFECT 1's note in
// sync/shipstation.ts describes. Run with the old match restored, the second
// label of a multi-package order finds EXACTLY ONE existing row -- its
// sibling's -- and updates it. The two labels COLLAPSE onto one row; they
// never reach the two-rows-match state that makes .single() answer
// `{ data: null, error: PGRST116 }` and fall through to .insert(). The
// self-seeding runaway described there cannot be reproduced through this code
// path alone: every ambiguity collapses before it can become two rows. It
// needs a second writer, a backfill, or a pre-existing table to seed it.
//
// That changes the error DIRECTION, so it is worth being exact. A collapse
// loses one of the two labels' carrier costs and overwrites the survivor's
// row with the other's data: measured cost comes out too LOW, margin too
// high, and the order looks more profitable than it is. Under-measured cost
// is just as undetected as over-measured -- the leak views look for work that
// was not billed and for negative margin, and nothing at all looks at whether
// a label's cost was recorded once, twice, or not at all. The practical
// reading is that a multi-package order's second label was silently free.
//
// These run the real match-then-insert-or-update path, not a shortcut: the
// double's maybeSingle() reproduces PGRST116 on multiple matches faithfully,
// so if a seeded ambiguity ever does arise the double will model it.
// ---------------------------------------------------------------------------
describe('syncShipments: running it twice over the same window', () => {
  it('changes no row count', async () => {
    const page = { shipments: [label(5001, 'A-100'), label(5002, 'A-101')], pages: 1 }
    h.getShipments.mockResolvedValue(page)

    const first = await syncShipments(30)
    expect(first).toMatchObject({ created: 2, updated: 0, errors: 0 })
    // Guard the guard: two empty runs would satisfy every assertion below.
    expect(shipments()).toHaveLength(2)

    const second = await syncShipments(30)

    // The row count is the headline, and `updated: 2` is what says the second
    // run RECOGNISED both labels rather than skipping them. A run that errored
    // out of both would also leave the count at 2 and would be a different
    // failure wearing the same green.
    expect(shipments()).toHaveLength(2)
    expect(second).toMatchObject({ created: 0, updated: 2, errors: 0 })
  })

  it('persists two labels on one order number as two rows, and still two on the second run', async () => {
    // The §8 bullet immediately above the idempotency one, and the one the old
    // code failed: "Two labels on one order number persist as two rows, not one
    // row and not three." Both halves are asserted here because they are the
    // same defect seen twice -- one row means the identity is too coarse,
    // three means it is not being matched on at all.
    h.getShipments.mockResolvedValue({
      shipments: [label(6001, 'B-200'), label(6002, 'B-200')], pages: 1,
    })

    await syncShipments(30)
    expect(shipments()).toHaveLength(2)
    expect(shipments().map((s) => s.shipstation_shipment_id).sort())
      .toEqual([6001, 6002])

    const second = await syncShipments(30)

    expect(shipments()).toHaveLength(2)
    expect(second).toMatchObject({ created: 0, updated: 2, errors: 0 })
    // Both rows kept their own tracking number. A match that collapsed the two
    // labels would leave one row carrying the other's data, which the row count
    // alone cannot see.
    expect(shipments().map((s) => s.tracking_number).sort())
      .toEqual(['TRK6001', 'TRK6002'])
  })

  it('does not duplicate labels that arrive with no order number at all', async () => {
    // ShipStation returns a blank orderNumber often enough that syncShipments
    // keeps a counter for it, so this is a real population and not a contrived
    // one. It is the WORST case for an order_number-keyed match, because every
    // such label shares the same key -- the empty string -- regardless of which
    // order it belongs to. Two unrelated labels collapse onto one row, and the
    // more of them arrive, the more of them land on the same row.
    //
    // Keying on shipmentId makes the blank order number a missing ATTRIBUTE
    // rather than a missing identity, which is the whole point: the row is
    // still uniquely addressable, and blankOrderNumber reports the gap instead
    // of the gap silently merging rows.
    h.getShipments.mockResolvedValue({
      shipments: [label(9001, ''), label(9002, '')], pages: 1,
    })

    await syncShipments(30)
    expect(shipments()).toHaveLength(2)

    // A third run as well as a second: re-running once proves the match works,
    // but a key that degrades as the table grows would survive one re-run.
    await syncShipments(30)
    const third = await syncShipments(30)

    expect(shipments()).toHaveLength(2)
    expect(third).toMatchObject({ created: 0, updated: 2, errors: 0 })
    // Both kept their own identity and their own cost, which the row count
    // cannot see.
    expect(shipments().map((s) => s.shipstation_shipment_id).sort())
      .toEqual([9001, 9002])
  })

  it('records no rate adjustment when the cost has not changed', async () => {
    // The other way a re-run can grow the database. A cost that is identical is
    // not money moving, and `diff` of 0 must not write a rate_adjustments row --
    // otherwise three crons a day produce three phantom adjustments daily, each
    // one a $0 claim against a client.
    seedAttributed(7001, 'C-300', 7.25)
    h.getShipments.mockResolvedValue({ shipments: [label(7001, 'C-300')], pages: 1 })

    await syncShipments(30)
    await syncShipments(30)

    expect(shipments()).toHaveLength(1)
    expect(adjustments()).toHaveLength(0)
  })

  it('does not overwrite a known cost with an unknown one on the second run', async () => {
    // Idempotency's other direction, and the one a row count cannot detect: the
    // second run must not make the database WORSE. ShipStation reporting no
    // cost on a label it has already rated is an absence of information, not a
    // correction to zero -- and `actual_cost` reverting to null would delete
    // carrier spend that was already measured.
    seedAttributed(8001, 'D-400', 9.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8001, 'D-400', { shipmentCost: null })], pages: 1,
    })
    const run = await syncShipments(30)

    expect(shipments()).toHaveLength(1)
    expect(shipments()[0].actual_cost).toBe(9.5)
    expect(run).toMatchObject({ errors: 0 })
    // And no adjustment: a cost going unknown is not a refund. `?? 0` on either
    // side of the diff books this as a full refund of $9.50 -- a credit note
    // against a real client, for money that never moved.
    expect(adjustments()).toHaveLength(0)
  })

  it('DOES record an adjustment when the cost genuinely changed', async () => {
    // The positive control, and it is not optional. Both assertions above are
    // `expect(adjustments()).toHaveLength(0)`, and an empty table satisfies
    // them whether the rule is working or the adjustment path is dead. The
    // first version of those two tests was exactly that vacuous: syncShipments
    // only ever READS client_id -- it is zenventory that attributes a shipment
    // to a client -- so a shipment the test itself had just created carried a
    // null client_id, the `&& existingShipment.client_id` guard short-circuited,
    // and no adjustment could be written for any input at all. Seeding an
    // already-attributed row via seedAttributed() is what makes the path live,
    // and this test is what proves it is.
    seedAttributed(8101, 'D-401', 9.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8101, 'D-401', { shipmentCost: 11.0 })], pages: 1,
    })
    await syncShipments(30)

    expect(adjustments()).toHaveLength(1)
    expect(adjustments()[0]).toMatchObject({
      client_id: 'c-known',
      original_cost: 9.5,
      adjusted_cost: 11,
      adjustment_amount: 1.5,
    })
  })

  it('records a cost DECREASE as an adjustment too', async () => {
    // DEFECT 2's direction. The old guard was `diff > 0.01`, so a void or a
    // refund -- money coming BACK -- was structurally invisible, and with it any
    // chance of reconciling a credit. The sign is the whole finding here: a
    // refund booked as a charge would be the same row with the wrong meaning.
    seedAttributed(8201, 'D-402', 9.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8201, 'D-402', { shipmentCost: 4.5 })], pages: 1,
    })
    await syncShipments(30)

    expect(adjustments()).toHaveLength(1)
    expect(adjustments()[0]).toMatchObject({
      adjustment_amount: -5,
      reason: 'Refund or void',
    })
  })

  it('writes one adjustment for a change, not one per run', async () => {
    // The §8 rule applied to the adjustment table itself, which is where
    // non-idempotency would be most expensive: a duplicate adjustment is a
    // duplicate claim against a client, and three crons a day compound it.
    seedAttributed(8301, 'D-403', 9.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8301, 'D-403', { shipmentCost: 11.0 })], pages: 1,
    })
    await syncShipments(30)
    expect(adjustments()).toHaveLength(1)

    // The second run sees 11.00 against a row that now holds 11.00, so the diff
    // is 0 and nothing is written. The third is the one that would catch an
    // adjustment re-derived from a stale `original_cost`.
    await syncShipments(30)
    await syncShipments(30)

    expect(adjustments()).toHaveLength(1)
  })
})
