// Turning a RecalculateStats into something a human acts on.
//
// WHY THIS FILE EXISTS.
//
// src/lib/billing/recalculate.ts does the hard part: when it cannot price a
// shipment it records WHY, counted by reason, with an example order number for
// each. Its own comment at the `reasons` field says what that is for:
//
//   "an unpriced shipment says what is missing from the rate card; a bare
//    total would be the old `unmatched` count wearing a new name"
//
// The dashboard button then rendered the bare total. `reasons` was computed on
// every run and dropped on the floor; the only other path to it was the
// monitor email, and MONITOR_EMAIL has been unset since 2026-10-15. So the one
// artifact that says which rate cards are incomplete was produced several
// times a day and never seen by anybody. That is why nobody could answer
// "which rates are missing?" from inside the system.
//
// Two more fields were equally invisible and matter more than `unmatched`:
//
//   skipped -- rows deliberately NOT written because an input could not be
//     read. Not a gap in the rate card; a read that failed. Acting on it means
//     re-running, not editing prices.
//   failed  -- rows whose write was ATTEMPTED AND DID NOT LAND. The database
//     disagrees with what the run thinks it did. This is the only one of the
//     six counts that means the screen you are looking at may be stale.
//
// The logic lives here rather than in SyncButton.tsx because vitest.config.ts
// excludes `.test.tsx`, so nothing in a component can be asserted. A severity
// rule that paints a run with 218 unrated shipments green is exactly the class
// of bug this project keeps finding (see the `null >= 0` note in
// profit-triple-parity.test.ts), and it has to be testable to stay fixed.

/** One reason a shipment could not be priced, as counted by recalculate.ts. */
export interface RecalcReason {
  reason: string
  count: number
  example: string
}

/**
 * The parts of RecalculateStats this file reads.
 *
 * Structurally typed and NOT imported from ./recalculate, because that module
 * pulls in supabaseAdmin and this one is consumed by a client component. Every
 * field but `updated` is optional: an older deployment's response, or a 500
 * body, must degrade to "unknown" rather than to 0 — a missing `failed` count
 * is not the same claim as `failed: 0`.
 */
export interface RecalcStatsLike {
  updated?: number | null
  zone_matched?: number | null
  legacy_matched?: number | null
  unmatched?: number | null
  skipped?: number | null
  failed?: number | null
  reasons?: RecalcReason[] | null
}

/** A count that is absent reads as unknown, never as zero. */
function count(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * How loudly to report the run.
 *
 * `showSuccess` is green and auto-dismisses in 4 seconds. That is the right
 * container for "nothing needs you" and the wrong one for anything else, which
 * is the whole reason this function exists instead of a literal.
 *
 *   'error'   a write did not land, so the data is not what the run says.
 *   'warning' the run worked and found something you have to fix: shipments
 *             with no price, or rows it could not read.
 *   'success' everything priced, nothing withheld.
 *
 * An UNKNOWN `failed` or `unmatched` is treated as a warning, not a success.
 * A response that cannot tell you whether writes landed has not told you they
 * did.
 */
export function recalcSeverity(stats: RecalcStatsLike): 'error' | 'warning' | 'success' {
  const failed = count(stats.failed)
  if (failed === null || failed > 0) return failed === null ? 'warning' : 'error'

  const unmatched = count(stats.unmatched)
  const skipped = count(stats.skipped)
  if (unmatched === null || skipped === null) return 'warning'
  if (unmatched > 0 || skipped > 0) return 'warning'

  // `reasons` can be non-empty while unmatched and skipped are both 0 only if
  // the caller hands us an inconsistent body; believe the detail over the
  // totals, because the detail is what names a real shipment.
  if ((stats.reasons?.length ?? 0) > 0) return 'warning'

  return 'success'
}

/** `3` -> "3", null -> "?" — so a missing count is visibly missing. */
function fig(n: number | null): string {
  return n === null ? '?' : String(n)
}

/**
 * The one-line summary. Every count recalculate.ts returns appears here,
 * including the two that the old toast omitted.
 */
export function recalcSummary(stats: RecalcStatsLike): string {
  const parts = [
    `${fig(count(stats.updated))} repriced`,
    `${fig(count(stats.zone_matched))} by zone`,
    `${fig(count(stats.legacy_matched))} by rate card`,
  ]
  const unmatched = count(stats.unmatched)
  const skipped = count(stats.skipped)
  const failed = count(stats.failed)
  if (unmatched !== 0) parts.push(`${fig(unmatched)} unpriced`)
  if (skipped !== 0) parts.push(`${fig(skipped)} skipped (unreadable)`)
  if (failed !== 0) parts.push(`${fig(failed)} WRITE FAILED`)
  return parts.join(' · ')
}

/**
 * The gap list, worst first.
 *
 * Sorted by count descending so the rate card costing you the most rows is at
 * the top; ties broken by reason text so the order is stable between runs and
 * two screenshots can be compared. Rows with a non-positive count are dropped:
 * a reason nothing matched is not a gap.
 */
export function recalcGaps(stats: RecalcStatsLike): RecalcReason[] {
  return [...(stats.reasons ?? [])]
    .filter(r => r && typeof r.count === 'number' && r.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

/**
 * Does the run need a human at all? Drives whether the panel renders.
 *
 * Deliberately not `recalcSeverity(stats) !== 'success'`: a run can be a
 * warning because a count was missing from the body, which is worth a toast
 * but gives a panel nothing to list.
 */
export function hasRecalcGaps(stats: RecalcStatsLike): boolean {
  if (recalcGaps(stats).length > 0) return true
  const failed = count(stats.failed)
  return failed !== null && failed > 0
}
