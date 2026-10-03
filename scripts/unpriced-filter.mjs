// Selecting the shipments nobody has priced, for the read-only diagnostics.
//
// AUTHORITY: section 4a of src/app/api/agent/monitor/route.ts. If this file and
// that scan ever disagree about which shipments are unpriced, that one is right
// and this one is a bug. It is pinned by
// src/lib/billing/unpriced-filter-parity.test.ts.
//
// WHY THIS EXISTS.
//
// src/lib/billing/recalculate.ts used to write `client_rate: 0` for a shipment
// it could not price. It now writes NULL -- see its header, which spells out
// that "a NULL does not equal 0 in SQL, so writing NULL without touching that
// scan would have switched off the only existing alarm for this exact
// condition". The monitor's scan was changed in the same commit. Seven
// diagnostics were not, and each kept selecting `.eq('client_rate', 0)`: they
// went on reporting the pre-change legacy zeros and silently omitted every
// shipment left unpriced since. One of them WRITES docs/rate-card-worklist.md,
// so the omission reached an operator worklist.
//
// Same shape as the four copies of the weight rule that commit 064bd0d
// collapsed into scripts/zone-weight.mjs: a diagnostic quietly disagreeing with
// the live biller about which shipments it is describing. So the predicate is
// in one place this time rather than seven.
//
// WHY BOTH CONDITIONS, AND WHY THE TWO ARE NOT MERGED.
//
// The monitor matches NULL and 0, and it runs them as two counts with two
// different messages. That distinction is not cosmetic -- the two values get
// into the column by different routes and mean different things:
//
//   NULL -> the rate card does not cover this shipment. Written by
//           recalculate.ts today. Unambiguous.
//   0    -> EITHER a row last priced before unknown became NULL (a legacy zero,
//           i.e. the same finding as NULL but undated), OR a rate card that
//           genuinely says the shipping is free. Nothing in the column tells
//           the two apart.
//
// Legacy zeros still exist in the table and are themselves a finding worth
// keeping visible, so both are selected. But a merged total would assert that
// every one of them is an uncovered shipment, which is exactly the kind of
// confident wrong number these scripts exist to find. Callers get the split and
// print both.
//
// Classification reuses `priceOf` from src/lib/billing/unpriced.ts -- the real
// module the app reads this column with -- rather than restating `== null`.
// That module is pure and imports nothing, so Node's type stripping loads it
// with no tsconfig `paths` alias to resolve. (scripts/zone-weight.mjs explains
// at length why zones.ts cannot be imported the same way.) It also already
// handles the shape this column actually arrives in: `numeric(10,2)` comes over
// PostgREST as the quoted string '0.00', which `=== 0` would miss.
import { priceOf } from '../src/lib/billing/unpriced.ts'

/**
 * The PostgREST disjunction naming both unpriced conditions, for `.or()`.
 *
 * `.is('client_rate', null).eq('client_rate', 0)` would be an AND and match
 * nothing at all. The repo already spells a disjunction this way in
 * src/lib/ledger/load-charge-inputs.ts.
 *
 * Combines with other filters as a single AND'd group, so the callers' existing
 * `.not('client_id', 'is', null)` keeps its meaning.
 */
export const UNPRICED_OR = 'client_rate.is.null,client_rate.eq.0'

/**
 * The two halves of `UNPRICED_OR` as separate narrowings, for a caller that
 * needs them as distinct queries rather than one union.
 *
 * They exist so that such a caller does not restate the column and operator --
 * the whole failure this file is fixing was seven scripts each carrying their
 * own copy of this predicate. The only current user is
 * scripts/diag-zonelookup.mjs, which samples a handful of rows: PostgREST
 * promises no ordering, so a `limit(5)` over the union could come back all of
 * one kind and say nothing about the other.
 */
export const onlyNoRate = (q) => q.is('client_rate', null)
export const onlyZeroRate = (q) => q.eq('client_rate', 0)

/** `client_rate IS NULL`: the rate card does not cover this shipment. */
export const NO_RATE = 'NO RATE'

/** `client_rate = 0`: a legacy zero, or a card that says free. */
export const ZERO_RATE = 'ZERO'

/**
 * Which of the two a selected row is, as NO_RATE or ZERO_RATE.
 *
 * Takes the ROW, not the value, so that a missing column can be told from a
 * NULL one. Most of these scripts name their columns in `.select()`, and a row
 * that never selected `client_rate` would answer `undefined` -- which `priceOf`
 * correctly reads as UNKNOWN, and which would therefore file every legacy zero
 * in the table under NO_RATE. A silently-wrong split is worse than no split, so
 * it throws instead.
 */
export function rateKind(row) {
  if (!row || typeof row !== 'object' || !('client_rate' in row)) {
    throw new Error(
      'rateKind: row has no `client_rate` property. Add it to the .select() '
      + 'list -- a column that was never read is not a NULL price, and '
      + 'treating it as one files every legacy zero under NO RATE.'
    )
  }
  return priceOf(row.client_rate) === null ? NO_RATE : ZERO_RATE
}

/**
 * The selected rows split by how they got there.
 *
 * `all` is kept so callers can still analyse the union -- a rate-card gap is
 * diagnosed the same way whichever value is stored -- while having the two
 * counts in hand to report.
 */
export function splitUnpriced(rows) {
  const all = rows ?? []
  const noRate = []
  const zero = []
  for (const row of all) {
    if (rateKind(row) === NO_RATE) noRate.push(row)
    else zero.push(row)
  }
  return { all, noRate, zero }
}

/**
 * The population described in lines, naming both counts and what each means.
 *
 * Returned as lines rather than printed so the one script that emits markdown
 * can embed the same wording it would have printed.
 */
export function unpricedLines(split, { indent = '  ' } = {}) {
  const lines = [
    `unpriced shipments (client assigned, client_rate NULL or 0): ${split.all.length}`,
  ]
  lines.push(
    `${indent}${String(split.noRate.length).padStart(4)} with client_rate NULL `
    + `— the rate card does not cover them; they are not $0`
  )
  lines.push(
    `${indent}${String(split.zero.length).padStart(4)} rated exactly $0 `
    + `— either a card that says free, or a row last priced before unknown became NULL`
  )
  return lines
}

/** `unpricedLines` as one printable block. */
export function unpricedSummary(split, opts) {
  return unpricedLines(split, opts).join('\n')
}

/** '33 (27 NULL + 6 $0)', for a heading that has room for one figure. */
export function unpricedCount(split) {
  return `${split.all.length} (${split.noRate.length} NULL + ${split.zero.length} $0)`
}
