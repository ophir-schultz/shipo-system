import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { periodRange, GRAINS, type DateRange, type Grain } from '@/lib/billing/statement'
import { WAREHOUSE_TZ } from '@/lib/ledger/pick-date'

// supabase/verify/statement_live_verify.sql recomputes a client's statement in
// SQL so the /statements screen can be checked against something that did not
// come out of the same code. That makes it an INSTRUMENT, and an instrument
// nobody calibrated measures nothing.
//
// This is the calibration. Two halves, and both are necessary:
//
//   1. The SQL's date arithmetic, modelled here in TypeScript, must agree with
//      periodRange on every day of four years and all four grains.
//   2. The .sql file must literally still CONTAIN the formulas the model
//      models -- otherwise editing the SQL leaves a green test describing a
//      file that no longer exists in that form, which is worse than no test.
//
// WHY A DISAGREEMENT HERE WOULD BE EXPENSIVE RATHER THAN MERELY WRONG.
//
// The two are compared by a human, by eye, on a screen and in a query result.
// If they disagree about a boundary -- one Sunday, one month end -- the
// comparison does not fail loudly. It produces two plausible figures that
// differ by a day of revenue, and the reasonable response to that is to doubt
// the ledger. So an uncalibrated cross-check is not neutral: it manufactures
// distrust in the figure that was right. That is the specific harm, and it is
// why this file exists rather than a note saying the SQL mirrors the code.
//
// THE FOUR FORMULAS, as the SQL writes them:
//
//   day    lo = d                                 hi = d
//   week   lo = d - (isodow(d) - 1)                hi = lo + 6
//   month  lo = date_trunc('month', d)             hi = lo + 1 month - 1 day
//   year   lo = date_trunc('year', d)              hi = lo + 1 year - 1 day
//
// isodow calls Monday 1 and Sunday 7. periodRange uses getUTCDay, which calls
// Sunday 0, and offsets by `(dow + 6) % 7`. Those agree -- Sunday goes back 6
// days either way -- but they agree by a coincidence of two different
// encodings, which is exactly the kind of agreement worth pinning rather than
// asserting. A reader checking it by hand gets it wrong about as often as not.

const SQL_PATH = 'supabase/verify/statement_live_verify.sql'

const sql = () => readFileSync(SQL_PATH, 'utf8')

/**
 * The file with `--` comments and string literals removed.
 *
 * Needed, not tidiness. The .sql file EXPLAINS in prose the things it must not
 * do -- "NOT calculated_at, or a backfill run today would move last month's
 * picks into this month's statement" -- so a scan of the raw text reads the
 * explanation as the code. The first version of the `calculated_at` assertion
 * below failed for exactly that reason, which is the same mistake
 * date-range-parity.test.ts records making twice. Three times now.
 *
 * Strings go too, because the report's own output text contains words like
 * 'UNKNOWN' and 'PARTIAL' that an assertion about the logic should not match.
 */
function codeOnly(src: string): string {
  let code = ''
  for (let i = 0; i < src.length;) {
    if (src.startsWith('--', i)) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (src[i] === "'") {
      i++
      while (i < src.length) {
        // '' is an escaped quote inside a literal, not the end of one.
        if (src.startsWith("''", i)) i += 2
        else if (src[i] === "'") { i++; break }
        else i++
      }
    } else {
      code += src[i]; i++
    }
  }
  return code
}

