// Static checks over the ledger migration files.
//
// These are not tests of behaviour -- nothing here connects to Postgres, and
// there is no psql on the machines this repo is developed on, so the migrations
// are applied by pasting them into the Supabase SQL editor. That is exactly why
// these checks are worth having: the migrations get read far more often than
// they get run, and the two failures below are both invisible on a read.
//
// Both encode a mistake that was actually made, in this repo, and shipped.

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = 'supabase'

/** Every ledger migration, so a new one is covered the day it is added. */
function migrationFiles(): string[] {
  const files = readdirSync(DIR)
    .filter((f) => /^ledger_.*\.sql$/.test(f))
    .sort()
  // Guards the guard: a renamed directory or a changed naming convention would
  // leave every test below iterating an empty list and passing.
  if (files.length < 5) {
    throw new Error(
      `Expected the ledger migrations in ${DIR}/, found ${files.length} file(s). `
      + 'If they moved or were renamed, update this test.')
  }
  return files
}

const FILES = migrationFiles()

/**
 * Drops whole-line `--` comments.
 *
 * Needed because these files document the mistakes below by quoting them, and
 * the first version of this test read its own explanatory comment in
 * ledger_03_charges.sql as a live `when others` handler and failed. A check
 * that cannot be described in prose next to the code is a check that gets its
 * explanation deleted.
 *
 * Only whole-line comments, deliberately. Stripping from any `--` onwards
 * would cut into string literals -- these files contain operator hints like
 * '... in place -- do NOT delete them ...' -- and that can swallow a quote and
 * desynchronise everything after it. A line whose first non-space characters
 * are `--` is unambiguous: no string literal in these files begins a line that
 * way. The residue is that a trailing comment on a line of code survives,
 * which is a false-positive risk only for a comment that quotes one of these
 * patterns inline, and the fix for that is to put it on its own line.
 */
function stripFullLineComments(sql: string): string {
  return sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
}

