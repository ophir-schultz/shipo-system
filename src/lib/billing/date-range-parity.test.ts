import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { filterByDate } from '@/lib/billing/date-range'

// /billing and /reports filtered the same rows by the same two dates and
// disagreed about undated rows, and the thing that let that happen is that each
// screen wrote its own comparison. date-range.ts is tested, but a test on the
// shared helper cannot stop a component from going back to comparing dates by
// hand -- the components are .tsx and vitest.config.ts collects only
// `src/**\/*.test.ts`, so neither can be given a test at all.
//
// So this pins the source text, the same arrangement as
// unpriced-filter-parity.test.ts: whole-line comments are stripped first,
// because both files now EXPLAIN the old broken comparisons in prose and an
// un-stripped scrape would read the explanation as the code.
//
// There is a third party to this agreement and it is the one that matters most:
// src/app/api/reports/download/route.ts filters in SQL. That is the artifact
// that leaves the building, so the screens have to match IT, not merely each
// other. Two screens that agree with each other and disagree with the
// spreadsheet is the defect with an extra step.

const src = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')
      && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('{/*'))
    .join('\n')

const BILLING_VIEW = '../../components/billing/BillingView.tsx'
const REPORTS_TABS = '../../components/reports/ReportsTabs.tsx'
const DOWNLOAD_ROUTE = '../../app/api/reports/download/route.ts'

/** The only two date columns that are nullable -- schema.sql:42,70. */
const NULLABLE_DATE_COLUMNS = ['ship_date', 'adjustment_date']

/**
 * Every line in either component where a date bound may be compared by hand.
 *
 * An allowlist and not a count, so adding a comparison fails with the offending
 * line printed rather than with `2 !== 1`.
 *
 * BillingView keeps exactly one: bills are not dated by a single column, they
 * span [week_start, week_end], and "the bill's week falls inside the requested
 * period" is interval containment, which filterByDate cannot express -- it
 * takes one dateKey. Both columns are `not null` (schema.sql:106,107), so the
 * undated branch could not fire here anyway and there is nothing to report.
 *
 * ReportsTabs keeps none. Every one of its five tabs filters a single column.
 */
const ALLOWED_COMPARISONS: Record<'BillingView' | 'ReportsTabs', string[]> = {
  BillingView: [
    'return (!dateFrom || b.week_start >= dateFrom) && (!dateTo || b.week_end <= dateTo)',
  ],
  ReportsTabs: [],
}

describe('both screens date-filter through the one shared predicate', () => {
  for (const [name, rel] of [['BillingView', BILLING_VIEW], ['ReportsTabs', REPORTS_TABS]] as const) {
    it(`${name} imports filterByDate`, () => {
      expect(src(rel)).toMatch(/from '@\/lib\/billing\/date-range'/)
    })

    it(`${name} has no date-bound comparison outside the allowlist`, () => {
      // Two earlier attempts at this assertion were worthless and the reason is
      // worth keeping, because it is the same mistake twice:
      //
      //   1. Banning `[<>]` near a column name matched the JSX on
      //      `{s.ship_date ? ... }</td>` render lines, so it failed on fixed
      //      and broken code alike. A test that cannot pass detects nothing.
      //   2. Banning `ship_date <op> dateFrom` PASSED on the pre-fix code --
      //      because neither bug was written that way. Both hid the comparison
      //      behind a helper, against a parameter named `d`, so the column name
      //      and the bound never appeared on the same line. A test that cannot
      //      fail detects nothing either, and that one I only caught by running
      //      it against HEAD.
      //
      // So the invariant is about the BOUND, not the column: inside these two
      // components, a date bound may participate in exactly one comparison --
      // the [week_start, week_end] containment in BillingView, over two `not
      // null` columns. Everything else must go through filterByDate. That is
      // the form both historical bugs violate, and it catches a new private
      // helper whatever it is named.
      //
      // Run against the pre-fix tree, this version reports 3 sites in
      // BillingView and 2 in ReportsTabs -- which are exactly the two
      // disagreeing lines plus the hand-rolled warehouse filter:
      //
      //   BillingView   return (!from || d >= from) && (!to || d <= to)
      //   BillingView   (!dateFrom || w.log_date >= dateFrom) && ...
      //   ReportsTabs   if (dateFrom && d && d < dateFrom) return false
      //   ReportsTabs   if (dateTo && d && d > dateTo) return false
      //
      // It fails on the defect and passes on the fix. Both halves verified, not
      // assumed -- that is the whole lesson of attempts 1 and 2.
      const sites = src(rel).split('\n')
        .map(l => l.trim())
        .filter(l => /[<>]=?\s*\b(?:dateFrom|dateTo|from|to)\b/.test(l)
                  || /\b(?:dateFrom|dateTo|from|to)\b\s*[<>]=?[^=]/.test(l))
      expect(sites).toEqual(ALLOWED_COMPARISONS[name])
    })

    it(`${name} has no private date-range helper left`, () => {
      expect(src(rel)).not.toMatch(/function inDateRange/)
    })
  }
})

describe('the shared predicate agrees with the SQL the export actually runs', () => {
  const route = src(DOWNLOAD_ROUTE)

  it('the export filters inclusively, which is what filterByDate assumes', () => {
    // If the route ever moved to .gt/.lt, filterByDate would keep the first and
    // last day of the range that the spreadsheet drops, and the table would
    // overstate the period by two days with nothing saying so.
    expect(route).toMatch(/\.gte\(/)
    expect(route).toMatch(/\.lte\(/)
    expect(route).not.toMatch(/\.gt\(['"](?:ship_date|adjustment_date|log_date|week_start|week_end)/)
    expect(route).not.toMatch(/\.lt\(['"](?:ship_date|adjustment_date|log_date|week_start|week_end)/)
  })

  it('still filters every nullable-date report, so undated rows are dropped there too', () => {
    // This is WHY dropping is the correct answer rather than a preference. A
    // .gte on a null column is null, not true, so the export has always
    // excluded these rows. If the route stopped filtering, dropping on screen
    // would become the thing that disagrees with the spreadsheet.
    for (const col of NULLABLE_DATE_COLUMNS) {
      expect(route, `route no longer range-filters ${col}`).toMatch(
        new RegExp(`\\.gte\\(['"]${col}['"]`),
      )
    }
  })

  it('drops an undated row exactly as a .gte/.lte pair would', () => {
    // Not a prose claim: the three-valued logic modelled and compared.
    const sqlKeeps = (d: string | null) => d !== null && d >= '2026-10-01' && d <= '2026-10-31'
    for (const d of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01', null]) {
      const screenKeeps =
        filterByDate([{ ship_date: d }], 'ship_date', '2026-10-01', '2026-10-31').rows.length === 1
      expect(screenKeeps, `disagreement on ${String(d)}`).toBe(sqlKeeps(d))
    }
  })
})
