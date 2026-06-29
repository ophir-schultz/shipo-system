'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

export default function AdjustmentsClient({ pending, resolved, pendingTotal }: {
  pending: any[]
  resolved: any[]
  pendingTotal: number
}) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)

  async function updateStatus(id: string, status: string, label: string) {
    setLoading(id + status)
    try {
      const res = await fetch(`/api/adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      showSuccess(`Adjustment ${label}`, `Status updated to "${status}"`)
      router.refresh()
    } catch (err: any) {
      showError('Update failed', err.message)
    } finally {
      setLoading(null)
    }
  }

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      approved: 'bg-green-900/60 text-green-300',
      billed: 'bg-blue-900/60 text-[#33BBFF]',
      waived: 'bg-gray-700 text-gray-400',
    }
    return map[status] ?? 'bg-gray-700 text-gray-400'
  }

  return (
    <div className="space-y-6">
      {/* Pending */}
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
              <th className="px-4 py-3 text-right">Original</th>
              <th className="px-4 py-3 text-right">Adjusted</th>
              <th className="px-4 py-3 text-right">Difference</th>
              <th className="px-4 py-3 text-center">Actions</th>
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
              pending.map((a: any) => {
                const busy = loading?.startsWith(a.id)
                return (
                  <tr key={a.id} className="border-b border-orange-900/20 hover:bg-orange-900/10">
                    <td className="px-5 py-3 font-mono text-xs text-gray-300">{a.order_number}</td>
                    <td className="px-4 py-3 font-medium text-gray-200">{a.clients?.name ?? <span className="text-gray-500 italic">Unassigned</span>}</td>
                    <td className="px-4 py-3 text-gray-300">{a.reason ?? 'Carrier reweigh / rate change'}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400">{a.original_cost != null ? `$${Number(a.original_cost).toFixed(2)}` : '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-300">{a.adjusted_cost != null ? `$${Number(a.adjusted_cost).toFixed(2)}` : '—'}</td>
                    <td className="px-4 py-3 text-right font-bold text-orange-400">+${Number(a.adjustment_amount ?? 0).toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5 justify-center">
                        <button
                          onClick={() => updateStatus(a.id, 'approved', 'approved')}
                          disabled={!!busy}
                          title="Mark as approved — will be charged to client"
                          className="px-2.5 py-1 rounded text-xs font-medium bg-green-800 hover:bg-green-700 text-green-200 disabled:opacity-40 transition"
                        >
                          {loading === a.id + 'approved' ? '…' : '✓ Approve'}
                        </button>
                        <button
                          onClick={() => updateStatus(a.id, 'billed', 'billed')}
                          disabled={!!busy}
                          title="Mark as already billed to client"
                          className="px-2.5 py-1 rounded text-xs font-medium text-[#00AAFF] border border-[#00AAFF]/40 hover:bg-[#00AAFF]/10 disabled:opacity-40 transition"
                        >
                          {loading === a.id + 'billed' ? '…' : '$ Billed'}
                        </button>
                        <button
                          onClick={() => updateStatus(a.id, 'waived', 'waived')}
                          disabled={!!busy}
                          title="Waive this adjustment — won't be charged"
                          className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-40 transition"
                        >
                          {loading === a.id + 'waived' ? '…' : '✕ Waive'}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
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

      {/* Resolved */}
      {resolved.length > 0 && (
        <div className="bg-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
            <span className="text-gray-300 font-semibold">Resolved Adjustments</span>
            <span className="text-gray-500 text-sm">{resolved.length} records</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase tracking-wider">
                <th className="px-5 py-3">Order #</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Original</th>
                <th className="px-4 py-3 text-right">Adjusted</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((a: any) => (
                <tr key={a.id} className="border-b border-gray-700/40 hover:bg-gray-700/20">
                  <td className="px-5 py-3 font-mono text-xs text-gray-400">{a.order_number}</td>
                  <td className="px-4 py-3 text-gray-300">{a.clients?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{a.reason ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500 text-xs">{a.original_cost != null ? `$${Number(a.original_cost).toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-500 text-xs">{a.adjusted_cost != null ? `$${Number(a.adjusted_cost).toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-300">+${Number(a.adjustment_amount ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadge(a.status)}`}>{a.status}</span>
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
