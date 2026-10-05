// Prevents two charge-calculation runs from overlapping.
//
// Recalculation deletes charges whose calculated_at predates the current run.
// If a second run starts while the first is still writing, the second's cutoff
// is LATER than the first's fresh rows, so it deletes them. The order loses
// charges, the next run restores them, and nothing ever errors — the ledger
// simply oscillates. See persist-charges.ts for the second defence.

export const STALE_RUN_MINUTES = 30

/**
 * The instant before which a still-'running' row is presumed abandoned.
 *
 * Derived from STALE_RUN_MINUTES rather than restated, because this value and
 * canStart() below now have to agree EXACTLY. canStart is the advisory
 * pre-check that keeps the common case free of exceptions; this cutoff is what
 * openSyncRun() reaps with before it takes the database-level lock. If the two
 * drifted apart, the gap between them would be a band of ages in which
 * canStart says "blocked" while the reaper has already cleared the row, or the
 * reverse -- canStart waves a run through and the index then refuses it. Both
 * are confusing rather than dangerous, and both are avoidable by having one
 * number.
 *
 * Returned as an ISO string because its only consumer is a PostgREST `lt`
 * filter, which compares timestamptz as text.
 */
export function staleRunCutoffISO(now: Date): string {
  return new Date(now.getTime() - STALE_RUN_MINUTES * 60_000).toISOString()
}

/**
 * Is this the unique-index refusal that means "another run already holds the
 * lock", as opposed to a genuine database failure?
 *
 * The distinction is the whole point of the mutex. 23505 here is the NORMAL,
 * EXPECTED outcome for the losing run of an overlapping pair -- it means the
 * lock worked. Every other error means we could not tell, and the callers
 * treat the two completely differently: a lock loss is a quiet skip, anything
 * else is reported. Conflating them would either hide real breakage behind
 * "someone else is running" or fire a false alarm on every overlap, and the
 * monitor is polled every five minutes from every open tab, so a false alarm
 * there is an alarm nobody reads within a day.
 *
 * Matched on the code, never the message: Postgres message text for a unique
 * violation names the index and is not stable across versions or renames.
 */
export function isLockConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === '23505'
}

export function canStart(
  openRuns: Array<{ started_at: string; status: string }>,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  for (const r of openRuns ?? []) {
    if (r.status !== 'running') continue

    const started = new Date(r.started_at).getTime()
    // A run whose timestamp we cannot read must not block every future run.
    if (!Number.isFinite(started)) continue

    const ageMinutes = (now.getTime() - started) / 60_000
    if (ageMinutes < STALE_RUN_MINUTES) {
      return {
        ok: false,
        reason: `A charge run started ${ageMinutes.toFixed(1)} minutes ago is `
              + `still in progress. Skipping this one.`,
      }
    }
  }
  return { ok: true }
}
