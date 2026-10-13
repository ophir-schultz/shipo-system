import { UNPRICED_DASH } from '@/lib/billing/unpriced'
import { isGrain, type DateRange, type Grain, type StatementLine } from '@/lib/billing/statement'

// The sentences the statement screen prints about its own figures.
//
// These live in a .ts and not in the page because vitest.config.ts collects only
// `src/**/*.test.ts`: logic inside a .tsx cannot be given a test. And every
// function here is a CLAIM about money a client is about to be invoiced for --
// what rate a line was priced at, whether the period is fully covered, whether
// a figure was measured or assumed. The same reason date-range.ts and
// summary.ts's label helpers are not inline either.

/**
 * What to print in the Rate column.
 *
 * Four decimals, matching ledger/page.tsx's fmtRate and the numeric(10,4) the
 * rate actually is: $0.2300 and $0.2000 rounded to two decimals read as the
 * same number at a glance, and these are per-unit rates multiplied by thousands
 * of picks.
 *
 * The three non-numeric answers are deliberately different sentences, because
 * they are three different facts and a shared dash would merge them:
 *
 *   'at cost'   the line has no rate-card rate by design -- at-cost freight is
 *               billed at whatever the carrier charged.
 *   'N rates'   the rate changed inside the period, so no single number is
 *               true of the whole line. Says how many rather than picking one.
 *   the dash    we hold a rate for some rows and could not read it. Unknown,
 *               and it uses the same dash as every other unknown figure in the
 *               app so it reads as one.
 */
export function rateText(line: Pick<StatementLine, 'unit_rate' | 'rates'>): string {
  if (line.unit_rate !== null) {
    return `$${line.unit_rate.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
  }
  if (line.rates === 0) return 'at cost'
  if (line.rates > 1) return `${line.rates} rates`
  // rates === 1 with a null unit_rate cannot happen -- buildStatement sets the
  // rate exactly when the count is 1 -- so this is the unreachable arm, and it
  // returns the unknown dash rather than asserting either of the two sentences
  // above about a state neither of them describes.
  return UNPRICED_DASH
}

/**
 * The period, written the way an invoice period is written.
 *
 * ISO dates and not a localised format. This string gets copied into an email
 * beside an amount, and '10/13/2026' means two different days depending on who
 * reads it -- the client is in Germany and so is the operator.
 */
export function periodLabel(grain: Grain, range: DateRange): string {
  if (range.from === range.to) return range.from
  return `${range.from} to ${range.to} (${grain})`
}

/** The grain in effect, and what to say if it is not the one that was asked for. */
export interface GrainChoice {
  grain: Grain
  /** A sentence naming what was asked for and what is shown instead, or ''. */
  note: string
}

/**
 * Which period the figures describe, given what the query string asked for.
 *
 * The note is the whole reason this is a function. An unrecognised `?grain=`
 * has to fall back to something, and a SILENT fallback is the worst available
 * outcome: a link written `?grain=weekly` -- or `?grain=quarter`, or a grain
 * this app adds later and an old bookmark predates -- would render a MONTH of
 * revenue under whatever heading the reader expected, and a month read as a
 * week is a figure four times too big arriving with no indication that anything
 * was substituted.
 *
 * So the fallback is reported, naming the rejected value back to the reader
 * rather than just the one being used: 'showing the month' alone does not tell
 * anyone that the link they followed was wrong, and it is the link that needs
 * fixing.
 *
 * A missing grain is NOT a note. Arriving at /statements with no query string
 * is the ordinary way in, not a mistake, and a caveat on the default view is
 * the caveat that teaches everyone to ignore caveats -- same rule as
 * coverageNote and unpricedNote.
 */
export function grainChoice(asked: string | null | undefined, fallback: Grain): GrainChoice {
  if (isGrain(asked)) return { grain: asked, note: '' }
  if (asked === null || asked === undefined || asked === '') {
    return { grain: fallback, note: '' }
  }
  return {
    grain: fallback,
    note: `'${asked}' is not a period this statement knows, so these figures `
      + `are for the ${fallback}. The link that asked for '${asked}' is wrong.`,
  }
}

/**
 * What the statement knows about whether this period is fully covered, or ''.
 *
 * The figures above a note like this are a correct sum over the rows the ledger
 * holds. That is NOT the same as a correct sum over the work that happened, and
 * nothing in a total can tell the two apart: a month before the ledger started
 * running sums to a confident $0.00, which reads as "this client did nothing"
 * rather than "we have no record".
 *
 * Deliberately states a FACT and not a cause. "No charge is recorded before X"
 * is true whether the ledger was not running or the client genuinely had no
 * activity; claiming either one would be asserting something this function
 * cannot see. The operator can tell which, and the sentence gives them the date
 * to ask about.
 *
 * Returns '' when the period starts at or after the earliest charge, because a
 * caveat printed on every statement is a caveat nobody reads -- same rule as
 * unpricedNote and undatedNote.
 */
export function coverageNote(earliest: string | null, range: DateRange): string {
  if (earliest === null) {
    return 'The ledger holds no charges for this client on any date, so the '
      + 'figures above are a sum over nothing rather than a quiet period.'
  }
  if (earliest > range.to) {
    return `The ledger's earliest charge for this client is ${earliest}, which `
      + `is after this period ends. Nothing above was read from this period.`
  }
  if (earliest > range.from) {
    return `No charge for this client is recorded before ${earliest}, so the `
      + `figures above cover ${earliest} to ${range.to} and not the whole period.`
  }
  return ''
}

/**
 * The sentence naming how much of this statement is an estimate rather than a
 * measurement, or ''.
 *
 * `is_estimate` means the ledger priced the line off an assumed rate because the
 * real one was not available (calculate-charges.ts). That is a figure which can
 * still move, and a client who is invoiced from it and then re-invoiced has to
 * be told why. Shaped to sit beside unpricedNote, which it appears next to.
 */
export function estimateNote(estimated: number): string {
  if (estimated <= 0) return ''
  return `${estimated} ${estimated === 1 ? 'charge' : 'charges'} priced from an `
    + `assumed rate, not a measured one`
}
