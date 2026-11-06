// Preview of a later backfill for order_charges.amount. This is not the writer.
//
// calculate-charges.ts still prices a shipping row from client_warehouse_rates
// and is unchanged. That warehouse rule is recorded below only as evidence.
// It is not the amount this preview proposes.
//
// The approved shipment price already stored on shipments.client_rate is the
// price this preview uses. A read of the live ledger found 701 of 709 null
// shipping charges already have that price, and 8 do not. Those 8 stay null.
// Carrier cost is not a price. This module does not write, and it does not
// change how a shipment price is calculated.

export const PROPOSAL_SOURCE = 'shipments.client_rate' as const
export const PROPOSAL_WRITER = 'proposal, not calculate-charges.ts' as const

export interface ChargeAmountInput {
  chargeType: string
  /** Stored amount. Null means unpriced. Zero is a real zero. */
  amount: number | null
  voided: boolean
  /** Approved per-shipment price. Null when that shipment has no price. */
  shipmentClientRate: number | null
}

export type ChargeAmountDecision =
  | { action: 'keep'; amount: number; reason: 'already priced' | 'voided zero'; kind: 'stored' }
  | {
      action: 'propose'
      amount: number
      source: typeof PROPOSAL_SOURCE
      writer: typeof PROPOSAL_WRITER
      kind: 'proposal'
    }
  | { action: 'leave-null'; reason: string; kind: 'proposal' }

function money(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return value
}

export function proposeChargeAmount(input: ChargeAmountInput): ChargeAmountDecision {
  const stored = money(input.amount)
  if (stored !== null) {
    return {
      action: 'keep',
      amount: stored,
      kind: 'stored',
      reason: input.voided && stored === 0 ? 'voided zero' : 'already priced',
    }
  }
  if (input.voided || input.chargeType !== 'shipping') {
    return {
      action: 'leave-null',
      kind: 'proposal',
      reason: 'No stored shipment price applies to this charge. Amount stays null.',
    }
  }
  const rate = money(input.shipmentClientRate)
  if (rate === null) {
    return {
      action: 'leave-null',
      kind: 'proposal',
      reason: 'No shipments.client_rate is stored. Amount stays null.',
    }
  }
  return {
    action: 'propose',
    amount: rate,
    source: PROPOSAL_SOURCE,
    writer: PROPOSAL_WRITER,
    kind: 'proposal',
  }
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

export interface WarehouseRateEvidence {
  role: 'evidence'
  writer: 'calculate-charges.ts'
  usedAsBackfill: false
  rateType: string | null
  note: string
}

/** What the warehouse-rate writer would have considered. Not a proposed amount. */
export function warehouseRateEvidence(rate: { rateType: string } | null): WarehouseRateEvidence {
  if (rate === null) {
    return {
      role: 'evidence',
      writer: 'calculate-charges.ts',
      usedAsBackfill: false,
      rateType: null,
      note: 'No warehouse rate is in effect. That is why the writer left the amount null. It is not a reason to drop a stored shipment price.',
    }
  }
  return {
    role: 'evidence',
    writer: 'calculate-charges.ts',
    usedAsBackfill: false,
    rateType: rate.rateType,
    note: 'The warehouse rate explains the writer. The backfill preview uses the stored shipment price instead.',
  }
}

export interface ServiceRevenueCoverage {
  nullCharges: number
  proposeFromShipmentPrice: number
  leaveNull: number
  serviceRevenueComplete: false
  missingLedgerOrders: readonly ['Nayax', 'Creative Pea']
  note: string
}

/**
 * Shipping proposals do not complete service revenue. Nayax and Creative Pea
 * are not ledger orders, so their pick, pack, and other service charges are
 * absent. No dollar figure is invented for that gap.
 */
export function serviceRevenueCoverage(audited: {
  withClientRate: number
  withoutClientRate: number
}): ServiceRevenueCoverage {
  return {
    nullCharges: audited.withClientRate + audited.withoutClientRate,
    proposeFromShipmentPrice: audited.withClientRate,
    leaveNull: audited.withoutClientRate,
    serviceRevenueComplete: false,
    missingLedgerOrders: ['Nayax', 'Creative Pea'],
    note: 'Nayax and Creative Pea are not ledger orders. Their service revenue is missing, so the shipment-price proposals do not make service revenue complete.',
  }
}
