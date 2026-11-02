import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, isMigrationMissing, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ClientReportView from '@/components/client-report/ClientReportView'
import { billingLineToReportRow, type BillingLineRecord } from '@/lib/pricing/client-report'

export const dynamic = 'force-dynamic'

interface ClientOption {
  id: string
  name: string
}

async function getReportData() {
  const [linesRes, clientsRes] = await Promise.all([
    readAllPages<BillingLineRecord & { client_id: string | null }>((from, to) =>
      supabaseAdmin
        .from('client_billing_lines')
        .select('client_id, line_date, order_number, recipient_name, tracking_number, sku, qty, qty_count, serial_number, pick_price, box_price, shipping_price, total, zone, zipcode, weight, volume_weight')
        .order('line_date', { ascending: false })
        .order('id')
        .range(from, to)),
    readAllPages<ClientOption>((from, to) =>
      supabaseAdmin
        .from('clients')
        .select('id, name')
        .order('id')
        .range(from, to)),
  ])

  const linesMissing = isMigrationMissing(linesRes)
  const linesRead = read('client_billing_lines', linesRes)
  const clientsRead = read('clients', clientsRes)
  const unreadable = readErrors(linesMissing ? null : linesRead, clientsRead)

  return {
    linesMissing,
    page: loaded(unreadable, () => ({
      rows: (linesMissing ? [] : linesRead.rows).map((line) => ({
        clientId: line.client_id,
        ...billingLineToReportRow(line),
      })),
      clients: clientsRead.rows,
    })),
  }
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-[#0B1220]">Client report</h2>
      <p className="text-[#4B4F58] text-sm mt-1">
        The billing workbook, for any date range. Finance approves it here, then downloads it. It is not emailed.
      </p>
    </div>
  )
}

export default async function ClientReportPage() {
  const res = await getReportData()
  if (!res.page.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={res.page.error} />
      </div>
    )
  }
  const data: LoadedData<typeof res.page> = res.page.data
  return (
    <div className="space-y-6">
      <Header />
      {res.linesMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-700 text-sm font-medium">Billing-line table is not in the database yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">
            Run <span className="font-mono">supabase/client_price_lists.sql</span> before importing a workbook. Nothing is shown as an empty report.
          </p>
        </div>
      )}
      <ClientReportView rows={data.rows} clients={data.clients} linesMissing={res.linesMissing} />
    </div>
  )
}
