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

// ---------------------------------------------------------------------------
// 3. The verify scripts in supabase/verify/, which nothing covered at all.
//
// Those five files hold roughly a hundred assertions about the migrations, and
// on this machine they are NEVER RUN: there is no psql, no docker and no
// postgres here, so they are applied by pasting them into the Supabase SQL
// editor, by hand, occasionally. A verify script with a syntax error does not
// fail -- it does not get executed in the first place, and the ledger simply
// stays unverified with nobody aware of it. That is the gap these two checks
// close: they are the only automated statement anyone makes about these files.
//
// WHY THE if/end-if COUNT IS PER FILE AND NOT PER BLOCK. ledger_02_verify.sql
// writes three of its blocks on one line --
// `do $$ begin raise notice 'PASS: ...'; end $$;` -- and a non-greedy
// do/end regex does not fail on that, it MERGES the block with its neighbour
// and reports a smaller number of larger blocks. The merged totals still
// balance, so the per-block version of this check passed while silently
// examining 3 blocks where 6 exist. Found by counting `do $$` separately and
// getting 6. A per-file total cannot say WHICH block is unbalanced, only that
// one is; that is the honest limit and it is still the difference between a
// script that runs and a script that does not.
//
// (Those three one-line blocks are not a defect. They are the "reaching this
// line means the INSERT above did not raise" idiom, where the bare insert is
// the assertion. A check for "prints PASS but contains no raise exception"
// would flag all three wrongly, which is why there isn't one.)
//
// SCOPED TO verify/ DELIBERATELY. In the migrations themselves `if` is
// ambiguous: `create index if not exists` is DDL while `if exists (select 1
// from pg_index ...) then` is a conditional, and no count can separate them
// without parsing. The verify scripts contain no DDL `if` at all, so there the
// count is exact -- and the second assertion below pins that premise, so the
// day someone adds `create table if not exists` to a verify script the test
// says the count can no longer be trusted instead of quietly going wrong.
// ---------------------------------------------------------------------------
const VERIFY_DIR = 'supabase/verify'

function verifyFiles(): string[] {
  const files = readdirSync(VERIFY_DIR)
    .filter((f) => /^ledger_.*\.sql$/.test(f))
    .sort()
  // Guards the guard, same reason as migrationFiles().
  if (files.length < 5) {
    throw new Error(
      `Expected the verify scripts in ${VERIFY_DIR}/, found ${files.length} `
      + 'file(s). If they moved or were renamed, update this test.')
  }
  return files
}

const VERIFY = verifyFiles()

/**
 * Blanks the contents of single-quoted literals, keeping the quotes.
 *
 * Required, and the reason is a mistake made while writing these very checks.
 * The assertions in ledger_04_verify.sql carry prose in their failure
 * messages -- 'FAIL: direct_labor is %, expected 2000.00. If this holds ...' --
 * and a case-insensitive `\bif\b` reads that "If" as a conditional opener. The
 * first run of this count reported two files as unbalanced when both were
 * fine. Same class of trap as stripFullLineComments above: a check that reads
 * the file's own English as code.
 *
 * `(?:[^']|'')*` consumes doubled quotes as content, which is how these files
 * escape an apostrophe inside a message ('the month''s rate').
 */
function blankStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}

