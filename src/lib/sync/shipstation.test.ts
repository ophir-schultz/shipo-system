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
  h.db = createFakeSupabase({ sync_runs: [], shipments: [], carriers: [] })
  h.getShipments.mockReset()
})

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
