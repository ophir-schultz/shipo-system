import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import { isMigrationMissing, read, readErrors, loaded } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import {
  applySerialFilters,
  applyShipmentTracking,
  mapSerialRow,
  parseSerialFilters,
  SERIAL_SCHEMA_MESSAGE,
  SERIAL_STATUSES,
  type RawSerialJoin,
  type SerialHistoryRow,
} from '@/lib/scan/serial-export'
import { shipmentTrackingByOrder } from '@/lib/scan/shipment-tracking'

export const dynamic = 'force-dynamic'

const SELECT_WITH_STATUS = 'id, serial, tracking_number, zenventory_status, zenventory_sent_at, zenventory_response, scan_events!inner(client_id, order_ref, sku, scanned_at, scanned_by, clients(name))'

interface ClientOption {
  id: string
  name: string
}

async function loadSerials(filters: ReturnType<typeof parseSerialFilters>['filters']) {
  return readAllPages<RawSerialJoin>((from, to) => {
    const query = supabaseAdmin
      .from('scanned_serials')
      .select(SELECT_WITH_STATUS)
      .order('id')
      .range(from, to)
    return applySerialFilters(query, filters)
  })
}

export default async function SerialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value)
  }
  const parsed = parseSerialFilters(params)

  const clientsRes = await readAllPages<ClientOption>((from, to) => supabaseAdmin
    .from('clients')
    .select('id, name')
    .order('name')
    .order('id')
    .range(from, to))

  const serialRes = parsed.error ? { data: [], error: null } : await loadSerials(parsed.filters)
  const schemaMissing = isMigrationMissing(serialRes)
  const trackingRes = parsed.error || schemaMissing
    ? { byOrder: {}, error: null }
    : await shipmentTrackingByOrder()
  const serialRead = read('scanned_serials', schemaMissing ? { data: [], error: null } : serialRes)
  const clientsRead = read('clients', clientsRes)
  const trackingRead = { rows: [], error: trackingRes.error ? `shipments: ${trackingRes.error}` : null }
  const page = loaded(readErrors(serialRead, clientsRead, trackingRead), () => ({
    rows: applyShipmentTracking(serialRead.rows.map(mapSerialRow), trackingRes.byOrder),
    clients: clientsRead.rows,
  }))

  const download = params.toString()
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Serial history</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Every serial that was scanned, with the order, the client, who scanned it, the tracking number when a label already exists, and whether it reached Zenventory. A pick does not wait for a tracking number and does not write one back to Zenventory. Nayax receives the serials from Zenventory through its existing API connection. Stored scans are kept.
        </p>
      </div>

      {parsed.error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{parsed.error}</div>
      )}
      {schemaMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-800 text-sm font-medium">Serial history is not in the database yet</p>
          <p className="text-amber-700 text-xs mt-1">{SERIAL_SCHEMA_MESSAGE}</p>
        </div>
      )}
      {!page.ok && <ViewUnreadable message={page.error} />}
      {page.ok && (
        <SerialHistory
          data={page.data}
          filters={parsed.filters}
          download={download}
          showRows={!schemaMissing && !parsed.error}
        />
      )}
    </div>
  )
}

function SerialHistory({
  data,
  filters,
  download,
  showRows,
}: {
  data: { rows: SerialHistoryRow[]; clients: ClientOption[] }
  filters: ReturnType<typeof parseSerialFilters>['filters']
  download: string
  showRows: boolean
}) {
  const field = 'bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm'
  const query = download ? `?${download}` : ''
  return (
    <>
      <form method="GET" className="bg-white rounded-xl p-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Client
          <select name="clientId" defaultValue={filters.clientId} className={field}>
            <option value="">All clients</option>
            {data.clients.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Order
          <input name="order" defaultValue={filters.order} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Serial
          <input name="serial" defaultValue={filters.serial} className={field} />
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
          Status
          <select name="status" defaultValue={filters.status} className={field}>
            <option value="">Any status</option>
            {SERIAL_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="bg-[#1A73E8] text-white rounded-lg px-4 py-2 text-sm font-semibold">
          Filter
        </button>
        <Link href={`/api/serials/download${query}${query ? '&' : '?'}format=csv`} className="text-sm text-[#1A73E8] px-2 py-2">CSV</Link>
        <Link href={`/api/serials/download${query}${query ? '&' : '?'}format=xlsx`} className="text-sm text-[#1A73E8] px-2 py-2">Excel</Link>
      </form>

      <div className="bg-white rounded-xl overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs text-[#6B7A8D]">
            <tr>
              {['Scanned at', 'Client', 'Order', 'Tracking', 'SKU', 'Serial', 'Scanned by', 'Zenventory'].map((heading) => (
                <th key={heading} className="px-3 py-2 font-medium">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showRows && data.rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-[#4B4F58]">No scanned serials match these filters.</td>
              </tr>
            )}
            {showRows && data.rows.map((row) => (
              <tr key={row.id} className="border-t border-[#E2E8F0]">
                <td className="px-3 py-2 whitespace-nowrap">{row.scannedAt ? row.scannedAt.slice(0, 16).replace('T', ' ') : ''}</td>
                <td className="px-3 py-2">{row.clientName || row.clientId}</td>
                <td className="px-3 py-2">{row.orderRef}</td>
                <td className="px-3 py-2 font-mono whitespace-pre">{row.trackingNumber}</td>
                <td className="px-3 py-2">{row.sku}</td>
                <td className="px-3 py-2 font-mono">{row.serial}</td>
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
