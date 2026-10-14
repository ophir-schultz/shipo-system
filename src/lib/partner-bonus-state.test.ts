import { describe, expect, it } from 'vitest'
import {
  computeOwed,
  type FbaInvoice,
  type PayoutRecord,
  type ReferralPartner,
  type ReferredClient,
} from './referrals'
import { BONUS_STATE_TEXT, bonusStateFor } from './partner-bonus-state'

/**
 * §4.3. `computeOwed` already decides the sign-up bonus's state and already
 * writes a sentence about it. The sentence is written for STAFF — "Qualified
 * — set the first-payment date to release" names a field the partner cannot
 * see and an action only Shipo can take. The statement drops all of it, so
 * today a partner sees a bonus only once it is released, with no way to tell
 * "not yet" from "never".
 *
 * This module re-voices that decision. It must not recompute it: a second
 * qualification rule would eventually tell the partner he is owed a bonus the
 * payout does not pay, or the reverse.
 *
 * TWO LAYERS OF TEST, deliberately:
 *
 *   1. hand-written lines, which pin the mapping including phrasings
 *      computeOwed does not currently emit, and
 *   2. lines taken from computeOwed ITSELF, which pin the mapping against
 *      the notes that actually arrive.
 *
 * (1) alone tests my guess about the note strings. The note is prose in
 * another module, and prose gets reworded; the day it does, (2) is what
 * fails instead of a partner's screen silently reclassifying him.
 */

describe('bonusStateFor / BONUS_STATE_TEXT', () => {
  it('maps a paid payout to paid', () => {
    expect(bonusStateFor({ status: 'paid', period: '2026-03' })).toBe('paid')
  })

  it('maps an approved payout to approved', () => {
    expect(bonusStateFor({ status: 'approved', period: '2026-03' })).toBe('approved')
  })

  it('handles a line with NO note at all', () => {
    // `note` is optional on OwedLine and absent is the commonest case.
    expect(() => bonusStateFor({ status: 'pending', period: '2026-03' })).not.toThrow()
  })

  it('maps an unqualified note to awaiting_first_payment, not an instruction', () => {
    const state = bonusStateFor({
      status: 'pending',
      note: 'No first-payment date set — window has not started',
      period: '2026-03',
    })
    expect(state).toBe('awaiting_first_payment')
    expect(BONUS_STATE_TEXT[state]).not.toMatch(/set the first-payment/i)
  })

  it('every state has partner-safe text', () => {
    for (const t of Object.values(BONUS_STATE_TEXT)) {
      expect(t).not.toMatch(/set the first-payment|re-send|reactivate|qualified on/i)
    }
  })

  it('has a phrasing for every state, and no empty one', () => {
    // Record<BonusState, string> makes a MISSING key a compile error; it
    // does not stop an empty string, which renders as a blank cell and
    // reads as "nothing to say about your bonus".
    for (const [state, text] of Object.entries(BONUS_STATE_TEXT)) {
      expect(text.trim().length, state).toBeGreaterThan(10)
    }
  })

  it('a settled payout stays settled whatever the note says', () => {
    // The ledger row is the fact; the note is advisory and is recomputed
    // on every page load. A paid bonus reported as "awaiting" would have
    // the partner chasing money already in his bank.
    expect(
      bonusStateFor({ status: 'paid', period: 'awaiting', note: 'Not yet owed — the client has not been invoiced yet' }),
    ).toBe('paid')
  })

  it('an unreleased line is never in_review, even with an unrecognised note', () => {
    // period 'awaiting' is computeOwed's STRUCTURAL marker for "this bonus
    // has not cleared its conditions" — not prose. A reworded note must
    // not be able to promote an unreleased bonus to "being processed",
    // which reads as "money is coming".
    expect(bonusStateFor({ status: 'computed', period: 'awaiting', note: 'something nobody has written yet' })).not.toBe(
      'in_review',
    )
  })

  it('distinguishes not-yet-invoiced from waiting-on-the-first-payment', () => {
    const notInvoiced = bonusStateFor({
      status: 'computed',
      period: 'awaiting',
      note: 'Not yet owed — the client has not been invoiced yet',
    })
    const noPaymentDate = bonusStateFor({
      status: 'computed',
      period: 'awaiting',
      note: 'Qualified — set the first-payment date to release',
    })
    expect(notInvoiced).toBe('not_qualified')
    expect(noPaymentDate).toBe('awaiting_first_payment')
    // Two different facts, so two different sentences.
    expect(BONUS_STATE_TEXT[notInvoiced]).not.toBe(BONUS_STATE_TEXT[noPaymentDate])
  })

  it('never shows a partner the bespoke-threshold note', () => {
    // qualifyNote's third branch tells staff to clear three columns on a
    // partner row. It is the most staff-voiced sentence in referrals.ts.
    const state = bonusStateFor({
      status: 'computed',
      period: 'awaiting',
      note:
        'Never owed — this partner row sets its contracted thresholds to 0, which closes ' +
        'every path. Clear those columns to put them on the standing terms.',
    })
    expect(BONUS_STATE_TEXT[state]).not.toMatch(/thresholds|columns|standing terms|partner row/i)
  })
})

