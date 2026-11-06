// What a later backfill could write into order_charges.amount.
//
// This does not write. A null amount stays null unless a client price
// already exists on the shipment. Carrier cost is never used as that price,
// and a missing price is never turned into zero.

export interface ChargeAmountInput {
  chargeType: string
  /** Stored amount. Null means unpriced. Zero is a real zero. */
  amount: number | null
  voided: boolean
  /** shipments.client_rate for a shipping charge. Null when nobody priced it. */
  shipmentClientRate: number | null
}

export type ChargeAmountDecision =
  | { action: 'keep'; amount: number; reason: 'already priced' | 'voided zero' }
  | { action: 'propose'; amount: number; source: 'shipments.client_rate' }
  | { action: 'leave-null'; reason: string }

function money(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return value
}

export function proposeChargeAmount(input: ChargeAmountInput): ChargeAmountDecision {
  const stored = money(input.amount)
  if (stored !== null) {
    return { action: 'keep', amount: stored, reason: input.voided && stored === 0 ? 'voided zero' : 'already priced' }
  }
  if (input.chargeType !== 'shipping') {
    return {
      action: 'leave-null',
      reason: `No ${input.chargeType} price is on this charge. Not invented, and not taken from carrier cost.`,
    }
  }
  const rate = money(input.shipmentClientRate)
  if (rate === null) {
    return {
      action: 'leave-null',
      reason: 'No shipping rate is in effect and shipments.client_rate is empty. Amount stays null.',
    }
  }
  return { action: 'propose', amount: rate, source: 'shipments.client_rate' }
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
