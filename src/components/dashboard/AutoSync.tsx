'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // every 5 minutes

export default function AutoSync() {
  const router = useRouter()
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [elapsed, setElapsed] = useState('')
  const [hasIssues, setHasIssues] = useState(false)

  const runSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      // Use the monitor agent — syncs + recalculates + checks for issues
      const res = await fetch('/api/agent/monitor', { method: 'GET' })
      const data = await res.json().catch(() => ({}))
      setLastSynced(new Date())
      setHasIssues(data.has_issues ?? false)
      if (data.errors?.length) {
        data.errors.forEach((e: string) => showError('Monitor alert', e))
      }
      router.refresh()
    } catch (err: any) {
      showError('Auto-sync failed', err?.message ?? 'Could not connect. Will retry in 5 minutes.')
    } finally {
      setSyncing(false)
    }
  }, [syncing, router])

  // Sync on mount, then every 5 minutes
  useEffect(() => {
    runSync()
    const interval = setInterval(runSync, SYNC_INTERVAL_MS)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update "X ago" label every 15 seconds
  useEffect(() => {
    const tick = () => {
      if (!lastSynced) return
      const secs = Math.floor((Date.now() - lastSynced.getTime()) / 1000)
      if (secs < 60) setElapsed(`${secs}s ago`)
      else setElapsed(`${Math.floor(secs / 60)}m ago`)
    }
    tick()
    const t = setInterval(tick, 15_000)
    return () => clearInterval(t)
  }, [lastSynced])

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full transition-colors ${
        syncing ? 'bg-[#00AAFF] animate-pulse' :
        hasIssues ? 'bg-orange-400 animate-pulse' :
        'bg-green-500'
      }`} />
      <span className="text-gray-400">
        {syncing
          ? 'Syncing…'
          : lastSynced
            ? `${hasIssues ? '⚠ Issues detected · ' : ''}Synced ${elapsed}`
            : 'Starting sync…'}
      </span>
    </div>
  )
}
