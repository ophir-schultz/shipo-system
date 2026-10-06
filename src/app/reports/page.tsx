import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
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

async function getReportData() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const today = now.toISOString().split('T')[0]

  const [clientsRes, shipmentsRes, lossRes, adjustmentsRes, billsRes, warehouseRes] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name').eq('active', true).order('name'),
    supabaseAdmin.from('shipments')
      .select('order_number, clients(name), ship_date, carrier, service, tracking_number, actual_cost, client_rate, profit_loss, is_loss')
      .order('ship_date', { ascending: false }).limit(200),
    supabaseAdmin.from('shipments')
      .select('order_number, clients(name), ship_date, carrier, service, actual_cost, client_rate, profit_loss')
      .eq('is_loss', true).order('profit_loss', { ascending: true }),
    supabaseAdmin.from('rate_adjustments')
      .select('order_number, clients(name), reason, adjustment_date, original_cost, new_cost, adjustment_amount, status')
      .order('adjustment_date', { ascending: false }),
    supabaseAdmin.from('bills')
      .select('clients(name), week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_total, grand_total, status')
      .order('week_start', { ascending: false }).limit(50),
    supabaseAdmin.from('warehouse_daily_log')
      .select('clients(name), log_date, service_type, quantity, rate, total, notes')
      .order('log_date', { ascending: false }).limit(200),
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
