import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_NOT_SENT_FROM_DASHBOARD,
  CONNECT_CAN_RECEIVE,
  CONNECT_IS_OFF,
  UNMATCHED_EVENT_COLUMNS,
  agreementLookupSteps,
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
