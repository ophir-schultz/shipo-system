import { REFERRAL_TERMS } from '@/lib/referrals'

// Where the staff commission figures come from.
//
// Two screens, two reads, one formula. Neither screen is an automatic
// payout, and neither is allowed to pretend the P&L filled the rows in.
// The sentences are imported by the screens so a rewrite of one cannot
// quietly describe a feed the other does not have.

/**
 * /referrals computes from the monthly account rows typed on that page
 * and from each client's first-payment date. It does not read the ledger
 * views.
 */
export const REFERRALS_MONEY_SOURCE =
  'The payout lines on this page are computed from the monthly account rows entered below and from the first-payment date on each client. They are not filled from the P&L. Nothing is paid until you approve it.'

/**
 * /pnl Partner Payouts reads the ledger views when they have rows, and
 * the same hand-entered monthly accounts for processing cost and for any
 * month the ledger does not cover. An empty ledger is not $0 owed.
 */
/**
 * Stored commission_type / commission_value are leftover columns.
 * computeOwed does not read them. A stored flat 0 must not be described
 * as the reason a payout is $0.
 */
export const STORED_COMMISSION_IGNORED =
  'Stored commission_type and commission_value are not used. A stored flat 0 does not set a future payout to $0. '
  + `The formula is ${REFERRAL_TERMS.COMMISSION_RATE * 100}% of net profit for ${REFERRAL_TERMS.COMMISSION_MONTHS} months, `
  + `a $${REFERRAL_TERMS.SIGNUP_BONUS} signup bonus after the first paid invoice, and a $${REFERRAL_TERMS.MIN_PAYOUT} payout minimum. `
  + 'Monthly account rows are typed on this page. They are not copied from the P&L.'

export function emptyReferralBooks(input: {
  linkedClients: number
  invoiceRows: number
  payoutRows: number
}): { genuineZero: boolean; text: string } {
  const genuineZero = input.linkedClients === 0 && input.invoiceRows === 0 && input.payoutRows === 0
  if (!genuineZero) {
    return {
      genuineZero: false,
      text: 'Some referral inputs exist. A $0 line is not explained by an empty book.',
    }
  }
  return {
    genuineZero: true,
    text: 'Owed and paid are $0 because no client is linked to a partner, no monthly account row has been entered, and no payout has been recorded. That zero is the empty book. It is not the stored commission value.',
  }
}

export const PNL_PARTNER_MONEY_SOURCE =
  'Staff detail: monthly totals come from the partner ledger when that view has rows. Payment processing, and any month the ledger does not cover, come from the hand-entered monthly accounts on Referrals. An empty ledger is not a figure of $0. Partners are not shown these inputs.'
