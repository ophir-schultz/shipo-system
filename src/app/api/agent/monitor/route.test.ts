import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

// THE ROUTE HANDLER ITSELF, not a function extracted from it.
//
// The gap this file guards was not a wrong calculation. Every part was already
// correct in isolation: the sync counted its per-item failures, close() put the
// row at 'failed', and the monitor reported what it was given. The defect lived
// in the WIRING — `items_failed` existed on one side of a call and nothing read
// it on the other — and a test of any single piece would have passed while the
// dashboard was green over a failed run (production, 2026-10-03 ~08:07 UTC:
// status 'failed', error_count 1, context 'shipment lookup #2500-2',
// has_issues false).
//
// So the subject here is the response body, and specifically has_issues: the
// field the AutoSync widget colours its indicator from. `clientResult` is typed
// `any` in the handler, so tsc cannot catch a renamed key on this seam either;
// this file is the only thing that can.
//
// Everything the handler calls is mocked to a clean, quiet default, so the ONLY
// thing that can put an entry in errors[] is the mocked sync result under test.
// That is what makes the negative control below meaningful.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  syncShipments: vi.fn(),
  syncClientAssignments: vi.fn(),
  sendEmail: vi.fn(),
  requireStaffOrCron: vi.fn(),
  recalculateShipments: vi.fn(),
  recalculateCharges: vi.fn(),
  loadChargeInputs: vi.fn(),
  persistStorageCharges: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/sync/shipstation', () => ({ syncShipments: h.syncShipments }))
vi.mock('@/lib/sync/zenventory', () => ({ syncClientAssignments: h.syncClientAssignments }))
vi.mock('@/lib/email', () => ({ sendEmail: h.sendEmail }))
vi.mock('@/lib/require-staff', () => ({ requireStaffOrCron: h.requireStaffOrCron }))
vi.mock('@/lib/billing/recalculate', () => ({ recalculateShipments: h.recalculateShipments }))
vi.mock('@/lib/ledger/persist-charges', () => ({ recalculateCharges: h.recalculateCharges }))
vi.mock('@/lib/ledger/load-charge-inputs', () => ({ loadChargeInputs: h.loadChargeInputs }))
vi.mock('@/lib/ledger/persist-storage-charges', () => ({
  persistStorageCharges: h.persistStorageCharges,
}))

const { GET } = await import('@/app/api/agent/monitor/route')

/** A sync result with nothing wrong with it. Spread and override per test. */
const cleanClientResult = {
  clients_synced: 8,
  clients_failed: 0,
  updated: 12,
  errors: [],
  items_failed: 0,
  item_failures: [],
  undated_picks: 0,
}

interface MonitorBody {
  ok: boolean
  has_issues: boolean
  errors: string[]
  log: string[]
  email: { subject?: string }
}

const run = async (clientResult: Record<string, unknown>): Promise<MonitorBody> => {
  h.syncClientAssignments.mockResolvedValue(clientResult)
  const res = await GET(new Request('https://shipo.test/api/agent/monitor'))
  return res.json() as Promise<MonitorBody>
}

beforeEach(() => {
  // Empty tables, so all five scans in section 4 answer zero rather than
  // erroring. A scan that failed would push into errors[] and make every
  // has_issues assertion below pass for the wrong reason.
  h.db = createFakeSupabase({ shipments: [], rate_adjustments: [], order_items: [] })

  h.requireStaffOrCron.mockReset().mockResolvedValue(null)
  h.syncShipments.mockReset().mockResolvedValue({
    created: 0, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
  })
  h.recalculateShipments.mockReset().mockResolvedValue({
    updated: 0, zone_matched: 0, legacy_matched: 0, unmatched: 0,
    skipped: 0, failed: 0, reasons: [],
  })
  // Throttled, which is the one skip cause the handler deliberately does NOT
  // treat as an issue — and it also gates off step 3c, so the storage block
  // cannot contribute an error either.
  h.recalculateCharges.mockReset().mockResolvedValue({
    skipped: true, cause: 'throttled', reason: 'ran 2 minutes ago',
  })
  h.loadChargeInputs.mockReset()
  h.persistStorageCharges.mockReset()
  h.syncClientAssignments.mockReset()
  h.sendEmail.mockReset().mockResolvedValue({ sent: true, provider: 'resend' })
})

