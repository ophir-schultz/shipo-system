import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'
import type { ChargeInput, RateCardLine } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

// The module under test reads `supabaseAdmin` on every call rather than
// capturing it, so a getter is enough to swap the whole database per test.
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { recalculateCharges, CHARGE_THROTTLE_MINUTES } =
  await import('@/lib/ledger/persist-charges')

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

const pickRate: RateCardLine = {
  id: 'rate-pick', chargeType: 'pick', variant: 'device',
  rate: 2, rateType: 'per_unit', effectiveFrom: null, effectiveTo: null,
}
const shipRate: RateCardLine = {
  id: 'rate-ship', chargeType: 'shipping', variant: null,
  rate: null, rateType: 'at_cost', effectiveFrom: null, effectiveTo: null,
}
const pickCost: CostRateRow = {
  id: 'cost-pick', cost_type: 'pick', variant: 'device', unit: 'per_unit',
  rate: 0.5, effective_from: '2020-01-01', effective_to: null, basis: 'measured',
}

/** An order with one picked device line, priced and costed. */
function order(id: string, overrides: Partial<ChargeInput> = {}): ChargeInput {
  return {
    order: { id, clientId: 'client-1', cancelled: false },
    items: [{ id: `${id}-item`, sku: 'D-1', quantityPicked: 3,
              isComponent: false, pickDate: '2026-09-01' }],
    shipments: [],
    rateCard: [pickRate],
    costRates: [pickCost],
    peakSurchargePct: 0,
    ...overrides,
  }
}

const charges = () => (h.db.tables.order_charges ?? []) as FakeRow[]
const chargeKeysFor = (orderId: string) =>
  charges().filter((c) => c.order_id === orderId).map((c) => c.charge_key).sort()

beforeEach(() => {
  h.db = createFakeSupabase({ sync_runs: [], order_charges: [] })
})

describe('recalculateCharges — the stale-delete', () => {
  it('never removes charges belonging to an order this run did not process', async () => {
    // The whole reason the delete carries an order-id filter. If it is ever
    // widened back to the whole table, an untouched order's charges — which may
    // be every charge for a client outside the window — are destroyed by a run
    // that had nothing to do with them.
    h.db.tables.order_charges = [
      { id: 'c-untouched', order_id: 'order-untouched', charge_key: 'item:x:pick',
        charge_type: 'pick', amount: 99, calculated_at: '2020-01-01T00:00:00.000Z' },
      { id: 'c-stale', order_id: 'order-a', charge_key: 'item:gone:pick',
        charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
    expect(chargeKeysFor('order-untouched')).toEqual(['item:x:pick'])
    // The row this run superseded is gone; the row it wrote is there.
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })

  it('issues every delete with an order_id filter', async () => {
    // Asserted on the STATEMENT, not only on its effect. A fixture can hide an
    // unscoped delete whenever every row in the table happens to belong to the
    // run; the missing filter cannot hide.
    h.db.tables.order_charges = [
      { id: 'c-stale', order_id: 'order-a', charge_key: 'item:gone:pick',
        charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]

    await recalculateCharges(async () => [order('order-a')])

    const deletes = h.db.calls.filter((c) => c.table === 'order_charges' && c.verb === 'delete')
    expect(deletes.length).toBeGreaterThan(0)
    for (const del of deletes) {
      expect(del.filters.some((f) => f.op === 'in' && f.column === 'order_id')).toBe(true)
      expect(del.filters.some((f) => f.op === 'lt' && f.column === 'calculated_at')).toBe(true)
    }
  })

  it('leaves a failed order its existing charges', async () => {
    // A corrupt quantity makes buildCharges throw. Deleting on the strength of
    // a calculation that failed would turn a bad line into a missing invoice.
    h.db.tables.order_charges = [
      { id: 'c-old', order_id: 'order-bad', charge_key: 'item:old:pick',
        charge_type: 'pick', amount: 7, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]
    const bad = order('order-bad')
    bad.items[0].quantityPicked = Number.NaN

    const result = await recalculateCharges(async () => [bad, order('order-a')])

    expect(result).toMatchObject({ skipped: false, failedOrders: 1 })
    expect(chargeKeysFor('order-bad')).toEqual(['item:old:pick'])
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })

  it('keeps one unwritable order from costing the rest of its chunk', async () => {
    h.db.tables.order_charges = [
      { id: 'c-old', order_id: 'order-bad', charge_key: 'item:old:pick',
        charge_type: 'pick', amount: 7, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]
    h.db.failOn = (call) =>
      call.table === 'order_charges' && call.verb === 'upsert'
        && call.payload.some((r) => r.order_id === 'order-bad')
        ? { message: 'numeric field overflow' }
        : null

    const result = await recalculateCharges(async () =>
      [order('order-bad'), order('order-a'), order('order-b')])

    expect(result).toMatchObject({ skipped: false, failedOrders: 1, upserted: 2 })
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
    expect(chargeKeysFor('order-b')).toEqual(['item:order-b-item:pick'])
    // Excluded from the stale-delete, so it still has what it had.
    expect(chargeKeysFor('order-bad')).toEqual(['item:old:pick'])
  })
})

describe('recalculateCharges — the gates', () => {
  it('skips, visibly, when a charge run finished recently', async () => {
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'ok', finished_at: minutesAgo(10) },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: true, cause: 'throttled' })
    expect(charges()).toHaveLength(0)
  })

  it('runs once the throttle interval has elapsed', async () => {
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'ok',
        finished_at: minutesAgo(CHARGE_THROTTLE_MINUTES + 5) },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })

  it('is not throttled by another source finishing recently', async () => {
    // A shipstation sync finishing a minute ago says nothing about charges.
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'shipstation', status: 'ok', finished_at: minutesAgo(1) },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
  })

  it('skips while another charge run is live', async () => {
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'running',
        started_at: minutesAgo(2), finished_at: null },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: true, cause: 'lock' })
    expect(charges()).toHaveLength(0)
  })

  it('skips rather than risk a concurrent delete when the lock cannot be read', async () => {
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'select'
        && call.filters.some((f) => f.op === 'eq' && f.column === 'status')
        ? { message: 'connection reset' }
        : null

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: true, cause: 'gate-unreadable' })
    expect(charges()).toHaveLength(0)
  })

  it('proceeds when the throttle gate cannot be read', async () => {
    // Unlike the lock, an unreadable throttle risks only redundant work.
    // Skipping on it would let one broken read stop charges being calculated.
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'select'
        && call.filters.some((f) => f.op === 'not-is-null')
        ? { message: 'statement timeout' }
        : null

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })
})

