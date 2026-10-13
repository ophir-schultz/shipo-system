import { describe, it, expect } from 'vitest'
import {
  classifyMonitorAttempt, describeSync, type MonitorAttempt,
} from './sync-status'

// This file exists because AutoSync.tsx read `data.has_issues ?? false` from a
// response it never checked for success. A 401/500/504 resolves normally, the
// field is absent, `?? false` makes it "no issues", and the widget rendered a
// green dot reading "Synced 3s ago" over a pass that had not run.
//
// So the assertions that matter most here are the negative ones: that the
// unknown state is never green and never says "Synced". Those two strings are
// the actual thing that lied.

const responded = (over: Partial<Extract<MonitorAttempt, { kind: 'responded' }>>): MonitorAttempt => ({
  kind: 'responded', ok: true, status: 200, bodyParsed: true, body: {}, ...over,
})

const clean = responded({ body: { ok: true, has_issues: false, errors: [] } })

describe('classifyMonitorAttempt separates a pass that ran from one that did not', () => {
  it('reports clean only for an OK response that actually says so', () => {
    const status = classifyMonitorAttempt(clean)
    expect(status.outcome).toBe('clean')
    expect(status.issues).toEqual([])
    expect(status.advancesTimestamp).toBe(true)
  })

  it('reports issues when the monitor says it found them, and carries them out', () => {
    const status = classifyMonitorAttempt(responded({
      body: { has_issues: true, errors: ['⚠ 41 shipments have no rate match', '✗ 2 could not be written'] },
    }))
    expect(status.outcome).toBe('issues')
    expect(status.issues).toHaveLength(2)
    expect(status.issues[0]).toMatch(/no rate match/)
    // The messages have to survive classification or the toasts go silent.
    expect(status.advancesTimestamp).toBe(true)
  })

  // The regression. Each of these used to produce outcome 'clean'.
  it.each([401, 403, 500, 502, 504])('treats HTTP %i as unknown, never as clean', (status) => {
    // 401 body is `{ error: 'Not authorised.' }` from requireStaff -- valid
    // JSON, which is why guarding only the parse would still have shown green.
    const result = classifyMonitorAttempt(responded({
      ok: false, status, body: { error: 'Not authorised.' },
    }))
    expect(result.outcome).toBe('unknown')
    expect(result.detail).toContain(String(status))
    expect(result.advancesTimestamp).toBe(false)
    expect(result.toast).not.toBeNull()
  })

  it('does not let a non-OK status be rescued by a body that looks clean', () => {
    // A cached or proxied 500 could carry anything. `ok` decides first.
    const result = classifyMonitorAttempt(responded({
      ok: false, status: 500, body: { ok: true, has_issues: false, errors: [] },
    }))
    expect(result.outcome).toBe('unknown')
  })

  // ── A 500 that means "ran, could not deliver the report" ──────────────────
  //
  // monitor/route.ts:792 returns `status: emailResult.sent ? 200 : 500`. That
  // 500 is DELIBERATE and has to stay: Vercel records the status of every cron
  // invocation, and it is the only signal an unattended caller surfaces, so it
  // is what turns a dead alerting channel into a visible failed run.
  //
  // But it is a second meaning on the same code. An unhandled throw also gives
  // 500, and those two want opposite words:
  //
  //   throw                -> the pass did not run, the body is worthless
  //   route.ts:792         -> the pass RAN IN FULL, the body is the whole report
  //
  // Collapsing them made the widget say "this pass did not run. Nothing here
  // reflects a completed check" over a pass whose results were sitting in the
  // response it had just discarded -- provably so, since sync_runs holds the
  // rows those passes wrote. That is the same defect this module was built to
  // fix, one layer further out: a shared status code with no discriminator.
  //
  // The rule that resolves it without reopening the original hole: A NON-OK
  // RESPONSE MAY NEVER PRODUCE `clean`. It may only ever produce `issues` or
  // `unknown`, and `issues` only when the body POSITIVELY reports a problem.
  // So a failed read still cannot render as reassurance -- the direction that
  // mattered -- while a completed pass stops being thrown away.
  it('reads a completed pass out of the 500 the route sends when mail is down', () => {
    // The real body from route.ts:759-793 when sendEmail returns provider 'none'.
    const result = classifyMonitorAttempt(responded({
      ok: false,
      status: 500,
      body: {
        ok: false,
        has_issues: true,
        errors: [
          '⚠ 294 shipments on stores with no client_store_ids row',
          "✗ THIS REPORT WAS NOT DELIVERED to ophir@shipousa.com (provider 'none')",
        ],
      },
    }))
    expect(result.outcome).toBe('issues')
    expect(result.issues).toHaveLength(2)
    // The findings must survive, or the operator loses them every pass.
    expect(result.issues[1]).toMatch(/NOT DELIVERED/)
    // The pass completed, so the clock is honest. The original bug was
    // advancing it over a pass that had NOT completed; this one did.
    expect(result.advancesTimestamp).toBe(true)
  })

  it('never says a pass did not run when the body proves it did', () => {
    const result = classifyMonitorAttempt(responded({
      ok: false,
      status: 500,
      body: { has_issues: true, errors: ['✗ THIS REPORT WAS NOT DELIVERED'] },
    }))
    // The precise sentence that was false on screen.
    expect(result.toast?.message ?? '').not.toMatch(/did not run/)
    expect(result.detail).not.toMatch(/did not run/)
  })

  it('still refuses a non-OK body that reports no problem at all', () => {
    // The companion to the rescue above, and the line that keeps the original
    // hole shut. has_issues false with an empty errors array is a body claiming
    // everything is fine on a response that failed -- exactly the shape a cached
    // or proxied 500 can carry. It gets nothing.
    for (const body of [
      { ok: true, has_issues: false, errors: [] },
      { has_issues: false },
      { ok: true },
      {},
    ]) {
      const result = classifyMonitorAttempt(responded({ ok: false, status: 500, body }))
      expect(result.outcome).toBe('unknown')
      expect(result.advancesTimestamp).toBe(false)
    }
  })

  it('does not mistake somebody else\'s JSON error for the monitor reporting', () => {
    // The rescue above keys on has_issues because that is the route's signature
    // field. An edge proxy, a gateway or an auth layer can return JSON with an
    // `errors` array of its own, and that is NOT a completed monitor pass -- it
    // is the "did not run" case wearing a familiar-looking shape. Without the
    // has_issues requirement this would advance the clock on nothing.
    for (const body of [
      { errors: ['upstream request timeout'] },
      { errors: ['blocked'], message: 'edge error' },
      { has_issues: 'true', errors: ['looks right, is a string'] },
    ]) {
      const result = classifyMonitorAttempt(responded({ ok: false, status: 500, body }))
      expect(result.outcome).toBe('unknown')
      expect(result.advancesTimestamp).toBe(false)
    }
  })

  it('still refuses a non-OK response whose body did not parse', () => {
    // An unhandled throw renders Next's HTML error page, which does not parse.
    // This is the genuine "did not run" 500 and must keep its original wording.
    const result = classifyMonitorAttempt(responded({
      ok: false, status: 500, bodyParsed: false, body: undefined,
    }))
    expect(result.outcome).toBe('unknown')
    expect(result.advancesTimestamp).toBe(false)
    expect(result.toast?.message).toMatch(/did not run/)
  })

  it('never lets a non-OK response reach clean, whatever the body says', () => {
    // The invariant, stated once as itself rather than implied by the cases.
    for (const body of [
      { ok: true, has_issues: false, errors: [] },
      { has_issues: true, errors: ['something'] },
      { has_issues: false, errors: ['something'] },
    ]) {
      expect(
        classifyMonitorAttempt(responded({ ok: false, status: 500, body })).outcome,
      ).not.toBe('clean')
    }
  })

  it('treats an unparseable body as unknown even on a 200', () => {
    const result = classifyMonitorAttempt(responded({ bodyParsed: false, body: undefined }))
    expect(result.outcome).toBe('unknown')
    expect(result.advancesTimestamp).toBe(false)
  })

  it('treats a 200 that omits has_issues as suspect rather than clean', () => {
    // The route sends has_issues on every success, so a 200 without it is not
    // the monitor's answer. This is the `?? false` that started all of it.
    for (const body of [{}, { ok: true }, { has_issues: null }, { has_issues: 'false' }]) {
      const result = classifyMonitorAttempt(responded({ body }))
      expect(result.outcome).toBe('unknown')
      expect(result.advancesTimestamp).toBe(false)
    }
  })

  it('believes a populated errors array even if has_issues is missing or false', () => {
    // Under-reporting is the direction that must never win. A missing
    // has_issues is still unknown, but one that says false while shipping
    // errors is a contradiction resolved toward the alarm.
    const result = classifyMonitorAttempt(responded({
      body: { has_issues: false, errors: ['⚠ 3 orders failed charge calculation'] },
    }))
    expect(result.outcome).toBe('issues')
    expect(result.issues).toHaveLength(1)
  })

  it('reports a thrown fetch as unknown with a reason', () => {
    const result = classifyMonitorAttempt({ kind: 'threw', message: 'Failed to fetch' })
    expect(result.outcome).toBe('unknown')
    expect(result.advancesTimestamp).toBe(false)
    expect(result.toast?.message).toMatch(/Failed to fetch/)
  })

  it('never produces a toast message containing undefined', () => {
    // An empty Error.message is a real case, and "undefined" rendered into a
    // toast reads as "no reason given, probably nothing".
    const attempts: MonitorAttempt[] = [
      { kind: 'threw', message: '' },
      responded({ ok: false, status: 0 }),
      responded({ bodyParsed: false, body: undefined }),
      responded({ body: {} }),
    ]
    for (const attempt of attempts) {
      const result = classifyMonitorAttempt(attempt)
      expect(result.toast?.message).toBeTruthy()
      expect(result.toast?.message).not.toMatch(/undefined/)
      expect(result.detail).not.toMatch(/undefined/)
    }
  })
})

