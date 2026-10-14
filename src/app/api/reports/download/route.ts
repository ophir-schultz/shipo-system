import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import * as XLSX from 'xlsx'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
// `priceOf` is no longer imported here. The profit-loss branch was its only
// consumer in this file, and that branch now goes through profit-rollup, which
// calls priceOf itself on every column before any arithmetic. The per-shipment
// sheets never needed it: they pass `client_rate` and `actual_cost` straight
// into cells, where a null arrives as a blank rather than as 0.00, which is
// already the honest rendering.
import { isReportType, REPORT_TYPES } from '@/lib/billing/report-types'
import {
  combineReconciled, marginPct, reconcile, reconciledOrUnknown,
} from '@/lib/billing/profit-rollup'

// The per-shipment sheets pass `s.client_rate` straight through, which is
// already honest: a null arrives in the cell as a blank, not as 0.00. The
// profit-loss roll-up below was not -- `+= s.client_rate ?? 0` folded an
// unpriced shipment into the client's revenue as nothing while still counting
// it in 'Total Shipments', so the spreadsheet's own two columns disagreed and
// the file gave no way to tell. Unpriced lines now get their own column, so the
// number is still there to be added up and the omission travels with it.
//
// WHY THIS ROUTE REFUSES INSTEAD OF RETURNING AN EMPTY WORKBOOK.
//
// Every branch below used to read `const { data } = await q`, discarding the
// error. A failed read therefore produced `rows = []`, and the tail of this
// function turns `[]` into a one-row sheet reading
//
//     No Data | No records found for the selected period
//
// So a database that was unreachable for one second produced a .xlsx that
// AFFIRMATIVELY STATED there was nothing to bill, for whatever client and month
// was selected. That is not an empty file, it is a false record, and
// reports/page.tsx already says why it is the worst possible artefact to get
// wrong: a spreadsheet "outlives the outage, outlives the session, gets
// attached to an email", and is then read as evidence that the period was
// genuinely quiet.
//
// That page refuses before its export button renders. It cannot help here --
// the browser requests this URL directly, so the page's gate is not in the
// path, and a truncated or failed read inside THIS function is the one the file
// is built from.
//
// ReportsTabs.handleDownload already checks `res.ok` and shows `data.error`, so
// a non-2xx with a JSON body surfaces as "Download failed: <reason>" and no
// file is written. The client side was always ready for a route that says no.
//
// WHY EVERY READ IS PAGED, EVEN THOUGH THE REFUSAL ABOVE EXISTS.
//
// The refusal catches a read that FAILED. It cannot catch a read that was
// TRUNCATED, and PostgREST truncates silently: every select here carried no
// .limit() and no .range(), so each one returned at most the server's
// `db-max-rows` -- 1000 by default -- as a 200 with `error: null`. The gate
// above passes it, every column maps correctly, and the workbook is a complete,
// well-formed, internally consistent record of the first thousand rows of the
// month, with nothing in the file or on the screen saying so.
//
// For a client over a thousand shipments in a period that is an invoice short by
// an unknown amount, in our favour or theirs, and it appears the moment the
// table crosses the cap without anything changing in this code. So the reads are
// paged via readAllPages, which keeps going until a page comes back empty.
//
// Each page builds a FRESH query, and each one ends its sort keys with
// `.order('id')`. The tiebreaker is not cosmetic: Postgres does not promise a
// stable row order between two OFFSET queries sorted on a non-unique column, and
// `ship_date` has thousands of ties. Without it, page two can repeat a row page
// one already returned and skip one it never did -- a billable line charged
// twice and another dropped, with the row count still looking plausible.

// The report types this route can build, and the guard for them, now live in
// @/lib/billing/report-types -- imported at the top of this file.
//
// They used to be declared right here, which is how 'profit-loss' came to be a
// working export that no tab could reach: this list had six entries and the tab
// list in ReportsTabs.tsx had five, with nothing relating them. The guard is
// still applied below, for the same reason as before -- an unrecognised `type`
// falls through all six branches and leaves `rows` empty, which the tail then
// renders as "No records found for the selected period", so a typo in a link
// produced a confident statement about a client's month. What changed is that
// the accepted set is now derived from the tabs instead of restated here, and
// report-types.test.ts fails if this route's branches and that list disagree.

