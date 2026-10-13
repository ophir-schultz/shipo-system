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

// ---------------------------------------------------------------------------
// WHICH CLIENT'S ROWS THESE ARE.
//
// Same shape as the date filter above, and here for the same reason: the two
// are applied together, by the same screens, and the second one did not exist.
//
// /reports' client dropdown filtered NOTHING. ReportsTabs.tsx accepted a
// `clientId`, passed it down to all five tables and never read it, while the
// Excel button beside the dropdown DID send it to /api/reports/download, which
// filters in SQL with `.eq('client_id', clientId)`. The table therefore showed
// every client and the spreadsheet you exported from it showed one. The
// screenshot that caught this had 'Nayax' selected above a table of SitnStand,
// Orcam, Crisp Power and Time Systems (UK) Ltd.
//
// That is the same class of defect as the undated-row disagreement documented
// at the top of this file -- screen and export answering a different question
// -- but worse in one way: nothing about the screen looked wrong. An operator
// checking figures before sending them has no way to see it.
//
// It could not be fixed in the component: src/app/reports/page.tsx selected
// `clients(name)` and no `client_id`, so the column to filter on was not in
// the payload. Fixed at the source. All four tables carry `client_id`
// (schema.sql:39,64,79,105), so nothing here is a workaround.

/** Rows belonging to the chosen client, and how many had no client at all. */
export interface ClientFiltered<T> {
  rows: T[]
  /**
   * Rows left out because their client_id is null, absent or not a string.
   *
   * Counts omissions only, never the rows the operator deliberately filtered
   * away by choosing a client -- the same rule `undated` follows, and for the
   * same reason: a note that fires on every normal screen is not read.
   *
   * This branch is live, not defensive. The production monitor reports 241
   * shipments from 9 unmapped stores, so these rows exist now and carry money
   * nobody has attributed. A plain `r.client_id === clientId` drops them
   * correctly and says nothing, which is how a client's report comes up short
   * while looking complete.
   */
  unattributed: number
}

/**
 * Filter rows to one client, reporting what could not be attributed.
 *
 * `clientKey` is `keyof T` so a column the row does not have is a compile
 * error rather than a filter that silently matches nothing. ReportsTabs once
 * carried a dead `clientKey = 'client_id'` parameter that was never referenced
 * and never passed; this is that parameter, used.
 *
 * Empty string means "every client", which is how a cleared <select> arrives
 * -- matching how filterByDate reads an empty bound. In that state the view
 * makes no claim about whose rows these are, so an unknown client contradicts
 * nothing and unattributed rows are kept and not counted.
 */
export function filterByClient<T>(
  rows: readonly T[],
  clientKey: keyof T & string,
  clientId: string,
): ClientFiltered<T> {
  if (!clientId) return { rows: [...rows], unattributed: 0 }

  const kept: T[] = []
  let unattributed = 0

  for (const r of rows) {
    const raw = r[clientKey]
    // Guard the type rather than comparing straight through. `undefined ===
    // clientId` and `7 === clientId` are both false, which drops the row with
    // no count -- the silent omission this function exists to remove. A column
    // the select forgot to ask for looks exactly like a row for another
    // client, and those want opposite fixes.
    if (typeof raw !== 'string') { unattributed++; continue }

    // Exact equality, never a prefix test. UUIDs share long prefixes and the
    // consequence of a loose match here is one client's money on another
    // client's invoice.
    if (raw === clientId) kept.push(r)
  }

  return { rows: kept, unattributed }
}

/**
 * The sentence a screen prints when rows were left out for having no client.
 *
 * Worded to sit beside undatedNote without being mistaken for it. The two
 * appear in the same line of the same table and mean different things -- one
 * row could not be placed in the PERIOD, the other could not be placed with a
 * CLIENT -- and they want different fixes: a store mapping versus a ship_date.
 *
 * Pluralizes by appending `s`, same caller constraint undatedNote documents.
 */
export function unattributedNote(unattributed: number, noun = 'shipment'): string {
  if (unattributed <= 0) return ''
  return `${unattributed} ${unattributed === 1 ? noun : `${noun}s`} with no client `
    + `not included`
}

/** Rows inside both the period and the client, with each omission named. */
export interface Scoped<T> extends DateFiltered<T>, ClientFiltered<T> {}

/**
 * Both filters, in the order that makes the counts mean what they say.
 *
 * CLIENT FIRST, THEN DATE, and that is not arbitrary. Filtering by date first
 * would count every client's undated rows and print the total on one client's
 * report -- "2 shipments with no date not included" on Nayax's page when one
 * of the two is Orcam's. The operator would go looking for a missing Nayax
 * shipment that was never theirs. Pinned by a test rather than left in prose.
 *
 * Lives here rather than in ReportsTabs.tsx because vitest.config.ts includes
 * only `src/**\/*.test.ts`: logic inside a .tsx cannot be given a test, and
 * this is the logic that decides which rows a client's report covers. The
 * component is left with no filtering decision of its own to get wrong.
 */
export function scopeRows<T>(
  rows: readonly T[],
  opts: {
    clientKey: keyof T & string
    clientId: string
    dateKey: keyof T & string
    from: string
    to: string
  },
): Scoped<T> {
  const byClient = filterByClient(rows, opts.clientKey, opts.clientId)
  const byDate = filterByDate(byClient.rows, opts.dateKey, opts.from, opts.to)
  return {
    rows: byDate.rows,
    undated: byDate.undated,
    unattributed: byClient.unattributed,
  }
}
