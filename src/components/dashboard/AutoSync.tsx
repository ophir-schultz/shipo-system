'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { showError } from '@/components/ui/Toast'
import {
  classifyMonitorAttempt, describeSync, type MonitorAttempt, type SyncStatus,
} from '@/lib/monitor/sync-status'
import { createSingleFlight } from '@/lib/monitor/single-flight'

const SYNC_INTERVAL_MS = 5 * 60 * 1000 // every 5 minutes

export default function AutoSync() {
  const router = useRouter()
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [elapsed, setElapsed] = useState('')
  const [status, setStatus] = useState<SyncStatus | null>(null)

  // The re-entry guard has to live in a ref rather than in `syncing`. The mount
  // effect below keeps an empty dep array, so setInterval holds ONE runSync
  // closure for the life of the page, and `syncing` read inside that closure is
  // frozen at its mount-time `false` -- so `if (syncing) return` could never
  // fire for a timer tick, which is the only call that can actually overlap.
  // A ref is read at call time, so it survives the capture. See
  // src/lib/monitor/single-flight.ts for the full account and why overlap on
  // /api/agent/monitor is reachable rather than theoretical.
  //
  // `syncing` stays, but only as display state, which is the one job it was
  // already doing correctly: it is set inside the gate, so it is true exactly
  // when a pass is really running and the dot really should be pulsing.
  const gate = useRef(createSingleFlight())

  const runSync = useCallback(() => gate.current(async () => {
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

    // `finally`, because a syncing flag left stuck true leaves the widget
    // reading "Syncing…" for the life of the page. The gate releases in a
    // `finally` of its own for the stricter version of the same reason: a gate
    // left shut would stop the widget syncing at all.
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
  }), [router])

  // Sync on mount, then every 5 minutes.
  //
  // The empty dep array is deliberate and is now safe. It means setInterval
  // captures one runSync for the life of the page, but everything that closure
  // touches is either stable (the gate ref, the state setters) or read at call
  // time, so nothing it sees can go stale -- which was not true while the
  // guard read `syncing`.
  //
  // Re-creating the interval whenever runSync changes would be the other way
  // to defeat the capture, but it is the worse one: clearInterval/setInterval
  // restarts the five-minute countdown from zero, so a dep that churns silently
  // changes the polling cadence, and one that churned on every sync would stop
  // the timer ever firing.
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