// ---------------------------------------------------------------------------
// 1. A constraint declared only inside `create table if not exists`.
//
// `create table if not exists` does NOTHING to a table that already exists --
// not even add a missing constraint. So a constraint added to a create-table
// body AFTER the table was first created exists only on databases built from
// the newer file. On every older one it is absent, re-applying the migration
// never repairs it, and the file's own "safe to run more than once" header
// reads as a promise that it would.
//
// This happened: order_charges_cost_has_basis was added inline by commit
// a97d44a, after 693f762 had already created the table without it. A database
// created from 693f762 bills costs with no stated provenance, renders them as
// measured, and has no second line of defence -- cost null at least shows up as
// cost_unknown_charges, but cost-without-basis shows up as nothing at all.
//
// The fix in every case is to ALSO add the constraint in a guarded
// `alter table ... add constraint` block whose duplicate_object arm is the
// ordinary path. Declaring it inline as well is not redundant: it is what makes
// a freshly created table correct before any alter runs.
// ---------------------------------------------------------------------------
describe('constraints declared inside create table have a repair block', () => {
  // KNOWN GAP, stated rather than left to be discovered: this only sees NAMED
  // constraints. An anonymous inline `unique (...)` or `check (...)` has the
  // identical re-apply problem, but Postgres generates its name, so there is
  // no name for an `add constraint` block to match on and nothing to assert.
  // Two of those exist today -- ledger_01_orders.sql's
  // `unique (order_id, source, line_ordinal)` and ledger_07_storage.sql's
  // `unique (client_id, period_month)` -- and both are safe for a reason this
  // test cannot check: `git show` of each file's first committed version has
  // them already present, so no database exists that is missing either one.
  // Verified by hand, not here. A NEW anonymous inline constraint would slip
  // past this test; name it and it will not.
  /** `constraint <name>` lines that are NOT part of an `add constraint`. */
  function inlineConstraints(sql: string): string[] {
    return [...stripFullLineComments(sql)
      .matchAll(/^[ \t]+constraint[ \t]+(\w+)/gim)].map((m) => m[1])
  }

  it('finds the inline declarations it is meant to check', () => {
    // Without this, a regex that matched nothing would make every assertion
    // below pass by iterating an empty array -- the shape of vacuous pass the
    // verify scripts in this repo warn about. order_charges_cost_has_basis is
    // named because it is the one that caused the bug; if it is ever renamed,
    // this line failing is the correct outcome.
    const all = FILES.flatMap((f) => inlineConstraints(readFileSync(`${DIR}/${f}`, 'utf8')))
    expect(all).toContain('order_charges_cost_has_basis')
  })

  for (const file of FILES) {
    const sql = readFileSync(`${DIR}/${file}`, 'utf8')
    const inline = inlineConstraints(sql)
    if (inline.length === 0) continue

    it(`${file}: every inline constraint is also added by an alter`, () => {
      const missing = inline.filter(
        (name) => !new RegExp(`add\\s+constraint\\s+${name}\\b`, 'i').test(sql))
      // The message carries the remedy, because the person who hits this is
      // adding a constraint and has no reason to know about a97d44a.
      expect(missing, `${file} declares ${missing.join(', ')} only inside `
        + 'create table, so a database that already exists never gets it. Add a '
        + 'guarded `alter table ... add constraint` block for it too -- copy '
        + 'order_charges_charge_type_valid in ledger_03_charges.sql, which '
        + 'handles duplicate_object as the ordinary case and names the '
        + 'offending rows when the data refuses the constraint.')
        .toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// 2. `exception when others then raise notice '<reassuring guess>'`.
//
// This file had three of these, all in the shape
//
//     exception when others then
//       raise notice 'order_charges.amount was already nullable';
//
// and the cause each one named was the one cause it could not possibly see:
// `alter column ... drop not null` on an already-nullable column does not
// raise, it is a no-op. Every condition those handlers actually caught was a
// broken paste or a missing prerequisite -- 42703 for a renamed column, 42501
// for a role that does not own the table -- and each printed a reassuring
// notice and let the migration finish green. The 42501 case is the expensive
// one: the column stays NOT NULL, the file reports success, and the failure
// surfaces much later as every at-cost charge being rejected.
//
// `when others` is not the problem; swallowing is. A handler must do one of:
//   - re-raise (`raise;` or `raise exception`), or
//   - report the SQLSTATE, so the reader can tell UNKNOWN from benign, or
//   - check the catalog for the state the file actually wanted, and raise if
//     it is not there.
//
// The last is the strongest and is what ledger_03 now does: it asks
// information_schema whether the column is nullable rather than inferring
// anything from which exception arrived.
// ---------------------------------------------------------------------------
describe('exception handlers do not print a reassuring guess', () => {
  /** Handler bodies, from `when others then` to the block end. */
  function whenOthersBodies(sql: string): string[] {
    return [...stripFullLineComments(sql)
      .matchAll(/when\s+others\s+then([\s\S]*?)end[\s;$]/gi)].map((m) => m[1])
  }

  it('finds the handlers it is meant to check', () => {
    const total = FILES.reduce(
      (n, f) => n + whenOthersBodies(readFileSync(`${DIR}/${f}`, 'utf8')).length, 0)
    // Not `> 0`: these files are known to contain several, and a regex that
    // found one of five would look like it had worked.
    expect(total).toBeGreaterThanOrEqual(5)
  })

  for (const file of FILES) {
    const sql = readFileSync(`${DIR}/${file}`, 'utf8')
    const bodies = whenOthersBodies(sql)
    if (bodies.length === 0) continue

    it(`${file}: every when-others handler re-raises, reports SQLSTATE, or checks the catalog`, () => {
      const swallowed = bodies.filter((body) => {
        const b = body.toLowerCase()
        const reRaises = /\braise\s*;/.test(b) || /\braise\s+exception\b/.test(b)
        const reportsState = b.includes('sqlstate')
        const checksCatalog = b.includes('information_schema') || b.includes('pg_')
        return !reRaises && !reportsState && !checksCatalog
      })
      expect(swallowed, `${file} has ${swallowed.length} when-others handler(s) `
        + 'that neither re-raise, nor print the SQLSTATE, nor check the catalog. '
        + 'A handler like that turns a broken paste into a green migration. '
        + `Offending body: ${JSON.stringify(swallowed[0]?.trim().slice(0, 160))}`)
        .toEqual([])
    })
  }
})
