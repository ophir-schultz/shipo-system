'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function SyncButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [recalcLoading, setRecalcLoading] = useState(false)
  const [result, setResult] = useState<any>(null)

  async function handleSync() {
    setLoading(true)
    setResult(null)
    const res = await fetch('/api/sync/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daysBack: 30 }),
    })
    const data = await res.json()
    setResult(data)
    setLoading(false)
    router.refresh()
  }

  async function handleRecalculate() {
    setRecalcLoading(true)
    setResult(null)
    const res = await fetch('/api/sync/recalculate', { method: 'POST' })
    const data = await res.json()
    setResult({ recalc: data })
    setRecalcLoading(false)
    router.refresh()
  }

  return (
    <div className="flex items-center gap-3">
      {result && (
        <span className="text-sm text-gray-400">
          {result.recalc
            ? `✓ ${result.recalc.updated} shipments recalculated · ${result.recalc.repriced} repriced by weight`
            : `✓ ${result.shipments?.created ?? 0} new · ${result.shipments?.updated ?? 0} updated · ${result.shipments?.adjustments ?? 0} adjustments`}
        </span>
      )}
      <button
        onClick={handleRecalculate}
        disabled={recalcLoading || loading}
        className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2"
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
  )
}