describe('GET /api/agent/monitor: per-item sync failures reach has_issues', () => {
  it('reports no issues when the sync is clean (the negative control)', async () => {
    // Guard-the-guard. Without this, the test below could pass because some
    // unrelated mock is dirty and errors[] is never empty — which would make
    // the whole file vacuous. Everything downstream depends on this being
    // genuinely quiet.
    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
    expect(body.log).toContain('✓ Client mapping: 12 shipments assigned')
  })

  it('sets has_issues on items_failed alone, with clients_failed still zero', async () => {
    // THE PRODUCTION CASE, end to end. One lost shipment assignment inside a
    // client that otherwise synced: clients_failed is 0, which is what used to
    // be the only signal read here, and the response said all clear.
    const body = await run({
      ...cleanClientResult,
      items_failed: 1,
      item_failures: ['Nayax: shipment lookup #2500-2'],
    })

    expect(body.has_issues).toBe(true)
    const err = body.errors.find((e) => e.includes('Zenventory item'))
    expect(err).toBeDefined()
    // The context, not just the count: '1' sends the reader to the sync_runs
    // table to find out WHICH, and the alert already knows.
    expect(err).toContain('Nayax: shipment lookup #2500-2')
    // The money consequence, in the voice of the surrounding pushes.
    expect(err).toContain('NO CLIENT')
    expect(err).toMatch(/item could not be/)
  })

  it('reports a failed client and failed items as two distinct issues, each once', async () => {
    // The two counts answer different questions, so folding items_failed into
    // clients_failed would both misreport the client and lose the detail. The
    // length assertion is the half that matters: it is what fails if a future
    // change reports one incident through both branches.
    const body = await run({
      ...cleanClientResult,
      clients_failed: 1,
      errors: ['Creative Pea: 401 Unauthorized'],
      items_failed: 2,
      item_failures: ['Nayax: order A-1', 'Nayax: shipment lookup A-2'],
    })

    expect(body.errors).toHaveLength(2)
    expect(body.errors.filter((e) => e.includes('did not sync'))).toHaveLength(1)
    expect(body.errors.filter((e) => e.includes('Zenventory item'))).toHaveLength(1)
    expect(body.has_issues).toBe(true)
  })

  it('withholds the green tick from the run log, which is what a person reads', async () => {
    // errors[] drives the alert; the log line is what someone scrolls to when
    // deciding whether a run was healthy. A ✓ beside a stage that lost two
    // items is the same false claim one layer down, and this route's header is
    // a post-mortem on exactly that.
    const body = await run({
      ...cleanClientResult,
      items_failed: 2,
      item_failures: ['Nayax: order A-1', 'Nayax: order A-2'],
    })

    const line = body.log.find((l) => l.includes('Client mapping'))
    expect(line).toBe('⚠ Client mapping: 12 shipments assigned · 2 items FAILED')
  })

  it('escalates the email subject, so the alert actually leaves the building', async () => {
    // has_issues colours a dashboard somebody has to be looking at. The 🚨
    // subject is what reaches Ophir on a Sunday, and it is derived from the
    // same errors[] — so this pins the consequence, not a second copy of the
    // same condition.
    await run({
      ...cleanClientResult,
      items_failed: 1,
      item_failures: ['Nayax: shipment lookup #2500-2'],
    })

    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    expect(h.sendEmail.mock.calls[0][0].subject).toMatch(/^🚨 Shipo Monitor — 1 issue need/)
  })
})