/**
 * yyyy-mm-dd, which is what every branch's .gte()/.lte() assumes.
 *
 * The old code wrote `dateFrom!`, asserting a query parameter that the URL may
 * simply not carry. With it absent the filter became `.gte('ship_date', null)`:
 * `null >= anything` is NULL in SQL, never TRUE, so the comparison matched no
 * rows and the route reported an empty period rather than a bad request. Same
 * trap date-range.test.ts already documents for this file.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A read failed, so there is no file.
 *
 * Names the read, because six of them feed this route and "could not read" with
 * no subject tells the operator nothing about whether one table is unreachable
 * or the whole database is.
 */
function unreadable(what: string, message: string) {
  return NextResponse.json({
    error: `No file was written: ${what} could not be read (${message}). `
      + `Nothing was exported, so no spreadsheet claims this period was empty. `
      + `Retry, and if it persists the figure is UNKNOWN rather than zero.`,
  }, { status: 502 })
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const clientId = searchParams.get('clientId')

  // Validated before any read, and answered with 400 rather than a workbook.
  // A bad request is the one case where an empty sheet is most misleading: the
  // period and client in the filename are whatever was asked for, so the file
  // looks like an answer to the question that was actually posed.
  if (!isReportType(type)) {
    return NextResponse.json({
      error: `No file was written: unknown report type ${JSON.stringify(type)}. `
        + `Expected one of ${REPORT_TYPES.join(', ')}.`,
    }, { status: 400 })
  }
  if (!ISO_DATE.test(dateFrom ?? '') || !ISO_DATE.test(dateTo ?? '')) {
    return NextResponse.json({
      error: `No file was written: dateFrom and dateTo are required as `
        + `yyyy-mm-dd (got ${JSON.stringify(dateFrom)} and `
        + `${JSON.stringify(dateTo)}). Without them every row is filtered out `
        + `by a null comparison and the report would look empty rather than wrong.`,
    }, { status: 400 })
  }
  // Ordering is checked too: .gte(from).lte(to) with the two swapped is
  // satisfiable by nothing, which again reads as a quiet month.
  if (dateFrom! > dateTo!) {
    return NextResponse.json({
      error: `No file was written: dateFrom ${dateFrom} is after dateTo `
        + `${dateTo}, which no row can satisfy.`,
    }, { status: 400 })
  }

  let rows: any[] = []
  let sheetName = 'Report'

  if (type === 'shipments') {
    sheetName = 'Shipments'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('shipments')
        .select('order_number, clients(name), ship_date, carrier, service, tracking_number, recipient_name, recipient_city, recipient_state, weight, actual_cost, client_rate, profit_loss, is_loss, source')
        .gte('ship_date', dateFrom!)
        .lte('ship_date', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      return q.order('ship_date', { ascending: false }).order('id').range(from, to)
    })
    if (error) return unreadable('shipments', error.message)
    rows = (data ?? []).map((s: any) => ({
      'Order #': s.order_number,
      'Client': s.clients?.name ?? '',
      'Ship Date': s.ship_date,
      'Carrier': s.carrier,
      'Service': s.service,
      'Tracking': s.tracking_number,
      'Recipient': s.recipient_name,
      'City': s.recipient_city,
      'State': s.recipient_state,
      'Weight (oz)': s.weight,
      'Carrier Cost ($)': s.actual_cost,
      'Client Rate ($)': s.client_rate,
      'Profit/Loss ($)': s.profit_loss,
      'Loss?': s.is_loss ? 'YES' : 'No',
      'Source': s.source,
    }))
  }

  else if (type === 'profit-loss') {
    sheetName = 'Profit & Loss'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('shipments')
        // `client_id` is NEW here and is the point of the rewrite below: this
        // branch used to roll up by `clients.name`, which is not a key.
        .select('client_id, clients(name), ship_date, actual_cost, client_rate, profit_loss, is_loss')
        .gte('ship_date', dateFrom!)
        .lte('ship_date', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      // This branch does not order its OUTPUT -- it rolls every row up by
      // client -- but it still has to order its INPUT, or paging it is
      // undefined. A roll-up is where a duplicated page hides best: the totals
      // are simply wrong, and there is no row count to check them against.
      return q.order('id').range(from, to)
    })
    if (error) return unreadable('shipments (profit & loss)', error.message)

    // WHAT THIS BRANCH USED TO DO, AND WHY IT WAS THE WORST OF THE SIX.
    //
    // This is the sheet that gets emailed, and it was the one place in the app
    // still printing the stack of figures that does not subtract. Four separate
    // defects, all of which are fixed by routing it through the same
    // profit-rollup module the Profit tab on /reports now uses -- so the
    // spreadsheet and the screen cannot disagree about a client's margin:
    //
    //   1. `cost += priceOf(s.actual_cost) ?? 0` -- a shipment the carrier has
    //      not billed yet was added into Total Carrier Cost as FREE, which
    //      inflates margin. The null-vs-zero rule this repo applies everywhere
    //      else: null is UNKNOWN and must not be spent as a 0.
    //   2. `profit += priceOf(s.profit_loss) ?? 0` -- read from the STORED
    //      column rather than derived. That column goes stale whenever a rate
    //      or a cost is corrected afterwards, so the sheet could disagree with
    //      its own two neighbouring columns.
    //   3. Revenue was summed over priced rows only while cost was summed over
    //      ALL rows, so 'Revenue - Cost' did not equal 'Net Profit/Loss' and
    //      nothing on the sheet said so. Three individually-defensible figures
    //      printed as a column that implies arithmetic it does not do.
    //   4. Grouped by `clients.name ?? 'Unknown'`. Two clients sharing a name
    //      merged into one line, and every unattributed row -- the 241 from 9
    //      unmapped stores the monitor reports -- was filed under a client
    //      literally called Unknown, where it read as a real customer.
    //
    // `reconcile` sums revenue and cost over the SAME rows and derives profit
    // by subtracting them in integer cents, so the identity holds by
    // construction. Rows it cannot reconcile are counted into three named
    // columns rather than being absorbed at 0.
    const groups = new Map<string, { name: string | null; rows: typeof data }>()
    for (const s of data ?? []) {
      // The empty string is the bucket for rows with no client. A real key, so
      // it cannot collide with a uuid and cannot be read as a client's name.
      const key = typeof s.client_id === 'string' ? s.client_id : ''
      const g = groups.get(key)
      if (g) g.rows!.push(s)
      else groups.set(key, { name: (s.clients as any)?.name ?? null, rows: [s] })
    }

    const lines = [...groups.entries()].map(([key, g]) => ({
      key,
      label: key === ''
        ? 'NO CLIENT ASSIGNED'
        : g.name ?? `(unnamed client ${key.slice(0, 8)})`,
      unattributed: key === '',
      r: reconcile(g.rows ?? []),
      losses: (g.rows ?? []).filter(s => s.is_loss).length,
    }))
      // Worst margin first, unattributed last. Same order as the screen.
      .sort((a, b) => {
        if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1
        return a.r.profit - b.r.profit
      })

    // A money cell whose value is UNKNOWN is left BLANK, not '0.00'. In a
    // spreadsheet a 0 is worse than anywhere else: it is indistinguishable from
    // a real zero AND it silently joins every SUM the recipient draws over the
    // column. An empty cell is skipped by SUM and shows up as a gap.
    const money = (n: number | null) => (n === null ? '' : n.toFixed(2))

    const lineRow = (l: typeof lines[number]) => {
      const v = reconciledOrUnknown(l.r)
      const pct = marginPct(l.r)
      return {
        'Client': l.label,
        'Shipments': l.r.counted,
        'Reconciled (in the figures below)': l.r.reconciled,
        'No agreed rate (excluded)': l.r.unrated,
        'Awaiting carrier cost (excluded)': l.r.uncosted,
        'Neither known (excluded)': l.r.unmeasured,
        'Revenue ($)': money(v.revenue),
        'Carrier Cost ($)': money(v.cost),
        // Derived by subtraction, in cents, from the two columns to its left.
        // Revenue - Carrier Cost equals this exactly, for every row.
        'Profit ($)': money(v.profit),
        // Blank and not '0%' when there is no revenue to be a ratio of.
        // `profit / 0` is Infinity or NaN and both render through toFixed
        // without complaint; the old code printed '0%', which reads as "we
        // broke even" for a client who was never billed at all.
        'Margin %': pct === null ? '' : `${pct.toFixed(1)}%`,
        'Loss-flagged Shipments': l.losses,
        'Stored profit_loss disagrees': l.r.stale,
      }
    }

    // Empty period: leave `rows` empty and let the tail of this function say
    // "No records found for the selected period", the same as every other
    // branch. Guarded explicitly rather than falling through, because the
    // total-row construction below indexes `lines[0]` to learn the column
    // names, and `noUncheckedIndexedAccess` is off in this project -- so
    // `lines[0]` type-checks as a line while being undefined at runtime, and
    // the spacer row threw a TypeError on `r.counted` for any client with no
    // shipments in range. Measured with node, not reasoned about.
    if (lines.length > 0) {
      const totals = combineReconciled(...lines.map(l => l.r))
      const dataRows = lines.map(lineRow)
      const columns = Object.keys(dataRows[0])
      rows = [
        ...dataRows,
        // One blank row, then the total. Appended rather than left for the
        // recipient to SUM, because a column with blanks in it is exactly
        // where a hand-drawn total goes wrong, and because the whole claim of
        // this sheet is that these three figures reconcile -- it should
        // demonstrate that at the bottom rather than assert it in a header.
        Object.fromEntries(columns.map(k => [k, ''])),
        lineRow({
          key: '', label: 'TOTAL', unattributed: false,
          r: totals, losses: lines.reduce((s, l) => s + l.losses, 0),
        }),
      ]
    }
  }

  else if (type === 'loss-shipments') {
    sheetName = 'Loss Shipments'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('shipments')
        .select('order_number, clients(name), ship_date, carrier, service, tracking_number, recipient_name, actual_cost, client_rate, profit_loss')
        .eq('is_loss', true)
        .gte('ship_date', dateFrom!)
        .lte('ship_date', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      return q.order('profit_loss', { ascending: true }).order('id').range(from, to)
    })
    if (error) return unreadable('shipments (losses)', error.message)
    rows = (data ?? []).map((s: any) => ({
      'Order #': s.order_number,
      'Client': s.clients?.name ?? '',
      'Ship Date': s.ship_date,
      'Carrier': s.carrier,
      'Service': s.service,
      'Recipient': s.recipient_name,
      'Carrier Cost ($)': s.actual_cost,
      'Client Rate ($)': s.client_rate,
      'Loss Amount ($)': Math.abs(s.profit_loss ?? 0).toFixed(2),
    }))
  }

  else if (type === 'adjustments') {
    sheetName = 'Rate Adjustments'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('rate_adjustments')
        .select('order_number, clients(name), original_cost, adjusted_cost, adjustment_amount, reason, adjustment_date, status, billed_to_client')
        .gte('adjustment_date', dateFrom!)
        .lte('adjustment_date', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      return q.order('adjustment_date', { ascending: false }).order('id').range(from, to)
    })
    if (error) return unreadable('rate_adjustments', error.message)
    rows = (data ?? []).map((a: any) => ({
      'Order #': a.order_number,
      'Client': a.clients?.name ?? '',
      'Adjustment Date': a.adjustment_date,
      'Original Cost ($)': a.original_cost,
      'Adjusted Cost ($)': a.adjusted_cost,
      'Adjustment Amount ($)': a.adjustment_amount,
      'Reason': a.reason,
      'Status': a.status,
      'Billed to Client': a.billed_to_client ? 'Yes' : 'No',
    }))
  }

  else if (type === 'billing') {
    sheetName = 'Billing'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('bills')
        .select('clients(name), week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_charges_total, grand_total, status')
        .gte('week_start', dateFrom!)
        .lte('week_end', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      return q.order('week_start', { ascending: false }).order('id').range(from, to)
    })
    if (error) return unreadable('bills', error.message)
    rows = (data ?? []).map((b: any) => ({
      'Client': b.clients?.name ?? '',
      'Week Start': b.week_start,
      'Week End': b.week_end,
      'Shipping ($)': b.shipping_total,
      'Warehouse ($)': b.warehouse_total,
      'Adjustments ($)': b.adjustments_total,
      'Manual Charges ($)': b.manual_charges_total,
      'Grand Total ($)': b.grand_total,
      'Status': b.status,
    }))
  }

  else if (type === 'warehouse') {
    sheetName = 'Warehouse Activity'
    const { data, error } = await readAllPages((from, to) => {
      let q = supabaseAdmin
        .from('warehouse_daily_log')
        .select('clients(name), log_date, service_type, quantity, rate, total, notes')
        .gte('log_date', dateFrom!)
        .lte('log_date', dateTo!)
      if (clientId) q = q.eq('client_id', clientId)
      return q.order('log_date', { ascending: false }).order('id').range(from, to)
    })
    if (error) return unreadable('warehouse_daily_log', error.message)
    rows = (data ?? []).map((w: any) => ({
      'Client': w.clients?.name ?? '',
      'Date': w.log_date,
      'Service': w.service_type?.replace(/_/g, ' '),
      'Quantity': w.quantity,
      'Rate ($)': w.rate,
      'Total ($)': w.total,
      'Notes': w.notes ?? '',
    }))
  }

  if (rows.length === 0) rows = [{ 'No Data': 'No records found for the selected period' }]

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)

  // Auto column widths
  const colWidths = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length, 15) }))
  ws['!cols'] = colWidths

  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${type}-report.xlsx"`,
    },
  })
}
