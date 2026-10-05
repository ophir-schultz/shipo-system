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

// ---------------------------------------------------------------------------
// OVERLAPPING RUNS.
//
// syncShipments takes no lock. The 'shipstation' sync_runs row is audit only --
// unlike the 'charges' row, which IS the lock recalculateCharges gates on -- so
// two of these can run at once, and they do: /api/agent/monitor declares
// maxDuration = 300 while AutoSync polls it every five minutes, and the
// single-flight guard that is supposed to prevent that is a React ref, which
// dedupes within ONE browser tab. A second tab, or the cron landing on a
// tab-driven pass, is two separate processes and neither can see the other.
//
// WHAT THESE TESTS CAN AND CANNOT DO. They do not run two syncs concurrently --
// the fake database is synchronous and there is nothing to interleave. What
// they do instead is reconstruct the exact state the LOSING run observes, which
// is the only state where behaviour differs, and assert on what it does from
// there. That is a weaker claim than a true concurrency test and a stronger one
// than idempotency: the seeded fixtures below are states that a single-threaded
// re-sync can never produce, so nothing above this line covers them.
// ---------------------------------------------------------------------------
describe('syncShipments: a second run overlapping the first', () => {
  /** The adjustment the winning run already wrote. */
  function seedAdjustment(shipmentId: number, amount: number, over: FakeRow = {}) {
    (h.db.tables.rate_adjustments as FakeRow[]).push({
      id: `adj-${shipmentId}`,
      shipment_id: `seed-${shipmentId}`,
      client_id: 'c-known',
      adjustment_amount: amount,
      original_cost: 9.5,
      adjusted_cost: 11,
      reason: 'Carrier rate adjustment',
      adjustment_date: '2026-09-02T00:00:00.000Z',
      status: 'pending',
      ...over,
    })
  }

  it('writes no second rate_adjustments row for an adjustment the other run already recorded', async () => {
    // THE LOSING RUN'S VIEW, exactly. Both runs read actual_cost at 9.50 before
    // either wrote 11.00 back, so this run still sees the OLD cost and computes
    // the same +1.50 -- while the adjustment row for it is already there. A
    // single-threaded re-sync cannot reach this state, because by its second
    // pass actual_cost is 11.00 and the diff is 0.
    //
    // The old code's select-then-insert would have found the row here and
    // skipped. What it could NOT do is survive the two runs reaching the select
    // before either reached the insert, which is the actual race; the upsert is
    // what closes that, and this fixture is the closest reachable proof.
    seedAttributed(8401, 'E-500', 9.5)
    seedAdjustment(8401, 1.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8401, 'E-500', { shipmentCost: 11.0 })], pages: 1,
    })
    const run = await syncShipments(30)

    expect(adjustments()).toHaveLength(1)
    // A duplicate is not an error. The other run recorded it; there is nothing
    // wrong and nothing for anyone to do.
    expect(run).toMatchObject({ errors: 0 })
  })

  it('does not count an adjustment it did not write', async () => {
    // The counter half, and it is a separate failure from the row count. Both
    // runs reporting `adjustments: 1` for one real re-bill is how the monitor
    // email comes to describe twice as much carrier movement as happened --
    // and the row count assertion above passes either way, because the counter
    // lives in the return value and not in the table.
    seedAttributed(8402, 'E-501', 9.5)
    seedAdjustment(8402, 1.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8402, 'E-501', { shipmentCost: 11.0 })], pages: 1,
    })
    const run = await syncShipments(30)

    expect(run).toMatchObject({ adjustments: 0, refunds: 0 })
  })

  it('leaves an already-approved adjustment approved, and does not move its date', async () => {
    // WHY ignoreDuplicates IS LOAD-BEARING. Drop it and the upsert becomes
    // ON CONFLICT DO UPDATE: the row count stays at 1, so both assertions in
    // the first test still pass, while this run quietly overwrites the stored
    // row with its own payload -- status back to 'pending' from 'approved', and
    // adjustment_date moved to today.
    //
    // That is worse than the duplicate it replaced. 'approved' is a person's
    // decision and the state billing/calculator.ts sums from, so reverting it
    // drops a real adjustment OUT of the client's next bill; and moving
    // adjustment_date walks the row forward a day at a time, three crons a day,
    // through whatever billing week it is eventually read in.
    seedAttributed(8403, 'E-502', 9.5)
    seedAdjustment(8403, 1.5, { status: 'approved' })

    h.getShipments.mockResolvedValue({
      shipments: [label(8403, 'E-502', { shipmentCost: 11.0 })], pages: 1,
    })
    await syncShipments(30)

    expect(adjustments()).toHaveLength(1)
    expect(adjustments()[0]).toMatchObject({
      status: 'approved',
      adjustment_date: '2026-09-02T00:00:00.000Z',
    })
  })

  it('still records an adjustment whose amount differs from the one already there', async () => {
    // The positive control for the conflict target, and the reason it is two
    // columns rather than one. A shipment legitimately collects several
    // adjustments over its life -- a re-bill, then a partial refund -- so an
    // index or an onConflict narrowed to shipment_id alone would silently
    // swallow every one after the first. Both of the two preceding tests assert
    // `toHaveLength(1)`, and an over-constrained key satisfies them perfectly.
    seedAttributed(8404, 'E-503', 9.5)
    seedAdjustment(8404, 1.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8404, 'E-503', { shipmentCost: 12.0 })], pages: 1,
    })
    const run = await syncShipments(30)

    expect(adjustments()).toHaveLength(2)
    expect(adjustments().map((a) => a.adjustment_amount).sort()).toEqual([1.5, 2.5])
    expect(run).toMatchObject({ adjustments: 1 })
  })

  it('names the real conflict target, so a typo cannot pass as a clean run', async () => {
    // The statement, not its effect. fake-supabase throws if an onConflict key
    // is absent from the payload, but nothing checks that the key is the one
    // the database actually has an index on -- and PostgREST answers 42P10 for
    // a target no unique index matches, which would mean NO adjustment is ever
    // written. Asserting the string here is what ties this file to
    // supabase/ledger_03c_rate_adjustments_uniq.sql; the two have to be changed
    // together or this goes red.
    seedAttributed(8405, 'E-504', 9.5)

    h.getShipments.mockResolvedValue({
      shipments: [label(8405, 'E-504', { shipmentCost: 11.0 })], pages: 1,
    })
    await syncShipments(30)

    const upserts = h.db.calls.filter(
      (c) => c.table === 'rate_adjustments' && c.verb === 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].onConflict).toBe('shipment_id,adjustment_amount')
    expect(upserts[0].ignoreDuplicates).toBe(true)
  })

  it('treats a 23505 on the shipments insert as a concurrent write, not a lost shipment', async () => {
    // The same overlap from the other side. Both runs matched no existing row
    // at the select, so both take the insert branch, and the slower one hits
    // shipments_shipstation_id_key. The row IS there -- written by the sibling
    // from the same payload -- so counting this in results.errors drove
    // monitor/route.ts:75 to email "N ShipStation shipments could not be
    // recorded ... their revenue and carrier cost are missing from the ledger",
    // which is false in every clause.
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === 'insert'
        ? { message: 'duplicate key value violates unique constraint '
                   + '"shipments_shipstation_id_key"', code: '23505' }
        : null

    h.getShipments.mockResolvedValue({
      shipments: [label(8501, 'E-600')], pages: 1,
    })
    const result = await syncShipments(30)

    expect(result).toMatchObject({ errors: 0, created: 0 })
    const run = theRun()
    // 'ok', not 'partial'. close() derives the status from the error count, so
    // a fail() here also reddens the row for a run that did nothing wrong.
    expect(run.status).toBe('ok')
    // Recorded, though. A rise in these is the only evidence available of how
    // often the two syncs actually overlap, so it must not be swallowed either.
    const errors = run.errors as Array<{ kind: string; message: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('warning')
    expect(errors[0].message).toContain('concurrent')
  })

  it('still fails loudly on an insert error that is NOT a duplicate key', async () => {
    // The guard on the guard. `insError?.code === '23505'` is one typo away
    // from swallowing every insert failure this sync can have -- a numeric
    // overflow, a not-null violation, a dead connection -- and every one of
    // those really does mean a shipment's revenue and carrier cost are missing
    // from the ledger. The test above cannot tell the difference; this one can.
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === 'insert'
        ? { message: 'numeric field overflow', code: '22003' }
        : null

    h.getShipments.mockResolvedValue({
      shipments: [label(8502, 'E-601')], pages: 1,
    })
    const result = await syncShipments(30)

    expect(result).toMatchObject({ errors: 1, created: 0 })
    const run = theRun()
    expect(run.status).toBe('failed')
    const errors = run.errors as Array<{ kind: string; message: string }>
    expect(errors[0].kind).toBe('error')
    expect(errors[0].message).toContain('overflow')
  })
})

