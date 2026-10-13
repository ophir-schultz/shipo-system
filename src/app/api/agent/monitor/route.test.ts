import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'
// The real schedule, reaching this file through the partial mock below. See the
// undelivered-report test for what it pins.
import { CHARGE_CRON_HOURS_UTC } from '@/lib/ledger/persist-charges'

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
// recalculateCharges is stubbed, but CHARGE_CRON_HOURS_UTC comes through REAL.
// The handler interpolates its length into the undelivered-report message, so a
// literal array here would be a second copy of the schedule and the assertion
// below would be checking the message against a fixture rather than against
// what production actually runs. importOriginal is safe despite this module
// reaching for the database: '@/lib/supabase' above is mocked behind a getter,
// so nothing is evaluated at import time.
vi.mock('@/lib/ledger/persist-charges', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger/persist-charges')>()),
  recalculateCharges: h.recalculateCharges,
}))
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
// A lost rate adjustment and an unrecorded shipment are different losses, and
// this route is the only place either becomes a sentence a person reads. Until
// the counter was split they shared one: `errors` was incremented by the
// adjustment fail site too, so a failed adjustment insert produced "1
// ShipStation shipment could not be recorded ... Their revenue and carrier cost
// are missing from the ledger until the next successful run picks them up" —
// wrong in every clause, since the shipment is recorded with both, and nothing
// ever retries the adjustment.
describe('GET /api/agent/monitor: a lost rate adjustment is not a lost shipment', () => {
  const withAdjFailure = {
    created: 0, updated: 1, adjustments: 0, refunds: 0,
    errors: 0, adjustmentErrors: 1, unknownCarrier: 0, blankOrderNumber: 0,
    skipped: false, skipReason: null,
  }

  it('reports the lost adjustment as an issue', async () => {
    h.syncShipments.mockResolvedValue(withAdjFailure)

    const body = await run(cleanClientResult)

    expect(body.errors.filter((e) => e.includes('rate adjustment'))).toHaveLength(1)
    expect(body.has_issues).toBe(true)
  })

  it('does not claim a shipment is missing from the ledger', async () => {
    // The assertion the old wording could not satisfy. This is the sentence
    // that was false, so this is the sentence that has to stay absent.
    h.syncShipments.mockResolvedValue(withAdjFailure)

    const body = await run(cleanClientResult)

    expect(body.errors.some((e) => e.includes('could not be recorded'))).toBe(true)
    expect(body.errors.some((e) => e.includes('shipment could not be recorded'))).toBe(false)
    expect(body.errors.some((e) => e.includes('shipments could not be recorded'))).toBe(false)
  })

  it('does not promise a self-heal that cannot happen', async () => {
    // Once actual_cost holds the new value the diff is 0 for ever, so "the next
    // successful run picks them up" is not merely optimistic, it is impossible.
    h.syncShipments.mockResolvedValue(withAdjFailure)

    const body = await run(cleanClientResult)

    const adj = body.errors.find((e) => e.includes('rate adjustment'))!
    expect(adj).not.toContain('next successful run picks them up')
    expect(adj).toContain('will not be retried')
  })

  it('reports a shipment failure and an adjustment failure as two separate issues', async () => {
    h.syncShipments.mockResolvedValue({ ...withAdjFailure, errors: 2, adjustmentErrors: 1 })

    const body = await run(cleanClientResult)

    expect(body.errors.filter((e) => e.includes('shipments could not be recorded'))).toHaveLength(1)
    expect(body.errors.filter((e) => e.includes('rate adjustment'))).toHaveLength(1)
    // And the shipment sentence must still carry its own number, not the total.
    expect(body.errors.some((e) => e.includes('2 ShipStation shipments'))).toBe(true)
  })

  it('says nothing about adjustments on a pass that lost none', async () => {
    h.syncShipments.mockResolvedValue({ ...withAdjFailure, updated: 1, adjustmentErrors: 0 })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
  })
})

