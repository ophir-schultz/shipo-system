import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPartnerGuideEmail } from './partner-guide-email'
import {
  PARTNER_TERMS_SECTIONS,
  PARTNER_TERMS_VERSION,
  STATEMENT_DISPUTE_WINDOW_DAYS,
  needsAcceptance,
  statementDisputeWindowPhrase,
} from './partner-terms'
import {
  REFERRAL_TERMS,
  buildStatement,
  computeOwed,
  netProfit,
  partnerAgreementSigned,
  type FbaInvoice,
  type ReferralPartner,
  type ReferredClient,
} from './referrals'

/**
 * The signed MileMogul agreement: commission and the signup bonus
 * start only after the agreement is signed, and a statement figure
 * may be disputed for 60 days (clause 3.8), not 30.
 *
 * The "Within 30 days of the end of the month" line on the statement
 * is payment timing (clause 3.6). It is a different sentence and stays.
 */

function partner(over: Partial<ReferralPartner> = {}): ReferralPartner {
  return {
    id: 'p1',
    name: 'Mile Mogul',
    company: null,
    status: 'active',
    agreement_status: 'signed',
    agreement_signed_at: '2026-10-23T23:38:42Z',
    ...over,
  }
}

function client(): ReferredClient {
  return {
    id: 'c1',
    name: 'Referred Co',
    referral_partner_id: 'p1',
    referral_signup_date: '2026-01-02',
    referral_first_payment_date: '2026-01-15',
  }
}

/** Standing month: $2,000 invoiced, $600 of the four deductible costs. */
function invoice(period: string, amount = 2000): FbaInvoice {
  return {
    id: `inv-${period}`,
    client_id: 'c1',
    period,
    amount,
    cost_freight: 400,
    cost_materials: 100,
    cost_storage: 50,
    cost_processing: 50,
  }
}

function yearOfInvoices(): FbaInvoice[] {
  const rows: FbaInvoice[] = []
  for (let i = 0; i < 13; i++) {
    const d = new Date(Date.UTC(2026, i, 1))
    rows.push(invoice(d.toISOString().slice(0, 10)))
  }
  return rows
}

function owedAmount(lines: { amount: number }[]): number {
  return Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100
}

describe('commission is calculated only after the agreement is signed', () => {
  const invoices = yearOfInvoices()
  const referred = client()

  it('keeps the standing rates', () => {
    expect(REFERRAL_TERMS.SIGNUP_BONUS).toBe(300)
    expect(REFERRAL_TERMS.COMMISSION_RATE).toBe(0.05)
    expect(REFERRAL_TERMS.COMMISSION_MONTHS).toBe(12)
    expect(REFERRAL_TERMS.MIN_PAYOUT).toBe(50)
  })

  it('pays an unsigned or sent-only partner $0 when a client and invoices exist', () => {
    for (const agreement_status of ['sent', 'not_sent', null, '', 'partially_signed'] as const) {
      const lines = computeOwed(
        [partner({ agreement_status, agreement_signed_at: null })],
        [referred],
        invoices,
        [],
      )
      expect(lines, agreement_status ?? 'null').toEqual([])
      expect(owedAmount(lines)).toBe(0)
    }
    const omitted = computeOwed(
      [partner({ agreement_status: undefined, agreement_signed_at: undefined })],
      [referred],
      invoices,
      [],
    )
    expect(omitted).toEqual([])
  })

  it('does not treat a voided or declined agreement as signed just because a timestamp remains', () => {
    for (const agreement_status of ['voided', 'declined'] as const) {
      expect(partnerAgreementSigned(partner({ agreement_status }))).toBe(false)
      const lines = computeOwed([partner({ agreement_status })], [referred], invoices, [])
      expect(lines).toEqual([])
    }
  })

  it('pays a signed partner the $300 bonus and 5% of net profit for 12 months', () => {
    const sample = invoices[0]
    // Labor is not a deductible cost. Net profit is the invoice less
    // freight, materials, storage and payment fees only.
    expect(netProfit(sample)).toBe(1400)
    expect(sample.amount - 400 - 100 - 50 - 50).toBe(1400)

    const lines = computeOwed([partner()], [referred], invoices, [])
    const bonuses = lines.filter((line) => line.kind === 'signup_bonus')
    const commissions = lines.filter((line) => line.kind === 'commission')

    expect(bonuses).toHaveLength(1)
    expect(bonuses[0].amount).toBe(300)
    expect(bonuses[0].period).toBe('2026-01')

    expect(commissions).toHaveLength(12)
    expect(commissions.every((line) => line.amount === 70)).toBe(true)
    expect(commissions.map((line) => line.period).sort()).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ])
    expect(lines.some((line) => line.period === '2027-01' && line.kind === 'commission')).toBe(false)
    expect(owedAmount(lines)).toBe(300 + 70 * 12)
  })

  it('still pays when status is signed and the timestamp was never stored', () => {
    const lines = computeOwed(
      [partner({ agreement_status: 'signed', agreement_signed_at: null })],
      [referred],
      [invoices[0]],
      [],
    )
    expect(lines.find((line) => line.kind === 'signup_bonus')?.amount).toBe(300)
    expect(lines.find((line) => line.kind === 'commission')?.amount).toBe(70)
  })

  it('still pays when the timestamp is set and status has not been flipped off sent', () => {
    const lines = computeOwed(
      [partner({ agreement_status: 'sent', agreement_signed_at: '2026-10-23T23:38:42Z' })],
      [referred],
      [invoices[0]],
      [],
    )
    expect(owedAmount(lines)).toBe(370)
  })

  it('still accrues for a signed partner with no W-9, and still rolls a balance under $50', () => {
    const january = invoice('2026-01-01')
    const february: FbaInvoice = {
      id: 'inv-feb',
      client_id: 'c1',
      period: '2026-02-01',
      amount: 1000,
      cost_freight: 200,
      cost_materials: 0,
      cost_storage: 0,
      cost_processing: 0,
    }
    expect(netProfit(february) * REFERRAL_TERMS.COMMISSION_RATE).toBe(40)

    const lines = computeOwed([partner()], [referred], [january, february], [])
    expect(lines.find((line) => line.kind === 'signup_bonus')?.amount).toBe(300)

    const statement = buildStatement(partner().id, [referred], lines, [january, february])
    const feb = statement.months.find((month) => month.period === '2026-02')
    expect(feb?.earned).toBe(40)
    expect(feb?.payable).toBe(0)
    expect(feb?.carriedOut).toBe(40)

    const src = readFileSync('src/lib/referrals.ts', 'utf8')
    expect(src).not.toContain('w9_received_at')
    expect(src).not.toContain('holdsW9')
  })
})

