import { describe, expect, it } from 'vitest'
import {
  DOCUSIGN_ENV_VARS,
  docusignConfig,
  docusignConfigMissing,
  jwtClaims,
  recipientViewRequest,
} from './docusign-client'

/**
 * The configuration half of the DocuSign client, which is the half that
 * can be wrong without anybody noticing.
 *
 * The two network calls are not tested here and cannot be: there is no
 * DocuSign account this suite may reach, and a mock of DocuSign tests my
 * guess about DocuSign. What IS tested is everything decided before the
 * socket opens — whether we are configured at all, what the assertion
 * claims, and the exact shape of the recipient-view request, which
 * DocuSign rejects outright when one field disagrees with the envelope.
 */

const FULL = {
  DOCUSIGN_INTEGRATION_KEY: 'ik',
  DOCUSIGN_USER_ID: 'uid',
  DOCUSIGN_ACCOUNT_ID: 'acct',
  DOCUSIGN_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
  DOCUSIGN_ACCOUNT_BASE_URI: 'https://na3.docusign.net',
  DOCUSIGN_OAUTH_HOST: 'account.docusign.com',
}

describe('docusignConfigMissing', () => {
  it('is empty when every variable is set', () => {
    expect(docusignConfigMissing(FULL)).toEqual([])
  })

  it('names every variable that is absent', () => {
    expect(docusignConfigMissing({})).toEqual([...DOCUSIGN_ENV_VARS])
  })

  it('treats blank and whitespace as absent', () => {
    expect(docusignConfigMissing({ ...FULL, DOCUSIGN_ACCOUNT_ID: '' })).toEqual([
      'DOCUSIGN_ACCOUNT_ID',
    ])
    expect(docusignConfigMissing({ ...FULL, DOCUSIGN_USER_ID: '   ' })).toEqual([
      'DOCUSIGN_USER_ID',
    ])
  })

  it('has no defaults — not one of these may be guessed', () => {
    // A default oauth host sends real partners' tax forms to the demo
    // account, or demo traffic to production. A default account id signs
    // against somebody else's account. There is no safe guess here, so
    // the list and the refusal are the whole mechanism.
    for (const name of DOCUSIGN_ENV_VARS) {
      const partial = { ...FULL, [name]: '' }
      expect(docusignConfigMissing(partial)).toEqual([name])
      expect(docusignConfig(partial)).toBeNull()
    }
  })
})

describe('docusignConfig', () => {
  it('is null when anything is missing, so the caller cannot half-configure a send', () => {
    expect(docusignConfig({})).toBeNull()
  })

  it('reads every value through', () => {
    const cfg = docusignConfig(FULL)!
    expect(cfg.integrationKey).toBe('ik')
    expect(cfg.userId).toBe('uid')
    expect(cfg.accountId).toBe('acct')
  })

  it('restores the newlines a dashboard env var flattens', () => {
    // THE BUG THIS EXISTS FOR. Vercel's env editor stores a pasted PEM
    // with literal backslash-n sequences. crypto.createSign then fails
    // with "error:1E08010C:DECODER routines::unsupported", which reads as
    // a bad key rather than a bad transport, and the obvious response is
    // to regenerate a key that was fine.
    const flat = { ...FULL, DOCUSIGN_PRIVATE_KEY: '-----BEGIN X-----\\nabc\\n-----END X-----' }
    const cfg = docusignConfig(flat)!
    expect(cfg.privateKey).toBe('-----BEGIN X-----\nabc\n-----END X-----')
    expect(cfg.privateKey).not.toContain('\\n')
  })

  it('leaves a properly multi-line key alone', () => {
    expect(docusignConfig(FULL)!.privateKey).toBe(FULL.DOCUSIGN_PRIVATE_KEY)
  })

  it('builds the REST base without doubling the slash or the path', () => {
    for (const base of [
      'https://na3.docusign.net',
      'https://na3.docusign.net/',
      'https://na3.docusign.net/restapi',
      'https://na3.docusign.net/restapi/',
    ]) {
      expect(docusignConfig({ ...FULL, DOCUSIGN_ACCOUNT_BASE_URI: base })!.restBase).toBe(
        'https://na3.docusign.net/restapi',
      )
    }
  })

  it('accepts the oauth host with or without a scheme and keeps only the host', () => {
    // The JWT `aud` must be the bare host. A scheme in it produces an
    // "invalid_grant" that says nothing about which field was wrong.
    for (const host of [
      'account.docusign.com',
      'https://account.docusign.com',
      'https://account.docusign.com/',
    ]) {
      expect(docusignConfig({ ...FULL, DOCUSIGN_OAUTH_HOST: host })!.oauthHost).toBe(
        'account.docusign.com',
      )
    }
  })
})

describe('jwtClaims', () => {
  const cfg = docusignConfig(FULL)!

  it('claims the integration key as issuer and the user as subject', () => {
    const c = jwtClaims(cfg, 1_760_000_000)
    expect(c.iss).toBe('ik')
    expect(c.sub).toBe('uid')
  })

  it('audiences the bare oauth host', () => {
    expect(jwtClaims(cfg, 1_760_000_000).aud).toBe('account.docusign.com')
  })

  it('asks for impersonation, which is what makes a service account possible', () => {
    // Without `impersonation` the token belongs to nobody and every
    // envelope call returns 401. Without `signature` it cannot send.
    const scopes = jwtClaims(cfg, 1_760_000_000).scope.split(' ')
    expect(scopes).toContain('signature')
    expect(scopes).toContain('impersonation')
  })

  it('expires within the hour DocuSign allows', () => {
    const c = jwtClaims(cfg, 1_760_000_000)
    expect(c.iat).toBe(1_760_000_000)
    expect(c.exp - c.iat).toBeGreaterThan(0)
    expect(c.exp - c.iat).toBeLessThanOrEqual(3600)
  })

  it('carries no secret', () => {
    // The assertion is signed, not encrypted, and anything in it is
    // readable by anyone who sees the request.
    const json = JSON.stringify(jwtClaims(cfg, 1_760_000_000))
    expect(json).not.toContain('PRIVATE KEY')
    expect(json).not.toContain('abc')
  })
})

describe('recipientViewRequest', () => {
  const view = recipientViewRequest({
    email: 'partner@example.com',
    userName: 'Acme LLC',
    clientUserId: 'partner-uuid',
    returnUrl: 'https://portal.example.com/partner',
  })

  it('identifies the recipient the same three ways the envelope did', () => {
    // DocuSign matches on email + name + clientUserId together. One
    // mismatch — a trimmed name, a lowercased email, a partner id taken
    // from a different column — is a 400 reading "Unknown recipient", and
    // the partner sees a dead button.
    expect(view.email).toBe('partner@example.com')
    expect(view.userName).toBe('Acme LLC')
    expect(view.clientUserId).toBe('partner-uuid')
  })

  it('returns the partner to his own dashboard', () => {
    expect(view.returnUrl).toBe('https://portal.example.com/partner')
  })

  it('does not claim we authenticated him', () => {
    // We did authenticate him — an emailed code — and `none` is what
    // DocuSign's own docs use for that case. What it must not say is
    // that DocuSign verified an identity, because DocuSign did not.
    expect(view.authenticationMethod).toBe('none')
  })
})
