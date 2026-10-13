import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// `/billing` and `/reports` were both dead, and the cause was three string
// literals:
//
//   billing/page.tsx  bills             ... manual_total ...
//   reports/page.tsx  bills             ... manual_total ...
//   reports/page.tsx  rate_adjustments  ... new_cost ...
//
// No migration creates either column and nothing in the codebase writes one.
// The writers write `manual_charges_total` (calculator.ts:298) and
// `adjusted_cost` (shipstation.ts:620). PostgREST answers a select naming a
// column that does not exist with a 42703, read() turns that into an error,
// and both pages refuse the WHOLE screen on any read error -- by design, because
// composing an invoice out of a database that is answering some questions and
// not others is worse than refusing. So one wrong word in one select is exactly
// what "billing is not working" looks like from the outside, and both selects
// dated to the initial commit.
//
// WHY THIS IS A TEST AND NOT JUST A FIX.
//
// My first answer here was that tsc cannot see inside `.select('a, b, c')`
// because it is a string. That is WRONG, and checking it is what made this test
// worth writing instead of worth deleting: supabase-js infers the row shape FROM
// the select literal, so changing one name in the string and nothing else fails
// with TS2322 at `const data: LoadedData<typeof reports>`, naming the property.
//
// Which means tsc already pins the select string to the component's declared TS
// type. What NOTHING pins either of them to is the database.
//
// And that is the defect that actually shipped. `manual_total` was in the select
// string AND in BillingBill AND in the JSX cell -- three places, mutually
// consistent, all three wrong. tsc has nothing to complain about. Verified, not
// reasoned: renaming both sides together on reports/page.tsx and ReportsTabs.tsx
// leaves `npx tsc --noEmit` at exit 0 and fails only the assertion below. That
// two-sided rename is the mutation this file is built to kill, and the one-sided
// rename -- the easier mutation -- proves nothing, because tsc kills it already.
//
// This is deliberately a GENERAL check and not a blacklist of the two known
// names. A blacklist would pass the moment someone invented a third.
//
// WHY THE SQL SIDE IS A PERMISSIVE UNION.
//
// `supabase/` is loose files, not an ordered migration directory, and some of
// them are proposals or read-only diagnostics rather than things that ran. So
// "known" here is the union of every `create table` body and every `add column`
// in every .sql file in the repo -- which over-accepts: a column mentioned only
// in an unapplied proposal counts as known.
//
// That is the right direction to be wrong in. The defect class is a name that
// appears in NO sql file anywhere, which is what both phantoms were, and a
// permissive union cannot produce a false failure that gets this test deleted.
//
// VERIFIED IN BOTH DIRECTIONS, which is the only reason to trust it:
//   - against HEAD~1 it reports exactly the three sites above, and nothing else
//   - against the fix it reports none
//
// WHY ONLY THESE FOUR FILES.
//
// Run over all 156 non-test files in src/ this reports seven more sites. Three
// are gaps in the parser rather than defects -- `zone_chart` has no `create
// table` anywhere in the repo, so only the one column an `alter table` mentions
// is known, and `origin_zip` reads as unknown. The others are open questions
// recorded here so they are not lost rather than asserted on:
//
//   clients.zenventory_api_key     src/lib/sync/zenventory.ts:16, and
//   clients.zenventory_api_secret  api/clients/[id]/test-zenventory/route.ts
//   partner_login_codes.status     api/partner/verify-code/route.ts
//
// The zenventory pair is the interesting one: the only zenventory column any
// file in supabase/ declares is `zenventory_secure_key`. But production is
// returning a Zenventory 401, not a PostgREST 42703, so that read is reaching
// the network and those columns do exist live -- added in the editor, not in a
// file. Widening this test would therefore fail on undocumented-but-real
// columns, which is how a useful test gets deleted. It stays scoped to the three
// files that compose money until the live column list is in the repo.

const SQL_DIR = 'supabase'

/**
 * The files that turn rows into a figure an operator sends to a client, and how
 * many `.from`/`.select` pairs the scraper below must still be able to see in
 * each.
 *
 * The per-file count replaced a blanket `> 3`, which the statement read would
 * have had to be excluded from for having only two -- and excluding a money-path
 * file from the money-path guard to keep the guard's own threshold tidy is how
 * this test would stop being worth having. Compared with >= and not ===, so
 * adding a read raises the number without failing the build, while a `.from`
 * written in a shape the scraper cannot see drops it and does.
 */
const MONEY_PATH: ReadonlyArray<{ file: string; selects: number }> = [
  { file: 'src/app/billing/page.tsx', selects: 5 },
  { file: 'src/app/reports/page.tsx', selects: 6 },
  { file: 'src/app/api/reports/download/route.ts', selects: 6 },
  { file: 'src/lib/billing/statement-charges.ts', selects: 2 },
]

const NON_COLUMN_LINE_STARTS = new Set([
  'primary', 'unique', 'constraint', 'foreign', 'check', 'exclude',
])

function sqlText(): string {
  const parts: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.sql')) parts.push(readFileSync(p, 'utf8'))
    }
  }
  walk(SQL_DIR)
  return parts.join('\n')
}

/**
 * table -> every column name any .sql file in the repo attributes to it.
 *
 * A table present with an EMPTY set means "named by an alter/view but never
 * created here", and the caller skips it rather than reporting all of its
 * columns as unknown.
 */
