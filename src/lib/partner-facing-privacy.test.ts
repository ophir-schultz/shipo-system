import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildStatement, computeOwed, type FbaInvoice, type ReferralPartner, type ReferredClient } from './referrals'
import { projectPartnerStatement, partnerMoneyLeaks } from './partner-facing'
import { buildPartnerReport } from './partner-report'
import { buildPartnerGuideEmail } from './partner-guide-email'
import { ROSTER_STATE_TEXT } from './partner-roster'
import { PARTNER_TERMS_SECTIONS } from './partner-terms'
import { portalAccessBlock } from './partner-access'
import { holdsW9 } from './partner-w9'
import { needsAcceptance } from './partner-terms'
import { agreementLookupSteps } from './partner-agreement-match'

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const PARTNER_SURFACES = [
  'src/components/partner/Statement.tsx',
  'src/lib/partner-report.ts',
  'src/lib/partner-guide-email.ts',
  'src/lib/partner-roster.ts',
  'src/lib/partner-terms.ts',
  'src/app/api/partner/report/route.ts',
]

describe('partner surfaces do not carry Shipo cost inputs', () => {
  it('reads the surfaces (control)', () => {
    for (const file of PARTNER_SURFACES) {
      expect(codeOf(file).length, file).toBeGreaterThan(200)
    }
  })

  it('names none of the cost, profit, or rate labels in partner-facing code', () => {
    const leaks = PARTNER_SURFACES.flatMap((file) =>
      partnerMoneyLeaks(codeOf(file)).map((hit) => `${file}: ${hit}`),
    )
    expect(leaks).toEqual([])
  })

  it('would catch a freight label (control)', () => {
    expect(partnerMoneyLeaks('Freight & carrier')).not.toEqual([])
  })
})

describe('the partner flow keeps its gates and then shows only the payout', () => {
  const partner: ReferralPartner = {
    id: 'p1',
    name: 'Dana Partner',
    company: null,
    status: 'active',
    email: 'dana@example.com',
    agreement_status: 'signed',
  } as ReferralPartner

  const client: ReferredClient = {
    id: 'c1',
    name: 'Acme Goods',
    referral_partner_id: 'p1',
    referral_signup_date: '2026-01-05',
    referral_first_payment_date: '2026-02-01',
  }

  const invoice: FbaInvoice = {
    id: 'i1',
    client_id: 'c1',
    period: '2026-02-01',
    amount: 4000,
    cost_freight: 222.22,
    cost_materials: 33.33,
    cost_storage: 44.44,
    cost_processing: 55.55,
  }

  it('refuses portal access until the agreement is signed, and does not treat a sent envelope as signed', () => {
    expect(portalAccessBlock({ ...partner, agreement_status: 'sent' })).toBe('unsigned')
    expect(portalAccessBlock({ ...partner, agreement_status: 'not_sent' })).toBe('unsigned')
    expect(portalAccessBlock({ ...partner, agreement_status: null })).toBe('unsigned')
    expect(portalAccessBlock(partner)).toBeNull()
  })

  it('still withholds money until a tax form is on file', () => {
    expect(holdsW9({ w9_received_at: null })).toBe(false)
    expect(holdsW9({ w9_received_at: '2026-03-01T00:00:00Z' })).toBe(true)
  })

  it('asks for the current terms before a statement', () => {
    expect(needsAcceptance([])).toBe(true)
    expect(needsAcceptance([{ terms_version: '2026-10-13' }])).toBe(true)
    expect(needsAcceptance([{ terms_version: '2026-11-06' }])).toBe(false)
  })

  it('terms, roster copy, and the guide do not describe costs or the rate', () => {
    const terms = PARTNER_TERMS_SECTIONS.map((s) => `${s.heading} ${s.body}`).join('\n')
    const roster = Object.values(ROSTER_STATE_TEXT).join('\n')
    const guide = buildPartnerGuideEmail(
      { id: 'p1', name: 'Dana', email: 'dana@example.com', status: 'active', agreement_status: 'signed' },
      'https://partners.shipousa.com',
    )
    expect(guide).not.toBeNull()
    expect(partnerMoneyLeaks(terms)).toEqual([])
    expect(partnerMoneyLeaks(roster)).toEqual([])
    expect(partnerMoneyLeaks(guide!.text)).toEqual([])
    expect(partnerMoneyLeaks(guide!.html)).toEqual([])
  })

  it('computes a commission on the server and the download contains only that amount', () => {
    const owed = computeOwed([partner], [client], [invoice], [], { now: new Date('2026-03-15T12:00:00Z') })
    const facing = projectPartnerStatement(buildStatement(partner.id, [client], owed, [invoice]))
    const csv = buildPartnerReport({
      statement: facing,
      roster: [],
      bonuses: null,
      orders: [],
      ordersTruncated: false,
      fba: [],
    })
    const projected = JSON.stringify(facing)
    for (const secret of ['4000', '222.22', '33.33', '44.44', '55.55']) {
      expect(csv, secret).not.toContain(secret)
      expect(projected, secret).not.toContain(secret)
    }
    expect(partnerMoneyLeaks(csv)).toEqual([])
    expect(facing.months.some((m) => m.clients.some((c) => c.commission > 0))).toBe(true)
    expect(csv).toContain('Commission')
  })

  it('does not offer an email lookup for a Connect event that has no partner id', () => {
    const steps = agreementLookupSteps({ partnerIdField: null, envelopeId: 'env-1' })
    expect(steps.map((s) => s.via)).toEqual(['stored_envelope'])
    expect(JSON.stringify(steps)).not.toMatch(/email/i)
  })
})
