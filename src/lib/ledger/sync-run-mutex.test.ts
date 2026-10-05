import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// The subject of this file is openSyncRun's half of the mutex: the stale-run
// reap, and the translation of a 23505 into "someone else holds the lock".
//
// It is a separate file from sync-run.test.ts because that one covers
// collectErrors(), which needs no database at all, and adding a module mock to
// it would make every pure test in it depend on a fake Supabase.
//
// WHAT THIS FILE CANNOT TEST, and what covers it instead: the fake does not
// enforce unique indexes, so nothing here proves the lock EXISTS -- only that
// openSyncRun does the right thing when the database says it was taken. The
// index itself is asserted by supabase/verify/ledger_03d_verify.sql, which
// inserts a real duplicate against the real table.
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { openSyncRun, isSyncRunLocked, LOCK_REFUSED_STATUS } =
  await import('@/lib/ledger/sync-run')
const { STALE_RUN_MINUTES } = await import('@/lib/ledger/run-lock')

const runs = () => (h.db.tables.sync_runs ?? []) as FakeRow[]
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

/** A row sitting in sync_runs, in whatever state the test needs. */
function seedRun(over: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    id: `seed-${runs().length + 1}`,
    source: 'charges',
    client_id: null,
    mode: 'live',
    status: 'running',
    started_at: minutesAgo(5),
    finished_at: null,
    errors: [],
    ...over,
  }
  ;(h.db.tables.sync_runs as FakeRow[]).push(row)
  return row
}

/** The 23505 PostgREST returns when a partial unique index refuses the insert. */
const UNIQUE_VIOLATION = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "sync_runs_running_source_key"',
}

/** Fail whichever sync_runs INSERT carries `status`, leaving the reap alone. */
function failInsertOfStatus(status: string, error: { code?: string; message: string }) {
  h.db.failOn = (call) =>
    call.table === 'sync_runs' && call.verb === 'insert'
      && call.payload[0]?.status === status ? error : null
}

/**
 * Make the LOCK-TAKE insert fail, leaving the reap AND the refusal row alone.
 *
 * Discriminating on the status in the payload, rather than just on the verb,
 * is load-bearing now that losing the lock writes a second row. A blanket
 * "fail every sync_runs insert" would suppress the refusal insert too, and
 * every assertion below about the refusal row would then be passing for the
 * wrong reason: the row would be missing because the test broke it, not
 * because the code failed to write it.
 */
const failTheInsert = (error: { code?: string; message: string }) =>
  failInsertOfStatus('running', error)

beforeEach(() => {
  h.db = createFakeSupabase({ sync_runs: [] })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'))
})
afterEach(() => { vi.useRealTimers() })

