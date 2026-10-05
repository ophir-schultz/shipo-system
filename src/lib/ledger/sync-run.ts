// A sync run that fails silently is indistinguishable from one that had
// nothing to do. sync_runs makes the difference recordable, and collectErrors
// keeps what went wrong rather than only how often.

import { STALE_RUN_MINUTES, isLockConflict, staleRunCutoffISO } from '@/lib/ledger/run-lock'

const MAX_STORED_ERRORS = 50
const MAX_STORED_WARNINGS = 50

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null) return 'null'
  if (err === undefined) return 'undefined'
  if (typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
    // JSON.stringify rather than String(): String() gives '[object Object]',
    // which loses the only information the error had.
    try { return JSON.stringify(err) } catch { return 'unserialisable error' }
  }
  return String(err)
}

// Entries stored in the sync_runs.errors jsonb column carry a `kind` field so
// that piece 4 (the monitoring agent) can count error kinds without parsing
// prose strings — see spec §4 and the errors column design note at line 429.
export type StoredEntry =
  | { kind: 'error'; context: string; message: string }
  | { kind: 'warning'; context: string; message: string }

export function collectErrors() {
  // Errors and warnings have independent caps so a flood of warnings (e.g.
  // an unknown carrier code appearing on every shipment) cannot displace a
  // single stored error. Without independent caps one flood fills the shared
  // budget and real insert/update failures are silently dropped.
  const storedErrors: Array<StoredEntry> = []
  const storedWarnings: Array<StoredEntry> = []
  let errorCount = 0
  let warnCount = 0
  return {
    push(context: string, err: unknown) {
      errorCount++
      if (storedErrors.length < MAX_STORED_ERRORS) {
        storedErrors.push({ kind: 'error', context, message: messageOf(err) })
      }
    },
    warn(context: string, detail: unknown) {
      warnCount++
      if (storedWarnings.length < MAX_STORED_WARNINGS) {
        storedWarnings.push({ kind: 'warning', context, message: messageOf(detail) })
      }
    },
    // count() returns errors only. Warnings are not failures; they must not
    // affect the close() status formula that distinguishes 'ok' / 'partial' /
    // 'failed'. Piece 4 can read warnCount() separately.
    count() { return errorCount },
    warnCount() { return warnCount },
    // list() returns both errors and warnings together so sync_runs.errors
    // contains the complete diagnostic picture in one column.
    list(): StoredEntry[] { return [...storedErrors, ...storedWarnings] },
  }
}

/**
 * Thrown when another run of the same (source, client_id) already holds the
 * lock. NOT a failure: it is the mutex working, and the correct response is to
 * skip quietly.
 *
 * A distinct type rather than a flag on the generic error because the three
 * callers each had to be taught the difference, and a string match on the
 * message would have been the fourth place this branch got bitten by matching
 * on Postgres prose. `isSyncRunLocked()` duck-types rather than using
 * `instanceof` so that it keeps working if this module is ever loaded twice
 * (two bundles, or a test importing through a different alias), which is a
 * silent and extremely confusing way for an `instanceof` guard to start
 * answering false.
 */
export class SyncRunLockedError extends Error {
  readonly isSyncRunLocked = true as const
  constructor(readonly source: string, readonly clientId: string | null) {
    super(
      `openSyncRun(${source}${clientId ? `, client ${clientId}` : ''}): another `
      + `run of this source is already in progress, so this one is skipping. `
      + `This is the sync_runs mutex working, not a failure.`)
    this.name = 'SyncRunLockedError'
  }
}

export function isSyncRunLocked(err: unknown): err is SyncRunLockedError {
  return typeof err === 'object' && err !== null
    && (err as { isSyncRunLocked?: unknown }).isSyncRunLocked === true
}

