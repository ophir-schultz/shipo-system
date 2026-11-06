import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { proposeChargeAmount, summarizeProposals, type ApplicableShippingRate } from './charge-amount-proposal'

const flat = (rate: number | null): ApplicableShippingRate => ({
  rateType: 'flat', rate, markup: null, actualCost: 99,
})

describe('order charge amount proposal', () => {
  it('keeps a stored price and a voided zero, and does not reprice them', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 12.5, voided: false, applicableRate: flat(1),
    })).toEqual({ action: 'keep', amount: 12.5, reason: 'already priced' })
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: 0, voided: true, applicableRate: null,
    })).toEqual({ action: 'keep', amount: 0, reason: 'voided zero' })
  })

  it('proposes the flat warehouse rate already in effect', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, applicableRate: flat(18.4),
    })).toEqual({ action: 'propose', amount: 18.4, source: 'client_warehouse_rates' })
  })

  it('leaves the amount null when no warehouse rate applies', () => {
    const decision = proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, applicableRate: null,
    })
    expect(decision).toEqual({
      action: 'leave-null',
      reason: 'No warehouse rate applies. Amount stays null.',
    })
  })

  it('leaves the amount null when the rate in effect cannot produce a price', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false, applicableRate: flat(null),
    }).action).toBe('leave-null')
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false,
      applicableRate: { rateType: 'at_cost', rate: null, markup: null, actualCost: null },
    }).action).toBe('leave-null')
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false,
      applicableRate: { rateType: 'cost_plus', rate: null, markup: null, actualCost: 8.2 },
    }).action).toBe('leave-null')
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false,
      applicableRate: { rateType: 'per_lb', rate: 4, markup: null, actualCost: 8.2 },
    }).action).toBe('leave-null')
  })

  it('uses carrier cost only as an at_cost or cost_plus rate that is already in effect', () => {
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false,
      applicableRate: { rateType: 'at_cost', rate: null, markup: null, actualCost: 8.2 },
    })).toEqual({ action: 'propose', amount: 8.2, source: 'client_warehouse_rates' })
    expect(proposeChargeAmount({
      chargeType: 'shipping', amount: null, voided: false,
      applicableRate: { rateType: 'cost_plus', rate: null, markup: 5, actualCost: 8.2 },
    })).toEqual({ action: 'propose', amount: 13.2, source: 'client_warehouse_rates' })
  })

  it('does not price a pick charge from a shipping rate', () => {
    expect(proposeChargeAmount({
      chargeType: 'pick', amount: null, voided: false, applicableRate: flat(18.4),
    }).action).toBe('leave-null')
  })

  it('does not read shipments.client_rate', () => {
    const src = readFileSync('src/lib/ledger/charge-amount-proposal.ts', 'utf8')
    expect(src).not.toContain('client_rate')
    expect(src).not.toContain('zone_rate')
  })

  it('counts a mostly-null batch without turning the unknowns into zero', () => {
    const inputs = [
      ...Array.from({ length: 4 }, () => ({
        chargeType: 'shipping', amount: 1, voided: false, applicableRate: null,
      })),
      ...Array.from({ length: 20 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, applicableRate: flat(10),
      })),
      ...Array.from({ length: 689 }, () => ({
        chargeType: 'shipping', amount: null, voided: false, applicableRate: null,
      })),
    ]
    expect(summarizeProposals(inputs)).toEqual({ keep: 4, propose: 20, leaveNull: 689 })
  })
})
