// A sync run that fails silently is indistinguishable from one that had
// nothing to do. sync_runs makes the difference recordable, and collectErrors
// keeps what went wrong rather than only how often.

const MAX_STORED_ERRORS = 50

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

export function collectErrors() {
  const stored: Array<{ context: string; message: string }> = []
  let n = 0
  return {
    push(context: string, err: unknown) {
      n++
      if (stored.length < MAX_STORED_ERRORS) {
        stored.push({ context, message: messageOf(err) })
      }
    },
    list() { return stored },
    count() { return n },
  }
}

export interface SyncRunHandle {
  id: string | null
  seen(n?: number): void
  wrote(n?: number): void
  fail(context: string, err: unknown): void
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
    async close(status) {
      const resolved =
        status ?? (errors.count() === 0 ? 'ok'
                 : rowsWritten > 0 ? 'partial' : 'failed')
      if (!id) return
      const { supabaseAdmin: db } = await import('@/lib/supabase')
      await db.from('sync_runs').update({
        finished_at: new Date().toISOString(),
        status: resolved,
        rows_seen: rowsSeen,
        rows_written: rowsWritten,
        errors: errors.list(),
      }).eq('id', id)
    },
  }
}

