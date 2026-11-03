import { WAREHOUSE_TZ, warehouseParts } from './pick-date'

// Calendar dates for screens whose "today" is the warehouse day, not the
// UTC day. Vercel runs in UTC, so `new Date().toISOString().slice(0, 10)`
// flips to tomorrow at 19:00 or 20:00 in New York. The ledger already
// dates picks with warehouseParts; these helpers are that same clock for
// the filters on the dashboard and the other date pickers.

export function easternToday(at: Date = new Date()): string {
  return warehouseParts(at, WAREHOUSE_TZ).date
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