// ---------------------------------------------------------------------------
// Every fail site reaches the counter the CALLER reads.
//
// These exist because of the 2026-10-03 defect: a sync_runs row closed 'failed'
// with error_count 1 on 'shipment lookup #2500-2' while /api/agent/monitor
// reported has_issues:false, painting the dashboard's sync indicator green over
// a failed run. The cause was that the row's status (driven by run.fail ->
// close()) and results.errors were two separate statements at every fail site,
// so a site could record one and not the other.
//
// shipstation.ts now routes all six per-item sites through one failItem()
// helper, but a helper is only a convention until something fails when it is
// bypassed. Each test below pins ONE site, asserting the run row and the
// returned counter TOGETHER -- the exact pair that came apart in production.
// Before these, five of the six sites had no test that noticed a lost counter
// bump: writing `run.fail()` instead of `failItem()` at any of them kept the
// whole suite green.
describe('syncShipments: the row and the counter agree at every fail site', () => {
  /**
   * The pair that drifted in production. A green `errors` over a row that
   * recorded a failure IS the defect, and asserting either half alone cannot
   * see it -- the 2026-10-03 row had the failure and the caller still read
   * zero.
   *
   * `status` is a parameter rather than always 'failed' because close()'s
   * formula is (no errors -> 'ok', else rows written -> 'partial', else
   * 'failed'): a site that fails AFTER something was written closes 'partial'.
   * Both are non-'ok', which is the property that matters here.
   */
  const expectOneFailure = (
    result: { errors: number },
    context: string,
    status: 'failed' | 'partial',
  ) => {
    expect(result.errors).toBe(1)
    const run = theRun()
    expect(run.status).toBe(status)
    expect(run.status).not.toBe('ok')
    // `context` rather than `message`: it is the string the fail site itself
    // passes, so it names WHICH of the six sites fired. Asserting on the
    // message would pass for a failure raised anywhere in the function.
    const errors = run.errors as Array<{ kind: string; context: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('error')
    expect(errors[0].context).toBe(context)
  }

  it('counts a label whose shipmentId is not a number', async () => {
    // shipmentId is the identity of the row, so a label without a usable one
    // cannot be written at all -- the whole label is dropped. That is a
    // shipment whose carrier cost is missing from the ledger, which is exactly
    // what results.errors is read to announce.
    h.getShipments.mockResolvedValue({
      shipments: [{ ...label(9101, 'E-901'), shipmentId: 'not-a-number' }],
      pages: 1,
    })

    const result = await syncShipments(30)

    expect(result.created).toBe(0)
    expectOneFailure(result, 'missing shipmentId', 'failed')
  })

  it('counts a failed existence lookup', async () => {
    // DEFECT 4's site. The select that decides insert-vs-update is the one
    // whose failure the 2026-10-03 production row actually recorded
    // ('shipment lookup #2500-2'), so this is the site that was green.
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === 'select'
        ? { message: 'could not connect to server', code: '08006' }
        : null

    h.getShipments.mockResolvedValue({
      shipments: [label(9102, 'E-902')], pages: 1,
    })
    const result = await syncShipments(30)

    expect(result).toMatchObject({ created: 0, updated: 0 })
    expectOneFailure(result, 'match shipment 9102', 'failed')
  })

  it('counts a failed rate-adjustment insert as an ADJUSTMENT failure, not a shipment one', async () => {
    // A lost adjustment is money. The reader is NOT billing/calculator.ts,
    // which an earlier version of this comment named: that file is imported by
    // nothing but its own test (grep, 2026-10-05), so citing it was citing dead
    // code. The live readers are billing/page.tsx, reports/page.tsx,
    // api/reports/download and the dashboard's pending-adjustments tile -- a
    // rate_adjustments row is how carrier spend reaches a person to approve,
    // and an adjustment never inserted is never billed on.
    //
    // And it never heals: the note at shipstation.ts:272 establishes that once
    // actual_cost holds the new value the diff is 0 on every later run, so this
    // branch is not re-entered. The shipment update below SUCCEEDS here, which
    // is exactly what moves actual_cost -- so this adjustment is lost
    // permanently, not until the next run.
    seedAttributed(9103, 'E-903', 5.00)
    h.db.failOn = (call) =>
      call.table === 'rate_adjustments' && call.verb === 'upsert'
        ? { message: 'deadlock detected', code: '40P01' }
        : null

    h.getShipments.mockResolvedValue({
      shipments: [label(9103, 'E-903', { shipmentCost: 9.50 })], pages: 1,
    })
    const result = await syncShipments(30)

    // `errors: 0` is the correction, and it is the point of this test. The
    // shipment WAS recorded -- updated: 1 -- so counting this in `errors` had
    // the monitor email "1 ShipStation shipment could not be recorded ... their
    // revenue and carrier cost are missing from the ledger until the next
    // successful run picks them up", and every clause of that is false here.
    // The adjustment is what was lost, and it gets its own counter.
    expect(result).toMatchObject({
      updated: 1, adjustments: 0, refunds: 0, errors: 0, adjustmentErrors: 1,
    })
    // Still recorded against the row, and the row is still off 'ok': this is a
    // real failure, just not a failure of the shipment.
    const run = theRun()
    expect(run.status).toBe('partial')
    const errors = run.errors as Array<{ kind: string; context: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'error', context: 'adjustment insert 9103' })
  })

  it('counts a failed shipment update', async () => {
    seedAttributed(9104, 'E-904', 7.25)
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === 'update'
        ? { message: 'numeric field overflow', code: '22003' }
        : null

    // Same cost as the seed, so the adjustment branch is not entered and the
    // update is the only thing that can fail.
    h.getShipments.mockResolvedValue({
      shipments: [label(9104, 'E-904', { shipmentCost: 7.25 })], pages: 1,
    })
    const result = await syncShipments(30)

    expect(result).toMatchObject({ updated: 0, created: 0 })
    expectOneFailure(result, 'update 9104', 'failed')
  })

  it('counts a label that throws while being read', async () => {
    // The per-shipment catch. Unlike the sites above, this one fires on a
    // THROWN error rather than a returned one -- a malformed payload, not a
    // database result -- and it is the catch-all that keeps one bad label from
    // abandoning the rest of the page. It still has to reach the counter.
    const exploding: Record<string, unknown> = { ...label(9105, 'E-905') }
    Object.defineProperty(exploding, 'dimensions', {
      get() { throw new Error('payload exploded') },
      enumerable: true,
    })

    h.getShipments.mockResolvedValue({
      shipments: [exploding, label(9106, 'E-906')], pages: 1,
    })
    const result = await syncShipments(30)

    // The second label is still written: the catch exists so one unreadable
    // payload does not cost the page.
    expect(result.created).toBe(1)
    expectOneFailure(result, 'shipment 9105', 'partial')
  })
})

