import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'
import type { ChargeInput, RateCardLine } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

// The module under test reads `supabaseAdmin` on every call rather than
// capturing it, so a getter is enough to swap the whole database per test.
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { recalculateCharges, CHARGE_THROTTLE_MINUTES, CHARGE_CRON_HOURS_UTC, chargeRunIsDue } =
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
  // The clock is pinned for every test, not only the ones about the schedule.
  // The throttle is now defeated by a scheduled firing having elapsed since the
  // last success, so on a real clock a test asserting "this is throttled" would
  // pass or fail depending on whether it happened to run in the ten minutes
  // after 06:00, 14:00 or 20:00 UTC. 10:00 is deliberately mid-gap.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
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

describe('recalculateCharges — the stale-delete blast radius', () => {
  /**
   * The scenario the floor exists for, and the reason it is the only guard in
   * this file whose failure is unrecoverable. order_charges IS the billing
   * record, not a cache of one: a rate card whose effective_to was typed a year
   * early makes buildCharges emit nothing, the upsert writes nothing, and the
   * sweep then deletes every charge in the window for having a stale
   * calculated_at. Re-running cannot restore it, because the calculator that
   * produced nothing is precisely why it went.
   */
  it('refuses a sweep that would delete more than the run built', async () => {
    // Four historic charges on one order; this run prices none of them, because
    // its rate card covers nothing.
    h.db.tables.order_charges = [1, 2, 3, 4].map((n) => ({
      id: `c-hist-${n}`, order_id: 'order-a', charge_key: `item:h${n}:pick`,
      charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z',
    }))

    const result = await recalculateCharges(async () =>
      [order('order-a', { rateCard: [] })])

    expect(result).toMatchObject({ skipped: false, upserted: 0, deleted: 0 })
    // Four candidates, zero rows built: 4 > 0, so nothing was deleted and the
    // number is reported rather than swallowed.
    expect(result.skipped === false && result.staleDeleteRefused).toBe(4)
    // The history is still there. This is the assertion that would have caught
    // the original bug.
    expect(chargeKeysFor('order-a'))
      .toEqual(['item:h1:pick', 'item:h2:pick', 'item:h3:pick', 'item:h4:pick'])
  })

  it('records the refusal as a run failure, not a warning', async () => {
    // fail(), not warn(), for two reasons the code names: close() resolves
    // non-'ok', so the run's status carries the problem; and the throttle only
    // accepts a SUCCEEDED run, so a refusal cannot buy the next hour of
    // silence for itself.
    h.db.tables.order_charges = [1, 2].map((n) => ({
      id: `c-h-${n}`, order_id: 'order-a', charge_key: `item:h${n}:pick`,
      charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z',
    }))

    await recalculateCharges(async () => [order('order-a', { rateCard: [] })])

    const run = (h.db.tables.sync_runs as FakeRow[]).find((r) => r.source === 'charges')
    expect(run?.status).not.toBe('ok')
    const stored = (run?.errors ?? []) as Array<{ kind: string; context: string }>
    expect(stored.some((e) => e.kind === 'error' && e.context === 'stale-delete refused'))
      .toBe(true)
  })

  it('refuses when it cannot count the candidates at all', async () => {
    // "I could not check" is not "it is fine" — the same rule the run-lock read
    // follows. An unreadable count must not wave through the sweep the count
    // exists to stop.
    h.db.tables.order_charges = [
      { id: 'c-hist', order_id: 'order-a', charge_key: 'item:h:pick',
        charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]
    h.db.failOn = (call) =>
      call.table === 'order_charges' && call.verb === 'select' && call.count === 'exact'
        ? { message: 'statement timeout' }
        : null

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: false, deleted: 0 })
    // The stale row survives, and no delete was even attempted.
    expect(chargeKeysFor('order-a'))
      .toContain('item:h:pick')
    const deletes = h.db.calls.filter((c) =>
      c.table === 'order_charges' && c.verb === 'delete')
    expect(deletes).toEqual([])
  })

  it('still sweeps when the run built at least as much as it would remove', async () => {
    // The floor must not be so eager that ordinary recalculation stops working.
    // One historic charge, one charge built: 1 > 1 is false, so the sweep runs.
    h.db.tables.order_charges = [
      { id: 'c-hist', order_id: 'order-a', charge_key: 'item:gone:pick',
        charge_type: 'pick', amount: 5, calculated_at: '2020-01-01T00:00:00.000Z' },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: false, upserted: 1, deleted: 1 })
    expect(result.skipped === false && result.staleDeleteRefused).toBe(0)
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })

  /**
   * `built` exists only because it can differ from `upserted`, and the monitor
   * email quotes it as the threshold the floor compared against. If the two
   * were interchangeable the field would be noise; this pins the one case that
   * proves they are not. Reporting `upserted` here instead would have told the
   * operator the run built 0 rows on a run that built 1 — and sent them to
   * audit a rate card that was fine.
   */
  it('reports rows built separately from rows the database accepted', async () => {
    h.db.failOn = (call) =>
      call.table === 'order_charges' && call.verb === 'upsert'
        ? { message: 'deadlock detected' }
        : null

    const result = await recalculateCharges(async () => [order('order-a')])

    // One charge was calculated; none landed. Both numbers are reported, and
    // they disagree — which is the entire point of carrying `built` out.
    expect(result).toMatchObject({ skipped: false, built: 1, upserted: 0, failedOrders: 1 })
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

  it.each(['failed', 'partial'] as const)(
    'is not throttled by a charge run that finished %s', async (status) => {
      // THE PROPERTY: only a run that SUCCEEDED may satisfy the throttle.
      // sync-run.ts stamps finished_at on every close, so keying the throttle
      // off finished_at alone let a run that wrote nothing silence the next
      // hour of attempts — and monitor/route.ts reports a `throttled` skip as
      // healthy, so the email said "All clear" while the ledger stood still.
      // A failure makes the next attempt more urgent, not less.
      h.db.tables.sync_runs = [
        { id: 'r1', source: 'charges', status, finished_at: minutesAgo(10) },
      ]

      const result = await recalculateCharges(async () => [order('order-a')])

      expect(result.skipped).toBe(false)
      expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
    })

  it('is not throttled by a failed run even when an older run succeeded', async () => {
    // The read must not simply take the newest 'ok' row and ignore what came
    // after it either: here the last success is two hours old, so the run is
    // due on age alone. The point of the fixture is that the intervening
    // failure neither satisfies the throttle nor hides the older success.
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'ok', finished_at: minutesAgo(120) },
      { id: 'r2', source: 'charges', status: 'failed', finished_at: minutesAgo(5) },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
  })

  it('never throttles a scheduled cron run out', async () => {
    // THE PROPERTY: a browser-driven run must not consume the window a cron
    // was going to use. AutoSync polls every five minutes from every open tab,
    // so a 13:30 run sits comfortably inside the 60-minute window that the
    // 14:00 cron then falls in — and that scheduled run silently did not
    // happen. The crons are the system of record; they are never skipped.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T14:00:00.000Z'))   // a cron firing
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'ok',
        finished_at: '2026-09-30T13:30:00.000Z' },            // a browser poll
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result.skipped).toBe(false)
    expect(chargeKeysFor('order-a')).toEqual(['item:order-a-item:pick'])
  })

  it('still throttles when no scheduled firing has come round', async () => {
    // The control for the test above. Without it, "never throttled" could be
    // satisfied by a throttle that never throttles anything.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T14:30:00.000Z'))
    h.db.tables.sync_runs = [
      { id: 'r1', source: 'charges', status: 'ok',
        finished_at: '2026-09-30T14:10:00.000Z' },
    ]

    const result = await recalculateCharges(async () => [order('order-a')])

    expect(result).toMatchObject({ skipped: true, cause: 'throttled' })
    expect(charges()).toHaveLength(0)
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
    // Matched on status = 'running' specifically: the throttle read now also
    // filters on status, and failing both reads would prove the skip for the
    // wrong reason.
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'select'
        && call.filters.some((f) => f.op === 'eq' && f.column === 'status' && f.value === 'running')
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

describe('recalculateCharges — running it twice', () => {
  /**
   * SPEC §8 CALLS THIS THE SINGLE MOST IMPORTANT TEST IN THIS FILE, because
   * three crons a day make non-idempotency compound: a charge path that writes
   * a second row instead of updating the first inflates every margin figure by
   * a factor of however many times the cron has run since the order landed, and
   * it inflates them — the direction nobody reports, since this system detects
   * under-billing and negative margin but has no branch that detects
   * over-billing. Storage has had the equivalent test since it was written
   * (persist-storage-charges.test.ts); charges had the ingredients, in
   * charge_key determinism and the onConflict target, but never composed them.
   *
   * The second run has to get past the throttle, which is what kept this test
   * from existing: a naive second call returns `skipped`. Time is advanced past
   * CHARGE_THROTTLE_MINUTES rather than by a fixed number, so the test tracks
   * the constant instead of pinning a guess about it, and lands at 11:01 UTC —
   * still inside the 10:00-14:00 cron gap, so the scheduled-firing escape
   * hatch is not what is being exercised here.
   *
   * WHAT THE MUTATION CHECK ESTABLISHED. Both routes to the bug are now
   * covered. Making chargeKey non-deterministic turns this test red, which is
   * the failure it is named for.
   *
   * The second route — a typo in the `onConflict` target — used to be a stated
   * blind spot here, because fake-supabase matched conflict keys with
   * `valuesEqual(row[k], incoming[k])` and for a column neither side has that
   * is `undefined === undefined`. A misspelled target therefore matched the
   * first row in the table and the upsert still appeared to work, so this
   * test's green was evidence about charge_key and about nothing else. The
   * double now refuses a conflict target naming a key the payload does not
   * have (fake-supabase.ts, and its own tests under 'the onConflict target'),
   * which is also what real PostgREST does — 42703 for the unknown column, or
   * 42P10 when no unique index matches. Re-verified by mutation: changing
   * `onConflict: 'order_id,charge_key'` to `'order_id,chargekey'` in
   * persist-charges.ts turns this test red.
   */
  it('writes the same charges, not a second copy of them', async () => {
    const input = () => order('order-a', {
      rateCard: [pickRate, shipRate],
      shipments: [{ id: 's1', shipmentId: 5001, shipDate: '2026-09-02',
                    actualCost: 7.25, voided: false }],
    })

    const first = await recalculateCharges(async () => [input()])
    expect(first).toMatchObject({ skipped: false })

    const keysAfterFirst = chargeKeysFor('order-a')
    const sumAfterFirst = charges().reduce((s, c) => s + Number(c.amount ?? 0), 0)
    // Guard the guard: a test that compared two empty sets would pass whatever
    // the code did. This is the standing rule in its arithmetic dialect — an
    // assertion about a total is not an assertion until the total exists.
    expect(keysAfterFirst.length).toBeGreaterThan(0)
    expect(sumAfterFirst).toBeGreaterThan(0)

    vi.setSystemTime(new Date(Date.now() + (CHARGE_THROTTLE_MINUTES + 1) * 60_000))

    const second = await recalculateCharges(async () => [input()])

    // It actually ran. Without this the three assertions below would hold
    // trivially for a run that returned `skipped` and touched nothing — the
    // most likely way for this test to look green while testing nothing.
    expect(second).toMatchObject({ skipped: false })

    // Identical keys, identical count, identical money.
    expect(chargeKeysFor('order-a')).toEqual(keysAfterFirst)
    expect(charges()).toHaveLength(keysAfterFirst.length)
    expect(charges().reduce((s, c) => s + Number(c.amount ?? 0), 0)).toBe(sumAfterFirst)

    // And nothing was deleted. A non-deterministic charge_key would show up
    // here first: the second run would write new rows, find the first run's
    // rows stale, and report a delete. `deleted: 0` is what says the second run
    // recognised its own work rather than replacing it.
    expect(second.skipped === false && second.deleted).toBe(0)
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

describe('chargeRunIsDue', () => {
  const at = (iso: string) => new Date(iso)

  it('is due when nothing has ever succeeded', () => {
    expect(chargeRunIsDue(null, at('2026-09-30T09:00:00.000Z'))).toBe(true)
  })

  it('is due once the throttle window has elapsed', () => {
    expect(chargeRunIsDue(at('2026-09-30T08:00:00.000Z'), at('2026-09-30T09:00:00.000Z'))).toBe(true)
    expect(chargeRunIsDue(at('2026-09-30T08:01:00.000Z'), at('2026-09-30T09:00:00.000Z'))).toBe(false)
  })

  it('is due on a scheduled firing regardless of how recent the last success was', () => {
    // One minute apart, which no age-based throttle would ever let through.
    expect(chargeRunIsDue(at('2026-09-30T13:59:00.000Z'), at('2026-09-30T14:00:00.000Z'))).toBe(true)
  })

  it('crosses midnight — the 06:00 firing is a boundary against a 05:50 success', () => {
    // lastScheduledFiring must fall back to yesterday's last hour when today's
    // first has not come round, or the first cron of the day would be the one
    // firing that a late-night browser poll could always throttle out.
    expect(chargeRunIsDue(at('2026-09-30T05:50:00.000Z'), at('2026-09-30T06:00:00.000Z'))).toBe(true)
    expect(chargeRunIsDue(at('2026-09-30T04:00:00.000Z'), at('2026-09-30T04:30:00.000Z'))).toBe(false)
  })

  it('treats a future or unparseable last-success as due', () => {
    expect(chargeRunIsDue(at('2026-09-30T10:00:00.000Z'), at('2026-09-30T09:00:00.000Z'))).toBe(true)
    expect(chargeRunIsDue(at('not a date'), at('2026-09-30T09:00:00.000Z'))).toBe(true)
  })

  it('matches the schedule in vercel.json', async () => {
    // CRON COUPLING. An hour missing from CHARGE_CRON_HOURS_UTC is an hour
    // whose scheduled run can be throttled out by browser polling again, which
    // is the whole defect the schedule clause exists to close. Read from the
    // file rather than restated, so editing vercel.json alone fails here.
    const { readFile } = await import('node:fs/promises')
    const vercel = JSON.parse(await readFile('vercel.json', 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>
    }
    const hours = vercel.crons
      .filter((c) => c.path === '/api/agent/monitor')
      .map((c) => Number(c.schedule.split(' ')[1]))
      .sort((a, b) => a - b)

    expect(hours).toEqual([...CHARGE_CRON_HOURS_UTC].sort((a, b) => a - b))
  })
})
