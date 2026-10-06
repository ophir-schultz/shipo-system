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

/**
 * A screen's whole payload: either usable data, or the reason there is none.
 *
 * This exists because of a gap in how the rest of this file can be checked.
 * `read` and `readErrors` are in a .ts and carry tests, but the thing that
 * actually goes wrong is one line of JSX in a page:
 *
 *     <BillingView data={data} />            // and no branch on the error
 *
 * which is not a type error, is not reachable by vitest (vitest.config.ts
 * includes only `src/**\/*.test.ts`, so a page component cannot be given a test
 * at all), and looks completely normal in review. Every page in this sweep is
 * one deleted ternary away from silently going back to invoicing from a blind
 * read.
 *
 * The `ok: boolean` literal is what closes it. It makes the union
 * discriminated, so TypeScript narrows `data` to `undefined` until the page has
 * checked -- and passing `T | undefined` to a component that requires `T` is
 * TS2345. Deleting the check stops compiling, which is a stronger guarantee
 * than a test for this particular regression and the only one available on a
 * .tsx. `ok` is redundant with `error !== null` to a human and is carried
 * anyway: a `string | null` discriminant does NOT narrow (probed -- all three
 * correct forms failed), so the redundancy is the entire mechanism.
 *
 * Narrowing works through `l.ok`, through `l.error !== null`, and through
 * destructuring `const { ok, data } = l`.
 */
export type Loaded<T> =
  | { ok: false; error: string; data?: undefined }
  | { ok: true; error: null; data: T }

/**
 * The data arm of a `Loaded`, so a page can annotate it and keep the gate.
 *
 * Needed because `Loaded` only gates a page whose component props are typed.
 * `BillingView` and `ReportsTabs` used to take `{ data: any }`, and
 * `T | undefined` is assignable to `any`, so on those two pages deleting the
 * check compiled perfectly happily -- which I only found by deleting it and
 * watching tsc pass on two of the three pages I had just claimed were
 * protected. Both now declare real payload types (`BillingData`,
 * `ReportsData`), so the prop itself rejects `undefined` and the gate holds on
 * all three; this type stays because it is what made those two safe in the
 * interim and because the next `any`-propped component will need it again.
 *
 * Writing the narrowed value into an annotated local puts the check back:
 *
 *     if (!billing.ok) return <ViewUnreadable message={billing.error} />
 *     const data: LoadedData<typeof billing> = billing.data
 *
 * Delete the `if` and the annotation rejects the now-possibly-undefined value
 * (TS2322) before it ever reaches the prop. Derived from the Loaded rather
 * than spelled out a second time, so it cannot drift away from the payload it
 * is describing.
 */
export type LoadedData<L> = L extends { ok: true; data: infer T } ? T : never

/**
 * Build a page payload from the combined verdict of its reads.
 *
 * `build` is a thunk, not a value, and that is deliberate: on the failure path
 * it is never called. Most of these pages do real work between the rows and the
 * screen -- pnl aggregates six tables into per-client margin, referrals runs
 * computeOwed over partners x invoices x payouts -- and running that over `[]`
 * produces a complete set of plausible figures that then have to be thrown
 * away. Not computing them means there is no moment at which a $0.00 margin for
 * every client exists in the program to be accidentally rendered, logged or
 * exported.
 *
 * Treats '' as success, matching readErrors, which filters empty reasons out
 * for the same reason: a blank red box blanks a figure and says nothing about
 * why.
 */
export function loaded<T>(error: string | null, build: () => T): Loaded<T> {
  if (error !== null && error !== '') return { ok: false, error }
  return { ok: true, error: null, data: build() }
}

/**
 * An embedded relation, whose cardinality nobody here can prove.
 *
 * `.select('order_number, clients(name)')` is a PostgREST embed. For a
 * many-to-one -- a shipment has ONE client -- PostgREST returns an object, and
 * all fourteen consumers of a `clients(name)` join in this repo read it that
 * way (`s.clients?.name`): dashboard/page.tsx, the Excel download route,
 * warehouse/page.tsx, ShipmentsTable, AdjustmentsClient, and the five sites in
 * ReportsTabs. The Excel route demonstrably produces client names in a shipped
 * spreadsheet, which is the strongest evidence available that the object
 * reading is the correct one.
 *
 * Against that: supabase-js parses the select STRING at compile time and types
 * this embed as `{ name: any }[]` -- an array. It is not reading the database
 * either; it defaults to array whenever it cannot see the foreign key, so its
 * guess is a guess. Neither position has been checked against the live DB.
 *
 * The honest move is not to pick. A type assertion here would be a lie that
 * compiles: if the array guess is the right one, `e.name` is `undefined` and
 * every client column on /reports silently renders a dash forever -- which is
 * exactly the failure mode `data: any` was hiding on this page. Accepting both
 * shapes costs one `Array.isArray` and cannot be wrong in either direction.
 */
export type Embed<T> = T | T[] | null

/**
 * The one row of an embed, whichever shape PostgREST sent.
 *
 * `[]` folds to null rather than throwing: an embed with no match is an
 * absence, not a failure, and the caller's `?? '—'` is already the right
 * rendering for it. `e[0] ?? null` rather than `e[0]` so a sparse or
 * null-headed array cannot hand back `undefined` and defeat a `=== null` check
 * at the call site.
 *
 * The `e === null` arm of the guard is redundant and kept anyway: `Array
 * .isArray(null)` is false, so a null embed already falls through and returns
 * itself. Removing it survives the whole test suite because no input can
 * distinguish the two -- an equivalent mutant, not a gap. It is spelled out
 * because the guard is what the reader is being asked to trust, and a guard
 * that handles two cases by handling one of them accidentally is worse
 * documentation than a redundant line.
 *
 * Assumes the embedded thing is a row, not itself an array. `Embed<string[]>`
 * would unwrap the wrong level. Every embed in this app is `table(cols)`, so
 * this has not been parameterised away.
 */
export function embedOne<T>(e: Embed<T> | undefined): T | null {
  if (e === null || e === undefined) return null
  return Array.isArray(e) ? (e[0] ?? null) : e
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
