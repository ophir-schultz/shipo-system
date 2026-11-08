import { WAREHOUSE_TZ, warehouseParts } from './pick-date'

// Calendar dates for screens whose "today" is the warehouse day, not the
// UTC day. Vercel runs in UTC, so `new Date().toISOString().slice(0, 10)`
// flips to tomorrow at 19:00 or 20:00 in New York. The ledger already
// dates picks with warehouseParts; these helpers are that same clock for
// the filters on the dashboard and the other date pickers.

export function easternToday(at: Date = new Date()): string {
  return warehouseParts(at, WAREHOUSE_TZ).date
}

/**
 * The America/New_York calendar day of a stored date.
 *
 * A date column is already that day. A timestamptz is an instant, and the
 * day is New York's, not the UTC date in front of the T. 2026-11-03T03:30Z
 * is still November 2 in the warehouse. Every screen that prints or filters
 * a ship date uses this, so a statement, a shipment row and a profit row
 * cannot name two days for one label.
 */
/**
 * A calendar day that was never a clock time: `YYYY-MM-DD` and nothing else.
 *
 * `2026-10-01T00:00:00Z` is not this. That string is an instant, and in New
 * York it is still September 30. A date-only ship day that was stored at UTC
 * midnight is recognized by shipCalendarDay, which also has the source day.
 */
export function dateOnlyLiteral(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

/** The calendar day of an exact UTC midnight, or null when the time is not that. */
export function utcMidnightDay(value: string | null | undefined): string | null {
  if (value == null) return null
  const midnight = /^(\d{4}-\d{2}-\d{2})[T ]00:00:00(?:\.0+)?(?:Z|\+00(?::00)?)?$/.exec(value.trim())
  return midnight ? midnight[1] : null
}

function instantDate(trimmed: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(trimmed)) return null
  // `+00` without minutes is not a form Date.parse accepts once the space
  // has been turned into a T. `2026-10-09 00:00:00+00` is still midnight UTC.
  const iso = trimmed.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

export function easternCalendarDay(value: string | Date | null | undefined): string {
  if (value == null || value === '') return ''
  if (typeof value !== 'string') {
    return Number.isNaN(value.getTime()) ? '' : easternToday(value)
  }
  const trimmed = value.trim()
  const literal = dateOnlyLiteral(trimmed)
  if (literal) return literal
  const at = instantDate(trimmed)
  if (at) return easternToday(at)
  if (!trimmed.includes('T')) return trimmed.slice(0, 10)
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? trimmed.slice(0, 10) : easternToday(parsed)
}

/**
 * The ship day when the source day is known separately from the stored instant.
 *
 * A plain `2026-10-01` stays October 1. A real `2026-10-01T00:00:00Z`, with
 * no date-only source, is September 30 in New York. The stored form that
 * keeps October 1 is a date-only raw shipDate whose timestamptz is that same
 * day at 00:00:00 UTC. A different clock time uses New York, even if a
 * date-only source is also present.
 */
export function shipCalendarDay(
  stored: string | null | undefined,
  sourceDay?: string | null,
): string {
  const source = dateOnlyLiteral(sourceDay ?? null)
  const storedText = stored == null ? '' : String(stored).trim()
  if (
    source
    && (storedText === '' || dateOnlyLiteral(storedText) === source || utcMidnightDay(storedText) === source)
  ) {
    return source
  }
  return easternCalendarDay(storedText)
}

/** `raw_data.shipDate` when that field is a string. Other payload fields are ignored. */
export function rawShipDate(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as { shipDate?: unknown }).shipDate
  return typeof value === 'string' ? value : null
}

/**
 * What to store for a ShipStation ship date.
 *
 * A date-only value is the start of that warehouse day, so a later Eastern
 * read returns the same day. A value that already carries a clock time,
 * including exactly 00:00:00Z, is stored unchanged.
 */
export function storedShipInstant(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return easternMidnightIso(trimmed)
  return trimmed
}

export function easternMonthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

export function easternYearStart(date: string): string {
  return `${date.slice(0, 4)}-01-01`
}

/**
 * Monday that begins the Eastern week containing `date`.
 * The week opens at 12:00 AM America/New_York on that Monday.
 * Callers that filter a timestamptz use easternMidnightIso on this date.
 */
export function easternWeekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  const dow = utc.getUTCDay()
  const back = dow === 0 ? 6 : dow - 1
  utc.setUTCDate(utc.getUTCDate() - back)
  return utc.toISOString().slice(0, 10)
}

export function easternAddDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

function clockInNewYork(at: Date): { date: string; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WAREHOUSE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  }
}

/**
 * The UTC instant when `date` begins in New York. For timestamptz filters
 * such as shipments.ship_date. Date columns compare to the YYYY-MM-DD itself.
 */
export function easternMidnightIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  let t = Date.UTC(y, m - 1, d - 1, 12, 0, 0)
  for (let i = 0; i < 48; i++) {
    const clock = clockInNewYork(new Date(t))
    if (clock.date === date && clock.hour === 0) {
      return new Date(t - (clock.minute * 60 + clock.second) * 1000).toISOString()
    }
    t += 3_600_000
  }
  throw new Error(`No Eastern midnight for ${date}`)
}
