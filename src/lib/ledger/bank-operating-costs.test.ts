import { describe, expect, it } from 'vitest'
import {
  bankOperatingFor,
  loadOctober2026BankLines,
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

  it('does not treat September lines as October, or the reverse', () => {
    const october = loadOctober2026BankLines()
    const asOctober = bankOperatingFor('2026-10', lines)
    const asSeptember = bankOperatingFor('2026-09', october)
    expect(asOctober.status).toBe('unknown')
    expect(asSeptember.status).toBe('unknown')
    const together = lines.length + october.length
    expect(together).toBe(58)
    const sep = bankOperatingFor('2026-09', lines)
    const oct = bankOperatingFor('2026-10', october)
    if (sep.status !== 'provisional' || oct.status !== 'provisional') return
    expect(sep.view.operatingSubtotalCents + oct.view.operatingSubtotalCents).not.toBe(sep.view.operatingSubtotalCents)
    expect(sep.view.expendituresCents).toBe(357113)
    expect(oct.view.expendituresCents).toBe(523706)
  })
})

describe('October 2026 bank operating costs', () => {
  const october = loadOctober2026BankLines()

  it('reconciles 20 lines: withdrawals 5217.06 plus fees 20.00 equal 5237.06', () => {
    const answer = bankOperatingFor('2026-10', october)
    expect(answer.status).toBe('provisional')
    if (answer.status !== 'provisional') return
    expect(answer.view.lines).toBe(20)
    expect(answer.view.label).toBe('Oct 2026')
    expect(answer.view.annualized).toBe(false)
    expect(answer.view.withdrawalsCents).toBe(521706)
    expect(answer.view.bankFeesCents).toBe(2000)
    expect(answer.view.expendituresCents).toBe(523706)
    expect(answer.view.softwareCents).toBe(19187)
    expect(answer.view.contractorsCents).toBe(472324)
    expect(answer.view.communicationsCents).toBe(4726)
    expect(answer.view.otherCents).toBe(25469)
    expect(answer.view.postageExcludedCents).toBe(0)
    expect(answer.view.operatingSubtotalCents).toBe(523706)
    expect(answer.view.netProfit).toBeNull()
  })

  it('keeps Cash App unconfirmed and Apple and uPrinting provisional', () => {
    const cashApp = october.filter((line) => line.payee.startsWith('Cash App'))
    expect(cashApp).toHaveLength(10)
    for (const line of cashApp) {
      expect(line.note.toLowerCase()).toContain('not labeled as confirmed payroll')
      expect(line.note.toLowerCase()).not.toContain('confirmed payroll expense')
    }
    const apple = october.filter((line) => line.payee.startsWith('Apple.com'))
    expect(apple.map((line) => line.note).join(' ')).toMatch(/provisional unreviewed bank classification/i)
    const printing = october.find((line) => line.payee.startsWith('uPrinting'))
    expect(printing?.category).toBe('other')
    expect(printing?.note).toMatch(/provisional unreviewed bank classification/i)
    expect(printing?.note).toMatch(/COGS vs OpEx/)
  })

  it('does not apply October to June, September, or November', () => {
    for (const period of ['2026-06', '2026-09', '2026-11']) {
      const answer = bankOperatingFor(period, october)
      expect(answer.status).toBe('unknown')
      if (answer.status !== 'unknown') continue
      expect(answer.reason).toMatch(/unknown, not zero/)
      expect(answer.reason).not.toMatch(/5237\.06|5217\.06/)
    }
  })
})

describe('bank samples stay off direct cost', () => {
  it('keeps bank operating costs off the fulfillment and shipping bases', () => {
    expect(BANK_OPEX_SEPARATE_FROM_DIRECT).toMatch(/not fulfillment direct costs/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/shipment/i)
    expect(DASHBOARD_SHIPPING_BASIS).toMatch(/shipments only/i)
    expect(FULFILLMENT_PNL_BASIS).not.toMatch(/3200\.38/)
  })
})