// ---------------------------------------------------------------------------
describe('openSyncRun: the reap', () => {
  // The reason the reap exists at all. Without it a single lambda killed at its
  // maxDuration -- which skips the finally that would have closed the row --
  // leaves 'running' behind for ever, the partial unique index refuses every
  // later run, and openSyncRun reads that refusal as "someone else is working"
  // and skips QUIETLY. A transient timeout becomes an unbounded outage of the
  // money path, with a table that looks perfectly healthy.
  it('closes a run abandoned longer than STALE_RUN_MINUTES', async () => {
    const stale = seedRun({ started_at: minutesAgo(STALE_RUN_MINUTES + 1) })

    await openSyncRun({ source: 'charges', mode: 'live' })

    expect(stale.status).toBe('failed')
    expect(stale.finished_at).toBeTruthy()
  })

  // The other half of the boundary, and the one that makes the test above mean
  // something. A reaper that closed everything would also pass that assertion,
  // and would be far worse than no reaper: it would hand the lock away from a
  // sync that is still writing, which is the exact overlap the mutex exists to
  // stop.
  it('leaves a run younger than STALE_RUN_MINUTES alone', async () => {
    const live = seedRun({ started_at: minutesAgo(STALE_RUN_MINUTES - 1) })

    await openSyncRun({ source: 'charges', mode: 'live' })

    expect(live.status).toBe('running')
    expect(live.finished_at).toBeNull()
  })

  // Recorded as a WARNING, not an error. close()'s status formula and every
  // error_count reader in the app treat warnings as non-failures, so a reaped
  // row must not fire the monitor's alarm: it did not fail, it stopped
  // existing. The row still says 'failed' because that is the only terminal
  // status the rest of the codebase knows, and because the charge throttle
  // (status = 'ok') and the zenventory watermark (status in ok/partial) must
  // not mistake an abandoned run for a completed one.
  it('records the reap as a warning, naming the timeout, not as an error', async () => {
    const stale = seedRun({ started_at: minutesAgo(STALE_RUN_MINUTES + 1) })

    await openSyncRun({ source: 'charges', mode: 'live' })

    const errors = stale.errors as Array<{ kind: string; message: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].kind).toBe('warning')
    expect(errors[0].message).toContain(String(STALE_RUN_MINUTES))
    expect(errors[0].message).toMatch(/maxDuration/)
  })

  // zenventory opens a row PER CLIENT and loops over the clients sequentially,
  // so at any moment several of its rows are legitimately 'running' at once.
  // Reaping by source alone would close a LIVE sibling's row the moment it
  // aged past thirty minutes -- a long sync eating its own lock.
  it('does not reap a stale row belonging to a different client of the same source', async () => {
    const other = seedRun({
      source: 'zenventory', client_id: 'client-A',
      started_at: minutesAgo(STALE_RUN_MINUTES + 1),
    })

    await openSyncRun({ source: 'zenventory', clientId: 'client-B', mode: 'live' })

    expect(other.status).toBe('running')
  })

  it('does not reap a stale row belonging to a different source', async () => {
    const other = seedRun({
      source: 'shipstation', started_at: minutesAgo(STALE_RUN_MINUTES + 1),
    })

    await openSyncRun({ source: 'charges', mode: 'live' })

    expect(other.status).toBe('running')
  })

  // Asserted on the STATEMENT rather than on the resulting rows, and that is
  // not fussiness -- it is the only way this can be tested here.
  //
  // PostgREST renders `.eq('client_id', null)` as `client_id = null`, which is
  // never true in SQL, so writing eq instead of is would mean the source-wide
  // rows -- charges and shipstation, the two whose overlap actually corrupts
  // data -- were NEVER reaped, and would wedge permanently. But the fake's eq
  // compares with `===` first, so `eq('client_id', null)` matches a null in the
  // double. The behavioural test is green under both spellings; only the filter
  // shape distinguishes them.
  it('filters client_id with IS NULL, not = null, for a source-wide run', async () => {
    await openSyncRun({ source: 'charges', mode: 'live' })

    const reap = h.db.calls.find((c) => c.table === 'sync_runs' && c.verb === 'update')
    expect(reap).toBeDefined()
    expect(reap!.filters).toContainEqual({ op: 'is-null', column: 'client_id', value: null })
    expect(reap!.filters).toContainEqual({ op: 'eq', column: 'source', value: 'charges' })
    expect(reap!.filters).toContainEqual({ op: 'eq', column: 'status', value: 'running' })
    expect(reap!.filters.some((f) => f.op === 'lt' && f.column === 'started_at')).toBe(true)
  })

  it('filters client_id with eq for a per-client run', async () => {
    await openSyncRun({ source: 'zenventory', clientId: 'client-A', mode: 'live' })

    const reap = h.db.calls.find((c) => c.table === 'sync_runs' && c.verb === 'update')
    expect(reap!.filters).toContainEqual({ op: 'eq', column: 'client_id', value: 'client-A' })
    expect(reap!.filters).not.toContainEqual({ op: 'is-null', column: 'client_id', value: null })
  })

  // The cutoff has to be computed from the SAME `now` the run starts from and
  // from the SAME constant canStart() uses. If the two drifted there would be a
  // band of ages in which canStart says "blocked" but the reaper has already
  // cleared the row, or the reverse.
  it('reaps at exactly STALE_RUN_MINUTES before now', async () => {
    await openSyncRun({ source: 'charges', mode: 'live' })

    const reap = h.db.calls.find((c) => c.table === 'sync_runs' && c.verb === 'update')
    const cutoff = reap!.filters.find((f) => f.op === 'lt' && f.column === 'started_at')!.value
    expect(cutoff).toBe(new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString())
  })

  // A failed reap is not on its own a reason to refuse to sync. If no stale row
  // exists the insert succeeds and nothing was lost; if one does, the insert
  // comes back 23505 and the run skips as though locked, which is the safe
  // direction. Refusing here would turn a transient read error into a missed
  // sync.
  it('still opens the run when the reap itself fails', async () => {
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'update'
        ? { message: 'connection reset' }
        : null

    const run = await openSyncRun({ source: 'charges', mode: 'live' })
    expect(run.id).toBeTruthy()
  })

  // The reap must not run after the insert, or it would close the row this run
  // just opened the instant that row aged -- and, more immediately, it would
  // make the 23505 arrive before the stale row had been cleared, so a wedged
  // source would stay wedged for ever. Ordering is a property of the code, not
  // of any fixture, so it is asserted on the call log.
  it('reaps BEFORE it tries to take the lock', async () => {
    await openSyncRun({ source: 'charges', mode: 'live' })

    const verbs = h.db.calls.filter((c) => c.table === 'sync_runs').map((c) => c.verb)
    expect(verbs.indexOf('update')).toBeGreaterThanOrEqual(0)
    expect(verbs.indexOf('update')).toBeLessThan(verbs.indexOf('insert'))
  })
})

