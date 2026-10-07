// Which rows are inside the period a screen claims to be showing.
//
// This exists because /billing and /reports filtered the same rows by the same
// two dates and disagreed about the one case that matters:
//
//   BillingView   `if (d === undefined) return !from && !to`   -> DROPPED
//   ReportsTabs   `if (from && d && d < from) return false`    -> KEPT
//
// A shipment with a null ship_date was therefore ON /reports and OFF /billing
// at the same moment, and neither screen said anything. Both readings were
// arrived at by accident -- one from a `>=` against undefined that is silently
// false, the other from a `&&` guard that skips the comparison entirely.
//
// The tie is not broken by preference. src/app/api/reports/download/route.ts
// filters in SQL, `.gte(col, from).lte(col, to)`, and in Postgres
// `null >= '2026-10-01'` evaluates to null, which is not true. So the .xlsx
// that /reports exports has excluded undated rows since the day it was written,
// and ReportsTabs was disagreeing with the spreadsheet you get by pressing the
// button beside the table. Three-valued logic is the behaviour of record.
//
// Dropping is right; dropping SILENTLY is the defect. A bounded view is a claim
// about a period, and a row whose date is unknown is not known to belong to it
// -- including it makes the claim false. Excluding it makes the view
// incomplete, which is recoverable only if the view admits it. So this returns
// a count alongside the rows, exactly as sumPriced returns `unpriced` alongside
// `total`, and for the same reason: a figure that quietly omits part of its
// input is worse than one that refuses.
//
// Lives in a .ts and not in either component because vitest.config.ts includes
// only `src/**/*.test.ts` -- logic inside a .tsx cannot be given a test, and
// this is the logic that decides which rows an invoice covers.

/** Rows inside the period, and how many could not be placed in it at all. */
export interface DateFiltered<T> {
  rows: T[]
  /**
   * Rows left out because their date is null, absent or not a string.
   *
   * Counts omissions only, never rows the operator deliberately filtered away
   * by choosing a narrower month. A warning that fires on every normal screen
   * is a warning nobody reads.
   */
  undated: number
}

/**
 * Filter rows to a date range, reporting what could not be placed.
 *
 * `dateKey` is `keyof T` so a column the row does not have is a compile error
 * rather than a filter that silently matches nothing.
 *
 * Empty string means "no bound", which is how both screens represent a cleared
 * date input. With BOTH bounds empty the view is not claiming a period, so
 * there is nothing an unknown date can contradict and undated rows are kept and
 * not counted -- that is the one screen state that can honestly show them.
 */
export function filterByDate<T>(
  rows: readonly T[],
  dateKey: keyof T & string,
  from: string,
  to: string,
): DateFiltered<T> {
  const bounded = Boolean(from) || Boolean(to)
  const kept: T[] = []
  let undated = 0

  for (const r of rows) {
    const raw = r[dateKey]
    // Guard the type rather than `raw?.split(...)`: these columns are
    // timestamptz, and anything that is not a string -- a numeric epoch, a
    // Date, a column the select never returned -- cannot be placed in the
    // period. Reading it as '' would be worse than useless: '' sorts before
    // every real date, so every row would silently fail the lower bound while
    // this function reported nothing wrong.
    const day = typeof raw === 'string' ? raw.split('T')[0] : null

    if (day === null) {
      // Unknown date. Only an unbounded view can honestly show it.
      if (bounded) undated++
      else kept.push(r)
      continue
    }

    // Inclusive at both ends, matching .gte/.lte in the download route. An
    // off-by-one here drops the first or last day of every month requested.
    //
    // The two emptiness guards are NOT symmetric, which is worth knowing before
    // anyone tidies them away as a matching pair:
    //
    //   `to &&`    load-bearing. '' sorts before every string, so `day > ''` is
    //              true for every real date. Drop this guard and a view with
    //              only a start date set renders empty.
    //   `from &&`  provably redundant. `day < ''` is false for every string,
    //              including ''. Removing it changes no input's outcome.
    //
    // The `from &&` guard survives mutation testing for that reason, and it
    // stays anyway: the two bounds are read as a pair, and a line that is
    // correct only because of how '' sorts is worse to inherit than a redundant
    // one. The asymmetry is the comment's job, not the reader's to rediscover.
    if (from && day < from) continue
    if (to && day > to) continue
    kept.push(r)
  }

  return { rows: kept, undated }
}

/**
 * The sentence a screen prints when rows were left out for having no date.
 *
 * Shaped and worded to sit beside unpricedNote, because the two appear in the
 * same line of the same tables and a reader should not have to work out that
 * they are different kinds of omission.
 *
 * Pluralizes by appending `s`, same as unpricedNote. Callers must therefore
 * pass an s-pluralizable noun -- the warehouse table was about to be given
 * 'entry' and would have printed "3 entrys". Pinned by a test rather than left
 * for the next person to find on screen.
 */
export function undatedNote(undated: number, noun = 'shipment'): string {
  if (undated <= 0) return ''
  return `${undated} ${undated === 1 ? noun : `${noun}s`} with no date `
    + `not included`
}
