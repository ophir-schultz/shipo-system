import { describe, it, expect } from 'vitest'
import { clientIp, acceptanceRow, USER_AGENT_MAX } from './partner-terms-record'
import { PARTNER_TERMS_VERSION } from './partner-terms'

describe('clientIp', () => {
  it('takes the FIRST hop of a Vercel chain', () => {
    expect(clientIp('203.0.113.7, 198.51.100.2, 10.0.0.1')).toBe('203.0.113.7')
  })
  it('trims surrounding whitespace', () => {
    expect(clientIp('  203.0.113.7  ')).toBe('203.0.113.7')
  })
  it('returns a single address unchanged', () => {
    expect(clientIp('203.0.113.7')).toBe('203.0.113.7')
  })
  it('is null for absent, empty or whitespace-only headers', () => {
    expect(clientIp(null)).toBeNull()
    expect(clientIp(undefined)).toBeNull()
    expect(clientIp('')).toBeNull()
    expect(clientIp('   ')).toBeNull()
    expect(clientIp(' , 10.0.0.1')).toBeNull()
  })
})

describe('acceptanceRow', () => {
  it('stamps the CURRENT version, never one supplied by the caller', () => {
    const row = acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: null })
    expect(row.terms_version).toBe(PARTNER_TERMS_VERSION)
  })
  it('carries the partner id and the first-hop ip', () => {
    const row = acceptanceRow({
      partnerId: 'p1',
      forwardedFor: '203.0.113.7, 10.0.0.1',
      userAgent: 'Mozilla/5.0',
    })
    expect(row.referral_partner_id).toBe('p1')
    expect(row.ip).toBe('203.0.113.7')
    expect(row.user_agent).toBe('Mozilla/5.0')
  })
  it('truncates a long user agent and nulls an empty one', () => {
    const row = acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: 'x'.repeat(5000) })
    expect(row.user_agent).toHaveLength(USER_AGENT_MAX)
    expect(acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: '' }).user_agent).toBeNull()
  })
})
