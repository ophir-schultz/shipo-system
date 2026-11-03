import Link from 'next/link'
import { easternToday } from '@/lib/ledger/eastern-day'
import { profitPeriod, profitRows, type ProfitLevel } from '@/lib/pricing/profit-view'
import { loadProfitShipments } from '@/app/api/profit/download/route'

export const dynamic = 'force-dynamic'

export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const grain = typeof raw.grain === 'string' ? raw.grain : 'week'
  const level = (typeof raw.level === 'string' ? raw.level : 'shipment') as ProfitLevel
  const from = typeof raw.from === 'string' ? raw.from : ''
  const to = typeof raw.to === 'string' ? raw.to : ''
  const period = profitPeriod({ grain, today: easternToday(), from, to })
  const safeLevel: ProfitLevel = level === 'order' || level === 'client' ? level : 'shipment'
  const loaded = period.error ? { rows: [], error: null } : await loadProfitShipments(period.from, period.to)
  const rows = loaded.error || period.error ? [] : profitRows(safeLevel, loaded.rows)
  const query = new URLSearchParams({ grain, level: safeLevel, from, to })
  const headings = rows[0] ? Object.keys(rows[0]) : []

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Profit</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Staff only. Price is what the client is charged. ShipStation cost is what we paid. Profit is the difference, and it stays blank when either figure is missing. A week opens Monday at 12:00 AM Eastern.
        </p>
      </div>
      <form method="GET" className="bg-white rounded-xl p-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Period
          <select name="grain" defaultValue={grain} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Level
          <select name="level" defaultValue={safeLevel} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
            <option value="shipment">Shipment</option>
            <option value="order">Order</option>
            <option value="client">Client</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          From
          <input type="date" name="from" defaultValue={from} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          To
          <input type="date" name="to" defaultValue={to} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="bg-[#1A73E8] text-white rounded-lg px-4 py-2 text-sm font-semibold">Show</button>
        <Link href={`/api/profit/download?${query}&format=csv`} className="text-sm text-[#1A73E8] px-2 py-2">CSV</Link>
        <Link href={`/api/profit/download?${query}&format=pdf`} className="text-sm text-[#1A73E8] px-2 py-2">PDF</Link>
      </form>
      {period.error && <p className="text-sm text-amber-800">{period.error}</p>}
      {loaded.error && <p className="text-sm text-red-700">{loaded.error}</p>}
      {!period.error && (
        <p className="text-xs text-[#6B7A8D]">{period.from} to {period.to}, {safeLevel}</p>
      )}
      <div className="bg-white rounded-xl overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs text-[#6B7A8D]">
            <tr>
              {headings.map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td className="px-3 py-6 text-[#4B4F58]">No shipments in this period.</td></tr>
            )}
            {rows.map((row, index) => (
              <tr key={`${row.Order ?? row.Client}-${index}`} className="border-t border-[#E2E8F0]">
                {headings.map((heading) => (
                  <td key={heading} className="px-3 py-2">{row[heading]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
