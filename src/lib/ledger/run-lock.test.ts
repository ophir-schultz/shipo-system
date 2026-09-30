import { describe, it, expect } from 'vitest'
import { canStart, STALE_RUN_MINUTES } from '@/lib/ledger/run-lock'

const now = new Date('2026-09-29T10:00:30Z')
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString()

describe('canStart', () => {
  it('allows a run when nothing is in flight', () => {
    expect(canStart([], now)).toEqual({ ok: true })
  })

  it('allows a run when previous runs have finished', () => {
    expect(canStart([{ started_at: minutesAgo(5), status: 'ok' }], now))
      .toEqual({ ok: true })
  })

  // REVIEW FOCUS 3. This is the case that corrupts the ledger: run A started
  // 30 seconds ago and is still writing. Run B must not start.
  it('refuses a run while another is live', () => {
    const r = canStart([{ started_at: minutesAgo(0.5), status: 'running' }], now)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/in progress/i)
  })

  // A crashed run leaves 'running' behind forever. Without a staleness cutoff
  // one crash stops charge calculation permanently and silently.
  it('allows a run when the live one is older than the stale cutoff', () => {
    expect(canStart(
      [{ started_at: minutesAgo(STALE_RUN_MINUTES + 1), status: 'running' }], now,
    )).toEqual({ ok: true })
  })

  it('still refuses just inside the stale cutoff', () => {
    expect(canStart(
      [{ started_at: minutesAgo(STALE_RUN_MINUTES - 1), status: 'running' }], now,
    ).ok).toBe(false)
  })

  it('ignores an unparseable started_at rather than blocking forever', () => {
    expect(canStart([{ started_at: 'not a date', status: 'running' }], now))
      .toEqual({ ok: true })
  })
})
