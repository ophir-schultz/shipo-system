import { supabaseAdmin } from '@/lib/supabase'

async function getAdjustments() {
  const [pendingRes, allRes] = await Promise.all([
    supabaseAdmin
      .from('rate_adjustments')
      .select('*, clients(name)')
      .eq('status', 'pending')
      .order('adjustment_amount', { ascending: false }),
    supabaseAdmin
      .from('rate_adjustments')
      .select('*, clients(name)')
      .neq('status', 'pending')
      .order('adjustment_date', { ascending: false })
      .limit(100),
  ])
  return {
    pending: pendingRes.data ?? [],
    resolved: allRes.data ?? [],
  }
}

export default async function AdjustmentsPage() {
  const { pending, resolved } = await getAdjustments()
  const pendingTotal = pending.reduce((s, r) => s + (r.adjustment_amount ?? 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">⚙️ Carrier Price Adjustments</h2>
        <p className="text-gray-400 text-sm mt-1">Stamps.com post-shipment price changes — review and charge clients accordingly</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl p-4 border border-orange-800/60" style={{ background: '#1a1000' }}>
          <p className="text-orange-400/70 text-xs uppercase tracking-wider">Pending Adjustments</p>
          <p className="text-2xl font-bold text-orange-400 mt-1">{pending.length}</p>
        </div>
        <div className="rounded-xl p-4 border border-orange-800/60" style={{ background: '#1a1000' }}>
          <p className="text-orange-400/70 text-xs uppercase tracking-wider">Total to Recover</p>
          <p className="text-2xl font-bold text-orange-400 mt-1">+${pendingTotal.toFixed(2)}</p>
        </div>
        <div className="rounded-xl p-4 border border-gray-700 bg-gray-800">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Resolved</p>
          <p className="text-2xl font-bold text-gray-300 mt-1">{resolved.length}</p>
        </div>
      </div>

      {/* Pending adjustments */}
      <div className="rounded-xl overflow-hidden border border-orange-800/40" style={{ background: '#110d00' }}>
        <div className="px-5 py-4 border-b border-orange-800/30 flex items-center justify-between" style={{ background: '#1e1500' }}>
          <div className="flex items-center gap-2">
            <span className="text-orange-400 text-lg">🔔</span>
            <span className="text-orange-300 font-bold">Pending — Needs Action</span>
            {pending.length > 0 && (
              <span className="bg-orange-700 text-orange-100 text-xs font-bold px-2 py-0.5 rounded-full">{pending.length}</span>
            )}
          </div>
          <span className="text-orange-400 font-bold">+${pendingTotal.toFixed(2)} total</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-orange-400/60 text-left border-b border-orange-900/30 text-xs uppercase tracking-wider">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Detected</th>
              <th className="px-4 py-3 text-right">Original Cost</th>
              <th className="px-4 py-3 text-right">New Cost</th>
              <th className="px-4 py-3 text-right">Adjustment</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {pending.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-green-400">
                  ✓ No pending adjustments — all carrier charges are settled
                </td>
              </tr>
            ) : (
              pending.map((a: any) => (
                <tr key={a.id} className="border-b border-orange-900/20 hover:bg-orange-900/10">
                  <td className="px-5 py-3 font-mono text-xs text-gray-300">{a.order_number}</td>
                  <td className="px-4 py-3 font-medium">{a.clients?.name ?? <span className="text-gray-500">Unassigned</span>}</td>
                  <td className="px-4 py-3 text-gray-300">{a.reason ?? 'Carrier reweigh / rate change'}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">{a.original_cost != null ? `$${a.original_cost.toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-400">{a.new_cost != null ? `$${a.new_cost.toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-right font-bold text-orange-400">+${(a.adjustment_amount ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="bg-orange-900/60 text-orange-300 px-3 py-1 rounded-full text-xs font-medium">Pending</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {pending.length > 0 && (
            <tfoot>
              <tr className="border-t border-orange-800/40">
                <td colSpan={6} className="px-5 py-3 text-orange-400 text-xs font-semibold">Total to Recover from Clients</td>
                <td className="px-4 py-3 text-right font-bold text-orange-400">+${pendingTotal.toFixed(2)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Resolved adjustments */}
      {resolved.length > 0 && (
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-700">
            <span className="text-gray-300 font-semibold">Resolved Adjustments</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase tracking-wider">
                <th className="px-5 py-3">Order #</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((a: any) => (
                <tr key={a.id} className="border-b border-gray-700/40 hover:bg-gray-700/20">
                  <td className="px-5 py-3 font-mono text-xs text-gray-400">{a.order_number}</td>
                  <td className="px-4 py-3 text-gray-300">{a.clients?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400">{a.reason ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">+${(a.adjustment_amount ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      a.status === 'charged' ? 'bg-green-900/60 text-green-300' :
                      a.status === 'waived' ? 'bg-gray-700 text-gray-400' :
                      'bg-gray-700 text-gray-400'
                    }`}>{a.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
