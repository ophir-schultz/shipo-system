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
 * Screens and routes whose figures are SUMS over the shipments table.
 *
 * A page earns its place here by aggregating: if a wrong row count changes a
 * number somebody reads as money, the read behind it has to be complete.
 */
const MONEY_READS = [
  'app/dashboard/page.tsx',
  'app/pnl/page.tsx',
  'app/losses/page.tsx',
  'app/api/agent/monitor/route.ts',
]

/**
 * Every `.from('shipments')` in a file, with the ~8 lines that follow it --
 * enough to see the modifiers attached to that query and no further.
 */
function shipmentReads(source: string): string[] {
  const lines = source.split('\n')
  const reads: string[] = []
  lines.forEach((line, i) => {
    if (line.includes(".from('shipments')")) {
      reads.push(lines.slice(Math.max(0, i - 2), i + 9).join('\n'))
    }
  })
  return reads
}

describe('money screens read the whole shipments table', () => {
  for (const rel of MONEY_READS) {
    it(`${rel} pages or bounds every shipments read`, () => {
      const source = readFileSync(join(ROOT, rel), 'utf8')
      const reads = shipmentReads(source)
      // A file on this list that reads no shipments at all has been moved or
      // renamed, and the check would pass vacuously.
      expect(reads.length).toBeGreaterThan(0)

      for (const read of reads) {
        const paged = read.includes('readAllPages') || read.includes('.range(')
        // The two honest ways to be bounded. `.limit(n)` says "the top n IS
        // the answer"; a head count is computed by the server and the row cap
        // cannot reach it.
        const boundedOnPurpose = /\.limit\(/.test(read)
          || /count:\s*'exact'[^)]*head:\s*true/.test(read)
        expect(
          paged || boundedOnPurpose,
          `Unpaged, unbounded shipments read in ${rel}:\n${read}\n\n`
          + 'PostgREST caps this at db-max-rows (1000) silently. Wrap it in '
          + "readAllPages with .order('id'), or say why it is bounded with "
          + '.limit() or a head count.',
        ).toBe(true)
      }
    })
  }

  it('pages with a unique sort key, so two pages cannot overlap or skip', () => {
    // readAllPages' contract, restated where it is used. Postgres promises
    // nothing about row order across two OFFSET queries sorted on a
    // non-unique column, so paging a read ordered only by ship_date can
    // return one shipment twice and miss another -- on a money page that is a
    // double-counted charge and a missing one, with the row count still
    // looking right.
    for (const rel of MONEY_READS) {
      const source = readFileSync(join(ROOT, rel), 'utf8')
      for (const read of shipmentReads(source)) {
        if (!read.includes('.range(')) continue
        expect(
          read.includes(".order('id')"),
          `Paged shipments read without .order('id') in ${rel}:\n${read}`,
        ).toBe(true)
      }
    }
  })
})
