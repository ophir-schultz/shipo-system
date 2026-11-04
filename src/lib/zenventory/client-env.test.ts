import { describe, expect, it } from 'vitest'
import {
  readZenventoryClientCredentials,
  zenventoryEnvNames,
  zenventorySlug,
} from './client-env'

describe('per-client Zenventory env credentials', () => {
  it('maps client names to the slugs saved in Preview', () => {
    expect(zenventorySlug('Orcam')).toBe('ORCAM')
    expect(zenventorySlug('  Nayax ')).toBe('NAYAX')
    expect(zenventorySlug('SitnStand')).toBe('SITNSTAND')
    expect(zenventorySlug('Crisp Power')).toBe('CRISP_POWER')
    expect(zenventorySlug('Creative Pea')).toBe('CREATIVEPEA')
    expect(zenventorySlug('Time Systems (UK) Ltd')).toBe('TIMESYSTEMS')
    expect(zenventorySlug('Suteka')).toBe('SUTEKA')
    expect(zenventorySlug('Kivema')).toBe('KIVEMA')
    expect(zenventorySlug('HexaPhoenix')).toBe('HEXAPHOENIX')
    expect(zenventorySlug('Vitamedix')).toBe('VITAMEDIX')
    expect(zenventorySlug('Hippie')).toBe('HIPPIE')
  })

  it('names the new env vars first and keeps the old names as the fallback', () => {
    expect(zenventoryEnvNames('ORCAM')).toEqual({
      key: 'ZEN_ORCAM_KEY',
      secret: 'ZEN_ORCAM_SECRET',
      secure: 'ZEN_ORCAM_SECURE',
      legacyKey: 'ZENVENTORY_KEY_ORCAM',
      legacySecret: 'ZENVENTORY_SECRET_ORCAM',
      legacySecure: 'ZENVENTORY_SECURE_ORCAM',
    })
    expect(zenventoryEnvNames('CREATIVEPEA').key).toBe('ZEN_CREATIVEPEA_KEY')
    expect(zenventoryEnvNames('TIMESYSTEMS').secret).toBe('ZEN_TIMESYSTEMS_SECRET')
  })

  it('reads ZEN_KEY and ZEN_SECRET and does not require the secure key', () => {
    const read = readZenventoryClientCredentials('Orcam', {
      ZEN_ORCAM_KEY: 'key',
      ZEN_ORCAM_SECRET: 'secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('key')
    expect(read.credentials.apiSecret).toBe('secret')
    expect(read.credentials.secureKey).toBeNull()
  })

  it('falls back to the old ZENVENTORY_ names when the new ones are unset', () => {
    const read = readZenventoryClientCredentials('Creative Pea', {
      ZENVENTORY_KEY_CREATIVEPEA: 'old-key',
      ZENVENTORY_SECRET_CREATIVEPEA: 'old-secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.slug).toBe('CREATIVEPEA')
    expect(read.credentials.apiKey).toBe('old-key')
    expect(read.credentials.apiSecret).toBe('old-secret')
  })

  it('prefers the new name when both are set', () => {
    const read = readZenventoryClientCredentials('Suteka', {
      ZEN_SUTEKA_KEY: 'new-key',
      ZENVENTORY_KEY_SUTEKA: 'old-key',
      ZEN_SUTEKA_SECRET: 'new-secret',
      ZENVENTORY_SECRET_SUTEKA: 'old-secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('new-key')
    expect(read.credentials.apiSecret).toBe('new-secret')
  })

  it('says not configured and names both forms of each missing variable', () => {
    const read = readZenventoryClientCredentials('Orcam', {})
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('not configured')
    expect(read.notice).toContain('ZEN_ORCAM_KEY (or ZENVENTORY_KEY_ORCAM)')
    expect(read.notice).toContain('ZEN_ORCAM_SECRET (or ZENVENTORY_SECRET_ORCAM)')
    expect(read.notice).not.toContain('SECURE')
  })

  it('requires the secure key only for the pick push, and says the key and secret are present', () => {
    const read = readZenventoryClientCredentials('Kivema', {
      ZEN_KIVEMA_KEY: 'key',
      ZEN_KIVEMA_SECRET: 'secret',
    }, { requireSecure: true })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('pick push is not configured')
    expect(read.notice).toContain('ZEN_KIVEMA_SECURE (or ZENVENTORY_SECURE_KIVEMA)')
    expect(read.notice).toContain('The key and secret are present')
  })

  it('accepts the secure key from the old name on the pick push', () => {
    const read = readZenventoryClientCredentials('Nayax', {
      ZEN_NAYAX_KEY: 'key',
      ZEN_NAYAX_SECRET: 'secret',
      ZENVENTORY_SECURE_NAYAX: 'secure',
    }, { requireSecure: true })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.secureKey).toBe('secure')
  })

  it('says not configured when the client has no slug', () => {
    const read = readZenventoryClientCredentials('Unknown Co', {
      ZEN_UNKNOWN_KEY: 'key',
      ZEN_UNKNOWN_SECRET: 'secret',
    })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('not configured')
    expect(read.notice).toContain('No slug')
  })
})