describe('recalculateCharges — the leak counters', () => {
  it('counts an order that was picked but produced no pick charge', async () => {
    // The detector used to live in the `else` of "has any charges at all", so
    // an order carrying a shipping charge — nearly every order — could never be
    // counted, and the leak detector was inert in the common case.
    const unpriced = order('order-a', {
      rateCard: [shipRate],                       // no pick line on the card
      shipments: [{ id: 's1', shipmentId: 5001, shipDate: '2026-09-02',
                    actualCost: 9.5, voided: false }],
    })

    const result = await recalculateCharges(async () => [unpriced])

    expect(result).toMatchObject({ skipped: false, unpricedOrders: 1 })
    expect(chargeKeysFor('order-a')).toEqual(['shipment:5001'])
  })

  it('does not count an order that was never picked', async () => {
    const nothingPicked = order('order-a')
    nothingPicked.items[0].quantityPicked = 0

    const result = await recalculateCharges(async () => [nothingPicked])

    expect(result).toMatchObject({ skipped: false, unpricedOrders: 0 })
  })

  it('separates an unknown pick cost from a carrier cost nobody has reported', async () => {
    const input = order('order-a', {
      costRates: [],                              // no pick cost rate at all
      rateCard: [pickRate, shipRate],
      shipments: [{ id: 's1', shipmentId: 5001, shipDate: '2026-09-02',
                    actualCost: null, voided: false }],
    })

    const result = await recalculateCharges(async () => [input])

    // The shipping row is NOT counted as a missing cost rate: a carrier cost
    // that has not arrived yet is a different problem with a different fix.
    expect(result).toMatchObject({
      skipped: false, unknownCostCharges: 1, unknownCarrierCharges: 1,
    })
  })
})

describe('recalculateCharges — bookkeeping', () => {
  it('records the run and closes it', async () => {
    await recalculateCharges(async () => [order('order-a')])

    const runs = (h.db.tables.sync_runs ?? []).filter((r) => r.source === 'charges')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'ok', rows_seen: 1, rows_written: 1 })
    expect(runs[0].finished_at).toBeTruthy()
  })

  it('writes charges in batches rather than one round trip per order', async () => {
    // The shape that timed the route out was two sequential queries per order.
    const many = Array.from({ length: 40 }, (_, i) => order(`order-${i}`))

    await recalculateCharges(async () => many)

    const upserts = h.db.calls.filter((c) => c.table === 'order_charges' && c.verb === 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].payload).toHaveLength(40)
    expect(upserts[0].onConflict).toBe('order_id,charge_key')
  })
})