const DAY_MS = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`)

/**
 * The period the SQL in statement_live_verify.sql computes for `day`.
 *
 * A deliberate second implementation, written from the SQL and not from
 * periodRange. Deriving it from periodRange would make the comparison below a
 * tautology -- the standard way a parity test comes out green while the two
 * things it claims to compare have never been compared.
 */
function sqlPeriod(grain: Grain, day: string): DateRange {
  const t = utc(day)
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()

  if (grain === 'day') return { from: day, to: day }

  if (grain === 'week') {
    // extract(isodow from d): Monday 1 ... Sunday 7.
    const isodow = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
    const lo = t - (isodow - 1) * DAY_MS
    return { from: iso(lo), to: iso(lo + 6 * DAY_MS) }
  }

  if (grain === 'month') {
    // date_trunc('month', d) + interval '1 month' - interval '1 day'.
    // Day 0 of the NEXT month is the last day of this one, which is how
    // Postgres's month-interval arithmetic lands here too.
    return { from: iso(Date.UTC(y, m, 1)), to: iso(Date.UTC(y, m + 1, 0)) }
  }

  return { from: iso(Date.UTC(y, 0, 1)), to: iso(Date.UTC(y, 11, 31)) }
}

/** Every day from `from` to `to` inclusive, as 'YYYY-MM-DD'. */
function everyDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = utc(from); t <= utc(to); t += DAY_MS) out.push(iso(t))
  return out
}

describe('the verification SQL computes the same periods as the code', () => {
  // Four years, so the span covers a leap day, a leap year's end, every
  // weekday as a period boundary, and the 28/29/30/31-day month ends.
  const DAYS = everyDay('2024-01-01', '2027-12-31')

  it('spans the boundaries it claims to', () => {
    // A guard on the guard. If this range ever shrinks to something that
    // happens to contain no leap day and no Sunday-the-1st, the agreement
    // below stops being evidence.
    expect(DAYS.length).toBe(1461)
    expect(DAYS).toContain('2024-02-29')
    expect(DAYS).toContain('2024-12-31')
    const dows = new Set(DAYS.map(d => new Date(utc(d)).getUTCDay()))
    expect(dows.size).toBe(7)
  })

  for (const grain of GRAINS) {
    it(`agrees on every ${grain} of four years`, () => {
      // Collected as a list of disagreements rather than asserted per day, so
      // a break reports WHICH dates and both answers instead of failing on the
      // first one and hiding the shape of the bug.
      const off: string[] = []
      for (const day of DAYS) {
        const code = periodRange(grain, day)
        const sqlr = sqlPeriod(grain, day)
        if (code.from !== sqlr.from || code.to !== sqlr.to) {
          off.push(`${day}: code ${code.from}..${code.to} / sql ${sqlr.from}..${sqlr.to}`)
        }
      }
      expect(off.slice(0, 10)).toEqual([])
    })
  }

  it('would notice a one-day disagreement, which is the only kind that matters', () => {
    // A negative control. Both implementations above are mine, so "they agree"
    // is only evidence if disagreement is detectable at all -- and the error
    // this test exists to catch is an off-by-one at a boundary, not a wild
    // one. Shifting the week start by a single day must be caught.
    const shifted = (day: string) => {
      const r = sqlPeriod('week', day)
      return { from: iso(utc(r.from) + DAY_MS), to: iso(utc(r.to) + DAY_MS) }
    }
    const caught = everyDay('2026-10-01', '2026-10-31').filter(day => {
      const code = periodRange('week', day)
      const bad = shifted(day)
      return code.from !== bad.from || code.to !== bad.to
    })
    // Every day, not merely most: a one-day shift moves both bounds of every
    // week, so a comparison that missed any of them would be comparing
    // something other than what it claims to.
    expect(caught).toHaveLength(31)
  })
})

describe('the verification SQL still contains the rules it was calibrated on', () => {
  it('computes the four periods exactly as the model above assumes', () => {
    // The WHOLE periods CTE, compared as one normalised string, rather than a
    // handful of toContain probes. sqlPeriod() above is hand-written from this
    // block and nothing derives either from the other, so this equality is the
    // only thing connecting them. If it is loose, the model can go on agreeing
    // with periodRange while the file it claims to describe has moved.
    //
    // Not hypothetical -- it is what the first version of this test did. It
    // asserted toContain('d - (extract(isodow from d)::int - 1)'), and that
    // expression appears TWICE here: once for `lo`, and once inside `lo + 6`
    // for `hi`. A mutant that broke the `lo` one left the `hi` one intact, the
    // substring was still present, and all 14 assertions passed against a file
    // whose weeks no longer started on Monday. Caught by mutation testing, not
    // by reading it.
    const block = /\n\s*periods as \(([\s\S]*?)\n\),/.exec(sql())
    expect(block, 'the periods CTE is gone or renamed').not.toBeNull()

    const normalised = (block === null ? '' : block[1])
      .split('\n')
      .map(l => l.replace(/--.*$/, '').trim())
      .filter(l => l !== '')
      .join(' ')
      .replace(/\s+/g, ' ')

    expect(normalised).toBe(
      "select 'day' as grain, 1 as ord, d as lo, d as hi from today"
      + ' union all'
      + " select 'week', 2,"
      + ' d - (extract(isodow from d)::int - 1),'
      + ' d - (extract(isodow from d)::int - 1) + 6'
      + ' from today'
      + ' union all'
      + " select 'month', 3,"
      + " date_trunc('month', d)::date,"
      + " (date_trunc('month', d) + interval '1 month' - interval '1 day')::date"
      + ' from today'
      + ' union all'
      + " select 'year', 4,"
      + " date_trunc('year', d)::date,"
      + " (date_trunc('year', d) + interval '1 year' - interval '1 day')::date"
      + ' from today',
    )
  })

  it("takes today in the warehouse's timezone, not UTC and not the server's", () => {
    // The same timezone that decides which charge_date a pick gets
    // (pick-date.ts:23). Between warehouse midnight and UTC midnight these
    // differ, so a UTC `today` asks the day grain for a date the ledger is not
    // yet writing to -- an empty statement while the warehouse is packing.
    expect(sql()).toContain(`now() at time zone '${WAREHOUSE_TZ}'`)
  })

  it('filters on charge_date, inclusively, and never on calculated_at', () => {
    // charge_date is the day the WORK happened. Filtering on calculated_at
    // would let a backfill run today move last month's picks into this month's
    // statement. `between` is inclusive both ends, which is what the app's
    // .gte/.lte pair does.
    expect(sql()).toContain('oc.charge_date between p.lo and p.hi')
    // Comments stripped: the header NAMES calculated_at to say it is not used,
    // and the raw text would match its own explanation.
    expect(codeOnly(sql())).not.toMatch(/\bcalculated_at\b/)
  })

  it('groups the lines on charge_type AND label, as buildStatement does', () => {
    // Grouping on charge_type alone would collapse 'Pick — single' and
    // 'Pick — multi', which are different rates, into one line at one of them.
    expect(sql()).toMatch(/group by[\s\S]{0,200}oc\.charge_type,\s*\n?\s*oc\.label/)
  })

  it('prints UNKNOWN only when EVERY counted row is unpriced', () => {
    // The rule as totalOrUnknown actually implements it (unpriced.ts:186), and
    // the one I had backwards myself before reading it. A partial sum is a real
    // figure about the rows it could price; dashing it would hide money the
    // operator can act on, and `unpriced > 0` here would make the SQL disagree
    // with the screen on every client with one at-cost freight line.
    expect(sql()).toContain('unpriced = counted')
    expect(sql()).not.toMatch(/unpriced\s*>\s*0\s*(then|$)/m)
  })

  it('selects every column the app selects, so a 42703 surfaces here', () => {
    // The live-schema check. `manual_total` and `new_cost` were three mutually
    // consistent wrong names that killed /billing and /reports; the repo-side
    // guard only proves a name appears in some .sql file, never that the file
    // ran. This query naming the same seven columns is what turns a phantom
    // column into a failure we see before a client does.
    // The column list is READ OUT OF statement-charges.ts rather than written
    // here, so the assertion is derived from the claim instead of restating
    // it. A hardcoded list would go stale the day someone adds a column to the
    // app's select, and would then certify a probe that no longer covers it --
    // which is the one job this probe has.
    const appSelect = /\.select\('([^']*)'\)/.exec(
      readFileSync('src/lib/billing/statement-charges.ts', 'utf8'),
    )
    expect(appSelect, "statement-charges.ts no longer has an inline .select('...')").not.toBeNull()

    // Scoped to the PROBE SUBQUERY, not to the file. Searching the whole file
    // for each name does not work and a mutant proved it: deleting
    // `is_estimate` from the probe left the test green, because the name still
    // appears further down in `count(*) filter (where oc.is_estimate)`. Every
    // one of these seven columns is used somewhere else in the query too, so a
    // whole-file toContain cannot fail for any of them -- it asserted nothing
    // at all, for all seven, while reading as though it covered them.
    const probe = /from \(\s*(select charge_type[\s\S]*?)\s*from order_charges\s*limit 1000\s*\) probe/
      .exec(codeOnly(sql()))
    expect(probe, 'the unfiltered live-schema probe subquery is gone').not.toBeNull()

    const probed = (probe === null ? '' : probe[1])
      .replace(/^select\s+/, '')
      .split(',')
      .map(c => c.trim())
      .sort()
    const appColumns = (appSelect === null ? '' : appSelect[1])
      .split(',')
      .map(c => c.trim())
      .sort()
    // Equality and not containment: a probe that reads MORE than the app does
    // would fail on a column the app never asks for, and that failure would be
    // read as a broken statement rather than a broken probe.
    expect(probed).toEqual(appColumns)
    expect(appColumns).toHaveLength(9)
  })

  it('is read-only, which is the premise on which it gets run in production', () => {
    // This file is handed to an operator to paste into the Supabase editor
    // against the live money tables. Everything else here is about whether its
    // ANSWER is right; this is about whether running it is safe at all, and it
    // is the assertion that must hold even if every other one is deleted.
    //
    // Comments and string literals are stripped first: the header discusses
    // insert/update/delete in prose, and an unstripped scan would read the
    // explanation as the code -- the same mistake date-range-parity.test.ts
    // records making twice.
    const src = sql()
    let code = ''
    for (let i = 0; i < src.length;) {
      if (src.startsWith('--', i)) {
        while (i < src.length && src[i] !== '\n') i++
      } else if (src[i] === "'") {
        i++
        while (i < src.length) {
          if (src.startsWith("''", i)) i += 2
          else if (src[i] === "'") { i++; break }
          else i++
        }
      } else {
        code += src[i]; i++
      }
    }

    for (const verb of [
      'insert', 'update', 'delete', 'drop', 'alter', 'truncate',
      'create', 'grant', 'revoke', 'copy', 'call', 'do',
    ]) {
      expect(new RegExp(`\\b${verb}\\b`, 'i').test(code), `SQL contains '${verb}'`).toBe(false)
    }

    // And exactly one statement, because the editor runs the whole buffer and
    // shows only the LAST result -- so a second statement here would hide the
    // report behind whatever followed it.
    expect(code.split(';').filter(s => s.trim() !== '')).toHaveLength(1)
  })
})
