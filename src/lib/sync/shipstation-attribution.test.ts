import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// The subject here is which CLIENT a synced label is recorded against.
//
// Separate from shipstation.test.ts deliberately, and not because the setup
// differs -- it is nearly identical. That file is 900 lines about the sync_runs
// row and the per-label failure counters, and a concurrent session was holding
// 164 uncommitted lines in it when this was written. Two sessions editing one
// test file is how one of them loses work, and these assertions are about a
// different question from any of the ones in there.
//
// WHAT IS BEING PINNED. syncShipments used to write no client_id at all: its
// `shipmentData` object had no such key, the comment said "for now match by
// order source", and nothing replaced it. 599 of 890 shipments were therefore
// unattributed, carrying $8,980.99 of carrier cost billed to nobody -- and the
// hole grew three times a day, because the pull that records the cost could not
// name the payer.
//
// The decision rule itself is tested in store-attribution.test.ts, which is
// pure and exhaustive. This file tests the WIRING: that the decision reaches the
// right column, that no attribution counter is folded into results.errors, and
// above all that an existing client_id survives a pass that disagrees with it.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  getShipments: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/api/shipstation', () => ({ getShipments: h.getShipments }))

const { syncShipments } = await import('@/lib/sync/shipstation')

const shipments = () => (h.db.tables.shipments ?? []) as FakeRow[]
const adjustments = () => (h.db.tables.rate_adjustments ?? []) as FakeRow[]
const runs = () => (h.db.tables.sync_runs ?? []) as FakeRow[]

const theRun = () => {
  expect(runs()).toHaveLength(1)
  return runs()[0]
}
const recordsOf = (run: FakeRow) =>
  (run.errors ?? []) as Array<{ kind: string; context: string; message: string }>
const warningsOf = (run: FakeRow) => recordsOf(run).filter((e) => e.kind === 'warning')
const errorsOf = (run: FakeRow) => recordsOf(run).filter((e) => e.kind === 'error')

beforeEach(() => {
  h.db = createFakeSupabase({
    sync_runs: [], shipments: [], carriers: [], rate_adjustments: [],
    client_store_ids: [],
  })
  h.getShipments.mockReset()
})

function mapStore(storeId: unknown, clientId: string) {
  (h.db.tables.client_store_ids as FakeRow[]).push({
    id: `csi-${String(storeId)}`, store_id: storeId, client_id: clientId,
  })
}

/**
 * One ShipStation label. `storeId` goes under advancedOptions, which is where
 * the live API puts it and therefore where storeIdOf looks first.
 *
 * Pass `storeId: null` for a label that carries no store key at all -- a
 * different case from one whose store is simply unmapped, and the two must not
 * share a counter.
 */
function label(shipmentId: number, over: Partial<{
  storeId: unknown; orderNumber: string; shipmentCost: unknown
}> = {}) {
  const advanced = 'storeId' in over && over.storeId === null
    ? {}
    : { advancedOptions: { storeId: 'storeId' in over ? over.storeId : '111' } }
  return {
    shipmentId,
    orderNumber: over.orderNumber ?? `ORD-${shipmentId}`,
    orderDate: '2026-09-01',
    shipDate: '2026-09-02',
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    trackingNumber: `TRK${shipmentId}`,
    shipmentCost: 'shipmentCost' in over ? over.shipmentCost : 7.25,
    weight: { value: 16, units: 'ounces' },
    dimensions: { length: 6, width: 4, height: 2, units: 'inches' },
    shipTo: { name: 'A Person', city: 'Dover', state: 'DE', postalCode: '19901' },
    ...advanced,
  }
}

function onePage(...labels: unknown[]) {
  h.getShipments.mockResolvedValue({ shipments: labels, pages: 1 })
}

/** An existing row, with whatever client_id it already holds -- including null. */
function seedShipment(shipmentId: number, over: Partial<{
  clientId: string | null; cost: number | null
}> = {}) {
  (h.db.tables.shipments as FakeRow[]).push({
    id: `seed-${shipmentId}`,
    client_id: 'clientId' in over ? over.clientId : null,
    shipstation_shipment_id: shipmentId,
    order_number: `ORD-${shipmentId}`,
    actual_cost: 'cost' in over ? over.cost : 7.25,
    source: 'stamps',
  })
}

