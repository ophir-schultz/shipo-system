import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import { easternCalendarDay } from '@/lib/ledger/eastern-day'
import { issueLabel, shipmentIssue, type DataIssueKind } from '@/lib/billing/data-issues'

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

function clientName(value: IssueRow['clients']): string {
  if (!value) return ''
  const name = Array.isArray(value) ? value[0]?.name : value.name
  return name ?? ''
}

async function getIssues() {
  const res = await readAllPages<IssueRow>((from, to) =>
    supabaseAdmin
      .from('shipments')
      .select('id, order_number, ship_date, tracking_number, client_id, client_rate, raw_data, clients(name)')
      .or('client_id.is.null,client_rate.is.null')
      .order('ship_date', { ascending: false })
      .order('id')
      .range(from, to))
  const readResult = read('shipments (data issues)', res)
  return loaded(readErrors(readResult), () => {
    const issues: Array<IssueRow & { kind: DataIssueKind }> = []
    for (const row of readResult.rows) {
      const kind = shipmentIssue(row)
      if (kind) issues.push({ ...row, kind })
    }
    return { issues }
  })
}

export default async function DataIssuesPage() {
  const page = await getIssues()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Data issues</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          {page.ok
            ? `${page.data.issues.length} shipments that cannot be billed: no client, or a client with no price. Voided labels are left off.`
            : 'This list could not be read.'}
        </p>
      </div>
      {!page.ok ? <ViewUnreadable message={page.error} /> : page.data.issues.length === 0 ? (
        <p className="text-sm text-[#4B4F58]">No open issues.</p>
      ) : (
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
                  <td className="px-4 py-2.5">{easternCalendarDay(row.ship_date)}</td>
                  <td className="px-4 py-2.5">{row.tracking_number ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
