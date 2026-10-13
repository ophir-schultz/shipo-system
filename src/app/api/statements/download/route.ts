import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readOne } from '@/lib/db/read'
import {
  readStatementCharges, readEarliestChargeDate,
} from '@/lib/billing/statement-charges'
import {
  periodRange, buildStatement, statementTotal, statementToday, isGrain, GRAINS,
} from '@/lib/billing/statement'
import {
  rateText, periodLabel, coverageNote, estimateNote,
} from '@/lib/billing/statement-view'
import { priceOf, totalOrUnknown, unpricedNote, UNPRICED_CELL } from '@/lib/billing/unpriced'

// The statement as a spreadsheet, built from the same read the screen uses.
//
// Same loader, same buildStatement, same sentences -- so a client who is sent
// this file and then shown the screen cannot be given two different answers.
// A second read written for the export is how that divergence happens, and the
// disagreement would surface as a client disputing a figure with nothing to say
// which of our own two numbers was right.
//
// WHY IT REFUSES RATHER THAN WRITING AN EMPTY WORKBOOK.
//
// This file gets attached to an email. It outlives the outage, outlives the
// session, and is read later as evidence about a period -- so a workbook built
// from a failed read is not an empty file, it is a false record, and a client
// invoiced from it is invoiced wrongly in writing. The same argument the reports
// route's header makes at length; the conclusion is the same and so is the shape
// of the refusal.
//
// An EMPTY PERIOD, by contrast, is a real answer and gets a real file. A client
// with no charges this week genuinely has none, and the sheet says so in words
// -- with the coverage note beside it, because "no charges recorded" and "no
// charges happened" are not the same sentence and only the ledger's earliest
// charge date can tell them apart.

/** A read failed, so there is no file. Names the read. */
function unreadable(what: string, message: string) {
  return NextResponse.json({
    error: `No file was written: ${what} could not be read (${message}). `
      + `Nothing was exported, so no spreadsheet claims this period was empty. `
      + `Retry, and if it persists the figure is UNKNOWN rather than zero.`,
  }, { status: 502 })
}

/**
 * A money cell: the number, or the word UNPRICED.
 *
 * Deliberately not `?? 0`. A line billed at cost whose carrier has not reported
 * is UNKNOWN, and a 0 in a spreadsheet column is a figure SUM() will happily
 * add -- so the one row that should stop the total from being trusted is the
 * one row that silently completes it. Text is skipped by SUM(), which is the
 * honest arithmetic.
 */
