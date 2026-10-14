import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readOne } from '@/lib/db/read'
import {
  readStatementCharges, readEarliestChargeDate,
} from '@/lib/billing/statement-charges'
import {
  buildStatement, statementTotal, resolvePeriod,
} from '@/lib/billing/statement'
import {
  rateText, periodLabel, coverageNote, estimateNote,
} from '@/lib/billing/statement-view'
import { totalOrUnknown, unpricedNote } from '@/lib/billing/unpriced'

// One client's statement as JSON, for the Statement tab on /reports.
//
// WHY THIS ROUTE EXISTS AT ALL, GIVEN /statements ALREADY RENDERS ONE.
//
// /statements is a server component: it reads on the server and ships HTML, and
// its period comes from the URL. That is the right shape for a page whose whole
// job is one client's statement, and it keeps working with JavaScript disabled.
//
// /reports is the opposite shape. Six tabs share one client dropdown and one
// From/To pair held in React state, and five of them already have their rows
// pre-loaded by reports/page.tsx. Adding a seventh pre-loaded payload would mean
// reading EVERY client's charges on every page load to serve a tab that shows
// one client -- and reports/page.tsx refuses the whole screen when any one of
// its reads fails, so a slow or failing charges read would blank the five tabs
// that work today. Hence a read on demand, when the tab is opened and a client
// is chosen.
//
// WHAT IS SHARED, AND WHY IT HAS TO BE.
//
// Everything except the transport: readStatementCharges, resolvePeriod,
// buildStatement, rateText, and all four notes. The screen, this route and the
// .xlsx therefore cannot quote three different figures for the same client and
// period. A second query written for the tab is exactly how that divergence
// arrives, and it would surface as a client disputing a number that one of our
// own screens still displays, with nothing to say which was right.
//
// THE DISPLAY STRINGS ARE BUILT HERE, NOT IN THE COMPONENT.
//
// `rateText` and the notes are CLAIMS about money -- what rate a line was
// priced at, whether the period is covered, whether a figure was measured. They
// live in statement-view.ts because vitest.config.ts collects only
// `src/**/*.test.ts`, so the same sentence re-implemented inside a .tsx could
// not be given a test. Sending the finished strings keeps the tab from becoming
// the one place those claims are made untested.
//
// WHAT IS NOT HERE: `actual_cost`, `profit_loss`, and anything else about what
// we paid the carrier. Not because this response is sent to a client -- it is
// staff-only and /reports is explicitly the internal screen -- but because this
// is the statement, and the statement is defined as the client-facing document.
// The margin view lives on the Profit tab, built from `shipments` over on
// profit-rollup.ts. Two documents, two bases, each labelled as what it is.

/** A read failed, so there are no figures. Names the read. */
function unreadable(what: string, message: string) {
  return NextResponse.json({
    error: `No figures: ${what} could not be read (${message}). Nothing is `
      + `shown, so no total claims this period was empty. Retry, and if it `
      + `persists the figure is UNKNOWN rather than zero.`,
  }, { status: 502 })
}

/**
 * Long enough for a YEAR, same as the download route.
 *
 * This is a serial chain of round trips whose length grows with the period --
 * `readAllPages` over `order_charges` is ceil(C / 1000) + 1 requests. The tab
 * offers whatever dates the operator types into /reports' From and To, so the
 * period is not bounded by a dropdown of five grains here.
 *
 * Cheaper than the download route by construction: it does NOT run the order
 * -number and shipment-fact joins, which are the two `readChunked` loops that
 * dominate that route's cost. The screen shows rolled-up lines, and the detail
 * is what the spreadsheet is for.
 */
export const maxDuration = 300

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const clientId = searchParams.get('client')

  if (clientId === null || clientId === '') {
    return NextResponse.json({
      error: 'A client is required. A statement with no client is not an empty '
        + 'statement, it is no statement.',
    }, { status: 400 })
  }

  const period = resolvePeriod({
    grain: searchParams.get('grain'),
    from: searchParams.get('from'),
    to: searchParams.get('to'),
  })
  if (!period.ok) return NextResponse.json({ error: period.error }, { status: 400 })
  const { range, grain } = period

  // Resolved, not trusted. An id matching no client would otherwise read every
  // table successfully, match nothing, and render a correctly-formatted
  // statement for nobody -- totalling $0.00, which reads as a quiet period.
  const clientRes = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('id', clientId)
    .single()
  const client = readOne('client', clientRes)
  if (client.error !== null) return unreadable('clients', client.error)
  if (client.row === null) {
    return NextResponse.json({
      error: `No client has id ${JSON.stringify(clientId)}. No statement was `
        + `built, because it would total $0.00 and look like a quiet period.`,
    }, { status: 404 })
  }

  const [chargesRes, earliestRes] = await Promise.all([
    readStatementCharges(clientId, range),
    readEarliestChargeDate(clientId),
  ])
  if (chargesRes.error) return unreadable('order_charges', chargesRes.error.message)
  if (earliestRes.error) {
    // Refused as hard as the charges read. This read is the only thing that
    // decides whether a $0.00 total means "nothing happened" or "we have no
    // record", and showing the total without it puts the confident reading of
    // an ambiguous figure on screen beside a Download button.
    return unreadable("the client's earliest charge", earliestRes.error.message)
  }

  const earliestRows = earliestRes.data ?? []
  const earliest = earliestRows.length === 0 ? null : earliestRows[0].charge_date

  const statement = buildStatement(chargesRes.data ?? [], range)

  return NextResponse.json({
    client: { id: client.row.id, name: client.row.name },
    from: range.from,
    to: range.to,
    period: periodLabel(grain, range),
    lines: statement.lines.map(line => ({
      charge_type: line.charge_type,
      label: line.label,
      quantity: line.quantity,
      // The rendered string and not the raw rate, because 'at cost', 'N rates'
      // and the unknown dash are three different sentences and rateText is
      // where the difference between them is tested.
      rate: rateText(line),
      // `null` for a line whose every row is UNPRICED, and the JSON `null`
      // survives the wire as null -- which the tab renders as a dash. A 0 here
      // would be indistinguishable from a line carried free.
      amount: totalOrUnknown(line.sum),
      unpriced: line.sum.unpriced,
      counted: line.sum.counted,
      estimated: line.estimated,
    })),
    total: statementTotal(statement),
    unpriced: statement.sum.unpriced,
    counted: statement.sum.counted,
    estimated: statement.estimated,
    // The caveats travel WITH the figures, as the spreadsheet's do. A note that
    // only the /statements page knows how to build does not exist on this tab,
    // and the figure it qualifies would be read without it.
    notes: [
      coverageNote(earliest, range),
      unpricedNote(statement.sum.unpriced, 'charge'),
      estimateNote(statement.estimated),
    ].filter(n => n !== ''),
  })
}
