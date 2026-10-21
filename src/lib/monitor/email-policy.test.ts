import { describe, it, expect } from 'vitest'
import {
  parseMonitorEmailMode,
  monitorEmailDecision,
  deliveryFailed,
} from './email-policy'

describe('parseMonitorEmailMode', () => {
  it('defaults to off when unset', () => {
    // The whole reason this file exists. If this ever flips to 'always' the
    // emails come back on the next deploy with nobody having asked for them.
    expect(parseMonitorEmailMode(undefined)).toBe('off')
    expect(parseMonitorEmailMode(null)).toBe('off')
    expect(parseMonitorEmailMode('')).toBe('off')
    expect(parseMonitorEmailMode('   ')).toBe('off')
  })

  it('does NOT fall back to always on a typo', () => {
    // A misspelled env var must stay quiet. Falling back to 'always' would
    // mean one bad character restores six mails a day.
    expect(parseMonitorEmailMode('alwyas')).toBe('off')
    expect(parseMonitorEmailMode('yes please')).toBe('off')
    expect(parseMonitorEmailMode('problemss')).toBe('off')
  })

  it('reads the explicit on values', () => {
    for (const v of ['always', 'on', 'true', '1']) {
      expect(parseMonitorEmailMode(v)).toBe('always')
    }
  })

  it('reads the problems-only values', () => {
    for (const v of ['problems', 'problems-only', 'issues', 'on-issues']) {
      expect(parseMonitorEmailMode(v)).toBe('problems')
    }
  })

  it('is case- and whitespace-insensitive', () => {
    // Vercel's env UI happily stores a trailing space.
    expect(parseMonitorEmailMode('  ALWAYS  ')).toBe('always')
    expect(parseMonitorEmailMode('Problems\n')).toBe('problems')
  })

  it('treats off-ish values as off rather than guessing', () => {
    for (const v of ['off', 'false', '0', 'no', 'disabled']) {
      expect(parseMonitorEmailMode(v)).toBe('off')
    }
  })
})

describe('monitorEmailDecision', () => {
  it('sends nothing when off, even on a run full of problems', () => {
    const d = monitorEmailDecision(undefined, true)
    expect(d.send).toBe(false)
    expect(d.mode).toBe('off')
  })

  it('tells the reader how to turn it back on', () => {
    // The run log is where someone looks when they want the mails back.
    const d = monitorEmailDecision(undefined, true)
    expect(d.reason).toContain('MONITOR_EMAIL')
    expect(d.reason).toContain('problems')
    expect(d.reason).toContain('always')
  })

  it('always has a reason', () => {
    for (const raw of [undefined, 'off', 'problems', 'always']) {
      for (const hasErrors of [true, false]) {
        expect(monitorEmailDecision(raw, hasErrors).reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('in problems mode, sends on a bad run and stays quiet on a clean one', () => {
    expect(monitorEmailDecision('problems', true).send).toBe(true)
    expect(monitorEmailDecision('problems', false).send).toBe(false)
  })

  it('in always mode, sends regardless of findings', () => {
    // This is the OLD behaviour, kept reachable but no longer the default.
    expect(monitorEmailDecision('always', true).send).toBe(true)
    expect(monitorEmailDecision('always', false).send).toBe(true)
  })

  it('ignores hasErrors entirely when off', () => {
    expect(monitorEmailDecision('off', true).send).toBe(false)
    expect(monitorEmailDecision('off', false).send).toBe(false)
  })
})

describe('deliveryFailed', () => {
  it('is false for a report we chose not to send', () => {
    // THE BUG THIS FUNCTION PREVENTS. A suppressed report is `sent: false`,
    // exactly like a dead mail provider. Reading `!sent` on its own would
    // 500 the cron six times a day and push a "NOT DELIVERED" line about a
    // delivery nobody attempted.
    const off = monitorEmailDecision(undefined, true)
    expect(deliveryFailed(off, false)).toBe(false)

    const cleanRun = monitorEmailDecision('problems', false)
    expect(deliveryFailed(cleanRun, false)).toBe(false)
  })

  it('is true when we tried to send and it did not go', () => {
    // The case the 500 exists for: a configured-but-broken provider, or no
    // provider at all. This must stay loud.
    const d = monitorEmailDecision('always', true)
    expect(deliveryFailed(d, false)).toBe(true)
  })

  it('is false on a successful send', () => {
    expect(deliveryFailed(monitorEmailDecision('always', true), true)).toBe(false)
    expect(deliveryFailed(monitorEmailDecision('problems', true), true)).toBe(false)
  })

  it('distinguishes suppressed from failed on identical `sent` values', () => {
    // Both arms get sent=false. Only one is a failure. If these two ever
    // return the same thing, the signal is gone.
    const suppressed = deliveryFailed(monitorEmailDecision('off', true), false)
    const failed = deliveryFailed(monitorEmailDecision('always', true), false)
    expect(suppressed).not.toBe(failed)
  })
})