// Both syncs can now lose the sync_runs lock to a concurrent invocation, and
// this route is where that becomes visible to a person. The failure mode this
// guards is specific: a skipped pass returns the SAME all-zero counters a pass
// with nothing to do returns, so without an explicit flag the handler prints
// the same green line for each — and `✓ ShipStation sync: 0 new` read as
// evidence of health is the precise mistake the rest of this file is a
// post-mortem on.
// A blank order number stops the sync matching a label to a Zenventory order,
// so the shipment gets no client and no rate. The alert for it used to say the
// shipments "can never be assigned a client or billed — this is unrecoverable
// revenue until someone identifies them by hand in ShipStation", and BOTH of
// those claims were false: measured 2026-10-13, all 9 such rows carried a
// ShipStation orderId and a shipTo.name that named the client, and seven were
// inbound RETURN labels to Shipo's own warehouse rather than uninvoiced outbound
// revenue.
//
// These tests pin the correction in both directions. The alert must carry the
// identification, and it must not overclaim in the opposite direction either --
// nine rows at one store do not license telling the operator that blank labels
// are returns.
describe('GET /api/agent/monitor: blank order numbers say which labels', () => {
  const withBlanks = (over: Record<string, unknown>) => ({
    created: 0, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, ...over,
  })

  it('puts the label descriptions in the alert, not just the count', async () => {
    h.syncShipments.mockResolvedValue(withBlanks({
      blankOrderNumber: 2,
      blankOrderNumberLabels: [
        'shipment 9101 · order 561469848 · to "SHIPO LLC - SUTEKA (#S7143)"',
        'shipment 9102 · no ShipStation orderId · no recipient name',
      ],
    }))

    const body = await run(cleanClientResult)
    const alert = body.errors.find((e) => e.includes('no order number')) ?? ''

    expect(alert).toContain('561469848')
    expect(alert).toContain('SUTEKA')
    // The second label too. An implementation that printed only the first would
    // pass every assertion above and still hide labels from the operator.
    expect(alert).toContain('shipment 9102')
    expect(body.has_issues).toBe(true)
  })

  it('no longer claims the revenue is unrecoverable or the client unknowable', async () => {
    // The specific wording that was wrong. Asserted as absences because the
    // defect was an assertion the data did not support -- a test that only
    // checked the new text would pass with the old sentence still appended.
    h.syncShipments.mockResolvedValue(withBlanks({
      blankOrderNumber: 1,
      blankOrderNumberLabels: ['shipment 9101 · order 42 · to "X"'],
    }))

    const body = await run(cleanClientResult)
    const alert = body.errors.find((e) => e.includes('no order number')) ?? ''

    expect(alert).not.toContain('unrecoverable')
    expect(alert).not.toContain('can never be')
    // And not the opposite overclaim either: the monitor must not tell anyone
    // these ARE returns, which is true of nine rows at one store and is not a
    // rule.
    //
    // Asserted as the presence of the hedge rather than the absence of
    // 'are returns'. The first draft used the absence, and it failed against
    // correct text -- the message says "check whether they are returns before
    // billing them", which contains that substring while claiming the opposite
    // of what the assertion was policing. Same trap as 'no cell' being a prefix
    // of 'no cell covering' in zones.test.ts, except this one fired instead of
    // passing silently, because here the substring appears in the GOOD text.
    expect(alert).toContain('whether they are returns')
  })

  it('states the shortfall when there are more blanks than examples', async () => {
    // The count is uncapped and the example list is capped at 20
    // (lib/sync/shipstation.ts BLANK_LABEL_EXAMPLES). A list silently shorter
    // than the number above it reads as the complete set, and whoever works
    // through it stops 5 labels early believing they are done.
    h.syncShipments.mockResolvedValue(withBlanks({
      blankOrderNumber: 25,
      blankOrderNumberLabels: Array.from(
        { length: 20 }, (_, i) => `shipment ${9200 + i} · order ${i} · to "X"`),
    }))

    const body = await run(cleanClientResult)
    const alert = body.errors.find((e) => e.includes('no order number')) ?? ''

    expect(alert).toContain('25')
    expect(alert).toContain('5 more not listed')
  })

  it('says nothing extra when the count and the examples agree', async () => {
    // The negative control for the line above: a shortfall notice that always
    // fired would be indistinguishable from one that fires correctly, and would
    // tell the operator there is hidden work when there is none.
    h.syncShipments.mockResolvedValue(withBlanks({
      blankOrderNumber: 1,
      blankOrderNumberLabels: ['shipment 9101 · order 42 · to "X"'],
    }))

    const body = await run(cleanClientResult)
    const alert = body.errors.find((e) => e.includes('no order number')) ?? ''

    expect(alert).not.toContain('more not listed')
  })

  it('still reports the count when the sync sent no examples at all', async () => {
    // Defensive: an older deployment of the sync, or a replayed result, has no
    // blankOrderNumberLabels key. The finding must survive its evidence being
    // absent -- degrading to the old count-only alert is acceptable, losing the
    // alert is not.
    h.syncShipments.mockResolvedValue(withBlanks({ blankOrderNumber: 3 }))

    const body = await run(cleanClientResult)
    const alert = body.errors.find((e) => e.includes('no order number')) ?? ''

    expect(alert).toContain('3')
    expect(alert).toContain('3 more not listed')
    expect(body.has_issues).toBe(true)
  })
})

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