describe('describeSync keeps the three states visually distinct', () => {
  const view = { syncing: false, elapsed: '3s ago' }

  it('is green and says Synced only when the pass was clean', () => {
    const { dot, label } = describeSync(classifyMonitorAttempt(clean), view)
    expect(dot).toContain('green')
    expect(label).toBe('Synced 3s ago')
  })

  it('is never green and never says Synced when the pass did not run', () => {
    // The whole bug, in one assertion pair.
    for (const attempt of [
      responded({ ok: false, status: 401, body: { error: 'Not authorised.' } }),
      responded({ ok: false, status: 504 }),
      responded({ bodyParsed: false, body: undefined }),
      responded({ body: {} }),
      // Deliberately a non-OK response carrying a body that would otherwise
      // classify as clean. Every other case here is also caught by the
      // response-shape check, so without this one the assertion below would
      // still pass with `res.ok` removed -- which is exactly the bug. Verified
      // by mutation: deleting the `!attempt.ok` branch fails on this entry.
      responded({ ok: false, status: 500, body: { ok: true, has_issues: false, errors: [] } }),
      { kind: 'threw', message: 'Failed to fetch' } as MonitorAttempt,
    ]) {
      const { dot, label } = describeSync(classifyMonitorAttempt(attempt), view)
      expect(dot).not.toContain('green')
      expect(label).not.toMatch(/Synced/)
      expect(label).toMatch(/failed/i)
    }
  })

  it('names the status code in the label so the failure is actionable', () => {
    const { label } = describeSync(
      classifyMonitorAttempt(responded({ ok: false, status: 504 })), view,
    )
    expect(label).toContain('504')
  })

  it('gives all three outcomes a different dot colour', () => {
    const dots = [
      clean,
      responded({ body: { has_issues: true, errors: ['x'] } }),
      responded({ ok: false, status: 500 }),
    ].map(a => describeSync(classifyMonitorAttempt(a), view).dot)
    expect(new Set(dots).size).toBe(3)
  })

  it('reports how stale the data is when a pass fails after an earlier success', () => {
    const failed = classifyMonitorAttempt(responded({ ok: false, status: 500 }))
    expect(describeSync(failed, { syncing: false, elapsed: '12m ago' }).label)
      .toContain('last clean 12m ago')
    // ...and says so plainly when there has never been one.
    expect(describeSync(failed, { syncing: false, elapsed: null }).label)
      .toContain('never completed')
  })

  it('shows the in-flight and pre-first-run states without claiming either outcome', () => {
    expect(describeSync(null, { syncing: true, elapsed: null }).label).toBe('Syncing…')
    const starting = describeSync(null, { syncing: false, elapsed: null })
    expect(starting.label).toBe('Starting sync…')
    expect(starting.dot).not.toContain('green')
    // A failed pass still shows as failed while the next attempt is in flight?
    // No -- syncing wins, because it is the honest description of right now.
    const failed = classifyMonitorAttempt(responded({ ok: false, status: 500 }))
    expect(describeSync(failed, { syncing: true, elapsed: '1m ago' }).label).toBe('Syncing…')
  })
})
