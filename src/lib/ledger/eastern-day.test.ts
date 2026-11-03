import { describe, expect, it } from 'vitest'
import {
  easternAddDays,
  easternMidnightIso,
  easternMonthStart,
  easternToday,
  easternWeekStart,
  easternYearStart,
} from './eastern-day'

describe('eastern calendar', () => {
  it('keeps the warehouse date when UTC has already rolled', () => {
    // 2026-09-30 01:30Z is still 2026-09-29 21:30 in New York.
    const at = new Date('2026-09-30T01:30:00Z')
    expect(easternToday(at)).toBe('2026-09-29')
    expect(easternMonthStart(easternToday(at))).toBe('2026-09-01')
    expect(easternYearStart(easternToday(at))).toBe('2026-01-01')
  })

  it('starts the week on Monday at Eastern midnight', () => {
    // 2026-09-29 is a Tuesday. Sunday belongs to the week that opened the Monday before.
    expect(easternWeekStart('2026-09-28')).toBe('2026-09-28')
    expect(easternWeekStart('2026-09-29')).toBe('2026-09-28')
    expect(easternWeekStart('2026-09-27')).toBe('2026-09-21')
    expect(easternMidnightIso(easternWeekStart('2026-11-03'))).toBe('2026-11-02T05:00:00.000Z')
  })

  it('places midnight on the Eastern offset, including winter', () => {
    // September is EDT, UTC-4. November is EST, UTC-5.
    expect(easternMidnightIso('2026-09-29')).toBe('2026-09-29T04:00:00.000Z')
    expect(easternMidnightIso('2026-11-03')).toBe('2026-11-03T05:00:00.000Z')
  })

  it('adds calendar days without using the server timezone', () => {
    expect(easternAddDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(easternAddDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})