describe('syncShipments attributes a label to its store’s client', () => {
  it('writes client_id on a label it is inserting for the first time', async () => {
    // The case that closes the hole. Before this, a brand-new label was written
    // with client_id null and stayed that way unless zenventory.ts happened to
    // match its order_number -- so the cost landed in the ledger and the revenue
    // never did.
    mapStore('111', 'client-a')
    onePage(label(5001))

    const result = await syncShipments(30)

    expect(result.created).toBe(1)
    expect(result.attributed).toBe(1)
    expect(shipments()[0].client_id).toBe('client-a')
  })

  it('writes client_id on an existing row that had none', async () => {
    // The 599. They are already in the table with their costs; what they lack
    // is a payer, and the update path is what gives it to them without a
    // backfill having to run first.
    mapStore('111', 'client-a')
    seedShipment(5002, { clientId: null })
    onePage(label(5002))

    const result = await syncShipments(30)

    expect(result.updated).toBe(1)
    expect(result.attributed).toBe(1)
    expect(shipments()[0].client_id).toBe('client-a')
  })

  it('stringifies a numeric storeId, because client_store_ids.store_id is text', async () => {
    // The failure this prevents does not look like a type error. A numeric 111
    // compared against the text column finds nothing, so every label reports as
    // coming from an unmapped store -- a wrong answer that reads as a data-entry
    // problem and sends someone to map stores that are already mapped.
    mapStore('111', 'client-a')
    onePage(label(5003, { storeId: 111 }))

    const result = await syncShipments(30)

    expect(result.attributed).toBe(1)
    expect(result.unmappedStore).toBe(0)
    expect(shipments()[0].client_id).toBe('client-a')
  })
})