/**
 * The second layer: the notes that ACTUALLY arrive.
 *
 * Every line below comes out of computeOwed, so a reworded note in
 * referrals.ts fails here rather than silently reclassifying a partner.
 */
describe('bonusStateFor over computeOwed s real lines', () => {
  const partner: ReferralPartner = {
    id: 'p1',
    name: 'Dana Partner',
    company: null,
    status: 'active',
  }

  const client = (over: Partial<ReferredClient> = {}): ReferredClient => ({
    id: 'c1',
    name: 'Acme Supplements',
    referral_partner_id: 'p1',
    referral_signup_date: '2026-01-05',
    referral_first_payment_date: null,
    ...over,
  })

  const invoice: FbaInvoice = {
    id: 'i1',
    client_id: 'c1',
    period: '2026-02-01',
    amount: 4000,
  }

  const bonusLine = (clients: ReferredClient[], invoices: FbaInvoice[], payouts: PayoutRecord[] = []) => {
    const line = computeOwed([partner], clients, invoices, payouts, { now: new Date('2026-03-15') }).find(
      (l) => l.kind === 'signup_bonus',
    )
    expect(line, 'computeOwed produced no signup_bonus line').toBeDefined()
    return line!
  }

  it('a client with no invoices at all reads not_qualified', () => {
    const line = bonusLine([client()], [])
    expect(line.period).toBe('awaiting')
    expect(bonusStateFor(line)).toBe('not_qualified')
  })

  it('an invoiced client with no first-payment date reads awaiting_first_payment', () => {
    // This is the case the staff note is written for, and the one a
    // partner most needs re-voiced.
    const line = bonusLine([client()], [invoice])
    expect(line.note).toMatch(/first-payment/i)
    expect(bonusStateFor(line)).toBe('awaiting_first_payment')
  })

  it('an owed-but-unsettled bonus reads in_review', () => {
    const line = bonusLine([client({ referral_first_payment_date: '2026-02-10' })], [invoice])
    expect(line.period).not.toBe('awaiting')
    expect(line.status).toBe('computed')
    expect(bonusStateFor(line)).toBe('in_review')
  })

  it('a settled bonus reads paid, from the ledger row', () => {
    const owed = bonusLine([client({ referral_first_payment_date: '2026-02-10' })], [invoice])
    const line = bonusLine([client({ referral_first_payment_date: '2026-02-10' })], [invoice], [
      {
        id: 'pay1',
        dedupe_key: owed.dedupeKey,
        status: 'paid',
        amount: 300,
        approved_at: '2026-03-01',
        paid_at: '2026-03-02',
      },
    ])
    expect(bonusStateFor(line)).toBe('paid')
  })

  it('every note computeOwed can emit maps to a state, and none to in_review while unreleased', () => {
    // The whole surface, in one pass: no real line may fall through to a
    // default that reads as money coming when nothing is owed.
    const cases: ReferredClient[][] = [
      [client()], // not invoiced
      [client({ referral_first_payment_date: null })], // no payment date
      [client({ referral_first_payment_date: '2026-02-10' })], // owed
      [client({ referral_first_payment_date: '2026-06-01' })], // payment date in the future
      [client({ referral_signup_date: null })], // no signup date recorded
    ]
    for (const clients of cases) {
      const line = bonusLine(clients, [invoice])
      const state = bonusStateFor(line)
      expect(Object.keys(BONUS_STATE_TEXT), line.note).toContain(state)
      if (line.period === 'awaiting') expect(state, line.note).not.toBe('in_review')
    }
  })
})
