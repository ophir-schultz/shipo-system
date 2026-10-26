// Static check over the repo's own source: no money screen may total the
// `shipments` table with an unpaged read.
//
// WHY THIS EXISTS, AND WHY IT IS A SOURCE CHECK.
//
// PostgREST caps every select at `db-max-rows` -- 1000 by default -- and
// reports the cap NOWHERE: a 200, `error: null`, and a thousand rows. The full
// account is at the head of ./page.ts. What that header could not say, because
// it had not happened yet, is how the failure presents when it reaches a
// screen.
//
// On 2026-10-23 the dashboard's year-to-date cards were computed from 1000 of
// 1823 shipments:
//
//   REVENUE (RECONCILED)   showed $18,256.87   actual $35,155.66
//   CARRIER COST           showed $10,758.96   actual $20,306.33
//   MARGIN                 showed  +$7,497.91  actual $14,849.33
//
// Half the business, in the three largest figures on the first screen anybody
// opens, with nothing marking it. Every individual number was computed
// correctly from the rows the page held; the rows were the lie. The margin
// percentage even looked plausible, because revenue and cost were truncated in
// roughly the same proportion.
//
// No behavioural test reaches this. vitest.config.ts excludes `.test.tsx`, so
// none of these pages can be rendered; and a test double that returns every
// row it is given -- as fake-supabase did until the same day -- cannot
// reproduce a server-side cap at all. The defect is visible only in the shape
// of the read: whether the query goes through readAllPages or not. Hence
// readFileSync and no import of the code under test.
//
// WHAT THIS DOES NOT CLAIM. It does not prove any figure on these screens is
// right, only that none of them totals `shipments` from a read that stops at
// an arbitrary row. A deliberately bounded read is exempt and must say so --
// `.limit(n)` for a top-N list, or `count: 'exact', head: true`, which the
// server computes and the cap never touches.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')

/**
 * Files, and the tables in them whose reads must be complete.
 *
 * A pair earns its place here by one of two tests: a wrong row count changes a
 * figure somebody reads as money, OR it changes what the screen says EXISTS.
 * The second is how the client page got here -- Orcam's zone matrix is 1600
 * cells, so an unpaged read showed two thirds of a rate card as though it were
 * the card, on the screen you open to ask whether a weight is covered.
 *
 * Tables too small to reach the cap are deliberately absent: `clients` is 9
 * rows and `client_store_ids` about 10, and listing them would be ceremony
 * rather than protection.
 */
const MONEY_READS: Array<[file: string, tables: string[]]> = [
  ['app/dashboard/page.tsx', ['shipments']],
  ['app/pnl/page.tsx', ['shipments']],
  ['app/losses/page.tsx', ['shipments']],
  ['app/api/agent/monitor/route.ts', ['shipments']],
  // Not a total -- a rate card. Truncation here reads as "that band is not in
  // the agreement", which is the same conclusion as a genuine gap.
  ['app/clients/[id]/page.tsx', ['client_zone_rates']],
  // Returned rows beside a server-computed `count: 'exact'`; past the cap the
  // two disagree with nothing saying which to believe.
  ['app/api/clients/[id]/zone-chart/route.ts', ['zone_chart']],
  // The stale sweep: a row this read misses is a superseded storage charge
  // that stays on the statement.
  ['lib/ledger/persist-storage-charges.ts', ['order_charges']],
]

/**
 * Every `.from('<table>')` in a file, with the ~8 lines that follow it --
 * enough to see the modifiers attached to that query and no further.
 */
function tableReads(source: string, table: string): string[] {
  const lines = source.split('\n')
  const reads: string[] = []
  lines.forEach((line, i) => {
    if (line.includes(`.from('${table}')`)) {
      // Generous, because query chains in this repo carry comments between
      // their modifiers -- a window tight enough to hold only code reported a
      // paged read as unpaged the first time this ran, which is the sort of
      // false alarm that gets a guard deleted rather than fixed.
      reads.push(lines.slice(Math.max(0, i - 4), i + 20).join('\n'))
    }
  })
  return reads
}

/** Reads that only ever touch one row, or write, are not this file's business. */
function isMultiRowRead(read: string): boolean {
  if (!read.includes('.select(')) return false
  if (/\.(insert|update|upsert|delete)\(/.test(read)) return false
  if (/\.(maybeSingle|single)\(/.test(read)) return false
  return true
}

describe('money reads cover the whole table', () => {
  for (const [rel, tables] of MONEY_READS) {
    for (const table of tables) {
      it(`${rel} pages or bounds every ${table} read`, () => {
        const source = readFileSync(join(ROOT, rel), 'utf8')
        const reads = tableReads(source, table).filter(isMultiRowRead)
        // A pair on this list that reads nothing has been moved or renamed,
        // and the check would pass vacuously.
        expect(reads.length).toBeGreaterThan(0)

        for (const read of reads) {
          const paged = read.includes('readAllPages')
            || read.includes('fetchAllPages') || read.includes('.range(')
          // The two honest ways to be bounded. `.limit(n)` says "the top n IS
          // the answer"; a head count is computed by the server and the row
          // cap cannot reach it.
          const boundedOnPurpose = /\.limit\(/.test(read)
            || /count:\s*'exact'[^)]*head:\s*true/.test(read)
          expect(
            paged || boundedOnPurpose,
            `Unpaged, unbounded ${table} read in ${rel}:\n${read}\n\n`
            + 'PostgREST caps this at db-max-rows (1000) silently. Wrap it in '
            + "readAllPages with .order('id'), or say why it is bounded with "
            + '.limit() or a head count.',
          ).toBe(true)
        }
      })
    }
  }

  it('pages with a unique sort key, so two pages cannot overlap or skip', () => {
    // readAllPages' contract, restated where it is used. Postgres promises
    // nothing about row order across two OFFSET queries sorted on a
    // non-unique column, so paging a read ordered only by ship_date or
    // weight_lb can return one row twice and miss another -- on a money page
    // that is a double-counted charge and a missing one, with the row count
    // still looking right.
    for (const [rel, tables] of MONEY_READS) {
      const source = readFileSync(join(ROOT, rel), 'utf8')
      for (const table of tables) {
        for (const read of tableReads(source, table)) {
          if (!read.includes('.range(')) continue
          // `.order('id')` is the default because `id` is unique on every
          // table in schema.sql. A read may sort on something else when that
          // something else is ALREADY unique -- but it has to say so, in
          // those words, next to the query. An unexplained exception and a
          // bug look identical from here, and the marker is what separates
          // them without this file having to model the schema's indexes.
          const declaresUniqueSort = read.includes('UNIQUE SORT:')
          expect(
            read.includes(".order('id')") || declaresUniqueSort,
            `Paged ${table} read in ${rel} sorts on something that may not be `
            + `unique, and two OFFSET pages can then repeat one row and skip `
            + `another:\n${read}\n\n`
            + `Add .order('id') as the last sort key, or a comment beginning `
            + `"UNIQUE SORT:" saying which index makes the current one unique.`,
          ).toBe(true)
        }
      }
    }
  })
})
