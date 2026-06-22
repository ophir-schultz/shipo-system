'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

export default function SyncButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [recalcLoading, setRecalcLoading] = useState(false)

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
      showSuccess('Sync complete', `${data.shipments?.created ?? 0} new · ${data.shipments?.updated ?? 0} updated · ${data.shipments?.adjustments ?? 0} adjustments`)
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
      showSuccess('Recalculation complete', `${data.updated} shipments updated · ${data.repriced} repriced by weight`)
      router.refresh()
    } catch (err: any) {
      showError('Recalculation failed', err?.message ?? 'Could not recalculate weights')
    } finally {
      setRecalcLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
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
