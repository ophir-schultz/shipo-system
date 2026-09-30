// A sync run that fails silently is indistinguishable from one that had
// nothing to do. sync_runs makes the difference recordable, and collectErrors
// keeps what went wrong rather than only how often.

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

export interface SyncRunHandle {
  id: string | null
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

  // If the bookkeeping row cannot be written, the sync still runs. Losing the
  // audit trail is bad; refusing to sync because of it is worse. We log the
  // error rather than silently eating it; the sync_runs row will just be absent.
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

  if (openError) console.error('[openSyncRun] could not create sync_runs row:', openError)

  const id: string | null = data?.id ?? null

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
      if (!id) return
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

