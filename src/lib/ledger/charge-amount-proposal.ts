// Preview of what a later backfill could write into order_charges.amount.
//
// The writer is calculate-charges.ts. A shipping amount comes only from the
// client_warehouse_rates line in effect on the ship date:
//   voided label                         -> 0, already stored, kept here
//   no line in effect                    -> null
//   at_cost                              -> carrier cost, or null if unreported
//   cost_plus                            -> carrier cost + markup, or null if either is missing
//   flat                                 -> the rate cell, or null if that cell is empty
//   any other rate_type                  -> null
//
// A shipment price from another table is not an input. Zone sheets are not an
// input. Carrier cost is used only inside an at_cost or cost_plus line that is
// already in effect. This module does not write.

import { cents, SHIPPING_RATE_TYPES } from './calculate-charges'

export interface ApplicableShippingRate {
  rateType: string
  /** Flat amount. Null on cost_plus, and null when a flat cell is empty. */
  rate: number | null
  /** Dollar markup. Read only for cost_plus. */
  markup: number | null
  /** Carrier cost. Read only for at_cost and cost_plus. */
  actualCost: number | null
}

export interface ChargeAmountInput {
  chargeType: string
  /** Stored amount. Null means unpriced. Zero is a real zero. */
  amount: number | null
  voided: boolean
  /** Warehouse rate in effect on the charge date. Null means no rate applies. */
  applicableRate: ApplicableShippingRate | null
}

export type ChargeAmountDecision =
  | { action: 'keep'; amount: number; reason: 'already priced' | 'voided zero' }
  | { action: 'propose'; amount: number; source: 'client_warehouse_rates' }
  | { action: 'leave-null'; reason: string }

function money(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return value
}

function pricedByRate(rate: ApplicableShippingRate): number | null {
  if (!SHIPPING_RATE_TYPES.has(rate.rateType)) return null
  if (rate.rateType === 'at_cost') {
    const cost = money(rate.actualCost)
    return cost === null ? null : cents(cost)
  }
  if (rate.rateType === 'cost_plus') {
    const cost = money(rate.actualCost)
    const markup = money(rate.markup)
    if (cost === null || markup === null) return null
    return cents(cents(cost + markup))
  }
  const flat = money(rate.rate)
  return flat === null ? null : cents(flat)
}

export function proposeChargeAmount(input: ChargeAmountInput): ChargeAmountDecision {
  const stored = money(input.amount)
  if (stored !== null) {
    return {
      action: 'keep',
      amount: stored,
      reason: input.voided && stored === 0 ? 'voided zero' : 'already priced',
    }
  }
  if (input.chargeType !== 'shipping' || input.applicableRate === null) {
    return {
      action: 'leave-null',
      reason: 'No warehouse rate applies. Amount stays null.',
    }
  }
  const next = pricedByRate(input.applicableRate)
  if (next === null) {
    return {
      action: 'leave-null',
      reason: 'A warehouse rate is in effect but it does not produce a price. Amount stays null.',
    }
  }
  return { action: 'propose', amount: next, source: 'client_warehouse_rates' }
}

export function summarizeProposals(inputs: readonly ChargeAmountInput[]): {
  keep: number
  propose: number
  leaveNull: number
} {
  const counts = { keep: 0, propose: 0, leaveNull: 0 }
  for (const input of inputs) {
    const decision = proposeChargeAmount(input)
    if (decision.action === 'keep') counts.keep += 1
    else if (decision.action === 'propose') counts.propose += 1
    else counts.leaveNull += 1
  }
  return counts
}
