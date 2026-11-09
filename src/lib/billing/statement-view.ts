import { priceOf, totalOrUnknown, UNPRICED_CELL, UNPRICED_DASH } from '@/lib/billing/unpriced'
import { isGrain, type DateRange, type Grain, type Statement, type StatementLine } from '@/lib/billing/statement'

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
 *   'see amount' the line has no single rate to print. The amount column is
 *                the charge. The statement does not say the charge is our cost.
 *   'N rates'   the rate changed inside the period, so no single number is
 *               true of the whole line. Says how many rather than picking one.
 *   the dash    we hold a rate for some rows and could not read it. Unknown,
 *               and it uses the same dash as every other unknown figure in the
 *               app so it reads as one.
 */
/** Rate column when the line has no single rate. Not a disclosure of our cost. */
export const PASS_THROUGH_RATE = 'see amount'

export function rateText(line: Pick<StatementLine, 'unit_rate' | 'rates'>): string {
  if (line.unit_rate !== null) {
    return `$${line.unit_rate.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
  }
  if (line.rates === 0) return PASS_THROUGH_RATE
  if (line.rates > 1) return `${line.rates} rates`
  // rates === 1 with a null unit_rate cannot happen -- buildStatement sets the
  // rate exactly when the count is 1 -- so this is the unreachable arm, and it
  // returns the unknown dash rather than asserting either of the two sentences
  // above about a state neither of them describes.
  return UNPRICED_DASH
}

/**
 * Rate cell on one charge row.
 *
 * A known amount with no single unit rate is the same fact the summary
 * prints as "see amount": Nayax pick rows store the price-list total and
 * leave the unit rate empty because one order mixes a carton rate and an
 * accessory rate. A shipping row keeps its ledger amount when no zone
 * client price replaces it. Neither case is an unknown charge, and neither
 * case is filled from carrier cost. Dividing the amount by the quantity
 * would invent a rate the list did not state.
 *
 * UNPRICED is only for a row whose amount is itself unknown.
 */
export function chargeRateCell(row: { unit_rate: unknown; amount: unknown }): number | string {
  const rate = priceOf(row.unit_rate)
  if (rate !== null) return rate
  if (priceOf(row.amount) !== null) return PASS_THROUGH_RATE
  return UNPRICED_CELL
}

/**
 * The period, written the way an invoice period is written.
 *
 * ISO dates and not a localised format. This string gets copied into an email
 * beside an amount, and '10/13/2026' means two different days depending on who
 * reads it -- the client is in Germany and so is the operator.
 *
 * `grain` is nullable because a period can now arrive as two explicit dates
 * (resolvePeriod), and such a range is NOT a calendar period even when it
 * happens to coincide with one. Printing `(month)` beside an explicitly-asked
 * 2026-10-01..2026-10-31 would state how the figure was derived, and the claim
 * would be false the next time someone asks for the 1st to the 30th. The dates
 * themselves are the whole truth available, so they are all that is printed.
 */
export function periodLabel(grain: Grain | null, range: DateRange): string {
  if (range.from === range.to) return range.from
  const span = `${range.from} to ${range.to}`
  return grain === null ? span : `${span} (${grain})`
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
export function coverageNote(
  earliest: string | null,
  range: DateRange,
  shownLines = 0,
): string {
  // Charge rows already on the statement — ledger lines or shipment prices
  // for this period — are the figures. A "no charges" sentence beside them
  // contradicts the total. Creative Pea, with no rows, still gets the note.
  if (shownLines > 0) {
    if (earliest === null || earliest > range.to) return ''
  }
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

export const COMPLETE_SUBTOTAL_LABEL = 'Subtotal'
export const PARTIAL_SUBTOTAL_LABEL = 'Known subtotal (partial)'
export const AMOUNT_DUE_LABEL = 'Amount due'
/** A known sum exists, and a missing charge means it is not the bill. */
export const AMOUNT_DUE_NOT_FINAL = 'not final'
/** No known charge amount, or every counted charge is missing. Not $0. */
export const AMOUNT_UNKNOWN = 'unknown'

export interface StatementFigures {
  /** Priced charges only. Null when every counted charge has no amount. */
  knownSubtotal: number | null
  /** A charge amount is missing. The known sum is not the period. */
  partial: boolean
  subtotalLabel: string
  /**
   * What could be billed. Null when a charge amount is missing, or when the
   * known subtotal itself is unknown. A monthly-minimum top-up is included
   * only when the period is fully priced and the minimum applies.
   */
  amountDue: number | null
}

/** Lines with no price, split by charge type so pick lines and shipping lines are not one order count. */
export function unpricedLinesNote(
  lines: readonly { charge_type: string; sum: { unpriced: number } }[],
): string {
  const byType = new Map<string, number>()
  for (const line of lines) {
    if (line.sum.unpriced <= 0) continue
    byType.set(line.charge_type, (byType.get(line.charge_type) ?? 0) + line.sum.unpriced)
  }
  const counts = [...byType.entries()]
  const total = counts.reduce((sum, [, count]) => sum + count, 0)
  if (total <= 0) return ''
  const parts = counts.map(([type, count]) => `${count} ${type}`)
  return `${total} lines have no price (${parts.join(' and ')}). That count is lines, not orders. They are not included`
}

/**
 * Subtotal and amount due for one statement.
 *
 * A missing charge amount is not $0 and is not dropped from the bill. The
 * dollars that were read stay visible, labeled partial. Amount due stays
 * unfinished. A unit rate that was never stored does not make a known amount
 * partial: that case is "see amount", and the amount is in the sum.
 *
 * A priced zero is a real zero. An empty period is $0. A full calendar month
 * whose every amount is known still takes the monthly minimum.
 */
export function statementFigures(
  statement: Pick<Statement, 'sum'>,
  minimum: { applies: boolean; totalCents: number | null },
): StatementFigures {
  const partial = statement.sum.unpriced > 0
  const knownSubtotal = partial && statement.sum.unpriced === statement.sum.counted
    ? null
    : totalOrUnknown(statement.sum)
  if (partial) {
    return {
      knownSubtotal,
      partial: true,
      subtotalLabel: PARTIAL_SUBTOTAL_LABEL,
      amountDue: null,
    }
  }
  const amountDue = minimum.applies && minimum.totalCents !== null
    ? minimum.totalCents / 100
    : knownSubtotal
  return {
    knownSubtotal,
    partial: false,
    subtotalLabel: COMPLETE_SUBTOTAL_LABEL,
    amountDue,
  }
}

/** The amount-due cell. A number, "not final", or "unknown". Never a guessed total. */
export function statementAmountDueCell(figures: StatementFigures): number | typeof AMOUNT_DUE_NOT_FINAL | typeof AMOUNT_UNKNOWN {
  if (figures.amountDue !== null) return figures.amountDue
  if (figures.partial && figures.knownSubtotal !== null) return AMOUNT_DUE_NOT_FINAL
  return AMOUNT_UNKNOWN
}