function moneyCell(value: number | null): number | string {
  return value === null ? UNPRICED_CELL : value
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const clientId = searchParams.get('client')
  const grain = searchParams.get('grain')

  // Both validated before any read, and answered with a 400 rather than a
  // workbook. A bad request is where an empty sheet misleads most: the client
  // name and period in the filename are whatever was asked for, so the file
  // looks like an answer to the question that was actually posed.
  if (clientId === null || clientId === '') {
    return NextResponse.json({
      error: 'No file was written: a client is required. A statement with no '
        + 'client is not an empty statement, it is no statement.',
    }, { status: 400 })
  }
  if (!isGrain(grain)) {
    return NextResponse.json({
      error: `No file was written: unknown period ${JSON.stringify(grain)}. `
        + `Expected one of ${GRAINS.join(', ')}. An unrecognised period would `
        + `otherwise fall through to a year, and a year of revenue under a `
        + `heading that says week is the worst wrong answer this route can give.`,
    }, { status: 400 })
  }

  // The client is resolved, not trusted. An id that matches no client would
  // otherwise read every table successfully, match nothing, and produce a
  // correctly-formatted statement for nobody -- headed with whatever id was in
  // the link and totalling $0.00.
  const clientRes = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('id', clientId)
    .single()
  const client = readOne('client', clientRes)
  if (client.error !== null) return unreadable('clients', client.error)
  if (client.row === null) {
    return NextResponse.json({
      error: `No file was written: no client has id ${JSON.stringify(clientId)}. `
        + `A statement was not built for an unknown client, because it would `
        + `total $0.00 and look like a quiet period.`,
    }, { status: 404 })
  }
  const { name } = client.row

  const range = periodRange(grain, statementToday())

  const [chargesRes, earliestRes] = await Promise.all([
    readStatementCharges(clientId, range),
    readEarliestChargeDate(clientId),
  ])
  if (chargesRes.error) return unreadable('order_charges', chargesRes.error.message)
  if (earliestRes.error) {
    // Refused as hard as the charges read. This read is what decides whether a
    // $0.00 total means "nothing happened" or "we have no record", and shipping
    // the total without it puts the confident reading of an ambiguous figure
    // into a file addressed to a client.
    return unreadable("the client's earliest charge", earliestRes.error.message)
  }

  const charges = chargesRes.data ?? []
  const earliest = (earliestRes.data ?? []).length === 0
    ? null
    : (earliestRes.data ?? [])[0].charge_date
  const statement = buildStatement(charges, range)
  const total = statementTotal(statement)

  // ---- Sheet 1: the statement as the client would read it ----
  const summary: Array<Record<string, string | number>> = statement.lines.map(line => ({
    'Charge': line.charge_type,
    'Line': line.label,
    'Units': line.quantity === null ? '' : line.quantity,
    'Rate': rateText(line),
    'Amount ($)': moneyCell(totalOrUnknown(line.sum)),
    'Unpriced rows': line.sum.unpriced,
    'Estimated rows': line.estimated,
  }))

  if (summary.length === 0) {
    // A real statement about a real empty period. Says which period, and says
    // it in words rather than leaving a reader to infer it from a blank sheet.
    summary.push({
      'Charge': '',
      'Line': `No charges recorded for ${name} in ${periodLabel(grain, range)}.`,
      'Units': '',
      'Rate': '',
      'Amount ($)': 0,
      'Unpriced rows': 0,
      'Estimated rows': 0,
    })
  } else {
    summary.push({
      'Charge': '',
      'Line': 'TOTAL',
      'Units': '',
      'Rate': '',
      'Amount ($)': moneyCell(total),
      'Unpriced rows': statement.sum.unpriced,
      'Estimated rows': statement.estimated,
    })
  }

  // The caveats travel WITH the figures, in the same sheet, below the total.
  // A note that only exists on the screen does not survive the download, and
  // this file is the artefact that gets read six weeks later.
  const notes = [
    coverageNote(earliest, range),
    unpricedNote(statement.sum.unpriced, 'charge'),
    estimateNote(statement.estimated),
  ].filter(n => n !== '')

  for (const note of notes) {
    summary.push({
      'Charge': 'NOTE', 'Line': note, 'Units': '', 'Rate': '',
      'Amount ($)': '', 'Unpriced rows': '', 'Estimated rows': '',
    })
  }

  // ---- Sheet 2: every charge row behind those lines ----
  // The detail is what makes the summary checkable. A client disputing a figure
  // is asking "which days", and without this sheet the only answer is to
  // re-run the query by hand.
  const detail = charges.map(c => ({
    'Date': c.charge_date,
    'Charge': c.charge_type,
    'Line': c.label,
    'Quantity': moneyCell(priceOf(c.quantity)),
    'Rate': moneyCell(priceOf(c.unit_rate)),
    'Amount ($)': moneyCell(priceOf(c.amount)),
    'Priced from an assumed rate': c.is_estimate === true ? 'yes' : 'no',
  }))

  const wb = XLSX.utils.book_new()
  for (const [sheetName, rows] of [
    ['Statement', summary],
    ['Charges', detail],
  ] as const) {
    // A detail sheet with no rows gets a header-only sheet rather than being
    // omitted: a missing tab reads as a feature that did not run, where an
    // empty one beside a summary saying 'no charges recorded' agrees with it.
    const ws = rows.length === 0
      ? XLSX.utils.aoa_to_sheet([['No charge rows in this period']])
      : XLSX.utils.json_to_sheet(rows as Array<Record<string, unknown>>)
    const first = rows[0]
    ws['!cols'] = first === undefined
      ? [{ wch: 40 }]
      : Object.keys(first).map(k => ({ wch: Math.max(k.length, 14) }))
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  // The filename carries the client and the actual dates, not the grain word.
  // 'statement-week.xlsx' sitting in a downloads folder beside last week's copy
  // is two files with one name and no way to tell which period either covers.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const filename = `statement-${slug || 'client'}-${range.from}-to-${range.to}.xlsx`

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
