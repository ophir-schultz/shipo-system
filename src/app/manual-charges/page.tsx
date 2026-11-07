import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ManualChargeForm from '@/components/billing/ManualChargeForm'
import { easternToday } from '@/lib/ledger/eastern-day'
import { RECENT_MANUAL_CHARGES } from '@/lib/billing/manual-charge'

export const dynamic = 'force-dynamic'

interface ClientRow {
  id: string
  name: string | null
}

interface ChargeRow {
  id: string
  client_id: string | null
  charge_date: string
  description: string | null
  amount: number | string | null
  approved: boolean | null
  clients: { name: string | null } | { name: string | null }[] | null
}

function clientName(value: ChargeRow['clients']): string {
  if (!value) return ''
  const name = Array.isArray(value) ? value[0]?.name : value.name
  return name ?? ''
}

function amountLabel(amount: number | string | null): string {
  if (amount === null || amount === '') return 'unknown'
  const n = typeof amount === 'number' ? amount : Number(amount)
  if (!Number.isFinite(n)) return 'unknown'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

async function getPage() {
  const [clientsRes, chargesRes] = await Promise.all([
    supabaseAdmin
      .from('clients')
      .select('id, name')
      .eq('active', true)
      .order('name'),
    supabaseAdmin
      .from('manual_charges')
      .select('id, client_id, charge_date, description, amount, approved, clients(name)')
      .order('charge_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(RECENT_MANUAL_CHARGES),
  ])
  const clients = read('clients (manual charges)', clientsRes)
  const charges = read('manual_charges (recent)', chargesRes)
  return loaded(readErrors(clients, charges), () => ({
    clients: clients.rows as ClientRow[],
    charges: charges.rows as ChargeRow[],
  }))
}

export default async function ManualChargesPage() {
  const page = await getPage()
  const today = easternToday()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Manual charges</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          One-off fees for an active client. The date is the Eastern warehouse day you enter. A saved charge is stored with approved false. This screen has no approval action, so the amount stays off bills until a separate billing approval exists.
        </p>
      </div>
      {!page.ok ? <ViewUnreadable message={page.error} /> : (
        <>
          {page.data.clients.length === 0 ? (
            <p className="text-sm text-[#4B4F58]">No active clients, so a charge cannot be recorded.</p>
          ) : (
            <ManualChargeForm clients={page.data.clients} today={today} />
          )}
          {page.data.charges.length === 0 ? (
            <p className="text-sm text-[#4B4F58]">No manual charges recorded.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="min-w-full text-sm">
                <thead className="bg-[#F4F6F8] text-left text-[#4B4F58]">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Client</th>
                    <th className="px-4 py-2.5 font-medium">Description</th>
                    <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Billing</th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.charges.map((row) => (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5">{row.charge_date}</td>
                      <td className="px-4 py-2.5">{clientName(row.clients) || 'Unknown client'}</td>
                      <td className="px-4 py-2.5">{row.description || 'unknown'}</td>
                      <td className="px-4 py-2.5 text-right">{amountLabel(row.amount)}</td>
                      <td className="px-4 py-2.5">{row.approved === true ? 'Approved' : row.approved === false ? 'Not approved' : 'Unknown'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
