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
          This is not that workbook. A unit that must be scanned is priced per order: floor(quantity / 20) × $1.50 + leftover × $0.32.
          A unit that does not require a scan is $0.20 each, with no carton rate, at any quantity.
          20 scannable units plus 100 accessories are $21.50. 122 scannable units are $9.64.
          105 scannable units are $9.10, which is 5 × $1.50 + 5 × $0.32.
          400 accessories are $80. 100 accessories are $20. A line with no scan requirement is unknown.
          Order lines do not store that flag. The Zenventory order read has it, and it is not kept here.
          An R or D prefix is not used. The prefix total is not a verified client price.
          A full box in this rule is 20 scannable units. It is not the physical box material fee.
          Shipping is shown only when one parcel has one client price. A stored rate that
          disagrees with the ledger charge is left blank.
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
            <p className="mt-1">Pick on the dated rows: {activity.coverage.pickKnown == null ? 'unknown' : `$${activity.coverage.pickKnown.toFixed(2)}`}. Orders the price list did not price: {activity.coverage.pickUnknownOrders}. A full carton is the carton rate. Leftover device units are the remainder rate. Other units are the accessory rate.</p>
            {activity.coverage.picks.length > 0 && (
              <div className="mt-3 max-h-80 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left">
                      <th className="py-1 pr-2">Order</th>
                      <th className="py-1 pr-2 text-right">Device units</th>
                      <th className="py-1 pr-2 text-right">Cartons</th>
                      <th className="py-1 pr-2 text-right">Remainder</th>
                      <th className="py-1 pr-2 text-right">Other units</th>
                      <th className="py-1 pr-2">Rate</th>
                      <th className="py-1 text-right">Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.coverage.picks.map((pick) => (
                      <tr key={pick.orderNumber} className="border-t border-[#E2E8F0]">
                        <td className="py-1 pr-2">{pick.orderNumber}</td>
                        <td className="py-1 pr-2 text-right">{pick.deviceUnits}</td>
                        <td className="py-1 pr-2 text-right">{pick.cartons}</td>
                        <td className="py-1 pr-2 text-right">{pick.remainder}</td>
                        <td className="py-1 pr-2 text-right">{pick.accessoryUnits}</td>
                        <td className="py-1 pr-2">{pick.rateLabel || 'Unknown'}</td>
                        <td className="py-1 text-right">{pick.amount == null ? 'Unknown' : `$${pick.amount.toFixed(2)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-1">Orders with no ship day, kept out of the dated rows: {activity.coverage.undatedOrders.length === 0 ? 'none' : activity.coverage.undatedOrders.join(', ')}.</p>
            <p className="mt-1">Parcels in the period with no matching order, not given a row: {activity.coverage.unmatchedParcels.length === 0 ? 'none' : activity.coverage.unmatchedParcels.join(', ')}.</p>
            <p className="mt-1">Shipping left blank because the stored rate and the ledger charge disagree: {activity.coverage.shippingConflicts.length === 0 ? 'none' : activity.coverage.shippingConflicts.join(', ')}.</p>
            <p className="mt-1">Shipping left blank because the order has more than one parcel: {activity.coverage.shippingAmbiguous.length === 0 ? 'none' : activity.coverage.shippingAmbiguous.join(', ')}.</p>
            {activity.coverage.peakNote !== '' && <p className="mt-2">{activity.coverage.peakNote}</p>}
            <p className="mt-2">The pick follows the stored price list. A different written schedule is not applied. Matching this list is not approval of another schedule.</p>
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
