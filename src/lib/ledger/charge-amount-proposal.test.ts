import { describe, expect, it } from 'vitest'
import { proposeChargeAmount, summarizeProposals } from './charge-amount-proposal'

describe('order charge amount proposal', () => {
  it('keeps a stored price and a voided zero', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 12.5, voided: false, shipmentClientRate: 99,
    })).toEqual({ action: 'keep', amount: 12.5, reason: 'already priced' })
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 0, voided: true, shipmentClientRate: 12,
    })).toEqual({ action: 'keep', amount: 0, reason: 'voided zero' })
  })

  it('proposes only an existing shipment client rate for an unpriced shipping row', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: 18.4,
    })).toEqual({ action: 'propose', amount: 18.4, source: 'shipments.client_rate' })
  })

  it('leaves a null amount null when no client price exists, and never uses carrier cost', () => {
    const decision = proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: null,
    })
    expect(decision.action).toBe('leave-null')
    if (decision.action === 'leave-null') expect(decision.reason).toMatch(/stays null/)
    expect(JSON.stringify(decision)).not.toMatch(/actual_cost|carrier/)
  })

  it('does not borrow a shipping price for a pick charge', () => {
    const decision = proposeChargeAmount({
      chargeType: 'pick', amount: null, voided: false, shipmentClientRate: 18.4,
    })
    expect(decision.action).toBe('leave-null')
  })

  it('counts a mostly-null batch without turning the unknowns into zero', () => {
    const inputs = [
      ...Array.from({ length: 4 }, () => ({
        chargeType: 'shipping', amount: 1, voided: false, shipmentClientRate: null,
      })),
      ...Array.from({ length: 100 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: 10,
      })),
      ...Array.from({ length: 609 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, shipmentClientRate: null,
      })),
    ]
    expect(summarizeProposals(inputs)).toEqual({ keep: 4, propose: 100, leaveNull: 609 })
    expect(inputs.filter((row) => row.amount === null)).toHaveLength(709)
  })
})