function knownColumns(): Map<string, Set<string>> {
  const known = new Map<string, Set<string>>()
  const add = (table: string, column?: string) => {
    if (!known.has(table)) known.set(table, new Set())
    if (column) known.get(table)!.add(column)
  }

  const sql = sqlText()

  for (const m of sql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi,
  )) {
    const table = m[1]
    add(table)
    for (const line of m[2].split('\n')) {
      const col = /^([a-z_0-9]+)\s+/.exec(line.trim())
      if (col && !NON_COLUMN_LINE_STARTS.has(col[1].toLowerCase())) add(table, col[1])
    }
  }

  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_0-9]+)([^;]*);/gi)) {
    add(m[1])
    for (const col of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)/gi)) {
      add(m[1], col[1])
    }
  }

  // A view's column list is a select, not a declaration, so it is not parsed --
  // the table is registered with no columns and therefore skipped.
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z_0-9]+)/gi)) {
    add(m[1])
  }

  return known
}

/**
 * Every `.from('table')` paired with the `.select('...')` that follows it.
 *
 * Positional rather than parsed, because these are chained builders and the
 * `.select` is always the next one after its `.from`. The 900-character window
 * is what keeps a `.from` with no select of its own (an insert, an update) from
 * stealing the select belonging to the next read in the file.
 */
function selectsIn(src: string): Array<{ table: string; columns: string }> {
  const out: Array<{ table: string; columns: string }> = []
  for (const m of src.matchAll(/\.from\(\s*'([a-z_0-9]+)'\s*\)/g)) {
    const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 900)
    const sel = /\.select\(\s*'([^']*)'/.exec(after)
    if (sel) out.push({ table: m[1], columns: sel[1] })
  }
  return out
}

/** Every `table.column` a file selects that no .sql file in the repo declares. */
function unknownColumns(file: string, known: Map<string, Set<string>>): string[] {
  const bad: string[] = []
  const check = (table: string, column: string) => {
    const cols = known.get(table)
    // Unknown table, or a table nothing in the repo CREATES: not this test's
    // claim to make. Reporting every column of an unparsed table would bury the
    // one finding that matters in noise.
    if (!cols || cols.size === 0) return
    if (!cols.has(column)) bad.push(`${file}: ${table}.${column}`)
  }

  for (const { table, columns } of selectsIn(readFileSync(file, 'utf8'))) {
    for (const raw of columns.split(',')) {
      const col = raw.trim()
      if (!col) continue

      // An embedded relation -- `clients(name)` -- names a column on the
      // RELATED table, not this one. Checking it against `table` would report
      // every join in the app.
      const embed = /^([a-z_0-9]+)\(([^)]*)\)$/.exec(col)
      if (embed) {
        for (const sub of embed[2].split(',')) {
          const name = sub.trim()
          if (name && name !== '*') check(embed[1], name)
        }
        continue
      }

      // `alias:real_column` -- PostgREST renaming. The real column is on the
      // right, and it is the one the database has to have.
      const name = col.includes(':') ? col.split(':').pop()!.trim() : col
      if (name && name !== '*') check(table, name)
    }
  }
  return bad
}

describe('the money path selects only columns that exist', () => {
  const known = knownColumns()

  it('parsed the schema it is about to judge against', () => {
    // A guard on the guard. If the regexes ever stop matching -- a reformat of
    // schema.sql, a move to a migrations directory -- `known` goes empty, every
    // table reads as unparsed, every file is skipped, and the test below passes
    // by examining nothing. That is the failure mode of every source-scraping
    // test and it has to be made loud.
    expect(known.size).toBeGreaterThan(20)
    expect(known.get('bills')).toContain('manual_charges_total')
    expect(known.get('rate_adjustments')).toContain('adjusted_cost')
    expect(known.get('shipments')).toContain('ship_date')
    expect(known.get('warehouse_daily_log')).toContain('log_date')
    // order_charges is parsed out of ledger_03_charges.sql rather than
    // schema.sql, so this also pins that the walk reaches the whole directory
    // and not just the one file the first three entries happen to need.
    expect(known.get('order_charges')).toContain('charge_date')
    expect(known.get('order_charges')).toContain('unit_rate')

    // And the other half: the two phantom names must still be absent, or this
    // whole file is asserting nothing. If someone later adds a `manual_total`
    // column for real, this fails and the comment at the top needs rewriting
    // rather than the assertion relaxing.
    expect(known.get('bills')).not.toContain('manual_total')
    expect(known.get('rate_adjustments')).not.toContain('new_cost')
  })

  it('can see the selects in each file', () => {
    // Same reason. A `.from(...)` written any other way -- a variable table
    // name, double quotes, a select string hoisted into a const -- would
    // silently drop that read from the scan.
    for (const { file, selects } of MONEY_PATH) {
      const found = selectsIn(readFileSync(file, 'utf8'))
      expect(found.length, `.from/.select pairs scraped from ${file}`).toBeGreaterThanOrEqual(selects)
    }
  })

  for (const { file } of MONEY_PATH) {
    it(`${file} names no column the repo does not declare`, () => {
      // Reported as a list of `file: table.column` and compared to empty, so a
      // regression fails by PRINTING the offending column rather than as
      // `1 !== 0`. Against HEAD~1 this is the three-line list in the header.
      expect(unknownColumns(file, known)).toEqual([])
    })
  }
})
