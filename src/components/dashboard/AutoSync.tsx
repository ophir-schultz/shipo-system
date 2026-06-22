'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { showError } from '@/components/ui/Toast'

const SYNC_INTERVAL_MS = 3 * 60 * 1000 // 3 minutes

export default function AutoSync() {
  const router = useRouter()
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [elapsed, setElapsed] = useState('')

  const runSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await fetch('/api/sync/all', { method: 'GET' })
      setLastSynced(new Date())
      router.refresh()
    } catch (err: any) {
      showError('Sync failed', err?.message ?? 'Could not connect to ShipStation. Will retry in 3 minutes.')
    } finally {
      setSyncing(false)
    }
  }, [syncing, router])

  // Sync on mount, then every 3 minutes
  useEffect(() => {
    runSync()
    const interval = setInterval(runSync, SYNC_INTERVAL_MS)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update "X ago" label every 10 seconds
  useEffect(() => {
    const tick = () => {
      if (!lastSynced) return
      const secs = Math.floor((Date.now() - lastSynced.getTime()) / 1000)
      if (secs < 60) setElapsed(`${secs}s ago`)
      else setElapsed(`${Math.floor(secs / 60)}m ago`)
    }
    tick()
    const t = setInterval(tick, 10_000)
    return () => clearInterval(t)
  }, [lastSynced])

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full ${syncing ? 'bg-[#00AAFF] animate-pulse' : 'bg-green-500'}`} />
      <span className="text-gray-400">
        {syncing ? 'Syncing…' : lastSynced ? `Synced ${elapsed}` : 'Waiting for sync…'}
      </span>
    </div>
  )
}
