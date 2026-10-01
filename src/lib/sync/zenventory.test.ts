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
