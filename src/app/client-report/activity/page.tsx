import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import { easternToday } from '@/lib/ledger/eastern-day'
import { periodRange } from '@/lib/billing/statement'
import { CLIENT_REPORT_COLUMNS, reportCells } from '@/lib/pricing/client-report'
import { loadOrderActivity } from '@/lib/pricing/load-order-activity'

export const dynamic = 'force-dynamic'

const ISO = /^\d{4}-\d{2}-\d{2}$/

export default async function OrderActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; from?: string; to?: string }>
}) {
  const query = await searchParams
  const month = periodRange('month', easternToday())
  const from = ISO.test(query.from ?? '') ? query.from! : month.from
  const to = ISO.test(query.to ?? '') ? query.to! : month.to
  const clientId = query.client ?? ''
  const clients = await readAllPages<{ id: string; name: string | null }>((start, end) => supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')
    .order('id')
    .range(start, end))
  const client = (clients.data ?? []).find((row) => row.id === clientId) ?? null
  const loaded = client
    ? await loadOrderActivity(client.id, client.name ?? '', from, to)
    : { activity: null, error: clients.error?.message ?? null }
  const activity = loaded.activity
  const exportQuery = new URLSearchParams({
    source: 'activity',
    format: 'csv',
    clientId,
    dateFrom: from,
    dateTo: to,
  })

  return (
    <div className="space-y-6 text-[#0B1220]">
      <div>
        <h2 className="text-2xl font-bold">Order activity</h2>
        <p className="mt-1 text-sm text-[#3A4658]">
          One row per order, using the same 16 columns as the imported workbook.
          This is not that workbook. Pick is the price list applied to each order:
          whole cartons at the carton rate, leftover device units at the remainder rate,
          and other units at the accessory rate. A reading that prices every device unit
          at the remainder rate is higher by the carton difference, and it is not the amount used here.
          Shipping is shown only when one parcel has one client price. A stored rate that
          disagrees with the ledger charge is left blank. Material is blank until a box code is known.
          A blank is unknown, not zero, and it is not a final total.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/client-report" className="font-semibold text-[#0B3361] underline">Imported workbook</Link>
          <span className="text-[#3A4658]"> is a different report. </span>
          <Link href="/statements" className="font-semibold text-[#0B3361] underline">Statements</Link>
          <span className="text-[#3A4658]"> groups these orders into the period total.</span>
        </p>
      </div>
      <form method="GET" className="flex flex-col gap-3 rounded-xl bg-white p-5 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="text-xs text-[#3A4658]">
          Client
          <select name="client" defaultValue={clientId} className="mt-1 block min-h-11 w-full rounded-lg border border-[#64748B] bg-white px-3 text-sm text-[#0B1220] sm:w-56">
            <option value="">Choose a client</option>
            {(clients.data ?? []).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[#3A4658]">
          From
          <input type="date" name="from" defaultValue={from} className="mt-1 block min-h-11 rounded-lg border border-[#64748B] bg-white px-3 text-sm text-[#0B1220]" />
        </label>
        <label className="text-xs text-[#3A4658]">
          To
          <input type="date" name="to" defaultValue={to} className="mt-1 block min-h-11 rounded-lg border border-[#64748B] bg-white px-3 text-sm text-[#0B1220]" />
        </label>
        <button type="submit" className="min-h-11 rounded-lg bg-[#0B3361] px-4 text-sm font-semibold text-white">Show orders</button>
        {client && (
          <a href={`/api/client-reports/download?${exportQuery}`} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[#1A73E8] px-4 text-sm font-semibold text-white">Download CSV</a>
        )}
      </form>
      {!client && <p className="text-sm text-[#0B1220]">Choose a client. No orders are shown until then, and an empty file is not a report that the client had no activity.</p>}
      {loaded.error && <p className="text-sm text-red-800">{loaded.error}</p>}
      {activity && (
        <>
          <div className="rounded-xl border border-[#CBD5E1] bg-white p-5 text-sm text-[#0B1220]">
            <p>{activity.coverage.datedOrders} orders in {from} to {to}. The date is the ship day in America/New_York.</p>
            <p className="mt-1">Pick on the dated rows: {activity.coverage.pickKnown == null ? 'unknown' : `$${activity.coverage.pickKnown.toFixed(2)}`}. Orders the price list did not price: {activity.coverage.pickUnknownOrders}.</p>
            <p className="mt-1">Orders with no ship day, kept out of the dated rows: {activity.coverage.undatedOrders.length === 0 ? 'none' : activity.coverage.undatedOrders.join(', ')}.</p>
            <p className="mt-1">Parcels in the period with no matching order, not given a row: {activity.coverage.unmatchedParcels.length === 0 ? 'none' : activity.coverage.unmatchedParcels.join(', ')}.</p>
            <p className="mt-1">Shipping left blank because the stored rate and the ledger charge disagree: {activity.coverage.shippingConflicts.length === 0 ? 'none' : activity.coverage.shippingConflicts.join(', ')}.</p>
            <p className="mt-1">Shipping left blank because the order has more than one parcel: {activity.coverage.shippingAmbiguous.length === 0 ? 'none' : activity.coverage.shippingAmbiguous.join(', ')}.</p>
          </div>
          <div className="overflow-x-auto rounded-xl bg-white p-5">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[#0B1220]">
                  {CLIENT_REPORT_COLUMNS.map((column) => (
                    <th key={column} className="whitespace-pre pb-2 pr-3 font-semibold">{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activity.rows.length === 0 && (
                  <tr><td colSpan={CLIENT_REPORT_COLUMNS.length} className="py-4 text-[#0B1220]">No dated orders in this range.</td></tr>
                )}
                {activity.rows.map((row) => (
                  <tr key={row.orderNumber} className="border-t border-[#E2E8F0]">
                    {reportCells(row).map((cell, index) => (
                      <td key={index} className="whitespace-pre py-2 pr-3 align-top text-[#0B1220]">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