// ---------------------------------------------------------------------------
describe('openSyncRun: losing the lock', () => {
  it('throws SyncRunLockedError when the insert comes back 23505', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    const err = await openSyncRun({ source: 'charges', mode: 'live' }).catch((e) => e)
    expect(isSyncRunLocked(err)).toBe(true)
    expect(err.name).toBe('SyncRunLockedError')
  })

  // The distinction the whole design rests on. 23505 is the mutex working and
  // the correct response is a quiet skip; everything else means we could not
  // tell, and must be reported. Conflating them either hides real breakage
  // behind "someone else is running" or fires a false alarm on every overlap --
  // and the monitor is polled every five minutes from every open tab, so a
  // false alarm there is an alarm nobody reads within a day.
  it('throws an ordinary error, NOT a lock error, for any other failure', async () => {
    failTheInsert({ code: '42501', message: 'permission denied for table sync_runs' })

    const err = await openSyncRun({ source: 'charges', mode: 'live' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isSyncRunLocked(err)).toBe(false)
    expect(err.message).toContain('permission denied')
  })

  // The loser writes exactly one row, and it is NOT a 'running' one.
  //
  // This replaces an earlier test that asserted the loser wrote nothing at
  // all, on the reasoning that a trace would make the monitor's error counts
  // climb with normal traffic. The premise was right and the conclusion was
  // wrong: the cost of writing nothing is that a refusal becomes unobservable
  // after the lambda exits, so a permanently wedged source is indistinguishable
  // from a healthy idle one and PART B of ledger_08_post_deploy_check.sql can
  // no longer see a second scheduler. The error counts stay flat anyway,
  // because the row is a warning and not an error -- asserted below.
  it('records the refusal as a sync_runs row', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    await openSyncRun({ source: 'charges', mode: 'live' }).catch(() => {})

    expect(runs()).toHaveLength(1)
    expect(runs()[0].status).toBe(LOCK_REFUSED_STATUS)
  })

  // The trap this whole change had to avoid. The refusal row must record the
  // refusal WITHOUT occupying the lock it just lost. Both indexes in
  // ledger_03d_sync_runs_mutex.sql are partial on `status = 'running'`, so the
  // one value this row may never carry is 'running' -- a refusal that wrote
  // one would collide with the winner it just lost to (if the insert even
  // succeeded) and, worse, would still be sitting there holding the source
  // after the winner closed. Every subsequent run of that source would then be
  // refused, each one writing another 'running' row, until the reaper's
  // 30-minute window happened to clear it. Asserted separately from the test
  // above because that one would still pass if the constant changed.
  it('does not write a running row, so the refusal cannot hold the lock', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    await openSyncRun({ source: 'charges', mode: 'live' }).catch(() => {})

    expect(runs().filter((r) => r.status === 'running')).toHaveLength(0)
  })

  // Born terminal: there is no close() coming for this row. A refusal row left
  // with a null finished_at would be an unfinished run that nothing will ever
  // finish -- precisely the shape ("started, never came back") that the row
  // exists to make distinguishable.
  it('closes the refusal row at birth', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    await openSyncRun({ source: 'charges', mode: 'live' }).catch(() => {})

    expect(runs()[0].finished_at).toBeTruthy()
  })

  // A refusal is the mutex working, not a failure, and the monitor's alarm is
  // driven by error counts. If this were recorded as kind:'error' then every
  // ordinary overlap -- the normal outcome the mutex is designed to produce --
  // would raise an alarm, and an alarm that fires on correct behaviour is one
  // nobody reads by the end of the week.
  it('records the refusal as a warning, not an error', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    await openSyncRun({ source: 'charges', mode: 'live' }).catch(() => {})

    const entries = runs()[0].errors as Array<{ kind: string; context: string }>
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('warning')
    expect(entries[0].context).toBe('lock refused')
  })

  // The row has to say WHICH lock was lost, or it cannot be counted per
  // cluster. zenventory refuses per client, so a refusal row that dropped the
  // client_id would be unattributable: three clients refused and one succeeded
  // would look the same as the reverse.
  it('names the source and client of the refused run', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    await openSyncRun({
      source: 'zenventory', clientId: 'client-A', mode: 'live',
      windowStart: '2026-09-01', windowEnd: '2026-09-30',
    }).catch(() => {})

    expect(runs()[0]).toMatchObject({
      source: 'zenventory',
      client_id: 'client-A',
      mode: 'live',
      window_start: '2026-09-01',
      window_end: '2026-09-30',
    })
  })

  // The refusal row must survive to be evidence. The reaper runs at the top of
  // every later openSyncRun and matches on status = 'running', so a terminal
  // 'skipped' row is outside it -- but only as long as the reaper keeps
  // filtering on that exact status. Widening it to, say, `neq('status','ok')`
  // would silently rewrite the refusal history into 'failed' rows, turning the
  // quiet record of a working mutex into a backlog of fake failures.
  it('never reaps a refusal row, however old', async () => {
    const old = seedRun({
      status: LOCK_REFUSED_STATUS,
      started_at: minutesAgo(STALE_RUN_MINUTES * 10),
      finished_at: minutesAgo(STALE_RUN_MINUTES * 10),
    })

    await openSyncRun({ source: 'charges', mode: 'live' })

    expect(old.status).toBe(LOCK_REFUSED_STATUS)
  })

  // Losing the lock and being unable to write the note about it are different
  // facts, and only the first one decides what the caller does. If a failed
  // refusal insert could mask or replace the lock error, a database hiccup
  // would turn a correctly-working mutex into either a hard sync failure or --
  // far worse -- a caller that no longer knows it must skip.
  it('still reports the lock loss when the refusal row cannot be written', async () => {
    h.db.failOn = (call) =>
      call.table === 'sync_runs' && call.verb === 'insert'
        ? (call.payload[0]?.status === 'running'
            ? UNIQUE_VIOLATION
            : { code: '42501', message: 'permission denied for table sync_runs' })
        : null

    const err = await openSyncRun({ source: 'charges', mode: 'live' }).catch((e) => e)

    expect(isSyncRunLocked(err)).toBe(true)
    expect(runs()).toHaveLength(0)
  })

  // Only a 23505 means "someone else holds it". A permission error or a
  // dropped connection means we could not tell, and writing a 'skipped' row
  // for it would put a specific, confident, false statement into the audit
  // trail -- the row says another run was holding the lock, and no such run
  // need exist. That lie is worse than the silence, because PART B counts
  // these rows.
  it('writes no refusal row when the insert failed for any other reason', async () => {
    failTheInsert({ code: '42501', message: 'permission denied for table sync_runs' })

    await openSyncRun({ source: 'charges', mode: 'live' }).catch(() => {})

    expect(runs()).toHaveLength(0)
  })

  // isSyncRunLocked duck-types rather than using instanceof, so that it keeps
  // working if the module is ever loaded twice -- two bundles, or a test
  // importing through a different alias. An instanceof guard silently starts
  // answering false in that situation, which would route every lock loss down
  // the failure path with no error anywhere to explain why.
  it('recognises a lock error that came from a different copy of the module', () => {
    const fromAnotherBundle = Object.assign(new Error('another run holds it'), {
      isSyncRunLocked: true,
    })
    expect(isSyncRunLocked(fromAnotherBundle)).toBe(true)
  })

  it('does not mistake an arbitrary object for a lock error', () => {
    expect(isSyncRunLocked(null)).toBe(false)
    expect(isSyncRunLocked(undefined)).toBe(false)
    expect(isSyncRunLocked({ code: '23505' })).toBe(false)
    expect(isSyncRunLocked(new Error('duplicate key value violates unique constraint'))).toBe(false)
  })

  it('names the source and the client in the message, so the log says which lock', async () => {
    failTheInsert(UNIQUE_VIOLATION)

    const err = await openSyncRun({
      source: 'zenventory', clientId: 'client-A', mode: 'live',
    }).catch((e) => e)
    expect(err.message).toContain('zenventory')
    expect(err.message).toContain('client-A')
  })
})

// ---------------------------------------------------------------------------
describe('openSyncRun: releasing the lock', () => {
  // The predicate `where status = 'running'` is what makes the lock
  // releasable: a row occupies the index only while it is running, and close()
  // moves it off, which IS the unlock and costs no extra write. If close() ever
  // stopped changing the status -- or the index lost its predicate -- the first
  // run of each source would hold it for ever and every later run would skip
  // silently. This is the code-side half of that guarantee; the index-side half
  // is asserted in supabase/verify/ledger_03d_verify.sql.
  it('close() moves the row off running, which is what frees the index slot', async () => {
    const run = await openSyncRun({ source: 'charges', mode: 'live' })
    expect(runs()[0].status).toBe('running')

    await run.close()

    expect(runs()[0].status).not.toBe('running')
    expect(runs()[0].finished_at).toBeTruthy()
  })

  it('close() frees it even when the run failed', async () => {
    const run = await openSyncRun({ source: 'charges', mode: 'live' })
    run.fail('something', new Error('boom'))

    await run.close()

    expect(runs()[0].status).toBe('failed')
  })
})