// ---------------------------------------------------------------------------
// Losing the sync_runs lock.
//
// Before ledger_03d_sync_runs_mutex.sql this source opened its row
// `errors` is rendered by the monitor as a count of SHIPMENTS -- "N ShipStation
// shipment(s) could not be recorded" -- but it was incremented once per
// FAILURE, by six different sites, two of which are sequential rather than
// mutually exclusive. So one label could report as two missing shipments.
//
// Same class of defect as the Zenventory client count fixed on 2026-10-05: a
// count of events read as a count of entities. Measured here before the fix,
// one label, two routes:
//
//   adjustment insert + update both fail -> errors 2, contexts
//     ["adjustment insert 9201","update 9201"]
//   adjustment insert errors, update THROWS -> errors 2, contexts
//     ["adjustment insert 9202","shipment 9202"]
//
// Lower blast radius than the Zenventory one -- nothing here is computed by
// subtraction, so no count could go negative, and the monitor's only gate is
// `errors > 0`, which a double count cannot flip either way. What it corrupted
// was the MAGNITUDE in the alert email, and the file's own standard for that is
// written at the 23505 branch: "An alert that is wrong about whether money is
// missing is worse than no alert, because it spends the attention that a real
// one needs."
//
// WHICH HALF OF THE FIX THESE TESTS ACTUALLY PIN, recorded as a correction
// rather than left as first written. Both routes above are fixed by splitting
// the adjustment site onto its own counter; the failedShipments set is not what
// kills them. Mutation established it: with the split in place, reverting that
// set to `results.errors++` leaves every test here green, because no route
// through the loop as it stands reaches two failItem sites -- the update site
// is the last statement in its branch and the insert site the last in the
// other. The set is a structural guarantee against a future route doing so,
// and the note on it in sync/shipstation.ts says so in those terms. Do not
// read these tests as evidence for it.
describe('syncShipments: one label, counted once', () => {
  it('counts a label whose adjustment AND update both fail as one shipment', async () => {
    // ROUTE A. The adjustment branch is entered only when the cost DIFFERS from
    // the stored one, which is why the site-4 test above deliberately matches
    // the seed cost -- it was avoiding this overlap rather than covering it.
    seedAttributed(9201, 'E-921', 5.00)
    h.db.failOn = (call) =>
      (call.table === 'rate_adjustments' && call.verb === 'upsert')
        || (call.table === 'shipments' && call.verb === 'update')
        ? { message: 'database is in recovery mode', code: '57P03' }
        : null
    h.getShipments.mockResolvedValue({
      shipments: [label(9201, 'E-921', { shipmentCost: 9.50 })], pages: 1,
    })

    const result = await syncShipments(30)

    // One label, so one missing shipment -- plus one separately-counted lost
    // adjustment. Was `errors: 2, adjustmentErrors: undefined`.
    expect(result).toMatchObject({ errors: 1, adjustmentErrors: 1, updated: 0 })
  })

  it('counts a label whose adjustment fails and whose update THROWS as one shipment', async () => {
    // ROUTE B. A rejection rather than a PostgREST error object, which reaches
    // the per-label catch instead of the `if (updError)` branch -- a different
    // pair of sites, the same double count.
    seedAttributed(9202, 'E-922', 5.00)
    h.db.failOn = (call) =>
      call.table === 'rate_adjustments' && call.verb === 'upsert'
        ? { message: 'deadlock detected', code: '40P01' }
        : null
    let seen = 0
    const real = h.db.client.from.bind(h.db.client)
    h.db.client.from = ((t: string) => {
      if (t === 'shipments' && ++seen === 2) throw new TypeError('fetch failed')
      return real(t)
    }) as typeof h.db.client.from
    h.getShipments.mockResolvedValue({
      shipments: [label(9202, 'E-922', { shipmentCost: 9.50 })], pages: 1,
    })

    const result = await syncShipments(30)

    expect(result).toMatchObject({ errors: 1, adjustmentErrors: 1 })
  })

  it('still records BOTH failures on the run row', async () => {
    // The dedupe is on the CALLER's count only. The row is the forensic record
    // and 'adjustment insert' beside 'update' says more than either alone --
    // the same split the Zenventory fix kept.
    seedAttributed(9203, 'E-923', 5.00)
    h.db.failOn = (call) =>
      (call.table === 'rate_adjustments' && call.verb === 'upsert')
        || (call.table === 'shipments' && call.verb === 'update')
        ? { message: 'database is in recovery mode', code: '57P03' }
        : null
    h.getShipments.mockResolvedValue({
      shipments: [label(9203, 'E-923', { shipmentCost: 9.50 })], pages: 1,
    })

    await syncShipments(30)

    const errors = theRun().errors as Array<{ context: string }>
    expect(errors.map((e) => e.context)).toEqual([
      'adjustment insert 9203', 'update 9203',
    ])
  })

  it('does not collapse two DIFFERENT labels that each fail', async () => {
    // The other half of the property, and the one a Set makes easy to get
    // wrong. Deduping per label must not dedupe across labels.
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === 'insert'
        ? { message: 'numeric field overflow', code: '22003' }
        : null
    h.getShipments.mockResolvedValue({
      shipments: [label(9204, 'E-924'), label(9205, 'E-925')], pages: 1,
    })

    const result = await syncShipments(30)

    expect(result.errors).toBe(2)
  })

  it('does not collapse two labels that BOTH lack a usable shipmentId', async () => {
    // These fail before any id is known, so there is no id to key them on.
    // Keying them on the same sentinel would report two dropped labels as one;
    // they get an ordinal instead.
    h.getShipments.mockResolvedValue({
      shipments: [
        { ...label(9206, 'E-926'), shipmentId: 'not-a-number' },
        { ...label(9207, 'E-927'), shipmentId: null },
      ],
      pages: 1,
    })

    const result = await syncShipments(30)

    expect(result.errors).toBe(2)
  })

  it('reports no adjustment failures on a clean pass', async () => {
    // The new counter has to be 0 rather than absent, or `Number(x ?? 0)` in
    // the monitor hides a missing field as a healthy zero.
    h.getShipments.mockResolvedValue({ shipments: [label(9208, 'E-928')], pages: 1 })

    const result = await syncShipments(30)

    expect(result.adjustmentErrors).toBe(0)
    expect(result.errors).toBe(0)
  })
})

