// Every client a partner referred, earning or not. Spec §4.1.
//
// THE DEFECT THIS FIXES. The statement rendered monthly earnings, and a
// month exists only once a client has paid. So a partner who had referred
// a client that signed last week saw "No statement yet — nothing is
// missing", about a client he had personally brought in. Ophir's words:
// "How can i add a partner i dont see the option to add more of my
// clients". The clients were in the database the whole time; the screen
// could only show the ones with money attached.
//
// So this module answers a different question from the statement: not
// "what are you owed" but "who have you referred, and where does each one
// stand". A client with no revenue has a state, not a zero.
//
// THE DATES ARE HAND-TYPED. `referral_signup_date` and
// `referral_first_payment_date` are both set by staff, in a form, with no
// validation between them. So all four nonsense combinations arrive here:
// no signup date, no payment date, a payment date before the signup date,
// and a payment date in the future. None of them may render as a verdict
// on the partner's earnings — and the dangerous one is "window closed",
// because a partner told the window is over stops asking.
//
// ONE PIECE OF DATE ARITHMETIC. `windowPosition` is built on
// referrals.ts's `monthIndex`, the same function `computeOwed` uses to
// decide whether a month's commission is owed. A second implementation
// would eventually disagree about a boundary month, and then the screen
// would name a window the payout does not honour.

import { REFERRAL_TERMS, isoDay, monthIndex, type ReferredClient } from './referrals'

export type RosterState = 'awaiting_first_payment' | 'earning' | 'window_closed'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * 'December 2026' for '2026-12' or '2026-12-31'.
 *
 * THE ONLY month-name list in src. Statement.tsx had its own copy
 * (`MONTH_NAMES` + `prettyPeriod`), and the window's closing month now
 * renders in the same table as the month headings — two formatters there
 * would eventually print one month two ways on one screen.
 *
 * Parsed by SLICING, never by `new Date(s)`: a date-only string is parsed
 * as UTC midnight and printed in the viewer's zone, so the 1st of a month
 * renders as the last day of the previous one for anybody west of
 * Greenwich. These are the months a partner checks his window against.
 *
 * Anything unparseable comes back unchanged, which matters for one real
 * value: `computeOwed` writes the literal period `'awaiting'` on an
 * unreleased bonus. 'undefined NaN' and a defaulted January would both
 * read as a month he could check.
 */
export function prettyMonth(period: string): string {
  const [y, m] = period.slice(0, 7).split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return period
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * A 'YYYY-MM-DD' column value as '5 January 2026', or '—' for absent.
 *
 * Shares `prettyMonth`'s month list and its parse-by-slicing rule, and for
 * the same reason: these are the dates a partner checks his commission
 * window against, and `new Date('2026-03-01')` prints as 28 February for
 * anybody west of Greenwich.
 *
 * Absent is not an error and not a zero — `referral_signup_date` and
 * `referral_first_payment_date` are both routinely empty, and a
 * substituted day would read as a fact about when his window opened.
 * Anything else unparseable comes back untouched rather than silently
 * becoming a wrong date.
 */
export function prettyDay(day: string | null): string {
  if (!day) return '—'
  const [y, m, d] = day.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d || m > 12) return day
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`
}

export interface RosterRow {
  clientId: string
  clientName: string
  /** The signup date as given, or null. Never substituted, never guessed. */
  referred: string | null
  firstPaid: string | null
  state: RosterState
  /**
   * Where this client sits in its window, or null for every state but
   * `earning`.
   *
   * CARRIED, not re-derivable. The roster table used to call
   * `windowPosition(row.firstPaid, asOf)` itself to fill its "Commission
   * window" cell, and that second call cannot see what `unusable` below
   * sees: a client whose first payment predates its signup date rendered
   * "your commission starts the month this client pays their first
   * invoice" beside "month 4 of 12 · closes after February 2027". One row
   * saying both, and the half he plans around is the running window.
   *
   * Set from the same branch that sets `state`, so the sentence and the
   * cell are one fact and a boundary cannot land differently on them.
   */
  window: { month: number; of: number; closesAfter: string } | null
}

/**
 * The sentence a partner reads next to each client.
 *
 * Partner voice. The staff voice for the same facts lives in
 * `computeOwed`'s notes ("set the first-payment date to release"), which
 * is an instruction he cannot carry out about a field he cannot see.
 *
 * The figures come from REFERRAL_TERMS rather than being written out, so
 * these cannot become a second, stale copy of the deal.
 */
export const ROSTER_STATE_TEXT: Record<RosterState, string> = {
  awaiting_first_payment:
    'Signed up. Your commission starts the month this client pays their first invoice.',
  earning: `Earning. You receive ${REFERRAL_TERMS.COMMISSION_RATE * 100}% of this account's net profit each month.`,
  window_closed: `The ${REFERRAL_TERMS.COMMISSION_MONTHS}-month commission window for this client has ended.`,
}