describe('syncShipments never overwrites a client_id it already has', () => {
  it('leaves a stored attribution alone and announces the disagreement', async () => {
    // THE CASE THAT MUST NEVER FIRE. 291 of the 890 rows in this database were
    // attributed by hand. A sync running three times a day that "corrected" one
    // of them would move a real invoice from one client to another with no
    // record that it moved, and nothing downstream could notice: the new
    // attribution is as plausible as the old one.
    mapStore('111', 'client-a')
    seedShipment(5004, { clientId: 'client-zzz' })
    onePage(label(5004))

    const result = await syncShipments(30)

    expect(shipments()[0].client_id).toBe('client-zzz')
    expect(result.attributed).toBe(0)
    expect(result.attributionConflicts).toBe(1)

    // And the warning names BOTH clients. "A conflict on shipment 5004" cannot
    // be acted on without a SQL session; the two ids are the entire content.
    const warn = warningsOf(theRun()).find((w) => w.context.includes('conflict'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('client-zzz')
    expect(warn!.message).toContain('client-a')
  })

  it('does not flag a conflict when the map agrees with what the row holds', async () => {
    // The positive control for the test above. Without it, "never overwrites"
    // is satisfied by an implementation that calls every attributed row a
    // conflict -- which would put a warning on all 291 hand-attributed rows
    // three times a day and bury the real ones.
    mapStore('111', 'client-a')
    seedShipment(5005, { clientId: 'client-a' })
    onePage(label(5005))

    const result = await syncShipments(30)

    expect(shipments()[0].client_id).toBe('client-a')
    expect(result.attributionConflicts).toBe(0)
    expect(result.attributed).toBe(0)
    expect(warningsOf(theRun())).toHaveLength(0)
  })
})

describe('syncShipments separates the reasons a label went unattributed', () => {
  it('names the stores that have no client_store_ids row, deduplicated', async () => {
    // The highest-leverage finding this sync can produce: one INSERT per store
    // attributes every shipment that store has ever sent and every one it will
    // send. So the STORE is the actionable unit, and the count of shipments is
    // context -- reporting "412 attribution problems" would read as 412 pieces
    // of work instead of three.
    onePage(label(6001, { storeId: '900' }), label(6002, { storeId: '900' }),
            label(6003, { storeId: '901' }))

    const result = await syncShipments(30)

    expect(result.created).toBe(3)
    expect(result.unmappedStore).toBe(3)
    expect(result.unmappedStoreIds).toEqual(['900', '901'])
    expect(result.attributed).toBe(0)
    // Written anyway, with its cost, and client_id left NULL rather than guessed.
    // An unattributed shipment is visibly missing from a client's invoice; a
    // wrongly attributed one is invisibly on it.
    expect(shipments().every((s) => s.client_id == null)).toBe(true)

    const warn = warningsOf(theRun()).find((w) => w.context.includes('client_store_ids'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('900')
    expect(warn!.message).toContain('901')
  })

  it('counts a label with NO store key separately from one whose store is unmapped', async () => {
    // Different work, so they cannot share a counter. An unmapped store is one
    // INSERT from being fixed for every shipment from it; a label with no store
    // key cannot be attributed by any SQL and needs someone reading tracking
    // numbers in ShipStation. Collapsing the two hides which kind of problem the
    // money is sitting behind -- and the second is the ceiling on this whole
    // method, so its size is the thing worth knowing first.
    onePage(label(6004, { storeId: null }), label(6005, { storeId: '900' }))

    const result = await syncShipments(30)

    expect(result.noStoreId).toBe(1)
    expect(result.unmappedStore).toBe(1)
    expect(result.unmappedStoreIds).toEqual(['900'])
  })

  it('treats a blank store id as no store id, not as a store named ""', async () => {
    // '' is a perfectly good lookup key. Letting it through would gather every
    // store-less label under one key, and a single client_store_ids row with a
    // blank store_id would then attribute all of them to that client at once.
    mapStore('', 'client-wrong')
    onePage(label(6006, { storeId: '   ' }))

    const result = await syncShipments(30)

    expect(result.noStoreId).toBe(1)
    expect(result.attributed).toBe(0)
    expect(shipments()[0].client_id == null).toBe(true)
  })

  it('does not count a store id it successfully mapped as unmapped', async () => {
    mapStore('111', 'client-a')
    onePage(label(6007))

    const result = await syncShipments(30)

    expect(result.unmappedStore).toBe(0)
    expect(result.unmappedStoreIds).toEqual([])
    expect(result.noStoreId).toBe(0)
  })
})

describe('syncShipments when the store map cannot be read', () => {
  it('records the shipments and their costs anyway, and says attribution did not run', async () => {
    // The degraded pass, and the shape of it is the point. This pull is the only
    // source of carrier cost in the business, so a failed lookup-table read must
    // not stop it: every row is still written with its cost. What is withheld is
    // the client_id, because a guess there is worse than a gap.
    h.db.failOn = (call) => call.table === 'client_store_ids'
      ? { message: 'permission denied for table client_store_ids', code: '42501' }
      : null
    onePage(label(7001))

    const result = await syncShipments(30)

    expect(result.storeMapUnavailable).toBe(true)
    expect(result.created).toBe(1)
    expect(shipments()[0].actual_cost).toBe(7.25)
    expect(shipments()[0].client_id == null).toBe(true)
  })

  it('does not report the failed read as a shipment that could not be recorded', async () => {
    // results.errors is rendered by monitor/route.ts as "N ShipStation shipments
    // could not be recorded ... Their revenue and carrier cost are missing from
    // the ledger until the next successful run picks them up." Every clause of
    // that is false here: the row is written, the cost is stored, and the next
    // run recovers the attribution for free. An alert that is wrong about
    // whether money is missing spends the attention a real one needs.
    h.db.failOn = (call) => call.table === 'client_store_ids'
      ? { message: 'permission denied', code: '42501' }
      : null
    onePage(label(7002))

    const result = await syncShipments(30)

    expect(result.errors).toBe(0)
    const run = theRun()
    expect(errorsOf(run)).toHaveLength(0)
    expect(run.status).not.toBe('failed')
    // Recorded as a warning, so it is findable against the run without moving
    // the row off 'ok' or reaching the alert email.
    expect(warningsOf(run).some((w) => w.context.includes('store map'))).toBe(true)
  })

  it('asks for no hand work on a degraded pass', async () => {
    // THE ORDERING THAT MATTERS. With the map unreadable, an implementation that
    // consulted the payload first would report these labels as 'no store id' --
    // which is surfaced as "cannot be attributed by any SQL, someone must read
    // tracking numbers in ShipStation", a claim about an afternoon of a person's
    // time, made by code that could not read the lookup table. One of these
    // labels HAS a mapped store and the other has no store key at all, so
    // neither counter may move.
    mapStore('111', 'client-a')
    h.db.failOn = (call) => call.table === 'client_store_ids'
      ? { message: 'permission denied', code: '42501' }
      : null
    onePage(label(7003), label(7004, { storeId: null }))

    const result = await syncShipments(30)

    expect(result.storeMapUnavailable).toBe(true)
    expect(result.noStoreId).toBe(0)
    expect(result.unmappedStore).toBe(0)
    expect(result.unmappedStoreIds).toEqual([])
    expect(result.attributed).toBe(0)
  })
})

describe('syncShipments records a rate adjustment on a shipment it attributes', () => {
  it('no longer discards a refund that arrives on a newly attributed shipment', async () => {
    // The loss this fixes is permanent, not deferred, which is why it is wired
    // in the same commit. The adjustment branch used to gate on the client_id
    // from BEFORE attribution, so a refund landing on a shipment this pass was
    // attributing computed its diff, found no client, and wrote nothing -- and
    // no later run recovers it, because once actual_cost holds the new value the
    // diff is 0 for ever and the branch is never re-entered.
    //
    // That is the mechanism by which every refund and void on the 599
    // unattributed shipments was discarded at the time, recoverable only from
    // ShipStation's side.
    mapStore('111', 'client-a')
    seedShipment(8001, { clientId: null, cost: 10.00 })
    onePage(label(8001, { shipmentCost: 7.25 }))

    const result = await syncShipments(30)

    expect(result.attributed).toBe(1)
    expect(result.refunds).toBe(1)
    expect(adjustments()).toHaveLength(1)
    expect(adjustments()[0].client_id).toBe('client-a')
    expect(adjustments()[0].adjustment_amount).toBe(-2.75)
  })

  it('bills a conflict’s adjustment to the STORED client, not the mapped one', async () => {
    // A conflict leaves the shipment attributed to whoever it was attributed to,
    // so the refund belongs to that same client: they are the one who was
    // charged the original. Writing it against the mapped client would credit a
    // client who was never billed and leave the charged one holding the full
    // cost -- two wrong invoices from one disagreement.
    mapStore('111', 'client-a')
    seedShipment(8002, { clientId: 'client-zzz', cost: 10.00 })
    onePage(label(8002, { shipmentCost: 7.25 }))

    const result = await syncShipments(30)

    expect(result.attributionConflicts).toBe(1)
    expect(adjustments()).toHaveLength(1)
    expect(adjustments()[0].client_id).toBe('client-zzz')
  })

  it('still writes no adjustment when no client can be named at all', async () => {
    // The gate is loosened, not removed. rate_adjustments.client_id feeds
    // billing/calculator.ts straight into a client's weekly bill, and there is
    // no such thing as an adjustment belonging to nobody -- a null there would
    // be rejected by the foreign key and fail the shipment over a bad
    // adjustment row.
    seedShipment(8003, { clientId: null, cost: 10.00 })
    onePage(label(8003, { storeId: '900', shipmentCost: 7.25 }))

    const result = await syncShipments(30)

    expect(result.unmappedStore).toBe(1)
    expect(adjustments()).toHaveLength(0)
    expect(result.refunds).toBe(0)
    expect(result.errors).toBe(0)
  })
})

describe('syncShipments keeps attribution findings out of the failure counter', () => {
  it('reports every attribution case at once without touching results.errors', async () => {
    // One pass containing every non-writing outcome, asserted together. Each of
    // these is a FINDING about a rate-card or mapping gap, and results.errors is
    // the counter that wakes somebody up about shipments whose cost is missing
    // from the ledger. None of these shipments is missing anything: all five are
    // written, all five carry their cost.
    mapStore('111', 'client-a')
    seedShipment(9003, { clientId: 'client-a' })
    seedShipment(9004, { clientId: 'client-zzz' })
    onePage(
      label(9001),                      // attribute
      label(9002, { storeId: '900' }),  // unmapped store
      label(9003),                      // keep
      label(9004),                      // conflict
      label(9005, { storeId: null }),   // no store id
    )

    const result = await syncShipments(30)

    expect(result.attributed).toBe(1)
    expect(result.unmappedStore).toBe(1)
    expect(result.noStoreId).toBe(1)
    expect(result.attributionConflicts).toBe(1)
    expect(result.storeMapUnavailable).toBe(false)

    expect(result.errors).toBe(0)
    expect(errorsOf(theRun())).toHaveLength(0)
    expect(shipments()).toHaveLength(5)
  })
})