// unconditionally and could not have a lock conflict at all. Now the loser of
// an overlapping pair gets 23505 -- and overlap here is the ORDINARY case, not
// a rare collision: the monitor route budgets 300s and AutoSync polls it every
// five minutes from every open browser tab, so a pass that uses its full budget
// has not finished when the next tick begins.
describe('syncShipments: losing the sync_runs lock', () => {
  /** Make the sync_runs INSERT fail, leaving the stale-run reap alone. */
  const failTheRunInsert = (error: { code?: string; message: string }) => {
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'insert' ? error : null
  }
  const lockConflict = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "sync_runs_running_source_key"',
  }

  // Does not throw, and that is the point. The three callers all surface a
  // throw from here: api/sync/all turns it into a 500, and the monitor turns it
  // into a 🚨 line. Propagating would mean raising an alarm BECAUSE the system
  // successfully prevented the problem it was built to prevent.
  it('returns instead of throwing', async () => {
    failTheRunInsert(lockConflict)
    await expect(syncShipments(30)).resolves.toBeTruthy()
  })

  it('says it skipped, and why', async () => {
    failTheRunInsert(lockConflict)
    const result = await syncShipments(30)
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toMatch(/already in progress/)
  })

  // Every counter at zero AND errors at zero. The monitor reads `errors` to
  // decide whether to send the alert, so a non-zero here would be the false
  // alarm this whole branch exists to avoid; and `created`/`updated` must not
  // claim work the sibling run is doing.
  it('reports no work and no failures', async () => {
    failTheRunInsert(lockConflict)
    const result = await syncShipments(30)
    expect(result).toMatchObject({
      created: 0, updated: 0, adjustments: 0, refunds: 0,
      errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
    })
  })

  // The distinguishing test. `skipped` has to be readable as "this pass did
  // nothing because another one is doing it" and NOT as "this pass did nothing
  // because there was nothing to do" -- the counters are identical in both
  // cases, so without the flag the monitor prints the same cheerful line.
  it('a genuinely empty pass is NOT marked skipped', async () => {
    h.getShipments.mockResolvedValue({ shipments: [], pages: 1 })
    const result = await syncShipments(30)
    expect(result.skipped).toBe(false)
    expect(result.skipReason).toBeNull()
    expect(result.created).toBe(0)
  })

  // It must not pull anything either. Returning the right numbers while still
  // hammering the ShipStation API for eleven pages would defeat the purpose of
  // stepping aside.
  it('does not call ShipStation at all', async () => {
    failTheRunInsert(lockConflict)
    await syncShipments(30)
    expect(h.getShipments).not.toHaveBeenCalled()
  })

  // Only 23505 is a lock. Any other failure to write the run row still throws,
  // because this sync writes the shipment cost rows and running it with no
  // record of the run is how a partial ingest becomes invisible.
  it('still throws when the run row fails for any other reason', async () => {
    failTheRunInsert({ code: '42501', message: 'permission denied for table sync_runs' })
    await expect(syncShipments(30)).rejects.toThrow(/permission denied/)
  })
})
// DEFECT 1, STILL LIVE, THROUGH A DIFFERENT DOOR. Found 2026-10-05 by writing
// the two-unusable-ids case below for the counter work, which returned
// `errors: 1` where the counter could only have produced 2 -- so the SECOND
// label had not reached the fail site at all.
//
// `Number(null)` is 0, not NaN, and `Number.isFinite(0)` is true. So the guard
// that exists to reject a label with no identity passes it through with the
// identity 0 -- as do '', false, [] and '0'. Every such label in every run
// shares that one key, which is precisely the collapse the guard was written to
// stop: measured end-to-end, two null-id labels at $11.11 and $22.22 produced
// ONE row (ssid 0, holding only $22.22), `created: 1, updated: 1`, and a run
// row closed `status: 'ok'` with `errors: []` and `rows_written: 2`.
//
// So the first label's carrier cost was not merely misattributed, it was
// overwritten, and nothing anywhere reported a problem. Row 0 is permanent, so
// each later run overwrites it again. This is the module's own described
// failure mode -- "the two labels COLLAPSE onto one, one carrier cost lost, the
// survivor overwritten. Measured cost comes out too low and margin too high" --
// and the leak views do not catch it, because they ask whether work was billed,
// never whether a cost was recorded exactly once.
describe('syncShipments: a label with no usable shipmentId', () => {
  it('does not collapse two id-less labels onto one row', async () => {
    h.getShipments.mockResolvedValue({
      shipments: [
        { ...label(1, 'E-910', { shipmentCost: 11.11 }), shipmentId: null },
        { ...label(2, 'E-911', { shipmentCost: 22.22 }), shipmentId: null },
      ],
      pages: 1,
    })

    await syncShipments(30)

    // The money assertion. Before the fix this was one row holding 22.22, and
    // 11.11 had been overwritten by it.
    expect(shipments()).toHaveLength(0)
  })

  it('never writes a shipment under the identity 0', async () => {
    h.getShipments.mockResolvedValue({
      shipments: [{ ...label(1, 'E-912'), shipmentId: null }],
      pages: 1,
    })

    await syncShipments(30)

    expect(shipments().map((r) => r.shipstation_shipment_id)).not.toContain(0)
  })

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a literal zero', 0],
    ['the string "0"', '0'],
    ['false', false],
  ])('refuses a shipmentId that is %s, rather than calling it shipment 0', async (_label, id) => {
    h.getShipments.mockResolvedValue({
      shipments: [{ ...label(1, 'E-913'), shipmentId: id }],
      pages: 1,
    })

    const result = await syncShipments(30)

    expect(shipments()).toHaveLength(0)
    expect(result.errors).toBe(1)
    expect(theRun().status).toBe('failed')
  })

  it('records WHICH labels it refused, so the cost can be recovered by hand', async () => {
    // The whole value of refusing instead of collapsing: the order number is
    // the only handle left on a label with no id, so it has to be on the row.
    h.getShipments.mockResolvedValue({
      shipments: [
        { ...label(1, 'E-914'), shipmentId: null },
        { ...label(2, 'E-915'), shipmentId: '' },
      ],
      pages: 1,
    })

    await syncShipments(30)

    const errs = theRun().errors as Array<{ context: string; message: string }>
    expect(errs).toHaveLength(2)
    expect(errs.every((e) => e.context === 'missing shipmentId')).toBe(true)
    expect(JSON.stringify(errs)).toContain('E-914')
    expect(JSON.stringify(errs)).toContain('E-915')
  })

  it('still accepts a legitimate id, so the guard has not been drawn too wide', async () => {
    // The positive control. A guard that refuses everything would pass every
    // assertion above and silently stop recording the business.
    h.getShipments.mockResolvedValue({
      shipments: [label(9301, 'E-930', { shipmentCost: 8.80 })],
      pages: 1,
    })

    const result = await syncShipments(30)

    expect(result).toMatchObject({ created: 1, errors: 0 })
    expect(shipments()).toHaveLength(1)
    expect(shipments()[0].shipstation_shipment_id).toBe(9301)
  })
})

