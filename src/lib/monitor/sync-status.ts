// What the AutoSync widget is allowed to claim after one call to
// /api/agent/monitor.
//
// This module exists because the widget used to derive its entire display from
// the response BODY and never looked at whether the request succeeded:
//
//   const res  = await fetch('/api/agent/monitor', { method: 'GET' })
//   const data = await res.json().catch(() => ({}))
//   setLastSynced(new Date())
//   setHasIssues(data.has_issues ?? false)
//
// On a 401, a 500 or a 504 the fetch RESOLVES -- only a network-level throw
// reaches a catch -- so every line above ran on a run that had not happened.
// `has_issues ?? false` turned an absent field into "no issues", `data.errors`
// was undefined so no toast was raised, and `setLastSynced(new Date())` stamped
// the current time on it. The dot rendered green and the label read
// "Synced 3s ago". A failed monitor pass was pixel-identical to a clean one.
//
// Note that a 401 from requireStaffOrCron is `{ error: 'Not authorised.' }`,
// which parses as JSON perfectly well. So guarding the parse is not enough and
// never was: `res.ok` is the load-bearing check, and the body shape is a second
// one behind it.
//
// Both of those are live cases rather than theoretical. The session behind the
// browser poll expires, and the route it polls declares `maxDuration = 300`
// precisely because it does not fit in Vercel's default budget -- a gateway
// timeout is the documented reason that ceiling was raised.
//
// Same doctrine as scripts/read-or-refuse.mjs and src/lib/billing/recalculate.ts:
// a read that did not happen is UNKNOWN, and UNKNOWN must never be rendered as
// the reassuring answer. NULL is "we do not know", 0 is "a decision somebody
// made", and a green tick is a decision this widget had not earned.
//
// The decision is kept pure and apart from the component for the same reason
// `readFailure` is kept apart from the `process.exit()` around it: so it can be
// unit-tested. vitest.config.ts collects only `src/**/*.test.ts`, so a test
// beside the .tsx would never run at all.

/**
 * The three states the widget must keep apart.
 *
 * `issues` and `unknown` are both "not fine", and collapsing them would be the
 * same mistake one level up: `issues` means the monitor ran and reported
 * problems with the data, `unknown` means nobody knows whether there are
 * problems. They lead an operator to different actions -- fix the data versus
 * fix the monitor -- so they get different colours and different words.
 */
export type SyncOutcome = 'clean' | 'issues' | 'unknown'

export interface SyncStatus {
  outcome: SyncOutcome
  /**
   * Why this is `unknown`, phrased to finish the sentence "Sync failed — ...".
   * Empty for the two outcomes that did run.
   */
  detail: string
  /** The monitor's own issue messages, each of which becomes a toast. */
  issues: string[]
  /**
   * Whether this attempt may advance the "last synced" clock. False for
   * `unknown`: the second half of the original bug was that the timestamp moved
   * on a run that never completed, so "Synced 3s ago" was a fresh lie rather
   * than a stale truth. The clock is now only ever the last pass that really
   * finished.
   */
  advancesTimestamp: boolean
  /** Raised as a toast, so a failure is announced and not merely coloured. */
  toast: { title: string; message: string } | null
}

/** One attempt on the endpoint, in the terms the caller actually has. */
export type MonitorAttempt =
  /** fetch() itself rejected -- offline, DNS, CORS, aborted. */
  | { kind: 'threw'; message: string }
  /** A response arrived. `body` is undefined when it would not parse. */
  | { kind: 'responded'; ok: boolean; status: number; bodyParsed: boolean; body?: unknown }

const UNREAD_TITLE = 'Sync status unknown'

/**
 * The monitor's own findings, but ONLY when this body is positively the
 * monitor reporting a problem. `null` for everything else.
 *
 * Used on the failed-response path, where the question is not "what does this
 * body say" but "is this body the route's completed report at all". Hence the
 * two conditions, which are different and both load-bearing:
 *
 *   `has_issues` is a real boolean  -- it is the route's signature field, sent
 *                                      on every response it builds itself, and
 *                                      absent from anything in front of it
 *   it positively reports a problem -- so a body claiming all is well on a
 *                                      response that FAILED is refused, which
 *                                      is the hole that must stay shut
 *
 * Returning the strings rather than a boolean matters: they are the findings,
 * and on a 500 from route.ts:792 they are the only copy that survives, since
 * the email carrying them is the thing that did not send.
 */
function readReportedProblem(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>

  if (typeof b.has_issues !== 'boolean') return null

  const issues = Array.isArray(b.errors)
    ? b.errors.filter((e): e is string => typeof e === 'string')
    : []

  // Either signal, matching the OK path: if a future version lets the flag and
  // the list disagree, the direction that under-reports must not win.
  if (b.has_issues !== true && issues.length === 0) return null

  return issues
}

function unknown(detail: string, message: string): SyncStatus {
  return {
    outcome: 'unknown',
    detail,
    issues: [],
    advancesTimestamp: false,
    toast: { title: UNREAD_TITLE, message },
  }
}

/**
 * What one attempt on /api/agent/monitor entitles the widget to display.
 *
 * Every path that is not a parsed, OK response carrying the monitor's own
 * contract lands on `unknown`. That is deliberately the default rather than the
 * exception: the failure mode being fixed here is a body-shaped guess rendering
 * as reassurance, and the only way to be sure that cannot recur is for `clean`
 * to require positive evidence.
 */
