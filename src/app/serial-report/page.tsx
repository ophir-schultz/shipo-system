import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages, type PageResult } from '@/lib/db/page'
import { isMigrationMissing, read, readErrors, loaded } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import {
  applySerialReportFilters,
  mapSerialReportRow,
  parseSerialReportFilters,
  SERIAL_REPORT_SELECT,
  SERIAL_REPORT_SELECT_BASE,
  serialColumnsMissing,
  type RawSerialReport,
  type SerialReportFilters,
  type SerialReportRow,
} from '@/lib/reports/serial-history'

export const dynamic = 'force-dynamic'

interface ClientOption {
  id: string
  name: string
}

function loadSerials(filters: SerialReportFilters, withStatus: boolean) {
  const columns = withStatus ? SERIAL_REPORT_SELECT : SERIAL_REPORT_SELECT_BASE
  return readAllPages<RawSerialReport>((from, to) => {
    const query = supabaseAdmin
      .from('scanned_serials')
      .select(columns)
      .order('id')
      .range(from, to)
    return applySerialReportFilters(query, filters) as unknown as PromiseLike<PageResult<RawSerialReport>>
  })
}

export default async function SerialReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value)
  }
  const parsed = parseSerialReportFilters(params)

  const clientsRes = await readAllPages<ClientOption>((from, to) => supabaseAdmin
    .from('clients')
    .select('id, name')
    .order('name')
    .order('id')
    .range(from, to))

  let statusMissing = false
  let serialRes = parsed.error
    ? { data: [] as RawSerialReport[], error: null }
    : await loadSerials(parsed.filters, true)
  if (!parsed.error && serialColumnsMissing(serialRes.error)) {
    statusMissing = true
    serialRes = await loadSerials(parsed.filters, false)
  }
  const tableMissing = isMigrationMissing(serialRes)

  const serialRead = read('scanned_serials', tableMissing ? { data: [], error: null } : serialRes)
  const clientsRead = read('clients', clientsRes)
  const page = loaded(readErrors(serialRead, clientsRead), () => ({
    rows: serialRead.rows.map(mapSerialReportRow),
    clients: clientsRead.rows,
  }))

  const download = params.toString()
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Serial history report</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Stored scans for a date range and a client, with the Zenventory send status. Nayax receives those serials from Zenventory through its existing API connection. Excel, CSV and PDF stay in the system. Nothing here is emailed.
        </p>
      </div>
      {parsed.error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{parsed.error}</div>
      )}
      {tableMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-800 text-sm font-medium">Scanned serials are not in the database yet</p>
          <p className="text-amber-700 text-xs mt-1">
            Run supabase/serialization_scans.sql. Nothing is shown as an empty history.
          </p>
        </div>
      )}
      {statusMissing && !tableMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-800 text-sm font-medium">Send status is not in the database yet</p>
          <p className="text-amber-700 text-xs mt-1">
            Run supabase/serial_delivery_status.sql. The scan, order and client are shown. Zenventory status stays blank until that file is applied.
          </p>
        </div>
      )}
      {!page.ok && <ViewUnreadable message={page.error} />}
      {page.ok && (
        <SerialReportBody
          rows={page.data.rows}
          clients={page.data.clients}
          filters={parsed.filters}
          download={download}
          showRows={!tableMissing && !parsed.error}
        />
      )}
    </div>
  )
}

function SerialReportBody({
  rows,
  clients,
  filters,
  download,
  showRows,
}: {
  rows: SerialReportRow[]
  clients: ClientOption[]
  filters: SerialReportFilters
  download: string
  showRows: boolean
}) {
  const field = 'bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm'
  const query = download ? `?${download}` : ''
  const href = (format: string) => `/api/serial-report/download${query}${query ? '&' : '?'}format=${format}`
  return (
    <>
      <form method="GET" className="bg-white rounded-xl p-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Client
          <select name="clientId" defaultValue={filters.clientId} className={field}>
            <option value="">All clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          From
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          To
          <input type="date" name="dateTo" defaultValue={filters.dateTo} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Order
          <input name="order" defaultValue={filters.order} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Serial
          <input name="serial" defaultValue={filters.serial} className={field} />
        </label>
        <button type="submit" className="bg-[#1A73E8] text-white rounded-lg px-4 py-2 text-sm font-semibold">
          Filter
        </button>
        {showRows && (
          <>
            <Link href={href('csv')} className="text-sm text-[#1A73E8] px-2 py-2">CSV</Link>
            <Link href={href('xlsx')} className="text-sm text-[#1A73E8] px-2 py-2">Excel</Link>
            <Link href={href('pdf')} className="text-sm text-[#1A73E8] px-2 py-2">PDF</Link>
          </>
        )}
      </form>
      <div className="bg-white rounded-xl overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs text-[#6B7A8D]">
            <tr>
              {['Scanned at', 'Client', 'Order', 'SKU', 'Serial', 'Scanned by', 'Zenventory'].map((heading) => (
                <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showRows && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-[#4B4F58]">No scanned serials in this range.</td>
              </tr>
            )}
            {showRows && rows.map((row) => (
              <tr key={row.id} className="border-t border-[#E2E8F0]">
                <td className="px-3 py-2 whitespace-nowrap">{row.scannedAt ? row.scannedAt.slice(0, 16).replace('T', ' ') : ''}</td>
                <td className="px-3 py-2">{row.clientName || row.clientId}</td>
                <td className="px-3 py-2">{row.orderRef}</td>
                <td className="px-3 py-2">{row.sku}</td>
                <td className="px-3 py-2 font-mono whitespace-pre">{row.serial}</td>
                <td className="px-3 py-2 font-mono text-xs">{row.scannedBy}</td>
                <td className="px-3 py-2" title={row.zenventoryResponse}>{row.zenventoryStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
