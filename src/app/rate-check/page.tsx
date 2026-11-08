import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import { loadRateCheck } from '@/lib/billing/rate-check-load'
import { DEFAULT_RATE_CHECK_FLAGS } from '@/lib/billing/rate-sheet'
import { SHIP_DATE_FILTER_NOTE } from '@/lib/billing/ship-day-label'

export const dynamic = 'force-dynamic'

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

function money(value: number | null): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}

export default async function RateCheckPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const week = one(raw.week)
  const clientId = one(raw.client)
  const round = one(raw.round) === '' ? DEFAULT_RATE_CHECK_FLAGS.roundWeight : one(raw.round) === '1'
  const dim = one(raw.dim) === '' ? DEFAULT_RATE_CHECK_FLAGS.useDimensionalWeight : one(raw.dim) === '1'
  const [clientsRes, check] = await Promise.all([
    readAllPages<{ id: string; name: string | null }>((from, to) => supabaseAdmin
      .from('clients')
      .select('id, name')
      .eq('active', true)
      .order('name')
      .order('id')
      .range(from, to)),
    loadRateCheck({
      week,
      clientId: clientId || null,
      flags: {
        roundWeight: round,
        useDimensionalWeight: dim,
      },
    }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Rate check</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Staff only. Compares non-voided shipments in a Monday–Sunday Eastern week with the 2026-11 client price sheet. Billing is unchanged. The sheet has no start or end date.
        </p>
      </div>
      <form method="GET" className="bg-white rounded-xl p-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Any day in the week
          <input name="week" type="date" defaultValue={check.report?.from || week} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Client
          <select name="client" defaultValue={clientId} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
            <option value="">All clients</option>
            {(clientsRes.data ?? []).map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Round weight up
          <select name="round" defaultValue={round ? '1' : '0'} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[#6B7A8D]">
          Dimensional weight when higher
          <select name="dim" defaultValue={dim ? '1' : '0'} className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
            <option value="1">Yes</option>
            <option value="0">No</option>
          </select>
        </label>
        <button className="bg-[#0B1220] text-white rounded-lg px-4 py-2 text-sm">Show</button>
      </form>
      {check.error ? <ViewUnreadable message={check.error} /> : check.report && (
        <>
          <p className="text-sm text-[#4B4F58]">
            {check.report.from} through {check.report.to}, Eastern. Client tabs are regular five-day ground. Zones 1 and 2 use the sheet’s 1&amp;2 price when that cell exists. {check.report.note} Clients with no tab show “no sheet rates”, and Suteka shipments over 6 lb show “Needs manual price (client approval)”. Neither is a mismatch.
          </p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-[#F4F6F8] text-left text-[#4B4F58]">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-4 py-2.5 font-medium">Shipments</th>
                  <th className="px-4 py-2.5 font-medium">Matched</th>
                  <th className="px-4 py-2.5 font-medium">Price gaps</th>
                  <th className="px-4 py-2.5 font-medium">Unknown billed</th>
                  <th className="px-4 py-2.5 font-medium">Not compared</th>
                  <th className="px-4 py-2.5 font-medium">Billed</th>
                  <th className="px-4 py-2.5 font-medium">Sheet</th>
                  <th className="px-4 py-2.5 font-medium">Leakage</th>
                </tr>
              </thead>
              <tbody>
                {check.report.summaries.map((row) => (
                  <tr key={row.clientName} className="border-t border-slate-100">
                    <td className="px-4 py-2.5">{row.clientName}</td>
                    <td className="px-4 py-2.5">{row.shipments}</td>
                    <td className="px-4 py-2.5">{row.matched}</td>
                    <td className="px-4 py-2.5">{row.priceGaps}</td>
                    <td className="px-4 py-2.5">{row.unknownBilled}</td>
                    <td className="px-4 py-2.5">{row.notCompared}</td>
                    <td className="px-4 py-2.5">{money(row.billedTotal)}</td>
                    <td className="px-4 py-2.5">{money(row.sheetTotal)}</td>
                    <td className="px-4 py-2.5">{row.difference == null ? '—' : row.difference === 0 ? money(0) : `${money(row.difference)} leakage`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[#6B7A8D]">{SHIP_DATE_FILTER_NOTE}</p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="min-w-full text-sm">
              <thead className="bg-[#F4F6F8] text-left text-[#4B4F58]">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-4 py-2.5 font-medium">Ship date</th>
                  <th className="px-4 py-2.5 font-medium">Weight (oz)</th>
                  <th className="px-4 py-2.5 font-medium">Zone</th>
                  <th className="px-4 py-2.5 font-medium">Service</th>
                  <th className="px-4 py-2.5 font-medium">Sheet price</th>
                  <th className="px-4 py-2.5 font-medium">Billed</th>
                  <th className="px-4 py-2.5 font-medium">Difference</th>
                  <th className="px-4 py-2.5 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {check.report.shipments.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-4 py-2.5">{row.orderNumber}</td>
                    <td className="px-4 py-2.5">{row.clientName}</td>
                    <td className="px-4 py-2.5">
                      <div>{row.shipDate ?? '—'}</div>
                      {row.storedShipDay ? <div className="text-[10px] text-amber-700">Stored ship day {row.storedShipDay}</div> : null}
                    </td>
                    <td className="px-4 py-2.5">{row.weightOz ?? '—'}</td>
                    <td className="px-4 py-2.5">{row.zone ?? '—'}</td>
                    <td className="px-4 py-2.5">{row.service}</td>
                    <td className="px-4 py-2.5">{money(row.sheetPrice)}</td>
                    <td className="px-4 py-2.5">{money(row.clientRate)}</td>
                    <td className="px-4 py-2.5">{money(row.difference)}</td>
                    <td className="px-4 py-2.5">{row.reason}</td>
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
