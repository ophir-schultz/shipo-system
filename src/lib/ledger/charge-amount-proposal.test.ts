import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  proposeChargeAmount,
  serviceRevenueCoverage,
  summarizeProposals,
  warehouseRateEvidence,
} from './charge-amount-proposal'

describe('order charge amount proposal', () => {
  it('keeps a stored price and a voided zero', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 12.5, voided: false, shipmentClientRate: 1,
    })).toEqual({ action: 'keep', amount: 12.5, kind: 'stored', reason: 'already priced' })
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 0, voided: true, shipmentClientRate: 12,
    })).toEqual({ action: 'keep', amount: 0, kind: 'stored', reason: 'voided zero' })
  })

  it('proposes the stored shipment price and does not follow a warehouse rate', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: 18.4,
    })).toEqual({
      action: 'propose',
      amount: 18.4,
      source: 'shipments.client_rate',
      writer: 'proposal, not calculate-charges.ts',
      kind: 'proposal',
    })
    expect(warehouseRateEvidence({ rateType: 'flat' })).toMatchObject({
      role: 'evidence',
      writer: 'calculate-charges.ts',
      usedAsBackfill: false,
    })
  })

  it('leaves a null amount null when the shipment has no stored price', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: null,
    })).toEqual({
      action: 'leave-null',
      kind: 'proposal',
      reason: 'No shipments.client_rate is stored. Amount stays null.',
    })
    expect(warehouseRateEvidence(null).usedAsBackfill).toBe(false)
  })

  it('does not turn carrier cost or a warehouse line into the proposal', () => {
    const src = readFileSync('src/lib/ledger/charge-amount-proposal.ts', 'utf8')
    expect(src).not.toContain('actualCost')
    expect(src).not.toContain('actual_cost')
    const decision = proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: null,
    })
    expect(decision.action).toBe('leave-null')
  })

  it('does not price a pick charge or a voided null from the shipment price', () => {
    expect(proposeChargeAmount({
      chargeType: 'pick', amount: null, voided: false, shipmentClientRate: 18.4,
    }).action).toBe('leave-null')
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: true, shipmentClientRate: 18.4,
    }).action).toBe('leave-null')
  })

  it('matches the audited 701 priced nulls and leaves the other 8 null', () => {
    const inputs = [
      ...Array.from({ length: 4 }, () => ({
        chargeType: 'shipping', amount: 0, voided: true, shipmentClientRate: 9,
      })),
      ...Array.from({ length: 701 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: 10,
      })),
      ...Array.from({ length: 8 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: null,
      })),
    ]
    expect(summarizeProposals(inputs)).toEqual({ keep: 4, propose: 701, leaveNull: 8 })
    const coverage = serviceRevenueCoverage({ withClientRate: 701, withoutClientRate: 8 })
    expect(coverage.nullCharges).toBe(709)
    expect(coverage.proposeFromShipmentPrice).toBe(701)
    expect(coverage.leaveNull).toBe(8)
    expect(coverage.serviceRevenueComplete).toBe(false)
    expect(coverage.missingLedgerOrders).toEqual(['Nayax', 'Creative Pea'])
    expect(coverage.note).toMatch(/service revenue is missing/)
  })

  it('does not call the writer or write a charge', () => {
    const src = readFileSync('src/lib/ledger/charge-amount-proposal.ts', 'utf8')
    expect(src).not.toContain('supabase')
    expect(src).not.toContain('buildCharges')
    const writer = readFileSync('src/lib/ledger/calculate-charges.ts', 'utf8')
    expect(writer).not.toContain('charge-amount-proposal')
  })
})
