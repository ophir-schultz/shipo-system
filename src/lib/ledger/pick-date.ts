/**
 * When did the pick happen?
 *
 * Zenventory gives us no usable pick timestamp -- `completedDate` was empty on
 * all 391 orders sampled -- so the date is derived from when our own sync first
 * observed a picked quantity. See the ledger spec, section 3.5.
 *
 * THE BEFORE-06:00 RULE. The crons in vercel.json fire at 06:00, 14:00 and
 * 20:00 UTC. In the warehouse that is roughly 02:00, 10:00 and 16:00. A pick
 * finished at 17:00 Monday is therefore first seen by the 02:00 Tuesday run, so
 * a watermark set before 06:00 local is evidence about the day that just ended.
 *
 * THIS IS COUPLED TO vercel.json. If the cron times change, this rule changes
 * with them. vercel.json carries a comment pointing back here.
 *
 * ASSUMPTION, NOT MEASUREMENT: that nothing is picked between midnight and 6am.
 * That is Ophir's account of how the warehouse runs, and the data cannot
 * confirm it, because the only pick timestamps available are our own
 * observation times. If a night shift is ever added, this rule silently
 * misdates an entire shift. Recorded here so it can be found on that day.
 */

export const WAREHOUSE_TZ = 'America/New_York'

/** Hour before which a watermark belongs to the previous warehouse day. */
const DAY_START_HOUR = 6

/**
 * The calendar date and hour at `at`, as seen in the warehouse.
 *
 * Uses Intl rather than an offset so it stays correct across both daylight
 * saving transitions. `en-CA` is chosen because it formats as YYYY-MM-DD.
 */
export function warehouseParts(
  at: Date,
  timeZone: string = WAREHOUSE_TZ
): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

/** Subtract one day from a YYYY-MM-DD string without touching timezones. */
function previousDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  // Date.UTC handles month and year rollover, including leap years.
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  return prev.toISOString().slice(0, 10)
}

/**
 * The warehouse day a pick observed at `observedAt` should be credited to.
 * Returns YYYY-MM-DD.
 */
export function watermarkPickDate(
  observedAt: Date,
  timeZone: string = WAREHOUSE_TZ
): string {
  const { date, hour } = warehouseParts(observedAt, timeZone)
  return hour < DAY_START_HOUR ? previousDay(date) : date
}

/**
 * THE WATERMARK IS ONLY EVIDENCE WHEN THE SYNC HAS BEEN WATCHING.
 *
 * Everything above rests on a premise the function itself cannot check: that
 * we observed the pick shortly after it happened. That is true while the crons
 * run, and false the moment they stop. Zenventory's credentials are returning
 * 401 for two clients as this is written, so the next SUCCESSFUL run is a first
 * run against a backlog — and the old code stamped today's date on every
 * already-picked line in it. Weeks of picks would have landed on a single day:
 * a fabricated labour spike on that day and a fabricated drought before it, in
 * a ledger whose whole purpose is to make cost per pick legible over time.
 *
 * So the watermark is used only when the previous finished run for this client
 * is recent enough that the pick must have happened inside the gap.
 *
 * WHY 24 HOURS, and not a tuned number. Inside 24 hours the pick happened
 * either today or yesterday, and the before-06:00 rule above exists precisely
 * to decide that adjacency — so the watermark is either right or off by the one
 * day the rule is built to handle. Past 24 hours the error is unbounded in days
 * and nothing in the data can bound it. The crons are 8, 6 and 10 hours apart,
 * so this tolerates two consecutive missed runs and rejects an outage.
 *
 * When it returns false the caller must leave pick_date NULL — unknown, which a
 * later real observation or a manual backfill can still fill — rather than
 * writing a date that is confidently wrong and, being set once and never moved,
 * never corrects itself.
 */
export const WATERMARK_MAX_GAP_HOURS = 24

export function watermarkIsEvidence(
  previousRunFinishedAt: string | null | undefined,
  now: Date,
  maxGapHours: number = WATERMARK_MAX_GAP_HOURS
): boolean {
  // No previous run at all is the first-run case: nothing bounds when the picks
  // we are about to read actually happened.
  if (!previousRunFinishedAt) return false

  const previous = new Date(previousRunFinishedAt)
  if (Number.isNaN(previous.getTime())) return false

  const gapHours = (now.getTime() - previous.getTime()) / 3_600_000
  // A negative gap means a run finished in the future: clock skew, or a row
  // written by something we do not understand. Either way it is not evidence of
  // continuity, and the fail-safe answer to "I cannot tell" is the same as the
  // answer to "there was no previous run".
  if (gapHours < 0) return false

  return gapHours <= maxGapHours
}
