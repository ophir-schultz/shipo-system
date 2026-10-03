'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { showError } from '@/components/ui/Toast'
import {
  classifyMonitorAttempt, describeSync, type MonitorAttempt, type SyncStatus,
} from '@/lib/monitor/sync-status'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // every 5 minutes

export default function AutoSync() {
  const router = useRouter()
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [elapsed, setElapsed] = useState('')
  const [status, setStatus] = useState<SyncStatus | null>(null)

  const runSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)

    // Every outcome, including a thrown fetch, becomes one MonitorAttempt and
    // is classified in one place. What this widget may claim about a pass lives
    // in src/lib/monitor/sync-status.ts, with the post-mortem on why a failed
    // pass used to render as a clean one.
    let attempt: MonitorAttempt
    try {
      // Use the monitor agent — syncs + recalculates + checks for issues
      const res = await fetch('/api/agent/monitor', { method: 'GET' })
      let body: unknown
      let bodyParsed = true
      try {
        body = await res.json()
      } catch {
        bodyParsed = false
      }
      attempt = { kind: 'responded', ok: res.ok, status: res.status, bodyParsed, body }
    } catch (err) {
      attempt = { kind: 'threw', message: err instanceof Error ? err.message : String(err) }
    }

    // `finally`, because `if (syncing) return` above means a syncing flag left
    // stuck true disables the widget for the life of the page.
    try {
      const next = classifyMonitorAttempt(attempt)
      setStatus(next)
      // Only a pass that actually finished may move the clock. Stamping the
      // time on a 401 turned "not synced since 09:00" into "Synced 3s ago".
      if (next.advancesTimestamp) setLastSynced(new Date())
      if (next.toast) showError(next.toast.title, next.toast.message)
      for (const issue of next.issues) showError('Monitor alert', issue)

      // Not refreshed on an unknown pass: the server components would re-render
      // from whatever the last successful run left behind, which is the stale
      // data this state exists to flag rather than refresh over.
      if (next.outcome !== 'unknown') router.refresh()
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

  // `elapsed` is still '' on the render between setLastSynced and the tick
  // effect, so it is passed as absent rather than as an empty string -- `??`
  // would keep '' and render a bare "Synced ".
  const { dot, label } = describeSync(status, {
    syncing,
    elapsed: lastSynced && elapsed ? elapsed : null,
  })

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full transition-colors ${dot}`} />
      <span className={status?.outcome === 'unknown' ? 'text-red-400' : 'text-gray-400'}>
        {label}
      </span>
    </div>
  )
}
