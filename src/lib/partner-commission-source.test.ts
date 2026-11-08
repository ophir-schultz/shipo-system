import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeOwed, type FbaInvoice, type ReferralPartner, type ReferredClient } from './referrals'
import { emptyReferralBooks, STORED_COMMISSION_IGNORED } from './partner-money-source'

describe('stored flat commission is not the payout', () => {
  it('pays 5% of net profit when the stored commission value is 0', () => {
    const partner = {
      id: 'p1',
      name: 'Partner',
      company: null,
      status: 'active',
      commission_type: 'flat',
      commission_value: 0,
    } as ReferralPartner & { commission_type: string; commission_value: number }
    const client: ReferredClient = {
      id: 'c1',
      name: 'Client',
      referral_partner_id: 'p1',
      referral_signup_date: null,
      referral_first_payment_date: '2026-01-15',
    }
    const invoice: FbaInvoice = {
      id: 'inv-1',
      client_id: 'c1',
      period: '2026-01-01',
      amount: 1000,
      cost_freight: 200,
      cost_materials: 0,
      cost_storage: 0,
      cost_processing: 0,
    }
    const commission = computeOwed([partner], [client], [invoice], [])
      .find((line) => line.kind === 'commission')
    expect(commission?.amount).toBe(40)
    expect(commission?.amount).not.toBe(0)
  })

  it('says an empty book is a real zero and not the stored flat value', () => {
    const empty = emptyReferralBooks({ linkedClients: 0, invoiceRows: 0, payoutRows: 0 })
    expect(empty.genuineZero).toBe(true)
    expect(empty.text).toMatch(/not the stored commission value/)
    expect(emptyReferralBooks({ linkedClients: 1, invoiceRows: 0, payoutRows: 0 }).genuineZero).toBe(false)
    expect(STORED_COMMISSION_IGNORED).toMatch(/flat 0 does not/)
    expect(STORED_COMMISSION_IGNORED).toMatch(/5%/)
    expect(STORED_COMMISSION_IGNORED).toMatch(/\$300/)
    expect(STORED_COMMISSION_IGNORED).toMatch(/\$50/)
    expect(STORED_COMMISSION_IGNORED).toMatch(/not copied from the P&L/)
  })

  it('computeOwed does not read the stored commission columns', () => {
    const src = readFileSync('src/lib/referrals.ts', 'utf8')
    expect(src).not.toContain('commission_value')
    expect(src).not.toContain('commission_type')
  })
})
