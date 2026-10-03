// What the read-only diagnostic scripts do when a read fails.
//
// These scripts exist to answer questions like "how many shipments are
// unpriced" and "which clients have no rate card", and their output is read by
// a person who was not watching the terminal. Every one of them used to
// destructure `{ data }` and carry on, so a read that never happened arrived in
// the output as an empty array -- which renders as 0, "none at all", "NOT IN
// CHART", "no rate cell". Those are not neutral blanks; they are the most
// alarming answer each question has, produced by the script failing rather than
// by the data, and they look exactly like a clean result.
//
// So: a failed read is UNKNOWN. Same doctrine as src/lib/billing/recalculate.ts,
// which writes NULL rather than a price it cannot stand behind, and the same
// distinction the monitor's scan draws -- NULL is "we do not know", 0 is "a
// decision somebody made". A diagnostic that prints 0 for an unanswered query
// has converted the first into the second.
//
// Two responses, and which one a read gets depends on how much of the output
// leans on it:
//   - refuse (exit 1) for a read the whole report is computed from. Printing
//     the remaining sections would mean printing numbers over a population the
//     script could not read.
//   - UNKNOWN for a per-item read. One client's unreadable rate card should not
//     throw away the other clients' rows, but it must not be rendered as an
//     empty card either -- an empty card and an unread card lead an operator to
//     opposite actions.
//
// `readFailure` is kept pure and separate from the `process.exit()` around it so
// the decision can be unit-tested; see src/lib/billing/read-or-refuse.test.ts.

/** What a failed-but-not-fatal read renders as. Never 0, never a blank. */
export const UNKNOWN = 'UNKNOWN'

/**
 * Why this PostgREST result cannot be used, or null if it can.
 *
 * `want` says what the caller asked the query for, because "data is null" means
 * different things depending on that and guessing wrong is a false alarm in one
 * direction and a missed one in the other:
 *
 *   'rows'  — a `.select()` for rows. A genuinely empty table answers `[]`, so
 *             a null here means the read did not happen.
 *   'count' — a `{ count: 'exact', head: true }` read. `data` is legitimately
 *             null for these (no rows were asked for), so checking it would
 *             fire on every successful count. The count itself is the payload.
 *   'maybe' — a `.maybeSingle()`. A null `data` is the ordinary "no such row"
 *             answer, which is usually the finding being reported, so only an
 *             explicit error counts as a failure.
 */
export function readFailure(res, { want = 'rows' } = {}) {
  if (!res || typeof res !== 'object') return 'no response object'
  if (res.error) {
    // PostgREST errors are not guaranteed to carry a message -- a transport
    // failure can arrive with only a code -- and `undefined` interpolated into
    // a refusal message is the sort of thing that gets read as "no reason
    // given, probably fine".
    const e = res.error
    return e.message || e.details || e.hint || `read failed (code ${e.code ?? 'absent'})`
  }
  if (want === 'count') {
    return res.count == null ? 'no count returned and no error given' : null
  }
  if (want === 'maybe') return null
  return res.data == null ? 'no rows returned and no error given' : null
}

const DEFAULT_INSTEAD =
  'Stopping here rather than printing the rest, which would describe a '
  + 'population this run could not read. Fix the read and re-run.'

/**
 * Stops the run, naming the read that failed and what was therefore not done.
 *
 * Exits non-zero so a cron or a shell pipeline sees the failure; several of
 * these scripts have their stdout redirected, and a refusal that only showed up
 * as a missing section would be invisible.
 */
export function refuse(what, why, { instead } = {}) {
  console.error(
    // Deliberately not "refusing to report" or "refusing to write": the callers
    // do both, and `instead` is where each says which.
    `\n!! REFUSING: ${what} failed -- ${why}.`
    + `\n   ${instead ?? DEFAULT_INSTEAD}`
  )
  process.exit(1)
}

/**
 * Returns the result untouched, or refuses. The whole result, not `res.data`,
 * so a caller that also asked for `{ count: 'exact' }` can still compare the
 * two and notice a capped read.
 */
export function mustRead(what, res, opts = {}) {
  const why = readFailure(res, opts)
  if (why) refuse(what, why, opts)
  return res
}

/** Same, for a count-only read. Returns the count. */
export function mustCount(what, res, opts = {}) {
  return mustRead(what, res, { ...opts, want: 'count' }).count
}

/**
 * Collects the per-item reads that failed, so they can be reported once at the
 * end instead of as a line lost in the middle of the output.
 *
 * A factory rather than module state: two of these scripts have more than one
 * independent group of soft reads, and a shared list would merge them.
 */
export function unknownLog() {
  const failures = []
  return {
    /**
     * Records a failed read and returns `{ ok: false, value: null, why }`;
     * on success returns `{ ok: true, value }`.
     *
     * The flag is returned rather than just a null value because for a
     * `.maybeSingle()` read the two are different findings: null-and-ok is "no
     * such row", which is often the answer the script is looking for, and
     * null-and-not-ok is "we did not find out".
     */
    soft(what, res, opts = {}) {
      const why = readFailure(res, opts)
      if (why) {
        failures.push({ what, why })
        return { ok: false, value: null, why }
      }
      return { ok: true, value: opts.want === 'count' ? res.count : res.data, why: null }
    },
    get length() { return failures.length },
    /** The failures, for a caller that wants to phrase the tail itself. */
    list() { return failures.slice() },
    /**
     * Prints the tail on stderr, if there is one. On stderr because stdout is
     * routinely redirected to a file and this is the line that says the file
     * has holes in it.
     */
    tail(what = 'reads') {
      if (!failures.length) return
      console.error(
        `\n!! ${failures.length} ${what} failed and are reported as ${UNKNOWN} above, `
        + `not as zero or absent:`
      )
      for (const f of failures) console.error(`     - ${f.what}: ${f.why}`)
      console.error(
        `   An ${UNKNOWN} is not a finding. Re-run before concluding anything `
        + `from the rows it would have covered.`
      )
    },
  }
}
