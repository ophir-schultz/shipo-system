// Prevents two charge-calculation runs from overlapping.
//
// Recalculation deletes charges whose calculated_at predates the current run.
// If a second run starts while the first is still writing, the second's cutoff
// is LATER than the first's fresh rows, so it deletes them. The order loses
// charges, the next run restores them, and nothing ever errors — the ledger
// simply oscillates. See persist-charges.ts for the second defence.

export const STALE_RUN_MINUTES = 30

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
