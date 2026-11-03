import { describe, expect, it } from 'vitest'
import {
  readZenventoryClientCredentials,
  zenventoryEnvNames,
  zenventorySlug,
} from './client-env'

describe('per-client Zenventory env credentials', () => {
  it('maps a client name to a slug and the env var names', () => {
    expect(zenventorySlug('Orcam')).toBe('ORCAM')
    expect(zenventorySlug('  Nayax ')).toBe('NAYAX')
    expect(zenventoryEnvNames('ORCAM')).toEqual({
      key: 'ZENVENTORY_KEY_ORCAM',
      secret: 'ZENVENTORY_SECRET_ORCAM',
      secure: 'ZENVENTORY_SECURE_ORCAM',
    })
  })

  it('reads the key and secret for that slug and does not require the secure key', () => {
    const read = readZenventoryClientCredentials('Orcam', {
      ZENVENTORY_KEY_ORCAM: 'key',
      ZENVENTORY_SECRET_ORCAM: 'secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('key')
    expect(read.credentials.apiSecret).toBe('secret')
    expect(read.credentials.secureKey).toBeNull()
  })

  it('says not configured and names the missing variables', () => {
    const read = readZenventoryClientCredentials('Orcam', {}, { requireSecure: true })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('not configured')
    expect(read.notice).toContain('ZENVENTORY_KEY_ORCAM')
    expect(read.notice).toContain('ZENVENTORY_SECRET_ORCAM')
    expect(read.notice).toContain('ZENVENTORY_SECURE_ORCAM')
  })

  it('says not configured when the client has no slug', () => {
    const read = readZenventoryClientCredentials('Unknown Co', {
      ZENVENTORY_KEY_UNKNOWN: 'key',
      ZENVENTORY_SECRET_UNKNOWN: 'secret',
    })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('not configured')
    expect(read.notice).toContain('No slug')
  })
})
