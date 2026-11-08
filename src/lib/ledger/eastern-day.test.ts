import { describe, expect, it } from 'vitest'
import {
  easternAddDays,
  dateOnlyLiteral,
  easternCalendarDay,
  shipCalendarDay,
  storedShipInstant,
  easternMidnightIso,
  easternMonthStart,
  easternToday,
  easternWeekStart,
  easternYearStart,
  utcMidnightDay,
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

  it('keeps a date-only October 1, and reads a real midnight UTC as the Eastern day', () => {
    expect(dateOnlyLiteral('2026-10-01')).toBe('2026-10-01')
    expect(dateOnlyLiteral('2026-10-01T00:00:00.000Z')).toBeNull()
    expect(easternCalendarDay('2026-10-01')).toBe('2026-10-01')
    expect(easternCalendarDay('2026-11-01')).toBe('2026-11-01')
    expect(easternCalendarDay('2026-03-08')).toBe('2026-03-08')
    expect(easternCalendarDay('2026-10-01T00:00:00Z')).toBe('2026-09-30')
    expect(easternCalendarDay('2026-10-01T00:00:00.000Z')).toBe('2026-09-30')
    expect(easternCalendarDay('2026-10-09 00:00:00+00')).toBe('2026-10-08')
    expect(easternCalendarDay('2026-11-01T00:00:00.000Z')).toBe('2026-10-31')
    expect(easternCalendarDay('2026-03-08T00:00:00.000Z')).toBe('2026-03-07')
    expect(easternWeekStart(easternCalendarDay('2026-10-05'))).toBe('2026-10-05')
    expect(easternWeekStart(easternCalendarDay('2026-10-05T00:00:00.000Z'))).toBe('2026-09-28')
    expect(utcMidnightDay('2026-10-01T00:00:00.000Z')).toBe('2026-10-01')
    expect(utcMidnightDay('2026-10-01T00:00:00.001Z')).toBeNull()
    expect(shipCalendarDay('2026-10-01T00:00:00.000Z', '2026-10-01')).toBe('2026-10-01')
    expect(shipCalendarDay('2026-10-01 00:00:00+00', '2026-10-01')).toBe('2026-10-01')
    expect(shipCalendarDay('2026-10-01T00:00:00.000Z')).toBe('2026-09-30')
    expect(shipCalendarDay('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).toBe('2026-09-30')
    expect(shipCalendarDay('2026-10-01T03:30:00.000Z', '2026-10-01')).toBe('2026-09-30')
    expect(shipCalendarDay('2026-10-02T12:00:00.000Z', '2026-10-01')).toBe('2026-10-02')
    expect(shipCalendarDay(storedShipInstant('2026-10-01'), '2026-10-01')).toBe('2026-10-01')
    expect(easternCalendarDay(storedShipInstant('2026-10-01'))).toBe('2026-10-01')
    expect(storedShipInstant('2026-10-01T00:00:00.000Z')).toBe('2026-10-01T00:00:00.000Z')
    expect(storedShipInstant('2026-10-27T15:00:00.000Z')).toBe('2026-10-27T15:00:00.000Z')
  })

  it('still converts a real clock time to the Eastern day', () => {
    expect(easternCalendarDay('2026-10-01T03:30:00.000Z')).toBe('2026-09-30')
    expect(easternCalendarDay('2026-11-01T03:30:00.000Z')).toBe('2026-10-31')
  })

  it('reads a timestamptz as the New York calendar day', () => {
    // 2026-10-27 03:30Z is still 2026-10-26 in New York (EDT, UTC-4).
    expect(easternCalendarDay('2026-10-27T03:30:00.000Z')).toBe('2026-10-26')
    // 2026-11-03 03:30Z is still 2026-11-02 in New York (EST, UTC-5).
    expect(easternCalendarDay('2026-11-03T03:30:00.000Z')).toBe('2026-11-02')
    expect(easternCalendarDay('2026-11-02')).toBe('2026-11-02')
    expect(easternCalendarDay(null)).toBe('')
  })

  it('adds calendar days without using the server timezone', () => {
    expect(easternAddDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(easternAddDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})
