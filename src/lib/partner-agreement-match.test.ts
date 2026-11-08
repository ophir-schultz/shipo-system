import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_NOT_SENT_FROM_DASHBOARD,
  CONNECT_CAN_RECEIVE,
  CONNECT_IS_OFF,
  UNMATCHED_EVENT_COLUMNS,
  agreementLookupSteps,
  planAgreementLink,
  planAgreementLinks,
  type AgreementEventRow,
} from './partner-agreement-match'
import { docusignReadiness } from './docusign-client'

describe('agreementLookupSteps', () => {
  it('uses a partner id we set, and never an address', () => {
    const steps = agreementLookupSteps({ partnerIdField: '  p1  ', envelopeId: 'env-9' })
    expect(steps).toEqual([
      { via: 'partner_id', partnerId: 'p1' },
      { via: 'stored_envelope', envelopeId: 'env-9' },
    ])
  })

  it('looks up only a stored envelope id when the payload has no partner id', () => {
    // The production Connect events. They carried a signer email and no
    // partner_id. The email is not an input to this function, so it cannot
    // become a match.
    expect(agreementLookupSteps({ partnerIdField: null, envelopeId: 'env-9' })).toEqual([
      { via: 'stored_envelope', envelopeId: 'env-9' },
    ])
    expect(agreementLookupSteps({ partnerIdField: '   ', envelopeId: 'env-9' })).toEqual([
      { via: 'stored_envelope', envelopeId: 'env-9' },
    ])
  })

  it('matches nobody when both keys are blank', () => {
    expect(agreementLookupSteps({ partnerIdField: null, envelopeId: '  ' })).toEqual([])
  })
})

const liveShape: AgreementEventRow[] = [
  { envelopeId: 'env-void-nov6', event: 'voided', referralPartnerId: null },
  { envelopeId: 'env-void-nov3', event: 'voided', referralPartnerId: null },
  { envelopeId: 'env-done-oct28', event: 'completed', referralPartnerId: null },
  { envelopeId: 'env-done-oct26-a', event: 'completed', referralPartnerId: null },
  { envelopeId: 'env-done-oct26-b', event: 'completed', referralPartnerId: null },
]

describe('staff agreement link plan', () => {
  it('leaves every unmatched event unmatched when nobody names a partner', () => {
    const plans = planAgreementLinks(liveShape, [])
    expect(plans.every((plan) => plan.action === 'unmatched')).toBe(true)
    expect(plans).toHaveLength(5)
  })

  it('refuses a voided envelope and does not treat a completed one as consent', () => {
    expect(planAgreementLink(liveShape[0], {
      envelopeId: 'env-void-nov6', partnerId: 'partner-signed',
    })).toMatchObject({ action: 'refuse' })
    const completed = planAgreementLink(liveShape[2], {
      envelopeId: 'env-done-oct28', partnerId: 'partner-signed',
    })
    expect(completed).toMatchObject({
      action: 'link',
      partnerId: 'partner-signed',
      grantsAccess: false,
      setsAgreementStatus: false,
      setsW9: false,
    })
  })

  it('is idempotent for the same pair and refuses to move an existing link', () => {
    const first = planAgreementLink(liveShape[2], {
      envelopeId: 'env-done-oct28', partnerId: 'partner-signed',
    })
    expect(first.action).toBe('link')
    const second = planAgreementLink(
      { ...liveShape[2], referralPartnerId: 'partner-signed' },
      { envelopeId: 'env-done-oct28', partnerId: 'partner-signed' },
    )
    expect(second.action).toBe('noop')
    const moved = planAgreementLink(
      { ...liveShape[2], referralPartnerId: 'partner-signed' },
      { envelopeId: 'env-done-oct28', partnerId: 'someone-else' },
    )
    expect(moved.action).toBe('refuse')
  })

  it('collapses a repeated envelope in one batch', () => {
    const plans = planAgreementLinks(
      [liveShape[2], { ...liveShape[2], event: 'completed' }],
      [{ envelopeId: 'env-done-oct28', partnerId: 'partner-signed' }],
    )
    expect(plans.map((plan) => plan.action)).toEqual(['link', 'noop'])
  })
})

