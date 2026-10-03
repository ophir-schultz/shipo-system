// A re-entry guard that survives being captured in a closure.
//
// This module exists because the guard in AutoSync.tsx was dead for every call
// that could actually race:
//
//   const runSync = useCallback(async () => {
//     if (syncing) return            // <-- never true on a timer tick
//     ...
//   }, [syncing, router])
//
//   useEffect(() => {
//     runSync()
//     const interval = setInterval(runSync, SYNC_INTERVAL_MS)
//     return () => clearInterval(interval)
//   }, [])                            // <-- captures ONE runSync, for ever
//
// The effect's dep array is empty, so setInterval holds the runSync closure
// built on the first render for the life of the page. `syncing` inside that
// closure is the mount-time value and is therefore permanently `false`, however
// many times the component re-renders with it true. Every five-minute tick
// walked straight past `if (syncing) return`. Only the mount call was ever
// guarded, and the mount call is the one with nothing to race.
//
// A ref fixes it because a ref is read at call time instead of captured at
// definition time. Keeping the guard in a module rather than inline in the
// component is the same move as sync-status.ts next door, and for the same
// reason: vitest.config.ts collects only `src/**/*.test.ts`, so a guard that
// lives in the .tsx cannot be tested at all -- and an untested guard that
// quietly stopped working is exactly what this file is cleaning up after.
//
// Why overlap is worth guarding in the first place: the route AutoSync polls,
// /api/agent/monitor, declares `maxDuration = 300` -- exactly the poll interval
// -- so a pass that uses its budget finishes no sooner than the next tick
// begins. Overlap there is reachable, not theoretical. That route syncs
// ShipStation, recalculates every client rate and writes thirty days of ledger
// charges; its own header is a post-mortem on concurrent runs colliding on the
// charge lock and raising 23505 against the client-keyed unique index for
// storage charges, which is why persistStorageCharges is now gated behind that
// lock. A browser-driven overlapping pass is the same hazard from the other
// side, and the route already notes it is polled from every open tab.

/**
 * Wraps an async task so that a call made while one is still in flight is
 * refused outright rather than queued or run alongside.
 *
 * Returns `true` when the task ran and `false` when it was refused, so a caller
 * can tell "skipped" from "did it" without keeping its own flag.
 *
 * The check and the claim both happen before the first `await`, which is what
 * makes this safe: two calls in the same tick cannot both find the gate open.
 *
 * The gate reopens in a `finally`, so a task that throws does not leave it shut
 * -- a shut gate means a widget that never syncs again for the life of the
 * page, which is a worse failure than the overlap being prevented. A rejection
 * is re-thrown rather than swallowed, so the gate never also becomes a place
 * where errors go to die.
 */
export function createSingleFlight() {
  let inFlight = false

  return async function run(task: () => Promise<void>): Promise<boolean> {
    if (inFlight) return false
    inFlight = true
    try {
      await task()
      return true
    } finally {
      inFlight = false
    }
  }
}
