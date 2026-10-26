// What a printed report has to say about itself.
//
// WHY THIS EXISTS.
//
// The PDF button on /reports is `window.print()`, and until 2026-10-26 there
// was not one `@media print` rule in the repo. So it printed the application:
// sidebar, filter bar, tab strip, buttons, and the report somewhere inside.
//
// The dangerous part was not that it looked wrong. It was that the filter bar
// is where the screen states its own scope -- which client, which dates -- and
// those are form controls. Print the page and the controls go with the rest of
// the chrome, leaving a table of figures with NOTHING on it saying whose they
// are or what period they cover. Hand that to a client, or file it, and there
// is no way to tell afterwards what you were looking at. It is the same defect
// as every other one found this week: a document that looks complete and does
// not say what it omits.
//
// So the scope moves out of the controls and into the document. This builds
// that header, and it is a pure function here rather than JSX in the component
// because vitest.config.ts excludes `.test.tsx` -- a heading rendered inline
// could not be asserted, and "the client name is right" is exactly the claim
// worth pinning.

export interface ReportHeadingInput {
  /** The tab's own label, e.g. 'Shipments'. */
  tabLabel: string
  /** '' means every client, which the heading must SAY rather than imply. */
  clientId: string
  clients: Array<{ id: string; name: string | null }>
  dateFrom: string
  dateTo: string
  /** Injected so the heading is testable; the component passes new Date(). */
  generatedAt: Date
}

export interface ReportHeading {
  title: string
  /** Which client, in words. Never blank. */
  scope: string
  /** Which dates, in words. Never blank. */
  period: string
  /** When this sheet of paper was produced. */
  generated: string
}

/** ISO yyyy-mm-dd, or the input unchanged when it is not a date we can read. */
function day(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * The four lines a printed report carries.
 *
 * Every one of them is non-empty by construction. An absent client is "All
 * clients" and not ''; an absent date is "not specified" and not a blank gap
 * where a date should be. A heading with a hole in it reads as a rendering
 * glitch, and a reader who decides the header is broken stops trusting the
 * table under it -- so the unknown cases are written out rather than omitted.
 */
export function reportHeading(input: ReportHeadingInput): ReportHeading {
  const { tabLabel, clientId, clients, dateFrom, dateTo, generatedAt } = input

  // Matched on id, never on name. Two clients may share a name, and the
  // export filters on the id -- so the heading must name the same thing the
  // figures were filtered by, or it describes a different report.
  const match = clientId === '' ? null : clients.find((c) => c.id === clientId)

  const scope = clientId === ''
    ? 'All clients'
    // A client id that matches nothing is NOT silently rendered as every
    // client: the table below it is filtered to that id and will be empty,
    // and "All clients" over an empty table is a contradiction the reader
    // would resolve as "we shipped nothing", which is a different claim.
    : (match?.name?.trim() || `Unknown client (${clientId})`)

  const from = day(dateFrom)
  const to = day(dateTo)
  const period = from && to
    ? `${from} to ${to}`
    : from ? `From ${from}`
    : to ? `Up to ${to}`
    : 'Period not specified'

  return {
    title: `${tabLabel} report`,
    scope,
    period,
    generated: `Generated ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  }
}
