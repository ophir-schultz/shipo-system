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
