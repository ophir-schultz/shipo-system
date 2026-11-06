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
export const PNL_PARTNER_MONEY_SOURCE =
  'Staff detail: monthly totals come from the partner ledger when that view has rows. Payment processing, and any month the ledger does not cover, come from the hand-entered monthly accounts on Referrals. An empty ledger is not a figure of $0. Partners are not shown these inputs.'
