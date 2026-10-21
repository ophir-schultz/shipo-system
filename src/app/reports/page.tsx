import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ReportsTabs from '@/components/reports/ReportsTabs'

// Every other screen's degraded render is at least thrown away when you
// navigate off it. This one has an Excel export, so a failed read that rendered
// as `[]` becomes a .xlsx file -- which outlives the outage, outlives the
// session, gets attached to an email, and carries no trace of the fact that the
// rows it is missing were never read rather than never existed. A spreadsheet
// is read as a record.
//
// So the page refuses before the export button exists at all. Six reads feed
// six tabs and any one of them failing blanks the whole thing, because the
// person about to export has no way to know which tab was the blind one.
//
// THE LIMITS THAT USED TO BE HERE.
//
// Three of these reads carried `.limit(200)`, `.limit(50)` and `.limit(200)`,
// and two carried no limit at all -- which is NOT "all rows", it is at most the
// server's `db-max-rows` (1000 by default) returned as a 200 with `error: null`.
// Neither kind of short read sets an error, so the refusal above passes both and
// every tab rendered a prefix of its table as though it were the table.
//
// That is a different failure from the export's, and worse in one way: the
// screen is what an operator checks a figure against. "Loss Shipments: 12" with
// a 200-row cap in front of it is a number they will quote.
//
// All five are paged now, each ending its sort keys with `.order('id')` because
// an OFFSET page boundary on a non-unique sort column is undefined and
// `ship_date` ties by the hundreds -- without it, paging trades truncation for
// a duplicated row and a dropped one.
//
// The caps are not replaced with bigger caps. If these tables grow to where
// loading them all is too slow, the honest fix is a server-side period filter
// (the export route already takes dateFrom/dateTo), not a row cap that the
// screen does not disclose.
//
// WHY `client_id` IS IN ALL FIVE SELECTS.
//
// It is not displayed. These selects also ask for `clients(name)`, which is
// what the Client column renders. `client_id` is here because the client
// DROPDOWN on this screen filtered nothing: ReportsTabs accepted a clientId,
// passed it to all five tables and could not use it, since the only thing in
// the payload was a joined name. Meanwhile the Excel button beside the dropdown
// DID send clientId to /api/reports/download, which filters in SQL with
// `.eq('client_id', clientId)`.
//
// So the table showed every client and the spreadsheet you exported from it
// showed one, and nothing on screen looked wrong. That is worse than the
// undated-row disagreement documented in src/lib/billing/date-range.ts: an
// operator checking figures before emailing them has no way to see it.
//
// Filtering on the id and not on the joined name is deliberate. Two clients may
// share a name, and a row with no client at all would group under whatever
// `?? 'Unknown'` fallback the renderer happens to use -- colliding with a client
// actually named Unknown. The id is the thing the export filters on, so it is
// the thing the screen must filter on.

// WITHOUT THIS LINE THIS SCREEN SHOWED DEPLOY-TIME DATA.
//
// Nothing in this file read searchParams, cookies or headers, so Next had no
// reason to think the page was request-dependent and prerendered it: `next
// build` emitted a 816 KB .next/server/app/reports.html with real order
// numbers baked into it, and the route table said `○ /reports` (Static). There
// is no `revalidate` here and no ISR, so static means frozen until the next
// deploy -- every shipment the crons wrote in between was invisible, on the one
// screen whose whole purpose is to be checked before money goes out.
//
// That is what "reports is not working" looks like from the outside: the tabs
// render, the figures are plausible, and they are hours or days old. It is also
// why the bug survived -- a deploy refreshes it, so it looks fine right after
// anyone ships a fix for something else.
//
// This is not a Next quirk, it is a line this file never had. Every page in
// this app that reads the database on the server and is NOT stale carries the
// same line already -- /statements, /ledger, /pnl, /quotes, /referrals -- or
// reads searchParams, which forces it implicitly (/shipments). /billing,
// /dashboard and /employees were frozen the same way and are fixed in the same
// change.
//
// Checked by the route table, not by eye: this route must print as `ƒ` and
// .next/server/app/reports.html must not exist after a build.
export const dynamic = 'force-dynamic'

async function getReportData() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const today = now.toISOString().split('T')[0]

  const [clientsRes, shipmentsRes, lossRes, adjustmentsRes, billsRes, warehouseRes] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name').eq('active', true).order('name'),
    // `id` is selected to be a React key and nothing else. `order_number` is
    // NOT unique -- ledger_03_charges.sql:8 says so in as many words:
    // multi-package orders, reships and return labels share one. Keying table
    // rows by it made React treat two real shipments as one row, so on a
    // re-render the second one's figures could land in the first one's DOM
    // node. A money table is the worst place for that.
    readAllPages((from, to) => supabaseAdmin.from('shipments')
      .select('id, client_id, order_number, clients(name), ship_date, carrier, service, tracking_number, actual_cost, client_rate, profit_loss, is_loss')
      .order('ship_date', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('shipments')
      .select('id, client_id, order_number, clients(name), ship_date, carrier, service, actual_cost, client_rate, profit_loss')
      .eq('is_loss', true)
      .order('profit_loss', { ascending: true }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('rate_adjustments')
      .select('client_id, order_number, clients(name), reason, adjustment_date, original_cost, adjusted_cost, adjustment_amount, status')
      .order('adjustment_date', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('bills')
      .select('client_id, clients(name), week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_charges_total, grand_total, status')
      .order('week_start', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('warehouse_daily_log')
      .select('client_id, clients(name), log_date, service_type, quantity, rate, total, notes')
      .order('log_date', { ascending: false }).order('id').range(from, to)),
  ])

  const clients = read('clients', clientsRes)
  const shipments = read('shipments', shipmentsRes)
  const lossShipments = read('shipments (losses)', lossRes)
  const adjustments = read('rate_adjustments', adjustmentsRes)
  const bills = read('bills', billsRes)
  const warehouse = read('warehouse_daily_log', warehouseRes)

  return loaded(
    readErrors(clients, shipments, lossShipments, adjustments, bills, warehouse),
    () => ({
      clients: clients.rows,
      shipments: shipments.rows,
      lossShipments: lossShipments.rows,
      adjustments: adjustments.rows,
      bills: bills.rows,
      warehouse: warehouse.rows,
      defaultFrom: monthStart,
      defaultTo: today,
    }),
  )
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Reports</h2>
      <p className="text-gray-400 text-sm mt-1">Live data with Excel export</p>
    </div>
  )
}

export default async function ReportsPage() {
  const reports = await getReportData()

  if (!reports.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={reports.error} />
      </div>
    )
  }

  // Annotated, not inferred. ReportsTabs used to take `data: any`, which would
  // accept `undefined` without complaint; this local was the only thing making
  // deletion of the refusal above a compile error rather than a silent return
  // to exporting a spreadsheet built from a read that failed. The prop now
  // declares ReportsData, so the gate is doubled rather than moved. Keep both:
  // this one fails here, naming the read, instead of at the JSX. See LoadedData.
  const data: LoadedData<typeof reports> = reports.data

  return (
    <div className="space-y-6">
      <Header />
      <ReportsTabs data={data} />
    </div>
  )
}
