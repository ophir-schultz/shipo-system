'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess, showWarning } from '@/components/ui/Toast'
import {
  hasRecalcGaps,
  recalcGaps,
  recalcSeverity,
  recalcSummary,
  type RecalcStatsLike,
} from '@/lib/billing/recalc-report'

export default function SyncButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [recalcLoading, setRecalcLoading] = useState(false)
  // Held in state rather than shown in a toast: the gap list is the artifact
  // you act on -- it names the rate cards that are incomplete and gives an
  // example order for each -- and showSuccess() auto-dismisses in 4 seconds.
  // Before this, `reasons` was computed on every run and never rendered at
  // all; see the header of src/lib/billing/recalc-report.ts.
  const [recalc, setRecalc] = useState<RecalcStatsLike | null>(null)

  async function handleSync() {
    setLoading(true)
    try {
      const res = await fetch('/api/sync/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysBack: 30 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      showSuccess('ShipStation sync complete', `${data.shipments?.created ?? 0} new · ${data.shipments?.updated ?? 0} updated · ${data.shipments?.adjustments ?? 0} adjustments`)
      if (data.client_sync_error) {
        showError('Zenventory client mapping failed', data.client_sync_error)
      }
      router.refresh()
    } catch (err: any) {
      showError('Sync failed', err?.message ?? 'Could not sync with ShipStation')
    } finally {
      setLoading(false)
    }
  }

  async function handleRecalculate() {
    setRecalcLoading(true)
    try {
      const res = await fetch('/api/sync/recalculate', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Recalculation failed')
      const stats = data as RecalcStatsLike
      setRecalc(stats)
      // Severity is decided in recalc-report.ts, where it can be tested --
      // vitest excludes .test.tsx, so a rule written inline here could not be.
      // The old call was showSuccess() unconditionally, which painted a run
      // with hundreds of unpriced shipments green for four seconds.
      const summary = recalcSummary(stats)
      const severity = recalcSeverity(stats)
      if (severity === 'error') showError('Recalculation wrote nothing for some rows', summary)
      else if (severity === 'warning') showWarning('Recalculation finished with gaps', summary)
      else showSuccess('Recalculation complete', summary)
      router.refresh()
    } catch (err: any) {
      showError('Recalculation failed', err?.message ?? 'Could not recalculate weights')
    } finally {
      setRecalcLoading(false)
    }
  }

  return (
    <div className="space-y-3">
    <div className="flex items-center gap-3">
      <button
        onClick={handleRecalculate}
        disabled={recalcLoading || loading}
        className="bg-[#EEF3FA] hover:bg-[#DDE6F2] disabled:opacity-50 text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2"
        title="Recalculate all shipment rates using billed weight (max of actual vs dimensional)"
      >
        {recalcLoading ? <><span className="animate-spin">⟳</span> Recalculating...</> : '⚖️ Recalculate Weights'}
      </button>
      <button
        onClick={handleSync}
        disabled={loading || recalcLoading}
        className="bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2"
      >
        {loading ? <><span className="animate-spin">⟳</span> Syncing...</> : <>⟳ Sync ShipStation</>}
      </button>
    </div>

    {recalc && hasRecalcGaps(recalc) && (
      <div className="border border-amber-700/60 bg-amber-950/40 rounded-lg p-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-semibold text-amber-200">
              Shipments this run could not price
            </p>
            <p className="text-amber-300/80 text-xs mt-0.5">{recalcSummary(recalc)}</p>
          </div>
          <button
            onClick={() => setRecalc(null)}
            className="text-amber-300/70 hover:text-amber-200 text-xs shrink-0"
          >
            Dismiss
          </button>
        </div>

        {/* `failed` is not a rate-card gap and must not be read as one: the
            write was attempted and the database did not accept it, so these
            rows still hold their OLD price and the screen below is stale for
            them. Re-run before trusting any figure. */}
        {typeof recalc.failed === 'number' && recalc.failed > 0 && (
          <p className="mt-3 text-red-300 text-xs">
            ⚠ {recalc.failed} row{recalc.failed === 1 ? '' : 's'} failed to save — those
            shipments still hold their previous price. Re-run before billing.
          </p>
        )}

        {recalcGaps(recalc).length > 0 && (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr className="text-amber-300/60 text-left">
                <th className="font-normal pb-1">What was missing</th>
                <th className="font-normal pb-1 text-right w-20">Shipments</th>
                <th className="font-normal pb-1 text-right w-28">Example order</th>
              </tr>
            </thead>
            <tbody>
              {recalcGaps(recalc).map(g => (
                <tr key={g.reason} className="border-t border-amber-800/30">
                  <td className="py-1 pr-3 text-gray-200">{g.reason}</td>
                  <td className="py-1 text-right text-amber-200 font-medium tabular-nums">{g.count}</td>
                  <td className="py-1 text-right text-[#4B4F58] font-mono">{g.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="mt-3 text-amber-300/60 text-xs">
          Each line is a rate the system has no price for. Open the example order to see
          the carrier, service and billed weight that found no band, then add that band to
          the client&apos;s rate card and run this again.
        </p>
      </div>
    )}
    </div>
  )
}