export function classifyMonitorAttempt(attempt: MonitorAttempt): SyncStatus {
  if (attempt.kind === 'threw') {
    // The one case the original code did handle. Kept on the same path as the
    // rest so there is a single definition of what a failed pass looks like.
    return unknown(
      'could not reach the monitor',
      `${attempt.message || 'Could not connect.'} Will retry in 5 minutes.`,
    )
  }

  if (!attempt.ok) {
    // A NON-OK RESPONSE MAY NEVER PRODUCE `clean`. Everything below keeps that
    // absolutely, and it is the whole of what the original bug needed.
    //
    // What it does NOT need is for every non-OK response to be treated as a
    // pass that never happened, because one of them is a pass that completed
    // in full. monitor/route.ts:792 returns `status: emailResult.sent ? 200
    // : 500` -- a deliberate 500 meaning "I ran, I have your report, I could
    // not DELIVER it". That 500 has to stay: Vercel records the status of
    // every cron invocation and it is the only signal an unattended caller
    // surfaces, so it is what makes a dead alerting channel visible.
    //
    // So 500 carries two meanings that want opposite words:
    //
    //   unhandled throw  -> did not run; the body is Next's HTML error page
    //   route.ts:792     -> ran in full; the body IS the report
    //
    // Collapsing them put "this pass did not run. Nothing here reflects a
    // completed check" on screen over passes whose results were in the very
    // response being discarded -- provably, since sync_runs holds the rows
    // those passes wrote. A shared status code with no discriminator, which is
    // the same defect this module exists to fix, one layer out.
    //
    // The discriminator is the body, and the bar for trusting it on a failed
    // response is deliberately higher than on a 200: it must carry
    // `has_issues` as a real boolean -- the route's signature field, which a
    // proxy error page or an auth interstitial has no reason to invent -- AND
    // it must POSITIVELY report a problem. A body claiming all is well on a
    // response that failed gets nothing, which is the exact hole that must
    // stay shut.
    const reported = readReportedProblem(attempt.bodyParsed ? attempt.body : undefined)
    if (reported) {
      return {
        outcome: 'issues',
        detail: '',
        issues: reported,
        // Honest here, and the distinction is the point. The original bug moved
        // this clock over a pass that had NOT completed. This pass did, so its
        // data is exactly as fresh as a 200's.
        advancesTimestamp: true,
        toast: null, // the per-issue toasts carry the detail, including the delivery failure
      }
    }

    return unknown(
      `status ${attempt.status}`,
      `The monitor returned HTTP ${attempt.status}, so this pass did not run. `
        + `Nothing here reflects a completed check`
        + `${attempt.status === 401 ? ' -- the session may have expired; try reloading' : ''}. `
        + `Will retry in 5 minutes.`,
    )
  }

  if (!attempt.bodyParsed) {
    // A 200 whose body is not JSON is not the monitor answering. It is usually
    // something in front of the route -- an auth interstitial, an edge error
    // page -- and it must not inherit the 200's credibility.
    return unknown(
      'unreadable response',
      'The monitor replied with something that is not its usual response, so '
        + 'this pass could not be read. Will retry in 5 minutes.',
    )
  }

  const body = (attempt.body ?? {}) as Record<string, unknown>
  const issues = Array.isArray(body.errors)
    ? body.errors.filter((e): e is string => typeof e === 'string')
    : []

  if (typeof body.has_issues !== 'boolean') {
    // The route returns `has_issues` on every success, so its absence from a
    // 200 means this is not the response this widget thinks it is reading --
    // a changed contract, or a different deployment answering. `?? false` here
    // was the exact line that turned that into a green dot, so the field being
    // missing is now a reason to refuse rather than a reason to default.
    return unknown(
      'unexpected response shape',
      'The monitor replied without saying whether it found issues, so this pass '
        + 'cannot be reported as clean.',
    )
  }

  if (body.has_issues || issues.length > 0) {
    // Either signal is enough. They agree in the route today (`has_issues` is
    // `errors.length > 0`), and if a future version lets them disagree, the
    // direction that under-reports is the one that must not win.
    return {
      outcome: 'issues',
      detail: '',
      issues,
      advancesTimestamp: true,
      toast: null, // the per-issue toasts below carry the detail
    }
  }

  return { outcome: 'clean', detail: '', issues: [], advancesTimestamp: true, toast: null }
}

/** The dot and the words, given a classified attempt and the view's clock. */
export function describeSync(
  status: SyncStatus | null,
  view: { syncing: boolean; elapsed: string | null },
): { dot: string; label: string } {
  if (view.syncing) {
    return { dot: 'bg-[#1A73E8] animate-pulse', label: 'Syncing…' }
  }

  if (!status) {
    return { dot: 'bg-gray-500', label: 'Starting sync…' }
  }

  const since = view.elapsed ?? 'just now'

  if (status.outcome === 'unknown') {
    return {
      dot: 'bg-red-500 animate-pulse',
      label: `⚠ Sync failed — ${status.detail}`
        + (view.elapsed ? ` · last clean ${view.elapsed}` : ' · never completed'),
    }
  }

  if (status.outcome === 'issues') {
    return { dot: 'bg-orange-400 animate-pulse', label: `⚠ Issues detected · Synced ${since}` }
  }

  return { dot: 'bg-green-500', label: `Synced ${since}` }
}
