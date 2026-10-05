import { describe, it, expect } from 'vitest'
import {
  canStart, isLockConflict, staleRunCutoffISO, STALE_RUN_MINUTES,
} from '@/lib/ledger/run-lock'

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

describe('staleRunCutoffISO', () => {
  // The cutoff and canStart() now have to agree EXACTLY, because they are the
  // two halves of one policy: canStart is the advisory pre-check and the cutoff
  // is what openSyncRun() reaps with before the unique index arbitrates. If
  // they drifted, the gap between them would be a band of ages in which
  // canStart says "blocked" while the reaper has already cleared the row, or
  // the reverse -- canStart waves a run through and the index then refuses it.
  //
  // So this is asserted as "the exact boundary canStart uses", not as "30
  // minutes ago": a test written against the literal would stay green while the
  // two halves separated, which is the only way this can actually break.
  it('is the exact instant at which canStart stops blocking', () => {
    const cutoff = staleRunCutoffISO(now)

    // One millisecond older than the cutoff: reaped, and canStart agrees.
    const older = new Date(Date.parse(cutoff) - 1).toISOString()
    expect(older < cutoff).toBe(true)
    expect(canStart([{ started_at: older, status: 'running' }], now)).toEqual({ ok: true })

    // One millisecond newer: not reaped (`lt` is strict), and canStart blocks.
    const newer = new Date(Date.parse(cutoff) + 1).toISOString()
    expect(newer < cutoff).toBe(false)
    expect(canStart([{ started_at: newer, status: 'running' }], now).ok).toBe(false)
  })

  // Its only consumer is a PostgREST `lt` filter, which compares timestamptz as
  // text. A Date object or a local-time string would compare wrongly rather
  // than error, so the shape is part of the contract.
  it('returns a UTC ISO string, because PostgREST compares it as text', () => {
    expect(staleRunCutoffISO(now)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })

  it('derives from STALE_RUN_MINUTES rather than restating it', () => {
    expect(staleRunCutoffISO(now))
      .toBe(new Date(now.getTime() - STALE_RUN_MINUTES * 60_000).toISOString())
  })
})

describe('isLockConflict', () => {
  // 23505 from the sync_runs insert is the NORMAL outcome for the losing run of
  // an overlapping pair: it means the mutex worked. Every other error means we
  // could not tell, and the callers treat the two completely differently -- a
  // lock loss is a quiet skip, anything else is reported.
  it('recognises a unique violation', () => {
    expect(isLockConflict({ code: '23505', message: 'duplicate key value' })).toBe(true)
  })

  it('rejects every other Postgres error', () => {
    expect(isLockConflict({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isLockConflict({ code: '42P10', message: 'no unique constraint matching' })).toBe(false)
    expect(isLockConflict({ code: '23503', message: 'foreign key violation' })).toBe(false)
  })

  // Matched on the CODE, never the message. Postgres names the index in its
  // unique-violation text and that text is not stable across versions or
  // renames -- matching on prose is how this branch has already been bitten
  // three times.
  it('does not match on the message text', () => {
    expect(isLockConflict({
      message: 'duplicate key value violates unique constraint "sync_runs_running_source_key"',
    })).toBe(false)
  })

  it('survives null, undefined and a bare string', () => {
    expect(isLockConflict(null)).toBe(false)
    expect(isLockConflict(undefined)).toBe(false)
    expect(isLockConflict('23505')).toBe(false)
  })

  // PostgREST sends the code as a string. A number 23505 is not what arrives,
  // and accepting it would be a quietly wrong equality to rely on.
  it('does not accept a numeric code', () => {
    expect(isLockConflict({ code: 23505 })).toBe(false)
  })
})