// ---------------------------------------------------------------------------
// A charge run that completes and writes nothing.
//
// Measured 2026-10-06: pnl_monthly returned zero rows, which for a FULL OUTER
// JOIN of two unfiltered aggregates proves order_charges AND operating_costs
// are both empty. The charge cron had been running for weeks. It was reporting
//
//     ✓ Charges: 0 orders · 0 written · 0 stale removed
//
// with a green tick and nothing in errors[], because the else-branch only
// escalated failedOrders, staleDeleteRefused and unpricedOrders -- all of which
// are zero when the run had no input to fail on. So the one state that means
// "the pipeline is severed" was indistinguishable from "a quiet hour".
//
// This route's own header is a post-mortem on exactly this shape of lie: "the
// ledger stayed empty behind an email whose subject said All clear". That fix
// (maxDuration = 300) addressed the kill. It did not address the silence.
//
// The two causes are split because they send someone to different places: no
// orders loaded at all is upstream, in the Zenventory sync that is the ONLY
// writer of `orders` (zenventory.ts:303); orders loaded that produced no charge
// is the rate cards or the order/shipment join.
// ---------------------------------------------------------------------------

const charging = (over: Record<string, unknown>) => {
  h.recalculateCharges.mockResolvedValue({
    skipped: false,
    orders: 0, built: 0, upserted: 0, deleted: 0,
    staleDeleteRefused: 0, failedOrders: 0,
    unknownCostCharges: 0, unknownCarrierCharges: 0, unpricedOrders: 0,
    ...over,
  })
  // A non-skipped charge run opens step 3c. 'missing-table' is log-only by
  // design, so storage cannot contribute an errors[] entry and make the
  // assertions below pass for the wrong reason.
  h.persistStorageCharges.mockResolvedValue({
    skipped: true, cause: 'missing-table', reason: 'client_storage_months does not exist',
  })
}