// ---------------------------------------------------------------------------
// A pass that stepped aside, reported as such.
//
// Both syncs can now lose the sync_runs lock to a concurrent invocation, and
// this route is where that becomes visible to a person. The failure mode this
// guards is specific: a skipped pass returns the SAME all-zero counters a pass
// with nothing to do returns, so without an explicit flag the handler prints
// the same green line for each — and `✓ ShipStation sync: 0 new` read as
// evidence of health is the precise mistake the rest of this file is a
// post-mortem on.
describe('GET /api/agent/monitor: a sync that skipped on the lock', () => {
  it('says the ShipStation sync was skipped, rather than ticking a zero pass', async () => {
    h.syncShipments.mockResolvedValue({
      created: 0, updated: 0, adjustments: 0, refunds: 0,
      errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
      skipped: true, skipReason: 'another run of this source is already in progress',
    })

    const body = await run(cleanClientResult)

    expect(body.log.some((l) => l.includes('ShipStation sync skipped'))).toBe(true)
    expect(body.log.some((l) => l.startsWith('✓ ShipStation sync:'))).toBe(false)
  })

  // Not an issue, and this is the half that matters. A lost lock means a
  // SIBLING run is doing the work, so nothing is missing. The monitor fires on
  // a cron and from every open browser tab every five minutes, so treating
  // routine overlap as an issue would be an alert nobody reads within a day.
  it('does not treat a skipped ShipStation sync as an issue', async () => {
    h.syncShipments.mockResolvedValue({
      created: 0, updated: 0, adjustments: 0, refunds: 0,
      errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
      skipped: true, skipReason: 'another run of this source is already in progress',
    })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
  })

  it('names the clients whose per-client lock was already held', async () => {
    const body = await run({
      ...cleanClientResult,
      clients_synced: 6,
      clients_locked: 2,
      locked_clients: ['Nayax', 'Creative Pea'],
    })

    const line = body.log.find((l) => l.includes('Client mapping'))
    expect(line).toContain('2 skipped')
    expect(line).toContain('Nayax')
    // Still a tick: locked is not failed, and the line must not acquire a ⚠.
    expect(line!.startsWith('✓')).toBe(true)
    expect(body.has_issues).toBe(false)
  })

  // The negative control for both of the above. Without it, a handler that
  // ALWAYS printed 'skipped' would pass every assertion in this block.
  it('an ordinary pass is still reported as an ordinary pass', async () => {
    const body = await run(cleanClientResult)

    // Scoped to the two lines this block changed. The charge stage prints its
    // own 'skipped' on the throttle -- a different thing entirely, and the
    // default in this file's beforeEach -- so a bare search for the word would
    // fail here for a reason that has nothing to do with the lock.
    expect(body.log.some((l) => l.includes('ShipStation sync skipped'))).toBe(false)
    expect(body.log.some((l) => l.startsWith('✓ ShipStation sync:'))).toBe(true)
    expect(body.log.find((l) => l.includes('Client mapping'))).not.toContain('skipped')
  })
})

// syncShipments assigns client_id from client_store_ids, and returns six
// counters saying what happened. This block is about which of them wake
// somebody up, because that decision is the entire value of the counters: a
// finding that lands in log[] on a route nobody reads the log of has not been
// reported, and a finding that lands in errors[] every eight hours forever
// stops being read at all. Both failure modes are already documented in
// route.ts, and this is where the split is held still.
//
// The default syncShipments mock in beforeEach omits all six fields, so every
// test here opts in explicitly and the negative control above stays clean.
const attributing = (over: Record<string, unknown>) => {
  h.syncShipments.mockResolvedValue({
    created: 3, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
    attributed: 0, unmappedStore: 0, unmappedStoreIds: [],
    noStoreId: 0, attributionConflicts: 0, storeMapUnavailable: false,
    ...over,
  })
}

