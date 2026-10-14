// The sign-up bonus, in the partner's voice. Spec §4.3.
//
// WHAT WAS WRONG. `computeOwed` already decides every sign-up bonus's
// state and already writes a sentence about it. The sentence is written
// for staff: "Qualified — set the first-payment date to release" names a
// field the partner cannot see and an action only Shipo can take. The
// statement rendered none of it, so a partner saw a bonus only once it
// had been released — with no way to tell "not yet" from "never", and
// nothing to ask about.
//
// ONE DECISION, TWO VOICES. The same two-map pattern as
// partner-access.ts: one function decides, a Record<State, string>
// phrases it, and a missing phrasing is a compile error. The alternative
// — a second function restating the conditions in partner language — is
// exactly the drift this module exists to prevent, and the dangerous
// direction is specific. This module must never DECIDE anything: a
// second qualification rule would eventually tell a partner a bonus is
// coming that the payout does not pay.
//
// WHAT DISCRIMINATES WHAT. Three inputs, used for three different jobs:
//
//   - `status` is the ledger row, and it is a FACT. paid is paid.
//   - `period` is computeOwed's STRUCTURAL marker: the literal string
//     'awaiting' means the bonus has not cleared its conditions. Not
//     prose, so no rewording can move it.
//   - `note` is prose, and it is used only to say WHICH condition is
//     outstanding — never whether one is.
//
// That split is the point. If an unrecognised note could reach
// 'in_review', rewording a sentence in referrals.ts would promote an
// unreleased bonus to "being processed", which a partner reads as money
// coming. Unreleased-and-unrecognised therefore falls to the state whose
// sentence promises nothing.

import { REFERRAL_TERMS, type OwedLine } from './referrals'

/**
 * Spec §4.3's four states, plus `not_qualified`.
 *
 * The spec names "paid / approved / in review / awaiting first payment".
 * `not_qualified` is the fifth because `computeOwed` has a case the four
 * cannot express: a client Shipo has not invoiced at all. Calling that
 * "awaiting first payment" would tell a partner we are waiting on his
 * client's money when we have not yet asked for it.
 */
export type BonusState = 'paid' | 'approved' | 'in_review' | 'awaiting_first_payment' | 'not_qualified'

/**
 * What the partner reads.
 *
 * `not_qualified` deliberately promises nothing and blames nobody — it is
 * also the fall-through for an unreleased bonus whose note this module
 * does not recognise, so it has to be true of every unreleased case,
 * including ones nobody has written yet.
 *
 * The figure comes from REFERRAL_TERMS rather than being typed out: a
 * second copy of the amount would go stale, and the copy that goes stale
 * is the one on the partner's screen.
 */
export const BONUS_STATE_TEXT: Record<BonusState, string> = {
  paid: `Your $${REFERRAL_TERMS.SIGNUP_BONUS} sign-up bonus for this client has been paid.`,
  approved: `Your $${REFERRAL_TERMS.SIGNUP_BONUS} sign-up bonus for this client is approved and will be paid on the next run.`,
  in_review: `Your $${REFERRAL_TERMS.SIGNUP_BONUS} sign-up bonus for this client is earned and being processed.`,
  awaiting_first_payment: `Your $${REFERRAL_TERMS.SIGNUP_BONUS} sign-up bonus for this client is held until their first invoice is paid.`,
  not_qualified: `No sign-up bonus is due on this client yet.`,
}

/** computeOwed's period for a bonus that has not cleared its conditions. */
const UNRELEASED = 'awaiting'

/**
 * Re-voice one `signup_bonus` line. Decides nothing.
 *
 * Order is load-bearing:
 *
 *   1. A settled ledger row wins over everything. The note is recomputed
 *      on every page load and is advisory; a paid bonus reported as
 *      "awaiting" would have a partner chasing money already in his bank.
 *   2. The note names the outstanding condition. A mention of the
 *      first-payment date means the client has qualified and the money
 *      has not arrived — the one case the staff sentence exists for.
 *   3. Anything still unreleased falls to `not_qualified`, whose sentence
 *      is true of every unreleased case.
 *   4. Everything left is a real month with no settled row: earned, not
 *      yet paid.
 */
export function bonusStateFor(line: Pick<OwedLine, 'status' | 'note' | 'period'>): BonusState {
  if (line.status === 'paid') return 'paid'
  if (line.status === 'approved') return 'approved'

  // `note` is optional on OwedLine and absent is the commonest case, so
  // it is coerced rather than branched on.
  const note = line.note ?? ''

  // Matched loosely on purpose: referrals.ts says "set the first-payment
  // date to release" today, and the property being read is only "this
  // sentence is about the first payment". A tighter match on the exact
  // staff phrasing would fail OPEN on a reword — the line would fall
  // through and read as not qualified, which is a different fact.
  if (/first[-\s]?payment/i.test(note)) return 'awaiting_first_payment'

  if (line.period === UNRELEASED) return 'not_qualified'

  return 'in_review'
}
