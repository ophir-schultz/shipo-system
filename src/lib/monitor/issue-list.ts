// Presenting what the monitor found, once, instead of once per finding.
//
// WHY THIS FILE EXISTS.
//
// AutoSync did this, every five minutes, for the life of the page:
//
//   for (const issue of next.issues) showError('Monitor alert', issue)
//
// One red toast per finding. On 2026-10-23 the monitor reported eleven, so
// eleven stacked red toasts covered the dashboard -- the screen you open to
// read the numbers, unreadable because of the alert about the numbers. They
// auto-dismiss after eight seconds, so the list you most need to act on is
// also the one that disappears, and it came back on the next poll whether or
// not anything had changed.
//
// It is the same error as the recalculation toast fixed earlier the same day
// (see src/lib/billing/recalc-report.ts): the right information in a container
// that cannot hold it. A toast is for "this happened just now, and you need
// not do anything". A list of shipments nobody has agreed a price for is
// neither of those.
//
// So the count lives in the widget permanently and the list opens on click.
// Nothing auto-dismisses, nothing stacks, and the state on screen is the state
// of the system rather than a moment of it.
//
// The logic is here rather than in AutoSync.tsx because vitest.config.ts
// excludes `.test.tsx`, so nothing asserted about a component would run.

export interface MonitorIssueSummary {
  /** Distinct findings, in the order the monitor reported them. */
  items: string[]
  count: number
  /** For the widget: "11 issues", "1 issue", or '' when there are none. */
  label: string
}

/**
 * Collapse the monitor's findings into something a header can show.
 *
 * Exact duplicates are dropped. The monitor groups by reason already, so a
 * repeat means the same finding arrived twice in one payload -- counting it
 * twice would overstate the work without naming any more of it. Order is
 * preserved rather than sorted: the route emits worst-first, and resorting
 * here would quietly override a judgement made with more context than this
 * function has.
 *
 * Blank and non-string entries are dropped. An empty bullet is not a finding,
 * and rendering one puts an item on the list that nobody can act on or match
 * to a shipment.
 */
export function summariseMonitorIssues(issues: unknown): MonitorIssueSummary {
  const seen = new Set<string>()
  const items: string[] = []

  if (Array.isArray(issues)) {
    for (const raw of issues) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      items.push(text)
    }
  }

  return {
    items,
    count: items.length,
    // Singular matters more than it looks: "1 issues" reads as a template that
    // was never finished, which is exactly the impression a money screen does
    // not want to give about its own alerting.
    label: items.length === 0 ? '' : `${items.length} issue${items.length === 1 ? '' : 's'}`,
  }
}