describe('GET /api/agent/monitor: what the attribution counters escalate', () => {
  // THE DEGRADED CASE ANNOUNCING ITSELF. A failed read of client_store_ids is
  // not an empty client_store_ids, and the difference is a whole pass's
  // billing. The shape being guarded against is that this reads EXACTLY like a
  // healthy run with no new stores -- created: 3, errors: 0, attributed: 0 --
  // so if it does not reach errors[], the sync bills nobody for everything it
  // pulls behind a subject line that says All clear.
  it('escalates an unreadable store map, which otherwise looks like a clean pass', async () => {
    attributing({ storeMapUnavailable: true })

    const body = await run(cleanClientResult)

    expect(body.has_issues).toBe(true)
    const err = body.errors.find((e) => e.includes('client_store_ids'))
    expect(err).toBeDefined()
    expect(err).toContain('NO')
    // And it must not claim the revenue is lost, because it is not: client_id
    // is still blank, so the next successful run attributes these rows. An
    // alert that overstates gets triaged as noise.
    expect(err).toContain('next successful run')
  })

  // The store ids are the actionable content, not the count. One
  // client_store_ids row attributes every shipment that store has ever sent
  // and every one it will send, so an alert that says "41 shipments from 2
  // stores" without naming them has reported a number and withheld the fix.
  it('names the unmapped store ids, because the ids are the action', async () => {
    attributing({ unmappedStore: 41, unmappedStoreIds: ['900', '901'] })

    const body = await run(cleanClientResult)

    expect(body.has_issues).toBe(true)
    const err = body.errors.find((e) => e.includes('no client_store_ids row'))
    expect(err).toBeDefined()
    expect(err).toContain('41 shipments')
    expect(err).toContain('900')
    expect(err).toContain('901')
    expect(err).toContain('cannot be invoiced')
  })

  // A conflict cannot be resolved by a rule -- client_store_ids is unique on
  // store_id alone, so one store mapping to two clients means the invariant is
  // already broken somewhere. It escalates, and it must say that nothing moved,
  // because "2 shipments are assigned to the wrong client" would otherwise read
  // as an invoice having already been changed under someone.
  it('escalates an attribution conflict and says nothing was moved', async () => {
    attributing({ attributionConflicts: 2 })

    const body = await run(cleanClientResult)

    expect(body.has_issues).toBe(true)
    const err = body.errors.find((e) => e.includes('different client'))
    expect(err).toBeDefined()
    expect(err).toContain('nothing was moved')
    expect(err).toContain('sync_runs')
  })

  // THE ONE THAT MUST NOT ALERT, and the reason is that there is no action to
  // offer. An unmapped store is fixed by one insert; a shipment carrying no
  // store key at all cannot be fixed from this database, because there is
  // nothing to map it by. It is the unknownCarrier case: a person eventually,
  // not a 🚨 every eight hours. Without this assertion the cheapest way to
  // "handle" the counter is to push it to errors[] with the others, and the
  // cost of that is the whole alert channel.
  it('reports a shipment with no store id at all without waking anyone', async () => {
    attributing({ noStoreId: 7 })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
    expect(body.log.some((l) => l.includes('no store id at all'))).toBe(true)
  })

  it('logs a successful attribution without calling it an issue', async () => {
    attributing({ attributed: 38 })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
    expect(body.log.some((l) => l.includes('38 shipments attributed'))).toBe(true)
  })

  // The negative control for this whole block. Every assertion above is a
  // search for a substring, and all five would pass against a handler that
  // emitted all six lines unconditionally on every pass -- which would put
  // three permanent errors[] entries in every email. This pins the silence.
  it('says nothing about attribution when there is nothing to say', async () => {
    attributing({})

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
    expect(body.log.some((l) => l.includes('attributed'))).toBe(false)
    expect(body.log.some((l) => l.includes('no store id'))).toBe(false)
    expect(body.log.some((l) => l.includes('client_store_ids'))).toBe(false)
  })
})
