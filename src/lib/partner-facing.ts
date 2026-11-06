// What a partner is allowed to hold.
//
// The commission is still computed in src/lib/referrals.ts from invoiced
// amounts and the four cost buckets. That arithmetic stays on the server.
// This module is the only shape that may be rendered, downloaded, or
// placed in a payload a partner receives. It copies the payout amounts
// and the activity counts, and it does not copy the inputs.
//
// A spread of StatementClientLine would put billed, costs and netProfit
// back on the object. The copies below name every field.

import type { PartnerStatement, PayoutStatus } from './referrals'

export interface PartnerFacingClient {
  clientId: string
  clientName: string
  units: number | null
  orders: number | null
  /** The partner's commission for the month. Not the invoice and not the profit. */
  commission: number
  status: PayoutStatus
  provisional?: boolean
  dedupeKey: string
}

export interface PartnerFacingBonus {
  clientName: string
  amount: number
  status: PayoutStatus
  dedupeKey: string
}

export interface PartnerFacingMonth {
  period: string
  clients: PartnerFacingClient[]
  bonuses: PartnerFacingBonus[]
  earned: number
  carriedIn: number
  payable: number
  carriedOut: number
}

export interface PartnerFacingStatement {
  months: PartnerFacingMonth[]
  lifetimeEarned: number
  paidToDate: number
  awaitingPayment: number
  carryForward: number
}

export function projectPartnerStatement(statement: PartnerStatement): PartnerFacingStatement {
  return {
    lifetimeEarned: statement.lifetimeEarned,
    paidToDate: statement.paidToDate,
    awaitingPayment: statement.awaitingPayment,
    carryForward: statement.carryForward,
    months: statement.months.map((month) => ({
      period: month.period,
      earned: month.earned,
      carriedIn: month.carriedIn,
      payable: month.payable,
      carriedOut: month.carriedOut,
      clients: month.clients.map((line) => ({
        clientId: line.clientId,
        clientName: line.clientName,
        units: line.units,
        orders: line.orders,
        commission: line.share,
        status: line.status,
        provisional: line.provisional,
        dedupeKey: line.dedupeKey,
      })),
      bonuses: month.bonuses.map((bonus) => ({
        clientName: bonus.clientName,
        amount: bonus.amount,
        status: bonus.status,
        dedupeKey: bonus.dedupeKey,
      })),
    })),
  }
}

/**
 * Words and column names that name Shipo's costs, margin, or the private
 * rate. A partner surface fails if any of these survive into text the
 * partner can read.
 */
export const PARTNER_MONEY_LEAKS: readonly RegExp[] = [
  /net profit/i,
  /\bmargin\b(?!\s*:)(?!-)/i,
  /\bfreight\b/i,
  /\bmaterials\b/i,
  /\bstorage\b/i,
  /payment processing/i,
  /total billed/i,
  /\binvoiced\b/i,
  /cost_freight|cost_materials|cost_storage|cost_processing|cost_labour/,
  /\b5%/,
  /your share/i,
]

export function partnerMoneyLeaks(text: string): string[] {
  return PARTNER_MONEY_LEAKS.filter((re) => re.test(text)).map((re) => re.source)
}
