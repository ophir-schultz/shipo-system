import { describe, expect, it } from 'vitest'
import {
  warehouseParts, watermarkPickDate, watermarkIsEvidence, WATERMARK_MAX_GAP_HOURS,
} from '@/lib/ledger/pick-date'

describe('warehouseParts', () => {
  it('reports the local date and hour, not the UTC ones', () => {
    // 2026-09-30T01:30Z is still 2026-09-29 at 21:30 in the warehouse.
    expect(warehouseParts(new Date('2026-09-30T01:30:00Z')))
      .toEqual({ date: '2026-09-29', hour: 21 })
  })
})

describe('watermarkPickDate', () => {
  it('stamps today when the sync runs during the working day', () => {
    // 14:00Z = 10:00 EDT, the mid-day cron.
    expect(watermarkPickDate(new Date('2026-09-29T14:00:00Z'))).toBe('2026-09-29')
  })

  it('stamps today for the last cron of the working day', () => {
    // 20:00Z = 16:00 EDT.
    expect(watermarkPickDate(new Date('2026-09-29T20:00:00Z'))).toBe('2026-09-29')
  })

  it('stamps the PREVIOUS day for the overnight cron', () => {
    // 06:00Z = 02:00 EDT. Nothing is picked at 2am; this run is evidence
    // about the day that just ended.
    expect(watermarkPickDate(new Date('2026-09-29T06:00:00Z'))).toBe('2026-09-28')
  })

  it('treats 05:59 local as the previous day and 06:00 as today', () => {
    expect(watermarkPickDate(new Date('2026-09-29T09:59:00Z'))).toBe('2026-09-28')
    expect(watermarkPickDate(new Date('2026-09-29T10:00:00Z'))).toBe('2026-09-29')
  })

  it('rolls back across a month boundary', () => {
    expect(watermarkPickDate(new Date('2026-10-01T06:00:00Z'))).toBe('2026-09-30')
  })

  it('rolls back across a year boundary', () => {
    expect(watermarkPickDate(new Date('2026-01-01T07:00:00Z'))).toBe('2025-12-31')
  })

  // --- Review Focus item 1 -------------------------------------------------
  // vercel.json schedules in UTC, which is fixed. Eastern is not. The 06:00Z
  // cron is 02:00 EDT in summer but 01:00 EST in winter -- both before 06:00
  // local, so both must roll back. A fixed -4 offset would put the winter run
  // at 02:00 and still work; a fixed -5 offset would put the summer run at
  // 01:00 and still work. The bug only appears if someone computes the date
  // from a stored offset that disagrees with the real one, which is why this
  // must go through Intl and why both seasons are tested.
  it('rolls back correctly in winter, when Eastern is UTC-5', () => {
    expect(watermarkPickDate(new Date('2026-01-15T06:00:00Z'))).toBe('2026-01-14')
  })

  it('handles the autumn transition day itself', () => {
    // 2026-11-01: EDT ends at 02:00 local. 06:00Z is 02:00 EDT -> 01:00 EST.
    expect(watermarkPickDate(new Date('2026-11-01T06:00:00Z'))).toBe('2026-10-31')
  })

  it('handles the spring transition day itself', () => {
    // 2026-03-08: EST ends at 02:00 local, clocks jump to 03:00.
    expect(watermarkPickDate(new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-07')
  })

  it('gives the same answer regardless of the machine timezone', () => {
    // Vercel runs in UTC; a developer laptop does not. The result must not
    // depend on which.
    const at = new Date('2026-09-29T06:00:00Z')
    expect(watermarkPickDate(at, 'America/New_York')).toBe('2026-09-28')
  })
})

describe('watermarkIsEvidence', () => {
  const now = new Date('2026-09-29T14:00:00Z')
  const hoursAgo = (h: number) =>
    new Date(now.getTime() - h * 3_600_000).toISOString()

  // Each of these three is a way of saying "we have no idea when the picks we
  // are about to read actually happened", and all three must answer the same
  // way, because the caller's next move -- write today's date, or leave null --
  // has to be the safe one in every case it cannot distinguish.
  it('refuses when there is no previous run at all', () => {
    expect(watermarkIsEvidence(null, now)).toBe(false)
    expect(watermarkIsEvidence(undefined, now)).toBe(false)
    expect(watermarkIsEvidence('', now)).toBe(false)
  })

  it('refuses an unparseable timestamp rather than treating it as recent', () => {
    expect(watermarkIsEvidence('not a date', now)).toBe(false)
  })

  it('refuses a run that finished in the future', () => {
    // Clock skew, or a row written by something we do not understand. `false`
    // is the fail-safe answer to "I cannot tell".
    expect(watermarkIsEvidence(hoursAgo(-3), now)).toBe(false)
  })

  it('trusts the normal cron cadence', () => {
    // The crons are 8, 6 and 10 hours apart. All three gaps must pass, or the
    // watermark is unusable in normal operation and every pick goes undated.
    expect(watermarkIsEvidence(hoursAgo(6), now)).toBe(true)
    expect(watermarkIsEvidence(hoursAgo(8), now)).toBe(true)
    expect(watermarkIsEvidence(hoursAgo(10), now)).toBe(true)
  })

  it('tolerates two consecutive missed runs', () => {
    // 18h is the worst single-miss gap (10 + 8); 24h is two misses. One slipped
    // cron must not cost a day of pick revenue.
    expect(watermarkIsEvidence(hoursAgo(18), now)).toBe(true)
    expect(watermarkIsEvidence(hoursAgo(24), now)).toBe(true)
  })

  it('refuses once the gap exceeds a day', () => {
    // The boundary is inclusive at 24 and false past it. Inside a day the
    // watermark is wrong by at most the one day the before-06:00 rule decides;
    // past it, the error is unbounded and nothing in the data can bound it.
    expect(watermarkIsEvidence(hoursAgo(WATERMARK_MAX_GAP_HOURS), now)).toBe(true)
    expect(watermarkIsEvidence(hoursAgo(WATERMARK_MAX_GAP_HOURS + 0.5), now)).toBe(false)
  })

  it('refuses the outage this guard exists for', () => {
    // Two clients are 401ing while Zenventory 2.0 credentials are restored. The
    // next successful run is a first run against weeks of already-picked
    // orders, and stamping all of them with one date is the bug.
    expect(watermarkIsEvidence(hoursAgo(24 * 14), now)).toBe(false)
  })

  it('honours an explicit gap bound', () => {
    expect(watermarkIsEvidence(hoursAgo(3), now, 2)).toBe(false)
    expect(watermarkIsEvidence(hoursAgo(3), now, 4)).toBe(true)
  })
})
