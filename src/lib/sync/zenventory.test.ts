import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// Same subject as shipstation.test.ts -- the sync_runs row, not the order rows
// -- but the correct answer here is the opposite one. This function syncs every
// client in one pass, so a throw on client 2 of 8 must NOT abandon clients 3
// through 8; it is caught at the per-client boundary, exactly as the
// openSyncRun failure already was. What must not happen is that client 2's row
// is left at 'running', because close() is the only thing that writes the
// run's warn() records -- including 'undated picks', which is the only place a
// fortnight of unbillable picks is ever announced.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  getCustomerOrders: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/api/zenventory', () => ({ getCustomerOrders: h.getCustomerOrders }))

const { syncClientAssignments } = await import('@/lib/sync/zenventory')

const client = (id: string, name: string) => ({
  id, name, active: true,
  zenventory_api_key: `key-${id}`, zenventory_api_secret: `secret-${id}`,
})

const runs = () => (h.db.tables.sync_runs ?? []) as FakeRow[]
const runFor = (clientId: string) => {
  const rows = runs().filter((r) => r.client_id === clientId)
  expect(rows).toHaveLength(1)
  return rows[0]
}

/**
 * Makes every statement against `table` throw rather than return an error.
 *
 * PostgREST faults come back as an error OBJECT, which every call site in
 * zenventory.ts already handles. The uncaught case is the one that REJECTS:
 * a DNS failure, a dropped socket, a fetch that never resolves into a
 * response. A synchronous throw from .from() stands in for that -- it reaches
 * the same catch by the same path, and it does not require faking the
 * internals of fetch to produce.
 */
function throwOn(table: string, message: string) {
  const real = h.db.client.from.bind(h.db.client)
  h.db.client.from = ((t: string) => {
    if (t === table) throw new TypeError(message)
    return real(t)
  }) as typeof h.db.client.from
}

beforeEach(() => {
  h.db = createFakeSupabase({
    clients: [], sync_runs: [], orders: [], order_items: [], shipments: [],
  })
  h.getCustomerOrders.mockReset()
  h.getCustomerOrders.mockResolvedValue({
    customerOrders: [{ orderNumber: 'A-1', orderDate: '2026-09-01', items: [] }],
    meta: { totalPages: 1 },
  })
})

