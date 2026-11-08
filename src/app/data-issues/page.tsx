import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import { easternToday } from '@/lib/ledger/eastern-day'
import { SHIP_DAY_LABEL_NOTE } from '@/lib/billing/ship-day-label'
import { ShipDay } from '@/components/shipments/ShipDay'
import { ambiguousPickCards, issueLabel, shipmentIssue, type DataIssueKind } from '@/lib/billing/data-issues'

export const dynamic = 'force-dynamic'

interface IssueRow {
  id: string
  order_number: string | null
  ship_date: string | null
  tracking_number: string | null
  client_id: string | null
  client_rate: number | null
  raw_data?: unknown
  clients: { name: string | null } | { name: string | null }[] | null
}

interface RateRow {
  client_id: string | null
  service_type: string | null
  rate: number | string | null
  effective_from: string | null
  effective_to: string | null
  clients: { name: string | null } | { name: string | null }[] | null
}

function clientName(value: IssueRow['clients'] | RateRow['clients']): string {
  if (!value) return ''
  const name = Array.isArray(value) ? value[0]?.name : value.name
  return name ?? ''
}

async function getIssues() {
  const [shipmentsRes, ratesRes] = await Promise.all([
    readAllPages<IssueRow>((from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('id, order_number, ship_date, tracking_number, client_id, client_rate, raw_data, clients(name)')
        .or('client_id.is.null,client_rate.is.null')
        .order('ship_date', { ascending: false })
        .order('id')
        .range(from, to)),
    readAllPages<RateRow>((from, to) =>
      supabaseAdmin
        .from('client_warehouse_rates')
        .select('client_id, service_type, rate, effective_from, effective_to, clients(name)')
        .order('client_id')
        .order('id')
        .range(from, to)),
  ])
  const shipments = read('shipments (data issues)', shipmentsRes)
  const rates = read('warehouse rate cards', ratesRes)
  return loaded(readErrors(shipments, rates), () => {
    const issues: Array<IssueRow & { kind: DataIssueKind }> = []
    for (const row of shipments.rows) {
      const kind = shipmentIssue(row)
      if (kind) issues.push({ ...row, kind })
    }
    const pickCards = ambiguousPickCards(rates.rows.map((row) => ({
      client_id: row.client_id,
      client_name: clientName(row.clients),
      service_type: row.service_type,
      rate: row.rate,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    })), easternToday())
    return { issues, pickCards }
  })
}

export default async function DataIssuesPage() {
  const page = await getIssues()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Data issues</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          This list is shipments with no client or no stored price, as of {easternToday()} Eastern. Voided labels are left off. It is not a count of null order charges, and it is not the dashboard, the October billing card, or the ledger. Those use different dates, clients, and whether a missing price is excluded. A charge can be null while its shipment already has a price. That price is not copied onto the charge here, and nothing on this page is written.
        </p>
        <p className="text-[#4B4F58] text-sm mt-1">
          {page.ok
            ? `${page.data.issues.length} shipments that cannot be billed, and ${page.data.pickCards.length} rate cards with more than one live pick rate. Voided labels are left off.`
            : 'This list could not be read.'}
        </p>
      </div>
      {!page.ok ? <ViewUnreadable message={page.error} /> : (
        <>
          {page.data.pickCards.length === 0 ? (
            <p className="text-sm text-[#4B4F58]">No rate card has two live pick rates.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-[#F4F6F8] text-left text-[#4B4F58]">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Client</th>
                    <th className="px-4 py-2.5 font-medium">Pick & pack</th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.pickCards.map((card) => (
                    <tr key={card.clientId} className="border-t border-slate-100">
                      <td className="px-4 py-2.5 text-[#0B1220]">{card.clientName}</td>
                      <td className="px-4 py-2.5">{card.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.data.issues.length === 0 ? (
            <p className="text-sm text-[#4B4F58]">No shipments are missing a client or a price.</p>
          ) : (
        <>
        <p className="mb-3 text-[11px] text-[#6B7A8D]">{SHIP_DAY_LABEL_NOTE}</p>
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-[#F4F6F8] text-left text-[#4B4F58]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Issue</th>
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Ship date</th>
                <th className="px-4 py-2.5 font-medium">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {page.data.issues.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 text-[#0B1220]">{issueLabel(row.kind)}</td>
                  <td className="px-4 py-2.5">{row.order_number ?? ''}</td>
                  <td className="px-4 py-2.5">{clientName(row.clients) || '—'}</td>
                  <td className="px-4 py-2.5"><ShipDay stored={row.ship_date} raw={row.raw_data} /></td>
                  <td className="px-4 py-2.5">{row.tracking_number ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
          )}
        </>
      )}
    </div>
  )
}