describe('verify scripts are structurally runnable', () => {
  const scrubbed = new Map(
    VERIFY.map((f) => [f, blankStringLiterals(
      stripFullLineComments(readFileSync(`${VERIFY_DIR}/${f}`, 'utf8')))]))

  const endIfs = (sql: string) => sql.match(/\bend\s+if\b/gi)?.length ?? 0
  const allIfs = (sql: string) => sql.match(/\bif\b/gi)?.length ?? 0

  it('finds the conditionals it is meant to count', () => {
    // Not `> 0`. ledger_04_verify.sql alone holds 69 `end if`s, so a regex that
    // matched a handful would look like it had worked -- the vacuous pass these
    // scripts' own comments warn about, in the test that checks them.
    const total = [...scrubbed.values()].reduce((n, s) => n + endIfs(s), 0)
    expect(total).toBeGreaterThanOrEqual(20)
  })

  for (const file of VERIFY) {
    const sql = scrubbed.get(file)!

    it(`${file}: no DDL \`if exists\`, so the conditional count is exact`, () => {
      const ddl = sql.match(/\bif\s+(?:not\s+)?exists\b/gi) ?? []
      expect(ddl, `${file} now contains ${ddl.length} \`if [not] exists\` `
        + 'clause(s). Those are DDL, not conditionals, so the if/end-if balance '
        + 'assertion below is counting them as openers and will report a false '
        + 'mismatch. Either keep DDL out of the verify scripts or teach this '
        + 'test to distinguish `create ... if not exists` from `if exists '
        + '(select ...) then`.')
        .toEqual([])
    })

    it(`${file}: every if is closed by an end if`, () => {
      const closes = endIfs(sql)
      // `end if` itself contains an `if`, so subtract the closers to get openers.
      const opens = allIfs(sql) - closes
      expect({ opens, closes }, `${file} has ${opens} \`if\` opener(s) and `
        + `${closes} \`end if\`. PL/pgSQL will refuse the whole block, which on `
        + 'a machine with no psql means the script is never executed and the '
        + 'migration it verifies stays unverified with nothing to show that it '
        + 'is. This count is per FILE, so it cannot tell you which block -- '
        + 'read the do-blocks from the top.')
        .toEqual({ opens: closes, closes })
    })

    it(`${file}: wrapped in begin and rolled back, never committed`, () => {
      // These scripts insert sentinel clients, orders and charges, future-dated
      // operating costs, and -- in ledger_04_verify.sql -- a deliberately
      // absurd 9.0000 pick cost rate placed as a trap for a loosened join. The
      // `rollback;` is the only thing keeping all of it out of the real tables.
      // A `commit` here does not fail; it leaves fixtures behind that
      // pnl_monthly and labour_variance_inputs then report as real money.
      const raw = readFileSync(`${VERIFY_DIR}/${file}`, 'utf8')
      const statements = sql.split('\n').map((l) => l.trim()).filter(Boolean)
      expect(statements[0], `${file} must open with \`begin;\``).toBe('begin;')
      expect(raw.trimEnd().endsWith('rollback;'),
        `${file} must end with \`rollback;\` -- its fixtures are written into `
        + 'the live tables and only the rollback removes them').toBe(true)
      // Checked against the scrubbed text, so the word inside a comment or a
      // notice message ('... and commit it ...') does not trip this.
      expect(sql.match(/\bcommit\b/gi) ?? [],
        `${file} contains a \`commit\`. Every row these scripts write is a `
        + 'fixture; committing one persists a VERIFY-ONLY client and its '
        + 'charges into the tables the P&L views read.')
        .toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// A verify fixture must not share an exclusion-constraint group with a SEEDED
// cost rate.
//
// Every check above is structural: it reads whether a file is shaped like a
// runnable script. All of them passed while ledger_02_verify.sql could not
// execute a single statement.
//
// What happened: its overlap fixtures keyed on the real ('pick','device') and
// ('storage',null) tuples from 2026-01-01. Then ledger_06_seed_cost_rates.sql
// seeded those same two tuples, open-ended, from the same date. The first
// insert in the file is a bare statement with no exception handler, so from
// the moment ledger_06 was applied the whole script aborted on line 7 with an
// exclusion_violation and verified nothing -- while continuing to typecheck,
// to pass every assertion above, and to read as a thorough piece of work.
//
// That direction is the lucky one. The same clash inside a block whose handler
// catches exclusion_violation reports PASS without the fixture's own insert
// having been exercised at all, and no amount of reading the file reveals it,
// because the cause is in a DIFFERENT file.
//
// The key is (cost_type, coalesce(variant,'')) because that is what
// cost_rates_no_overlap and the unique index actually group on -- not cost_type
// alone. ledger_04_verify.sql shares the cost_type 'pick' quite legitimately,
// under the fresh variants 'VERIFY-A' and 'VERIFY-B', and a cost_type-only
// check would condemn it.
//
// DELIBERATELY STRICTER THAN THE DATABASE: it ignores effective_from, so a
// fixture sharing a group but sitting in a non-overlapping window (2098, as
// ledger_04_verify.sql does with ('pick', null)) would still be refused here.
// Dates are the fragile half of that reasoning -- they are what a later edit
// moves without thinking -- and a verify fixture has no reason to want a
// seeded key. To satisfy this check, give the fixture its own synthetic
// cost_type or its own variant, as 'overlap_probe' and 'basis_probe' do.
// ---------------------------------------------------------------------------
describe('verify fixtures do not collide with seeded cost rates', () => {
  const SEED = `${DIR}/ledger_06_seed_cost_rates.sql`

  /**
   * The (cost_type, variant) pairs written by every `insert into cost_rates`
   * in a file, variant-null normalised to '' exactly as the constraint does.
   *
   * Scoped to `insert into cost_rates ... ;` regions so that a tuple belonging
   * to some other table cannot be read as a rate. Both callers below assert on
   * what this returns before trusting it: a regex over SQL that quietly
   * matched nothing would turn this whole describe into the vacuous pass these
   * files keep warning about.
   */
  function costRateGroups(sql: string): Set<string> {
    const out = new Set<string>()
    for (const stmt of sql.match(/insert\s+into\s+cost_rates\b[\s\S]*?;/gi) ?? []) {
      const at = stmt.search(/\bvalues\b/i)
      if (at < 0) continue
      // `null\b`, NOT `(?:...|null)\b`. The word boundary has to live inside
      // the null branch: after the closing quote of a variant the next
      // character is a comma, and `\b` between two non-word characters does
      // not match. Written the other way this found only the null-variant
      // rows -- which is to say it found the seed file's ('pack', null) and
      // ('storage', null) and nothing else, and the two instrumentation tests
      // above are the only reason that was noticed rather than shipped as a
      // check that silently examined a third of its input.
      for (const m of stmt.slice(at).matchAll(/\(\s*'([^']*)'\s*,\s*(?:'([^']*)'|null\b)/gi)) {
        out.add(`${m[1]} ${m[2] ?? ''}`)
      }
    }
    return out
  }

  const show = (g: string) => {
    const [type, variant] = g.split(' ')
    return `('${type}', ${variant === '' ? 'null' : `'${variant}'`})`
  }

  const seeded = costRateGroups(
    stripFullLineComments(readFileSync(SEED, 'utf8')))

  it('parsed the seed file it is comparing against', () => {
    // Exactly six, named. ledger_06 seeds six rows; if a seventh is added or
    // the file is reshaped so the parser stops finding them, this fails and
    // asks to be updated rather than letting the comparison below shrink to
    // nothing and keep passing.
    expect([...seeded].map(show).sort(), `Parsed ${seeded.size} rate group(s) `
      + `from ${SEED}, expected the six it seeds. Either a rate was added -- in `
      + 'which case extend this list and check no verify fixture already uses '
      + 'it -- or the insert was reformatted past what costRateGroups can read, '
      + 'and this check is no longer comparing against anything.')
      .toEqual([
        "('material', 'box_medium')",
        "('material', 'box_small')",
        "('pack', null)",
        "('pick', 'component')",
        "('pick', 'device')",
        "('storage', null)",
      ])
  })

  it('parsed the verify fixtures it is checking', () => {
    // Two anchors from two different files, so a parser that worked on the
    // seed file but not on the fixtures cannot hide. ledger_04_verify.sql's
    // 'pick'/'VERIFY-A' is the load-bearing one: it proves the key is the
    // (cost_type, variant) pair, since cost_type alone would reject it.
    const all = new Set<string>()
    for (const f of VERIFY) {
      for (const g of costRateGroups(
        stripFullLineComments(readFileSync(`${VERIFY_DIR}/${f}`, 'utf8')))) {
        all.add(g)
      }
    }
    expect([...all].map(show).sort(), 'Found no recognisable cost_rates '
      + `fixtures across ${VERIFY.length} verify script(s). The collision check `
      + 'below would then compare an empty set and pass unconditionally.')
      .toContain("('overlap_probe', 'device')")
    expect([...all].map(show).sort()).toContain("('pick', 'VERIFY-A')")
  })

  for (const file of VERIFY) {
    it(`${file}: no fixture keyed on a seeded rate`, () => {
      const groups = costRateGroups(
        stripFullLineComments(readFileSync(`${VERIFY_DIR}/${file}`, 'utf8')))
      const clashes = [...groups].filter((g) => seeded.has(g)).map(show).sort()
      expect(clashes, `${file} inserts cost_rates rows keyed on `
        + `${clashes.join(', ')}, which ${SEED} also seeds. Depending on where `
        + 'the insert sits, this either aborts the script with an '
        + 'exclusion_violation before it asserts anything, or -- inside a block '
        + 'that handles exclusion_violation -- reports PASS without the insert '
        + 'under test having run. Give the fixture a synthetic cost_type or its '
        + 'own variant instead.')
        .toEqual([])
    })
  }
})
