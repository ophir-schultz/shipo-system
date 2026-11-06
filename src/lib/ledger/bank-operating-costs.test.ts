import { describe, expect, it } from 'vitest'
import {
  bankOperatingFor,
  loadSeptember2026BankLines,
  BANK_OPEX_SEPARATE_FROM_DIRECT,
} from './bank-operating-costs'
import { DASHBOARD_SHIPPING_BASIS, FULFILLMENT_PNL_BASIS } from '@/lib/billing/pnl-basis'

const lines = loadSeptember2026BankLines()

describe('September 2026 bank operating costs', () => {
  it('reconciles 38 lines to 3571.13, with operating subtotal 3200.38 excluding postage', () => {
    const answer = bankOperatingFor('2026-09', lines)
    expect(answer.status).toBe('provisional')
    if (answer.status !== 'provisional') return
    expect(answer.view.lines).toBe(38)
    expect(answer.view.annualized).toBe(false)
    expect(answer.view.label).toBe('Sep 2026')
    expect(answer.view.expendituresCents).toBe(357113)
    expect(answer.view.postageExcludedCents).toBe(37075)
    expect(answer.view.operatingSubtotalCents).toBe(320038)
    expect(answer.view.softwareCents).toBe(83626)
    expect(answer.view.contractorsCents).toBe(180780)
    expect(answer.view.communicationsCents).toBe(42632)
    expect(answer.view.bankFeesCents).toBe(13000)
    expect(answer.view.operatingSubtotalCents + answer.view.postageExcludedCents).toBe(357113)
    expect(answer.view.netProfit).toBeNull()
  })

  it('does not copy September backward to June or forward to November', () => {
    for (const period of ['2026-06', '2026-06-01', '2026-11', '2026-11-30']) {
      const answer = bankOperatingFor(period, lines)
      expect(answer.status).toBe('unknown')
      if (answer.status !== 'unknown') continue
      expect(answer.reason).toMatch(/unknown, not zero/)
      expect(answer.reason).not.toMatch(/3200\.38|3571\.13/)
    }
  })

  it('keeps bank operating costs off the fulfillment and shipping bases', () => {
    expect(BANK_OPEX_SEPARATE_FROM_DIRECT).toMatch(/not fulfillment direct costs/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/shipment/i)
    expect(DASHBOARD_SHIPPING_BASIS).toMatch(/shipments only/i)
    expect(FULFILLMENT_PNL_BASIS).not.toMatch(/3200\.38/)
  })
})