/**
 * Where a client sits in its commission window, or null.
 *
 * Null means "no position to show", and it covers three different causes
 * on purpose: there is no first paid invoice, the window has closed, or
 * the recorded first-payment date is in the future. The caller
 * distinguishes them, because only the caller has the signup date.
 *
 * The bound is `[start, start + COMMISSION_MONTHS)`, identical to the one
 * in `computeOwed`. A future date is excluded by the SAME comparison
 * rather than by a separate branch: `idx < start` is already outside the
 * range, so there is no second rule to keep in step. The month returned
 * is therefore always in 1..of — never 0, never negative.
 */
export function windowPosition(
  firstPaid: string | null,
  asOf: Date,
): { month: number; of: number; closesAfter: string } | null {
  if (!firstPaid) return null

  const of = REFERRAL_TERMS.COMMISSION_MONTHS
  const start = monthIndex(firstPaid)
  const idx = monthIndex(isoDay(asOf))

  if (idx < start || idx >= start + of) return null

  // The LAST month commission is owed, not the month after it. The bound
  // above is half-open, so the final owed index is `start + of - 1` —
  // naming `start + of` would promise a thirteenth month the payout does
  // not honour, and the partner would discover it by not being paid.
  // Derived from the same `start`, so it cannot disagree with `month`.
  return { month: idx - start + 1, of, closesAfter: prettyMonth(monthFromIndex(start + of - 1)) }
}

/** Inverse of referrals.ts `monthIndex`, as 'YYYY-MM'. */
function monthFromIndex(idx: number): string {
  const y = Math.floor(idx / 12)
  const m = (idx % 12) + 1
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * One row per client, in the order given.
 *
 * Nothing is filtered. A partner who referred a client is shown that
 * client whatever its state — that is the whole fix, and a filter here
 * would reintroduce the empty screen for the exact case that caused the
 * complaint.
 */
export function rosterRows(
  clients: ReadonlyArray<ReferredClient>,
  asOf: Date,
): RosterRow[] {
  const nowIdx = monthIndex(isoDay(asOf))

  return clients.map((c) => {
    const referred = c.referral_signup_date ?? null
    const firstPaid = c.referral_first_payment_date ?? null

    // Two ways the pair of hand-typed dates is unusable. Both read as
    // "the window has not started", which is the honest answer: we do
    // not know when this client paid, so we cannot say he is earning and
    // we certainly cannot say he is finished.
    //
    //   - paid before signed: impossible, so one of the two is wrong
    //   - paid in a future month: the window has not opened yet
    //
    // The alternative for the second case is what falling through to
    // `window_closed` would produce — telling a partner the window for a
    // client who has not paid yet is already over. That is the one wrong
    // answer that makes him stop asking.
    const unusable =
      firstPaid !== null &&
      ((referred !== null && firstPaid < referred) || monthIndex(firstPaid) > nowIdx)

    // ONE call to windowPosition per client, and both the state and the
    // cell come off it. Asking twice is how the two disagreed.
    let state: RosterState
    let position: { month: number; of: number; closesAfter: string } | null = null
    if (firstPaid === null || unusable) state = 'awaiting_first_payment'
    else {
      position = windowPosition(firstPaid, asOf)
      state = position ? 'earning' : 'window_closed'
    }

    return { clientId: c.id, clientName: c.name, referred, firstPaid, state, window: position }
  })
}
