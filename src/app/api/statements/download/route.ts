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
import {
  readOrderNumbers, readShipmentFacts, shipmentIdFromChargeKey,
  factsByShipmentId, buildShipmentLines, unmatchedParcelNote,
} from '@/lib/billing/statement-detail'
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
//
// THREE SHEETS, ONE SOURCE OF MONEY.
//
//   Statement  the rolled-up lines, the TOTAL, and the notes.
//   Charges    every charge row behind those lines, with its order number.
//   Shipments  the parcel behind every freight charge: carrier, service,
//              tracking, weight, destination.
//
// Every amount on all three comes from `order_charges` and nowhere else, so the
// sheets arithmetically agree by construction rather than by review. The order
// number and the parcel facts are joined on in statement-detail.ts, which
// documents at length why `shipments.client_rate` -- which looks exactly like
// the per-parcel billed amount -- is not it.
//
// What is NOT here, deliberately: `actual_cost`, `profit_loss`, and anything
// else describing what we paid the carrier or made on the parcel. This file is
// emailed to the client. The internal counterpart lives behind /reports.

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

/**
 * Long enough for a YEAR of charges, because the dropdown now offers one.
 *
 * This route's cost is not one query, it is a serial chain of round trips, and
 * the chain grows with the period. Counted off the code:
 *
 *   charges    readAllPages over order_charges   ceil(C / 1000) + 1
 *   orders     readChunked, 150 ids per request  2 * ceil(Uo / 150)
 *   shipments  readChunked, 150 ids per request  2 * ceil(Us / 150)
 *
 * The 2 is not a typo. `readChunked` calls `readAllPages` per chunk, a chunk
 * can return at most 150 rows because both join keys are unique, and 150 is
 * under PAGE_SIZE -- so every chunk pays one request for its rows and one more
 * for the empty page that proves there are no others. The orders and shipments
 * reads overlap in a Promise.all, but the chunks WITHIN each are awaited one at
 * a time, so the wall clock follows the longer of the two.
 *
 * At a few thousand orders that is tens of requests and a couple of seconds,
 * which is why 'month' has been fine on the default budget. A year is the same
 * arithmetic with a bigger Uo: twenty thousand orders is ~270 serial round
 * trips, which is comfortably over Vercel's default and lands as a killed
 * function -- a JSON error behind a fetch() on a download button, which reads
 * to whoever clicked it as "the button is broken" and gets worked around by
 * asking someone to send the numbers by hand.
 *
 * 300 to match /api/agent/monitor, the other long read in this app. Raising the
 * ceiling and not touching the reads is deliberate: making `readChunked`
 * concurrent would cut the wall clock, but it would also rewrite the
 * discard-on-error rule on a money-path read to make a once-a-period download
 * faster. Wrong trade. The slow correct version is the one that ships.
 */
export const maxDuration = 300

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

  // ---- The two lookups that turn the detail into something checkable ----
  //
  // Driven by the charges that were just read, not by a date window of their
  // own, which is why they cannot widen or narrow the period the file is headed
  // with. Both are reads of FACTS -- an order number, a carrier, a tracking
  // number -- and neither contributes an amount: every figure in this workbook
  // still comes from `order_charges`. See statement-detail.ts for why
  // `shipments.client_rate` is not safe to put beside it.
  //
  // Only shipping charges are asked about. A pick line has no parcel, and
  // `charge_key` namespaces other than `shipment:<id>` are deliberately not
  // matched (a `return:` is not the shipment it reverses).
  const orderIds = charges.flatMap(c => c.order_id === null ? [] : [c.order_id])
  const shipmentIds = charges.flatMap(c => {
    if (c.charge_type !== 'shipping') return []
    const id = shipmentIdFromChargeKey(c.charge_key)
    return id === null ? [] : [id]
  })

  const [ordersRes, factsRes] = await Promise.all([
    readOrderNumbers(orderIds),
    readShipmentFacts(shipmentIds),
  ])
  // Refused as hard as the charges read, and for the same reason. A workbook
  // whose Order column is blank for half its rows does not read as "the join
  // failed" -- it reads as charges we cannot attribute to an order, which is a
  // claim about the ledger rather than about our read of it.
  if (ordersRes.error) return unreadable('order numbers', ordersRes.error.message)
  if (factsRes.error) return unreadable('shipment details', factsRes.error.message)

  const orderNumbers = new Map(
    (ordersRes.data ?? []).map(o => [o.id, o.order_number] as const),
  )
  const facts = factsByShipmentId(factsRes.data ?? [])
  const { lines: shipmentLines, unmatched } = buildShipmentLines(
    charges, orderNumbers, facts,
  )

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
    // On sheet 1 and not only on sheet 3, because a blank carrier column is
    // noticed by whoever opens the file first, and the one sentence that
    // explains it has to be where they are looking.
    unmatchedParcelNote(unmatched),
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
  //
  // The Order column is first after the date, because "which orders is this
  // for?" is the question a client asks of a total before any other, and an
  // unattributed charge shows an empty cell rather than being dropped -- a
  // charge missing from the sheet is a charge missing from the explanation of a
  // total it is still inside.
  const detail = charges.map(c => ({
    'Date': c.charge_date,
    'Order': c.order_id === null ? '' : orderNumbers.get(c.order_id) ?? '',
    'Charge': c.charge_type,
    'Line': c.label,
    'Quantity': moneyCell(priceOf(c.quantity)),
    'Rate': moneyCell(priceOf(c.unit_rate)),
    'Amount ($)': moneyCell(priceOf(c.amount)),
    'Priced from an assumed rate': c.is_estimate === true ? 'yes' : 'no',
  }))

  // ---- Sheet 3: the parcel behind every freight charge ----
  // Freight is the line clients query most and the only one whose unit is a
  // physical object, so "which parcel, what weight, going where" is answerable
  // from the file instead of from an email to us.
  //
  // One row per shipping CHARGE, so this sheet's Amount column sums to the
  // shipping figure on sheet 1. A sheet built by reading every shipment in the
  // window instead would include parcels the ledger has not billed, and would
  // then disagree with the total sitting two tabs away in the same file.
  const shipments = shipmentLines.map(line => ({
    'Ship Date': line.ship_date,
    'Order': line.order_number,
    'Carrier': line.carrier,
    'Service': line.service,
    'Tracking': line.tracking_number,
    'Weight (lb)': line.weight === null ? '' : line.weight,
    'Destination': line.destination,
    'Amount ($)': moneyCell(priceOf(line.amount)),
    // Says which blanks are a failed lookup rather than a parcel we have no
    // carrier for. Without it the two are indistinguishable in the cell.
    'Parcel record found': line.matched ? 'yes' : 'no',
  }))

  const wb = XLSX.utils.book_new()
  // Each empty sheet carries its OWN sentence. 'No charge rows in this period'
  // on a Shipments tab would be false for a client who was picked and packed
  // but shipped nothing -- there are charges, just no freight among them, and
  // the two are a different fact about the period.
  for (const [sheetName, rows, ifEmpty] of [
    ['Statement', summary, 'No charge rows in this period'],
    ['Charges', detail, 'No charge rows in this period'],
    ['Shipments', shipments, 'No shipping charges in this period'],
  ] as const) {
    // A detail sheet with no rows gets a header-only sheet rather than being
    // omitted: a missing tab reads as a feature that did not run, where an
    // empty one beside a summary saying 'no charges recorded' agrees with it.
    const ws = rows.length === 0
      ? XLSX.utils.aoa_to_sheet([[ifEmpty]])
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