describe('syncClientAssignments: a throw closes the row and spares the other clients', () => {
  it('closes the failing client\'s run row instead of leaving it running', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    throwOn('shipments', 'fetch failed')

    await expect(syncClientAssignments(30)).rejects.toThrow(/every client/)

    for (const id of ['c1', 'c2']) {
      const run = runFor(id)
      expect(run.status).not.toBe('running')
      expect(run.finished_at).toBeTruthy()
    }
  })

  it('records the throw on the row, so a dead run is not closed as ok', async () => {
    h.db.tables.clients = [client('c1', 'Nayax')]
    throwOn('shipments', 'fetch failed')

    await expect(syncClientAssignments(30)).rejects.toThrow()

    const run = runFor('c1')
    // close() picks the status from the error list. fail() must therefore run
    // BEFORE it, or this row closes 'ok' over a client that never synced.
    expect(run.status).toBe('failed')
    const errors = run.errors as Array<{ kind: string; message: string }>
    expect(errors.some((e) => e.kind === 'error' && e.message.includes('fetch failed')))
      .toBe(true)
  })

  it('does not abandon the clients after the one that threw', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    // Only the first client's work explodes; the second must still be attempted.
    let seen = 0
    const real = h.db.client.from.bind(h.db.client)
    h.db.client.from = ((t: string) => {
      if (t === 'shipments' && ++seen === 1) throw new TypeError('fetch failed')
      return real(t)
    }) as typeof h.db.client.from

    const result = await syncClientAssignments(30)

    expect(result.clients_failed).toBe(1)
    expect(result.clients_synced).toBe(1)
    expect(result.errors.join(' ')).toContain('Nayax')
    // The second client reached the end of its own body and closed clean. If
    // the throw had propagated out of the loop there would be no row at all.
    expect(runFor('c2').status).toBe('ok')
  })

  it('still closes a clean client as ok, so the finally has not flattened everything to failed', async () => {
    h.db.tables.clients = [client('c1', 'Nayax')]

    await expect(syncClientAssignments(30)).resolves.toMatchObject({ clients_failed: 0 })

    expect(runFor('c1').status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// SPEC §8: "Running the sync twice over the same window changes no row count.
// The single most important test in this file: three crons a day make
// non-idempotency compound."
//
// This is the orders/order_items half. It is the half that rests entirely on
// two onConflict targets -- 'client_id,order_key' and
// 'order_id,source,line_ordinal' -- and until fake-supabase.ts was hardened
// this session, a mangled target was INVISIBLE to a test: the double matched on
// `valuesEqual(row[k], incoming[k])`, and for a column neither side has that is
// `undefined === undefined`, so a misspelled target matched the first row in
// the table and the upsert still looked like it worked. The double now refuses
// a target naming a key the payload lacks, which is what makes the row counts
// below mean anything.
//
// The second run is not a formality here. It is the run that first HAS a
// usable watermark, because run one left an 'ok' sync_runs row seconds ago --
// so it is the run with both the means and the opportunity to date a pick that
// run one honestly declined to date. See the sticky-null test.
// ---------------------------------------------------------------------------
const orders = () => (h.db.tables.orders ?? []) as FakeRow[]
const items = () => (h.db.tables.order_items ?? []) as FakeRow[]

/** One Zenventory order with `lines` picked lines, in the real payload shape. */
const payload = (orderNumber: string, lines: Array<Record<string, unknown>>) => ({
  customerOrders: [{
    orderNumber, orderDate: '2026-09-01', items: lines,
  }],
  meta: { totalPages: 1 },
})

describe('syncClientAssignments: running it twice over the same window', () => {
  beforeEach(() => {
    h.db.tables.clients = [client('c1', 'Nayax')]
  })

  it('changes no row count, for orders or for order_items', async () => {
    h.getCustomerOrders.mockResolvedValue(payload('A-1', [
      { sku: 'WIDGET', quantityOrdered: 2, quantityPicked: 2 },
      { sku: 'GIZMO', quantityOrdered: 1, quantityPicked: 1 },
    ]))

    await syncClientAssignments(30)
    // Guard the guard: one order and two items would be satisfied by every
    // assertion below even if the second run did nothing at all, so the first
    // run's counts are asserted before the second one is allowed to matter.
    expect(orders()).toHaveLength(1)
    expect(items()).toHaveLength(2)

    await syncClientAssignments(30)

    expect(orders()).toHaveLength(1)
    expect(items()).toHaveLength(2)
    // And the second run closed clean. A run that errored on both upserts would
    // also leave the counts untouched -- the same green over a dead sync.
    expect(runs().filter((r) => r.status === 'ok')).toHaveLength(2)
  })

  it('treats an order number differing only in case as the same order', async () => {
    // This is what order_key is FOR: it is `orderNumber.toUpperCase()`, while
    // order_number keeps what the API sent. Zenventory has returned both
    // casings for one order, and without the key the second casing is a second
    // order -- two orders billed for one, and the pick charges split across
    // them so neither looks wrong on its own.
    h.getCustomerOrders.mockResolvedValueOnce(
      payload('a-1', [{ sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 1 }]))
    await syncClientAssignments(30)
    expect(orders()).toHaveLength(1)

    h.getCustomerOrders.mockResolvedValueOnce(
      payload('A-1', [{ sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 1 }]))
    await syncClientAssignments(30)

    expect(orders()).toHaveLength(1)
    expect(orders()[0].order_key).toBe('A-1')
    expect(items()).toHaveLength(1)
  })

  it('keeps a line undated when the first run found its date unknowable', async () => {
    // THE STICKY NULL, and the reason the second run is the dangerous one.
    //
    // Run one is a first run for this client: there is no previous 'ok'
    // sync_runs row, so watermarkIsEvidence() is false and the picked line is
    // written pick_date null / pick_date_source 'unknown' -- a recorded
    // "we looked, and it is unknowable", not a gap.
    //
    // Run two finds run one's row finished seconds ago, so the watermark IS now
    // usable. Without `&& pickSource !== 'unknown'` it would stamp TODAY on a
    // pick that happened during an outage of unknown length, and because
    // pick_date is set once and never moved, that fabricated date is permanent.
    // A fortnight of backlogged picks would land on one day: an invented labour
    // spike there and an invented drought before it, in the one report that
    // exists to make cost per pick legible over time.
    h.getCustomerOrders.mockResolvedValue(payload('A-1', [
      { sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 1 },
    ]))

    await syncClientAssignments(30)
    expect(items()[0].pick_date).toBeNull()
    expect(items()[0].pick_date_source).toBe('unknown')

    await syncClientAssignments(30)

    expect(items()).toHaveLength(1)
    expect(items()[0].pick_date).toBeNull()
    expect(items()[0].pick_date_source).toBe('unknown')
    // is_estimate must stay false too: a watermark date is an estimate and is
    // flagged as one, but an UNKNOWN date is not an estimate of anything, and
    // the charge calculator skips the line entirely rather than estimating it.
    expect(items()[0].is_estimate).toBe(false)
  })

  it('reports undated picks as a per-run DELTA, not a standing count', async () => {
    // Written the other way round first, asserting 1 on both runs, on the
    // reasoning that a degraded state has to keep announcing itself. It failed,
    // and the design is right and the test was wrong -- recorded here because
    // the failing version is the one a reader will be tempted to restore.
    //
    // undatedPicks++ sits in the branch the sticky 'unknown' marker skips, so
    // it counts lines THIS PASS declined to date and reads zero afterwards. The
    // standing count deliberately lives elsewhere: step 4e of
    // src/app/api/agent/monitor/route.ts scans order_items for
    // `pick_date is null and quantity_picked > 0`, with no window.
    //
    // That is the better home, and not merely a different one. The monitor keys
    // on the CONDITION rather than the marker, so it clears itself the moment a
    // human supplies a date; a standing counter in here keyed on the marker
    // would keep alerting after the money became billable, which is how a true
    // alert turns into furniture. Two standing counts would also disagree the
    // first time one of them changed.
    //
    // So this asserts the delta ON PURPOSE. Making it a gauge here reports the
    // undated backlog twice, and the obvious next step after that is deleting
    // the monitor scan as redundant -- which would move the one standing
    // detector of unbillable picked work into a sync result that nothing
    // retains. Note what is NOT a fallback: leaks_monthly cannot see these
    // lines at all. Both picked_never_billed and pick_days filter on
    // `oi.pick_date is not null`, and calculate-charges skips an undated line,
    // so the monitor scan is the ONLY thing anywhere that reports them.
    h.getCustomerOrders.mockResolvedValue(payload('A-1', [
      { sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 1 },
    ]))

    const first = await syncClientAssignments(30)
    const second = await syncClientAssignments(30)

    expect(first.undated_picks).toBe(1)
    expect(second.undated_picks).toBe(0)

    // The row is still undated, which is what makes the zero above a delta and
    // not a resolution. This is exactly the state the monitor scan looks for.
    expect(items()[0].pick_date).toBeNull()
    expect(items()[0].quantity_picked).toBe(1)
  })

  it('does not leave a second row behind when a line stops being picked', async () => {
    // An unpick is an update to the SAME line, keyed on line_ordinal, not a new
    // line. If it inserted instead, the order would hold two rows for ordinal 1
    // -- one picked, one not -- and the pick charge would be raised off
    // whichever the calculator read first.
    h.getCustomerOrders.mockResolvedValueOnce(payload('A-1', [
      { sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 1 },
    ]))
    await syncClientAssignments(30)
    expect(items()).toHaveLength(1)

    h.getCustomerOrders.mockResolvedValueOnce(payload('A-1', [
      { sku: 'WIDGET', quantityOrdered: 1, quantityPicked: 0 },
    ]))
    await syncClientAssignments(30)

    expect(items()).toHaveLength(1)
    expect(items()[0].quantity_picked).toBe(0)
    // Both cleared together. Leaving pick_date_source 'unknown' on a line that
    // is no longer picked would block the watermark on a later healthy run that
    // had every right to write it.
    expect(items()[0].pick_date).toBeNull()
    expect(items()[0].pick_date_source).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// THE GAP BETWEEN THE ROW AND THE REPORT.
//
// close() resolves the status from the error count, so one run.fail() closes
// the row 'failed' or 'partial'. But the only per-client failure signal the
// caller got was `clients_failed: clientErrors.length`, and the per-item
// fail() sites did not touch clientErrors -- so a run that lost orders or
// shipment assignments returned clients_failed 0, api/agent/monitor/route.ts
// pushed nothing into errors[], has_issues came back false and the dashboard
// indicator went green over a row that says 'failed'. Observed in production
// on 2026-10-03 ~08:07 UTC: status 'failed', error_count 1, context
// 'shipment lookup #2500-2'.
//
// These tests are written against the RETURN VALUE as well as the row,
// because the row was already right. The bug was entirely in what the caller
// could see, so a test that only inspects sync_runs cannot detect it.
// ---------------------------------------------------------------------------
describe('syncClientAssignments: per-item failures reach the caller', () => {
  beforeEach(() => {
    h.db.tables.clients = [client('c1', 'Nayax')]
  })

  const failShipments = (verb: 'select' | 'update') => {
    h.db.failOn = (call) =>
      call.table === 'shipments' && call.verb === verb
        ? { message: 'permission denied for table shipments' }
        : null
  }

  it('reports a failed shipment lookup, which clients_failed cannot see', async () => {
    failShipments('select')

    const result = await syncClientAssignments(30)

    // Both halves of the production contradiction, asserted together: the row
    // knows it failed...
    expect(runFor('c1').status).toBe('failed')
    expect((runFor('c1').errors as Array<{ context: string }>)[0].context)
      .toBe('shipment lookup A-1')
    // ...and the whole-client count says nothing is wrong, which is the number
    // the monitor was reading. This stays 0 ON PURPOSE -- the client synced.
    expect(result.clients_failed).toBe(0)
    // items_failed is the signal that was missing, and it names the order so
    // the alert can say which one rather than only how many.
    expect(result.items_failed).toBe(1)
    expect(result.item_failures).toEqual(['Nayax: shipment lookup A-1'])
  })

  it('reports a failed assignment, and the shipment is left with no client to bill', async () => {
    h.db.tables.shipments = [{ id: 's1', order_number: 'A-1', client_id: null }]
    failShipments('update')

    const result = await syncClientAssignments(30)

    expect(result.items_failed).toBe(1)
    expect(result.item_failures[0]).toContain('assign shipment A-1')
    // The money consequence the alert names, asserted rather than asserted
    // about: the shipment still has no client, so nothing can invoice it, and
    // `updated` correctly does not count the update that never happened.
    expect(h.db.tables.shipments[0].client_id).toBeNull()
    expect(result.updated).toBe(0)
  })

  it('reports a failed order upsert, not only the shipment-loop failures', async () => {
    // A second, distant fail() site. Pairing only the two sites in the
    // assignment loop would leave the order loop silent again, and an order
    // that was not recorded raises no pick or pack charge at all.
    h.db.failOn = (call) =>
      call.table === 'orders' && call.verb === 'upsert'
        ? { message: 'deadlock detected' }
        : null

    const result = await syncClientAssignments(30)

    expect(result.items_failed).toBe(1)
    expect(result.item_failures).toEqual(['Nayax: order A-1'])
    expect(runFor('c1').status).toBe('failed')
  })

  it('does not also count a pagination failure, which clients_failed already reports', async () => {
    // Two clients, because one failing client out of one throws.
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    h.getCustomerOrders.mockReset()
    h.getCustomerOrders
      .mockRejectedValueOnce(new Error('401 Unauthorized'))
      .mockResolvedValue({
        customerOrders: [{ orderNumber: 'A-1', orderDate: '2026-09-01', items: [] }],
        meta: { totalPages: 1 },
      })

    const result = await syncClientAssignments(30)

    // The 401 is a whole-client event: it pushes clientErrors, so route.ts
    // already alerts on it. Counting it in items_failed as well would turn one
    // incident into two alerts -- the doubling route.ts avoids explicitly when
    // the storage block declines to re-report a skipped charge run.
    expect(result.clients_failed).toBe(1)
    expect(result.items_failed).toBe(0)
    expect(result.item_failures).toEqual([])
    expect(runFor('c1').status).toBe('failed')
  })

  it('does not also count the per-client catch, for the same reason', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    let seen = 0
    const real = h.db.client.from.bind(h.db.client)
    h.db.client.from = ((t: string) => {
      if (t === 'shipments' && ++seen === 1) throw new TypeError('fetch failed')
      return real(t)
    }) as typeof h.db.client.from

    const result = await syncClientAssignments(30)

    expect(result.clients_failed).toBe(1)
    expect(result.items_failed).toBe(0)
  })

  it('caps the names it returns without capping the count', async () => {
    h.getCustomerOrders.mockResolvedValue({
      customerOrders: Array.from({ length: 15 }, (_, i) => ({
        orderNumber: `A-${i + 1}`, orderDate: '2026-09-01', items: [],
      })),
      meta: { totalPages: 1 },
    })
    failShipments('select')

    const result = await syncClientAssignments(30)

    // The count is the figure and the list is examples. Capping the count would
    // under-report the money; an uncapped list would put fifteen lines of
    // near-identical prose in the alert email that has to stay readable.
    expect(result.items_failed).toBe(15)
    expect(result.item_failures).toHaveLength(10)
  })
})

// ---------------------------------------------------------------------------
// Losing a per-client sync_runs lock.
//
// This loop is sequential, so a client can never collide with itself -- a lock
// conflict here means a SECOND invocation of syncClientAssignments is in flight
// for the same client, and that invocation is mid-sync and will write
// everything this one would have. So it is recorded, and it is not a failure.
describe('syncClientAssignments: a client whose lock is already held', () => {
  /** Fail the sync_runs INSERT for one client only, leaving the reap alone. */
  const lockOut = (clientId: string | null) => {
    h.db.failOn = (call) => {
      if (call.table !== 'sync_runs' || call.verb !== 'insert') return null
      if (clientId !== null && call.payload[0]?.client_id !== clientId) return null
      return {
        code: '23505',
        message: 'duplicate key value violates unique constraint '
               + '"sync_runs_running_source_client_key"',
      }
    }
  }

  it('does not report the locked client as an error', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut('c1')

    const result = await syncClientAssignments(30)

    // errors[] feeds the 🚨 alert email, naming the clients that did not sync.
    // Naming a client that is at this moment syncing correctly in the sibling
    // run is a false alarm, and the monitor runs every five minutes.
    expect(result.clients_failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('counts it as locked, and names it', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut('c1')

    const result = await syncClientAssignments(30)

    expect(result.clients_locked).toBe(1)
    expect(result.locked_clients).toEqual(['Nayax'])
  })

  // The assertion that makes the two above safe. clients_synced is computed by
  // subtraction, so a locked client that was only kept out of clientErrors
  // would be COUNTED AS SYNCED -- and in the realistic case, where a whole
  // second invocation races the first, every client is locked and the run
  // would report a full clean pass having touched nothing. That is a worse lie
  // than the false alarm it was avoiding.
  it('does not count a locked client as synced', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut('c1')

    const result = await syncClientAssignments(30)

    expect(result.clients_synced).toBe(1)
  })

  it('reports nothing synced when every client is locked, and does not throw', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut(null)

    const result = await syncClientAssignments(30)

    expect(result.clients_synced).toBe(0)
    expect(result.clients_locked).toBe(2)
    expect(result.clients_failed).toBe(0)
  })

  // One client's lock must not abandon the rest -- the same guarantee the 401s
  // already have. Zenventory 2.0 credentials are missing for two clients today,
  // so a partial pass is the normal state here, not an edge case.
  it('still syncs the other clients', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut('c1')

    await syncClientAssignments(30)

    expect(runs().filter((r) => r.client_id === 'c2')).toHaveLength(1)
    expect(runFor('c2').status).toBe('ok')
  })

  // Nothing is written for the locked client. If a row survived, the next run's
  // watermark read would see it, and every overlap would leave a permanent
  // 'failed' row behind.
  it('leaves no run row behind for the locked client', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    lockOut('c1')

    await syncClientAssignments(30)

    expect(runs().filter((r) => r.client_id === 'c1')).toHaveLength(0)
  })

  // Only 23505 is a lock. Any other failure to open the row is still a failed
  // client, because attributable failure is the entire reason the per-client
  // rows exist.
  it('a non-lock failure to open the row is still a failed client', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'insert'
        && call.payload[0]?.client_id === 'c1'
        ? { code: '42501', message: 'permission denied for table sync_runs' }
        : null

    const result = await syncClientAssignments(30)

    expect(result.clients_failed).toBe(1)
    expect(result.clients_locked).toBe(0)
    expect(result.errors[0]).toContain('Nayax')
  })
})

// One client can fail TWICE in a single pass, and until 2026-10-05 that made
// the client counts arithmetically impossible rather than merely wrong.
//
// The route: page 1 of the order list succeeds, page 2 rejects (failure #1,
// which `break`s out of pagination), execution carries on into the shipment
// assignment loop with the partial order list, and that throws (failure #2, via
// the per-client catch). Both are real, distinct failures and both SHOULD be
// recorded. What must not happen is that the client is COUNTED twice, because
// clients_failed was the length of a message list and clients_synced was
// computed by subtracting it.
//
// Every assertion below is on a count, not a message, for that reason: the
// messages were never the bug.
describe('syncClientAssignments: a client that fails twice in one pass', () => {
  // Page 1 ok with more pages promised, page 2 rejects, then the first
  // shipments statement throws -- which lands on whichever client is processed
  // first, so c1 double-fails and the rest of the list is untouched.
  const doubleFailFirstClient = () => {
    h.getCustomerOrders.mockReset()
    h.getCustomerOrders
      .mockResolvedValueOnce({
        customerOrders: [{ orderNumber: 'A-1', orderDate: '2026-09-01', items: [] }],
        meta: { totalPages: 2 },
      })
      .mockRejectedValueOnce(new Error('page 2 died'))
      .mockResolvedValue({
        customerOrders: [{ orderNumber: 'B-1', orderDate: '2026-09-01', items: [] }],
        meta: { totalPages: 1 },
      })

    let seen = 0
    const real = h.db.client.from.bind(h.db.client)
    h.db.client.from = ((t: string) => {
      if (t === 'shipments' && ++seen === 1) throw new TypeError('fetch failed')
      return real(t)
    }) as typeof h.db.client.from
  }

  it('counts it once, not once per failure', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()

    const result = await syncClientAssignments(30)

    // Was 2 before the fix: one client, counted once per error message.
    expect(result.clients_failed).toBe(1)
  })

  it('does not lose the client that did sync from clients_synced', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()

    const result = await syncClientAssignments(30)

    // Was 0 before the fix -- 2 clients minus 2 "failures" -- which erased
    // Creative Pea, a client that synced perfectly well, from the only number
    // the monitor uses to say how many clients a pass covered.
    expect(result.clients_synced).toBe(1)
  })

  it('never reports more failed clients than there are clients', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()

    const result = await syncClientAssignments(30)

    // The invariant the old code could violate, stated directly: these three
    // partition the client list, so they cannot sum to more than it or imply a
    // negative. Asserted as arithmetic rather than as literals so this keeps
    // its teeth if the scenario above ever drifts.
    const { clients_synced: synced, clients_failed: failed, clients_locked: locked } = result
    expect(synced).toBeGreaterThanOrEqual(0)
    expect(failed).toBeLessThanOrEqual(h.db.tables.clients.length)
    expect(synced + failed + locked).toBe(h.db.tables.clients.length)
  })

  it('still records both failures, because two things really did go wrong', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()

    const result = await syncClientAssignments(30)

    // Deliberately NOT deduped. The count is the figure and the list is the
    // examples -- the same split items_failed/item_failures already uses, where
    // the list is capped at ten and the count stays complete. Collapsing these
    // to one message would throw away the fact that the pagination failure is
    // what left the order list partial, which is the more useful half.
    expect(result.errors).toHaveLength(2)
    expect(result.errors.join(' ')).toContain('page 2 died')
    expect(result.errors.join(' ')).toContain('fetch failed')
  })

  it('records both failures on the client\'s sync_runs row too', async () => {
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()

    await syncClientAssignments(30)

    // run.fail() is still called per failure, not per client. The row is the
    // forensic record and both contexts belong on it; it is only the CALLER's
    // client count that had to become per-client.
    const errors = runFor('c1').errors as Array<{ context: string }>
    expect(errors).toHaveLength(2)
    expect(errors.map((e) => e.context)).toEqual([
      'pagination page 2',
      'zenventory sync for Nayax',
    ])
  })

  it('throws when the only client failed, even though it failed twice', async () => {
    // The consequence that mattered most, and the reason this was worth fixing
    // rather than noting. The all-failed guard is what turns "nothing worked"
    // into a thrown error, which is what the monitor route and the 🚨 alert
    // email actually report. Comparing a message count to a client count made
    // it 2 !== 1, so the one pass where the ONLY client failed completely
    // returned NORMALLY -- silence on a total outage.
    h.db.tables.clients = [client('c1', 'Nayax')]
    doubleFailFirstClient()

    await expect(syncClientAssignments(30)).rejects.toThrow(/failed for every client/)
  })

  it('counts a double failure and a locked client without double-subtracting', async () => {
    // Set-counted failures and locked clients have to stay disjoint, since both
    // are subtracted from clients_synced. c1 double-fails, c2 is locked out by
    // a sibling run, nothing synced -- and that is 0, not a negative.
    h.db.tables.clients = [client('c1', 'Nayax'), client('c2', 'Creative Pea')]
    doubleFailFirstClient()
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'insert'
        && call.payload[0]?.client_id === 'c2'
        ? { code: '23505', message: 'duplicate key value violates unique constraint' }
        : null

    const result = await syncClientAssignments(30)

    expect(result.clients_failed).toBe(1)
    expect(result.clients_locked).toBe(1)
    expect(result.clients_synced).toBe(0)
  })
})