describe('the webhook does not match by email', () => {
  const src = readFileSync('src/app/api/partner/agreement-webhook/route.ts', 'utf8')

  it('was read (control)', () => {
    expect(src).toContain('agreementLookupSteps')
  })

  it('does not query partners by the signer address', () => {
    // `recipients` stays: a declined envelope still records the signer's
    // declinedReason. That is not a lookup key.
    expect(src).not.toContain("ilike('email'")
    expect(src).not.toContain('signerEmail')
    expect(src).not.toMatch(/\.eq\(\s*'email'/)
  })
})

describe('staff are told the dashboard cannot send an agreement', () => {
  it('says there is no send action and that email is not a match', () => {
    expect(AGREEMENT_NOT_SENT_FROM_DASHBOARD).toMatch(/does not create or send/i)
    expect(AGREEMENT_NOT_SENT_FROM_DASHBOARD).toMatch(/email is never enough/i)
    expect(CONNECT_CAN_RECEIVE).toMatch(/cannot send/i)
    expect(CONNECT_IS_OFF).toContain('DOCUSIGN_CONNECT_SECRET')
  })

  it('the unmatched list does not include the stored payload', () => {
    expect(UNMATCHED_EVENT_COLUMNS).toBe('envelope_id, event, processed_at')
    expect(UNMATCHED_EVENT_COLUMNS).not.toContain('payload')
  })

  it('the referrals page selects those columns and renders the notice', () => {
    const page = readFileSync('src/app/referrals/page.tsx', 'utf8')
    const notice = readFileSync('src/components/partner/DocusignNotice.tsx', 'utf8')
    expect(page).toContain('UNMATCHED_EVENT_COLUMNS')
    expect(page).toContain('REFERRALS_MONEY_SOURCE')
    expect(page).not.toMatch(/select\(\s*[^)]*payload/)
    expect(notice).toContain('AGREEMENT_NOT_SENT_FROM_DASHBOARD')
  })
})

describe('docusignReadiness', () => {
  const six = {
    DOCUSIGN_INTEGRATION_KEY: 'ik',
    DOCUSIGN_USER_ID: 'uid',
    DOCUSIGN_ACCOUNT_ID: 'acct',
    DOCUSIGN_PRIVATE_KEY: 'key',
    DOCUSIGN_ACCOUNT_BASE_URI: 'https://na3.docusign.net',
    DOCUSIGN_OAUTH_HOST: 'account.docusign.com',
  }

  it('treats a Connect secret alone as a webhook that can receive and an API that cannot send', () => {
    // Production: only DOCUSIGN_CONNECT_SECRET is set.
    const ready = docusignReadiness({ DOCUSIGN_CONNECT_SECRET: 'secret' })
    expect(ready.connectConfigured).toBe(true)
    expect(ready.apiMissing).toEqual([
      'DOCUSIGN_INTEGRATION_KEY',
      'DOCUSIGN_USER_ID',
      'DOCUSIGN_ACCOUNT_ID',
      'DOCUSIGN_PRIVATE_KEY',
      'DOCUSIGN_ACCOUNT_BASE_URI',
      'DOCUSIGN_OAUTH_HOST',
    ])
    expect(ready.w9Missing).toContain('ACCOUNTANT_W9_EMAIL')
  })

  it('does not report the API missing when the six variables are set', () => {
    const ready = docusignReadiness({
      ...six,
      DOCUSIGN_CONNECT_SECRET: 'secret',
      ACCOUNTANT_W9_EMAIL: 'books@example.com',
      ACCOUNTANT_W9_NAME: 'Books',
      NEXT_PUBLIC_SITE_URL: 'https://partners.shipousa.com',
    })
    expect(ready.apiMissing).toEqual([])
    expect(ready.w9Missing).toEqual([])
    expect(ready.connectConfigured).toBe(true)
  })

  it('reports Connect off when the secret is blank, without printing the secret', () => {
    const ready = docusignReadiness({ ...six, DOCUSIGN_CONNECT_SECRET: '   ' })
    expect(ready.connectConfigured).toBe(false)
    expect(JSON.stringify(ready)).not.toContain('super-secret')
  })
})