export interface SyncRunHandle {
  // Non-nullable. openSyncRun now throws rather than handing back a handle with
  // no row behind it, so anything holding a SyncRunHandle holds a real
  // 'running' row — which for source='charges' is the run LOCK itself. Nothing
  // in the codebase reads this field; it is kept because a run id is the one
  // thing you need to find the row in sync_runs while debugging.
  id: string
  seen(n?: number): void
  wrote(n?: number): void
  fail(context: string, err: unknown): void
  // warn() records a notable but non-failure finding (e.g. an unknown carrier
  // code). It is stored in sync_runs.errors with kind:'warning' so piece 4 can
  // distinguish it from kind:'error' entries without parsing prose.
  warn(context: string, detail: unknown): void
  close(status?: 'ok' | 'partial' | 'failed'): Promise<void>
}

export async function openSyncRun(input: {
  source: string
  clientId?: string | null
  mode: 'backfill' | 'live'
  windowStart?: string | null
  windowEnd?: string | null
}): Promise<SyncRunHandle> {
  const errors = collectErrors()
  let rowsSeen = 0
  let rowsWritten = 0

  // Lazy import so the module can be loaded in tests without Supabase env vars.
  // collectErrors() is the testable unit; openSyncRun() is exercised manually.
  const { supabaseAdmin } = await import('@/lib/supabase')

  // THE ROW IS NOT ONLY AN AUDIT TRAIL. For source='charges' the 'running' row
  // IS the run lock: recalculateCharges gates on `select ... where source =
  // 'charges' and status = 'running'` (persist-charges.ts:155-159) before it
  // starts, and the charge run finishes by deleting every charge whose
  // calculated_at predates its own cutoff. So a failed insert here did not cost
  // us a log line — it left the lock SILENTLY ABSENT while the caller carried
  // on believing it held one, and AutoSync polls this route every five minutes
  // from every open browser tab. A second run starting in that window has a
  // later cutoff than the first run's fresh rows and deletes them.
  //
  // Hence the throw. The earlier reasoning ("losing the audit trail is bad;
  // refusing to sync because of it is worse") is sound for a pure audit row and
  // wrong for a lock, and openSyncRun cannot tell from here which one it is
  // writing. Throwing is the fail-safe default: a caller that genuinely does
  // not need the row has to catch and say so, which zenventory.ts does per
  // client, rather than a caller that needs the lock silently not getting one.
  //
  // It also keeps the error object alive. The old shape logged it and dropped
  // it; close() then returned early on the null id and discarded errors.list()
  // as well, so the run's entire error record went nowhere.
  // ---------------------------------------------------------------------
  // THE MUTEX, HALF ONE: reap.
  //
  // supabase/ledger_03d_sync_runs_mutex.sql puts a partial unique index over
  // the 'running' rows, so the insert below is now the single atomic point at
  // which a run either takes the lock or discovers someone else has it. That
  // replaces canStart()'s select-then-insert, which could never be atomic:
  // two callers that both read before either wrote both passed the gate.
  //
  // But an index alone would be a REGRESSION, and a severe one. close() runs
  // in a finally, so an ordinary throw still closes the row -- yet a lambda
  // hard-killed at maxDuration (the monitor route budgets 300s and is polled
  // every five minutes) never runs finally at all, and leaves 'running'
  // behind for ever. Under a bare unique index that one timeout would lock
  // the source out permanently: every later run refused, nothing written,
  // and the table looking perfectly healthy. A transient failure would have
  // become an unbounded outage of the money path.
  //
  // canStart() already has the answer and has had it all along -- a 'running'
  // row older than STALE_RUN_MINUTES does not block (run-lock.ts:23). So this
  // is not a new policy, it is the existing one made atomic: clear the rows
  // canStart would already have ignored, then let the index arbitrate what is
  // left. Both halves read the same constant, via staleRunCutoffISO().
  //
  // Scoped to this exact (source, client_id). zenventory opens a row PER
  // CLIENT, so reaping by source alone would close a live sibling's row and
  // hand its lock away mid-sync.
  //
  // Recorded as a WARNING, not an error, and that is deliberate: close()'s
  // status formula and every error_count reader treat warnings as non-
  // failures, so a reaped row does not fire the monitor's alarm. It did not
  // fail; it stopped existing. The row still says 'failed' because that is
  // the only terminal status the rest of the codebase knows, and because
  // both readers that matter -- the charge throttle (status = 'ok') and the
  // zenventory watermark (status in ok/partial) -- must not mistake an
  // abandoned run for evidence of a completed one.
  const now = new Date()
  const reap = supabaseAdmin
    .from('sync_runs')
    .update({
      status: 'failed',
      finished_at: now.toISOString(),
      errors: [{
        kind: 'warning',
        context: 'run abandoned',
        message: `Still 'running' more than ${STALE_RUN_MINUTES} minutes after it `
               + `started, so a later run of the same source presumed it dead and `
               + `closed it. The usual cause is the lambda being killed at its `
               + `maxDuration, which skips the finally that would have closed it.`,
      }],
    })
    .eq('source', input.source)
    .eq('status', 'running')
    .lt('started_at', staleRunCutoffISO(now))

  // `.is(null)` and `.eq(id)` are NOT interchangeable here. PostgREST renders
  // eq against null as `client_id = null`, which is never true, so the
  // source-wide rows (charges, shipstation) would never be reaped and would
  // wedge exactly as described above.
  const { error: reapError } = await (input.clientId
    ? reap.eq('client_id', input.clientId)
    : reap.is('client_id', null))

  // Not fatal on its own. If the reap failed but no stale row exists, the
  // insert below succeeds and nothing was lost; if one does exist, the insert
  // returns 23505 and this run skips as though locked -- which is the safe
  // direction. Worth a log either way, because a reap that keeps failing is
  // how a source quietly stops syncing.
  if (reapError) {
    console.error('[openSyncRun] could not reap stale runs:', reapError)
  }

  // THE MUTEX, HALF TWO: take the lock, atomically.
  const { data, error: openError } = await supabaseAdmin
    .from('sync_runs')
    .insert({
      source: input.source,
      client_id: input.clientId ?? null,
      mode: input.mode,
      window_start: input.windowStart ?? null,
      window_end: input.windowEnd ?? null,
      status: 'running',
    })
    .select('id')
    .maybeSingle()

  // The expected, non-alarming outcome for the loser of an overlapping pair.
  // Checked BEFORE the generic branch so a lock loss can never be reported as
  // a database failure. See isLockConflict() for why this is matched on the
  // SQLSTATE and not on the message.
  if (isLockConflict(openError)) {
    throw new SyncRunLockedError(input.source, input.clientId ?? null)
  }

  if (openError) {
    console.error('[openSyncRun] could not create sync_runs row:', openError)
    throw new Error(
      `openSyncRun(${input.source}): could not create the sync_runs row, so this `
      + `run holds no lock and must not proceed: ${messageOf(openError)}`,
      { cause: openError })
  }

  // A successful insert with no row back is the same hazard wearing different
  // clothes: `data?.id ?? null` used to turn it into a null id, which is
  // indistinguishable from the error case above and just as unlocked. PostgREST
  // can return this when the insert is filtered out of the representation, so
  // it is not merely theoretical.
  const id: string | undefined = data?.id ?? undefined
  if (!id) {
    throw new Error(
      `openSyncRun(${input.source}): the sync_runs insert reported no error but `
      + `returned no id, so this run holds no lock and must not proceed.`)
  }

  return {
    id,
    seen(n = 1) { rowsSeen += n },
    wrote(n = 1) { rowsWritten += n },
    fail(context, err) { errors.push(context, err) },
    warn(context, detail) { errors.warn(context, detail) },
    async close(status) {
      const resolved =
        status ?? (errors.count() === 0 ? 'ok'
                 : rowsWritten > 0 ? 'partial' : 'failed')
      // No `if (!id) return` any more. That early return was the second half of
      // the same defect: with no row, close() threw away errors.list() -- every
      // failure the run had recorded -- and reported nothing. `id` is now
      // guaranteed by openSyncRun, which throws rather than returning a handle
      // without one.
      const { supabaseAdmin: db } = await import('@/lib/supabase')
      const { error: closeError } = await db.from('sync_runs').update({
        finished_at: new Date().toISOString(),
        status: resolved,
        rows_seen: rowsSeen,
        rows_written: rowsWritten,
        errors: errors.list(),
      }).eq('id', id)
      if (closeError) console.error('[close] could not update sync_runs row:', closeError)
    },
  }
}

