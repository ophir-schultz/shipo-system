// Turning a PostgREST result into something a screen is allowed to make a
// claim about.
//
// The shape these replace is `const { data } = await supabaseAdmin...; return
// data ?? []`, which appears all over this app and is wrong in one specific
// direction: it maps a FAILED read onto the same value as an EMPTY one. Every
// empty state in the UI is then a claim made on no evidence --
//
//   "No warehouse rates yet · Upload a CSV or add rates manually"
//
// -- printed over a rate card sitting in the table intact, because the
// connection dropped for one second. Acting on that sentence means re-uploading
// a negotiated rate card from whatever file is to hand, so the degraded case is
// not merely uninformative; it instructs you to destroy data.
//
// These live in a plain .ts, not inside the page that uses them, because
// vitest.config.ts includes only `src/**/*.test.ts`: logic inside a .tsx cannot
// be given a test, and this is the logic that decides whether the screen is
// entitled to say "there is nothing here".

export interface PostgrestLike<T> {
  data: T | null
  error: { message: string; code?: string } | null
}

/** Rows, or the reason there are none -- never the two collapsed together. */
export interface Read<T> {
  rows: T[]
  /** null = the read succeeded. A message = it did not, so `rows` means nothing. */
  error: string | null
}

/**
 * A list read.
 *
 * `what` is prefixed to the message because a Postgres string like "relation
 * does not exist" does not say WHICH relation, and a screen with four reads on
 * it needs the reader to know which section is blind.
 */
export function read<T>(what: string, res: PostgrestLike<T[]>): Read<T> {
  if (res.error) return { rows: [], error: `${what}: ${res.error.message}` }
  return { rows: res.data ?? [], error: null }
}

/**
 * The combined verdict of every read that one figure depends on.
 *
 * Returns null when all of them succeeded, and otherwise ONE message naming
 * all of the failures. Two reasons it is not "the first error":
 *
 *   1. A figure like "revenue this week" is shipments + warehouse lines +
 *      approved manual charges. If any one of those three reads failed the
 *      figure is not LOW, it is UNKNOWN. A caller that checks only the
 *      shipments read publishes a confident number short by an unknown amount,
 *      which is the defect this whole branch exists to remove.
 *   2. An operator looking at a blind dashboard needs to know whether one
 *      table is unreachable or the whole connection is, and the first error
 *      alone cannot tell them. Same reasoning as generateWeeklyBill reporting
 *      all four of its failed reads together rather than stopping at the first.
 *
 * Deliberately `string | null` rather than a boolean: a caller holding this has
 * the reason in hand, so it can show it instead of an unexplained dash.
 */
export function readErrors(
  ...reads: ReadonlyArray<{ error: string | null } | null | undefined>
): string | null {
  const failed = reads
    .map(r => r?.error)
    .filter((e): e is string => typeof e === 'string' && e !== '')
  return failed.length === 0 ? null : failed.join('; ')
}

/**
 * Codes that all mean the same thing: the schema this query needs is not there.
 *
 * There is no migration runner in this project -- a migration is a .sql file a
 * person pastes into the Supabase editor -- so "the table does not exist yet" is
 * a NORMAL state on a fresh database, not an incident.
 *
 *   42P01     Postgres undefined_table.
 *   42703     Postgres undefined_column. The table is there but the migration
 *             that added a column to it is not. Same remedy, so same bucket;
 *             this matches the existing judgement in load-charge-inputs.ts.
 *   PGRST205  PostgREST, 404, "Caused when the table specified in the URI is
 *             not found" -- its schema cache answers before Postgres is ever
 *             asked, so this is the code supabase-js actually returns for
 *             `.from('a_table_that_does_not_exist')`. Confirmed against the
 *             PostgREST error reference, not against this database; omitting it
 *             would mean the day-one banner never appears, which is the whole
 *             reason the predicate exists.
 *
 * PGRST204 ("the column specified in the `columns` query parameter is not
 * found") is deliberately NOT here. It is a write-path code, every caller of
 * this predicate only reads, and the safe direction for an unexercised code is
 * to fall through to showing the operator the real message.
 */
const MIGRATION_MISSING_CODES: ReadonlySet<string> = new Set([
  '42P01',
  '42703',
  'PGRST205',
])

/**
 * Did this read fail because the migration has not been applied, as opposed to
 * failing for a reason retrying would fix?
 *
 * Three pages used to decide this with `const migrationApplied = !res.error`,
 * which is the error-swallowing defect wearing a different hat. It does not
 * discard the error; it MISREADS it. Every failure became "the table does not
 * exist yet", so a one-second connection drop printed
 *
 *   "⚠ Referral tables not created yet · Run supabase/referral_program.sql,
 *    then supabase/partner_portal.sql, then supabase/partner_login.sql"
 *
 * over a populated payout ledger. That is worse than an unexplained blank: it
 * is confident, specific, wrong, and the instruction it gives you is to start
 * pasting DDL at a database that is fine.
 *
 * Takes the RAW PostgREST result rather than a `Read`, which is load-bearing:
 * `read()` has already flattened the error to a string and thrown the code
 * away, so a `Read` cannot answer this question -- and because `Read.error` is
 * `string | null`, passing one here is a compile error rather than a silent
 * `false`.
 *
 * Note that a migration-missing read is STILL a failed read. `read()` will
 * report an error for it too, so a page that handles both must ask this first;
 * otherwise the yellow actionable banner is shadowed by the red one.
 */
export function isMigrationMissing(
  res: { data?: unknown; error: { code?: string } | null } | null | undefined,
): boolean {
  return MIGRATION_MISSING_CODES.has(res?.error?.code ?? '')
}

/** One row, the reason we could not read it, or neither: it is simply absent. */
export interface ReadOne<T> {
  row: T | null
  /** null = we got an answer. The answer may still be "no such row". */
  error: string | null
}

/**
 * A `.single()` read, which folds two very different outcomes into one error.
 *
 * PostgREST answers `.single()` with PGRST116 both when NO row matched and when
 * several did. For a primary-key lookup several is impossible, so the code means
 * "no such row" -- a real answer, and the only one that justifies notFound().
 * Any other error means we never got an answer at all.
 *
 * Keeping them apart is what stops a database outage from rendering the 404
 * page. A 404 on a client detail screen reads as "I deleted this client", and
 * the reasonable response to it -- re-create the client -- produces a duplicate
 * with an empty rate card.
 */
export function readOne<T>(what: string, res: PostgrestLike<T>): ReadOne<T> {
  if (res.error) {
    if (res.error.code === 'PGRST116') return { row: null, error: null }
    return { row: null, error: `${what}: ${res.error.message}` }
  }
  // data null with no error should not happen on .single(), but if it does the
  // honest reading is "absent", not "unreadable": we were given an answer.
  return { row: res.data ?? null, error: null }
}