describe('the partner-visible dispute window is 60 days', () => {
  it('uses the sixty-day objection window from the signed agreement', () => {
    expect(STATEMENT_DISPUTE_WINDOW_DAYS).toBe(60)
    expect(statementDisputeWindowPhrase()).toBe('within 60 days')
    expect(PARTNER_TERMS_VERSION).toBe('2026-11-09')
    expect(needsAcceptance([{ terms_version: '2026-11-06' }])).toBe(true)
    expect(needsAcceptance([{ terms_version: PARTNER_TERMS_VERSION }])).toBe(false)

    const terms = PARTNER_TERMS_SECTIONS.map((section) => section.body).join('\n')
    expect(terms).toContain('within 60 days of receiving the statement')
    expect(terms).not.toMatch(/30 days/)

    const mail = buildPartnerGuideEmail(
      {
        id: 'p1',
        name: 'Dana Katz',
        email: 'dana@example.com',
        status: 'active',
        agreement_status: 'signed',
      },
      'https://partners.shipousa.com',
    )
    expect(mail).not.toBeNull()
    expect(mail!.html).toContain('within 60 days of receiving a statement')
    expect(mail!.text).toContain('within 60 days of receiving a statement')
    expect(mail!.html).not.toMatch(/30 days/)
    expect(mail!.text).not.toMatch(/30 days/)
  })

  it('says 60 days in the portal footer and the statement, and leaves payment timing at 30 days', () => {
    const layout = readFileSync('src/app/partner/layout.tsx', 'utf8')
    const statement = readFileSync('src/components/partner/Statement.tsx', 'utf8')
    expect(layout).toContain('statementDisputeWindowPhrase()')
    expect(layout).not.toMatch(/30 days/)
    expect(statement).toContain('statementDisputeWindowPhrase()')
    expect(statement).toContain("v: 'Within 30 days'")
    expect(statement).toContain("d: 'of the end of the month shown'")
    expect(statement).not.toContain('within 30 days')
  })

  it('has no remaining partner-facing "within 30 days" dispute sentence', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          if (name === 'node_modules') continue
          walk(path)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name) || name.endsWith('.test.ts')) continue
        const text = readFileSync(path, 'utf8')
        if (text.includes('within 30 days')) hits.push(path)
      }
    }
    walk('src')
    expect(hits).toEqual([])
  })
})
