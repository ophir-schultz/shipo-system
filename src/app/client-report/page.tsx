import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, isMigrationMissing, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ClientReportView from '@/components/client-report/ClientReportView'
import { billingLineToReportRow, type BillingLineRecord } from '@/lib/pricing/client-report'
import { withStoredSerials, type RawScanSerial } from '@/lib/pricing/report-serials'

export const dynamic = 'force-dynamic'

interface ClientOption {
  id: string
  name: string
}

async function getReportData() {
  const [linesRes, clientsRes, scansRes] = await Promise.all([
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
    readAllPages<RawScanSerial>((from, to) =>
      supabaseAdmin
        .from('scanned_serials')
        .select('serial, position, scan_events!inner(client_id, order_ref, sku)')
        .order('id')
        .range(from, to)),
  ])

  const linesMissing = isMigrationMissing(linesRes)
  const scansMissing = isMigrationMissing(scansRes)
  const linesRead = read('client_billing_lines', linesRes)
  const clientsRead = read('clients', clientsRes)
  const scansRead = read('scanned_serials', scansRes)
  const unreadable = readErrors(linesMissing ? null : linesRead, clientsRead, scansMissing ? null : scansRead)

  return {
    linesMissing,
    scansMissing,
    page: loaded(unreadable, () => ({
      rows: withStoredSerials(
        (linesMissing ? [] : linesRead.rows).map((line) => billingLineToReportRow(line)),
        scansMissing ? [] : scansRead.rows,
      ),
      clients: clientsRead.rows,
    })),
  }
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-[#0B1220]">Client report</h2>
      <p className="text-[#4B4F58] text-sm mt-1">
        Imported billing lines only, in the workbook&apos;s 16 columns. The pick amounts stay as they were imported. They are not recalculated with the scan rule. Live orders are not copied into this table. An empty range means no workbook rows, not that the client was idle. Approving and importing are separate actions. Nothing is generated on its own.
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
      <p className="text-sm text-[#0B1220]">
        <a href="/client-report/activity" className="font-semibold text-[#0B3361] underline">Order activity</a>
        <span className="text-[#3A4658]"> is the live per-order sheet. It is not this import.</span>
      </p>
      {res.linesMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-700 text-sm font-medium">Billing-line table is not in the database yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">
            Run <span className="font-mono">supabase/client_price_lists.sql</span> before importing a workbook. Nothing is shown as an empty report.
          </p>
        </div>
      )}
      {res.scansMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-700 text-sm font-medium">Scanned serials are not in the database yet</p>
          <p className="text-amber-700 text-xs mt-1">
            Run <span className="font-mono">supabase/serialization_scans.sql</span>. Until then the SERIAL column shows only what was stored on the billing line.
          </p>
        </div>
      )}
      <ClientReportView rows={data.rows} clients={data.clients} linesMissing={res.linesMissing} />
    </div>
  )
}