describe('GET /api/agent/monitor: a charge run that wrote nothing', () => {
  it('escalates a run that loaded no orders at all, and names the sync that feeds them', async () => {
    charging({ orders: 0, built: 0, upserted: 0 })

    const body = await run(cleanClientResult)

    expect(body.has_issues).toBe(true)
    const line = body.errors.find((e) => e.includes('no orders'))
    expect(line).toBeDefined()
    // Has to point somewhere. A bare count repeats what the log already said.
    expect(line).toContain('Zenventory')
  })

  it('does not put a green tick beside a zero-row charge run', async () => {
    // The tick is the actual carrier of the false claim. Escalating to errors[]
    // while still logging "✓ Charges: 0 orders" leaves the contradiction in the
    // email body, and the body is what gets read.
    charging({ orders: 0, built: 0, upserted: 0 })

    const body = await run(cleanClientResult)

    expect(body.log.some((l) => l.startsWith('✓ Charges'))).toBe(false)
  })

  it('tells orders-that-built-nothing apart from no-orders-at-all', async () => {
    // 40 orders in the window and not one charge row produced. Upstream is
    // fine; pricing or the order/shipment join is not. The no-orders message
    // would send someone to the Zenventory sync, which is working.
    charging({ orders: 40, built: 0, upserted: 0 })

    const body = await run(cleanClientResult)

    expect(body.has_issues).toBe(true)
    const line = body.errors.find((e) => e.includes('built no charge'))
    expect(line).toBeDefined()
    expect(line).toContain('40')
    // Must NOT blame the upstream sync: it delivered 40 orders.
    expect(body.errors.some((e) => e.includes('no orders'))).toBe(false)
  })

  it('stays silent on a run that loaded orders and wrote charges', async () => {
    // The negative control. Both assertions above are substring searches and
    // both would pass against a handler that emitted the warnings on every
    // pass -- which would mean a permanent 🚨 on every one of the three daily
    // crons forever.
    charging({ orders: 40, built: 120, upserted: 120 })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
    expect(body.log.some((l) => l.includes('✓ Charges: 40 orders'))).toBe(true)
  })

  it('stays silent on a throttled skip, which is the one healthy skip cause', async () => {
    // Guards the boundary from the other side. The throttle is the ONE skip
    // cause that must stay quiet, and a zero-orders check written in the wrong
    // branch would start alerting on it three times a day.
    h.recalculateCharges.mockResolvedValue({
      skipped: true, cause: 'throttled', reason: 'ran 2 minutes ago',
    })

    const body = await run(cleanClientResult)

    expect(body.errors).toEqual([])
    expect(body.has_issues).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AN UNDELIVERABLE ALERT MUST NOT ANSWER 200 OK.
//
// sendEmail() never throws: with no provider configured it returns
// { sent: false, provider: 'none', error: 'No email provider configured' }
// (lib/email.ts:141). The handler's only response was
//
//     log.push(`📧 Email → ${ALERT_TO}: ... FAILED (${err})`)
//
// and `log` IS THE BODY OF THE EMAIL THAT WAS NOT SENT. So a dead alerting
// channel recorded itself exclusively in the message it failed to deliver, and
// answered the cron with ok:true / HTTP 200 while doing it.
//
// Measured before writing this: no Shipo Monitor alert exists anywhere in the
// ALERT_TO mailbox -- inbox, spam or trash -- so this path is not hypothetical.
//
// Every other test in this file mocks sendEmail to { sent: true }, which is why
// the gap survived: the failure branch had no coverage at all.
//
// The cron is the only unattended caller and a non-2xx is the only thing it
// surfaces, so the status code is the signal being asserted here -- not just
// the body. `run` discards the Response, hence runRaw.
describe('GET /api/agent/monitor: the alert could not be delivered', () => {
  const runRaw = async (clientResult: Record<string, unknown>) => {
    h.syncClientAssignments.mockResolvedValue(clientResult)
    const res = await GET(new Request('https://shipo.test/api/agent/monitor'))
    return { res, body: (await res.json()) as MonitorBody }
  }

  it('answers non-2xx with ok:false when the provider is not configured', async () => {
    h.sendEmail.mockResolvedValue({
      sent: false, provider: 'none', error: 'No email provider configured',
    })

    const { res, body } = await runRaw(cleanClientResult)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(body.ok).toBe(false)
  })

  it('says the channel is dead, and says it in errors[] where it is read', async () => {
    h.sendEmail.mockResolvedValue({
      sent: false, provider: 'none', error: 'No email provider configured',
    })

    const { body } = await runRaw(cleanClientResult)

    // The reason has to travel. "email failed" sends nobody anywhere; the
    // provider's own error names what to configure.
    const line = body.errors.find((e) => e.includes('No email provider configured'))
    expect(line).toBeDefined()
    expect(body.has_issues).toBe(true)

    // And the frequency it quotes has to be TRUE. This sentence tells a person
    // how much they are not being told, so a stale number understates the
    // damage -- and it HAS gone stale once already, when the schedule went from
    // three runs a day to six. The handler derives it from
    // CHARGE_CRON_HOURS_UTC; this asserts the claim against that same constant,
    // so re-hardcoding the digit survives only until the schedule next moves.
    expect(line).toContain(`${CHARGE_CRON_HOURS_UTC.length} times a day`)
  })

  it('still answers 200/ok on a clean run that WAS delivered (the control)', async () => {
    // Guard-the-guard. Without this, returning 500 unconditionally would pass
    // both assertions above and break every healthy run in production.
    const { res, body } = await runRaw(cleanClientResult)

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.has_issues).toBe(false)
  })

  it('reports BOTH the real issues and the delivery failure, not one instead of the other', async () => {
    // The failure mode this guards: folding delivery into the issue list in a
    // way that replaces the findings. If the channel is dead AND there are six
    // real problems, the response is the only place either is recorded, so it
    // has to carry both.
    h.recalculateShipments.mockResolvedValue({
      updated: 0, zone_matched: 0, legacy_matched: 0, unmatched: 7,
      skipped: 0, failed: 0, reasons: [],
    })
    h.sendEmail.mockResolvedValue({
      sent: false, provider: 'none', error: 'No email provider configured',
    })

    const { body } = await runRaw(cleanClientResult)

    expect(body.errors.some((e) => e.includes('no rate match'))).toBe(true)
    expect(body.errors.some((e) => e.includes('No email provider configured'))).toBe(true)
  })
})
