import { describe, expect, it } from 'vitest'
import {
  readOrderReadCredentials,
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

  it('uses this client row only when that client has no env pair', () => {
    const read = readZenventoryClientCredentials('Orcam', {
      ZENVENTORY_API_KEY: 'global-key',
      ZENVENTORY_API_SECRET: 'global-secret',
    }, {
      stored: { apiKey: 'row-key', apiSecret: 'row-secret' },
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('row-key')
    expect(read.credentials.apiSecret).toBe('row-secret')
    expect(read.credentials.keySource).toBe('clients.zenventory_api_key')
  })

  it('does not mix an env key with a stored secret or another client', () => {
    const partial = readZenventoryClientCredentials('Orcam', {
      ZEN_ORCAM_KEY: 'env-key',
    }, {
      stored: { apiKey: 'row-key', apiSecret: 'row-secret' },
    })
    expect(partial.ok).toBe(false)
    if (partial.ok) return
    expect(partial.notice).toContain('ZEN_ORCAM_SECRET')
    expect(partial.notice).not.toContain('row-secret')
    expect(partial.notice).not.toContain('env-key')
  })

  it('keeps an env pair ahead of the stored pair and the global pair', () => {
    const read = readZenventoryClientCredentials('Orcam', {
      ZEN_ORCAM_KEY: 'env-key',
      ZEN_ORCAM_SECRET: 'env-secret',
      ZENVENTORY_API_KEY: 'global-key',
      ZENVENTORY_API_SECRET: 'global-secret',
    }, {
      stored: { apiKey: 'row-key', apiSecret: 'row-secret' },
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('env-key')
    expect(read.credentials.apiSecret).toBe('env-secret')
    expect(read.credentials.keySource).toBe('ZEN_ORCAM_KEY')
  })

  it('reads ZEN_KEY and ZEN_SECRET and does not treat the secret as a SecureKey', () => {
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
    expect(read.notice).toContain('API secret is not used')
    expect(read.notice).toContain('ZEN_ORCAM_SECURE')
    expect(read.notice).toContain('ZENVENTORY_SECURE_ORCAM')
  })

  it('does not count the pick as configured when Nayax has no secure variable', () => {
    const read = readZenventoryClientCredentials('Nayax', {
      ZEN_NAYAX_KEY: 'key',
      ZEN_NAYAX_SECRET: 'secret',
    }, { requireSecure: true })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.notice).toContain('ZEN_NAYAX_SECURE')
    expect(read.notice).toContain('not used as that key')
  })

  it('keeps the API secret when the secure variable is unset and a pick is not required', () => {
    const read = readZenventoryClientCredentials('Suteka', {
      ZENVENTORY_KEY_SUTEKA: 'old-key',
      ZENVENTORY_SECRET_SUTEKA: 'old-secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiSecret).toBe('old-secret')
    expect(read.credentials.secureKey).toBeNull()
  })

  it('prefers a dedicated secure variable over the secret', () => {
    const read = readZenventoryClientCredentials('Nayax', {
      ZEN_NAYAX_KEY: 'key',
      ZEN_NAYAX_SECRET: 'secret',
      ZEN_NAYAX_SECURE: 'dedicated',
    }, { requireSecure: true })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.secureKey).toBe('dedicated')
    expect(read.credentials.apiSecret).toBe('secret')
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

  it('reads an order with only the dedicated SecureKey and does not copy the secret', () => {
    const read = readOrderReadCredentials('Nayax', {
      ZEN_NAYAX_SECRET: 'secret',
      ZEN_NAYAX_SECURE: 'dedicated',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.apiKey).toBe('')
    expect(read.credentials.apiSecret).toBe('secret')
    expect(read.credentials.secureKey).toBe('dedicated')
    expect(read.credentials.secureKey).not.toBe(read.credentials.apiSecret)
  })

  it('strips a file-upload wrapper and keeps a clean key unchanged', () => {
    const quoted = readOrderReadCredentials('Nayax', {
      ZEN_NAYAX_KEY: '"fixture-key"',
      ZEN_NAYAX_SECRET: "'fixture-secret'\n",
      ZEN_NAYAX_SECURE: '\uFEFFfixture-secure',
    })
    expect(quoted.ok).toBe(true)
    if (!quoted.ok) return
    expect(quoted.credentials.apiKey).toBe('fixture-key')
    expect(quoted.credentials.apiSecret).toBe('fixture-secret')
    expect(quoted.credentials.secureKey).toBe('fixture-secure')
    expect(quoted.credentials.keySource).toBe('ZEN_NAYAX_KEY')
    expect(quoted.credentials.secretSource).toBe('ZEN_NAYAX_SECRET')

    const clean = readOrderReadCredentials('Nayax', {
      ZEN_NAYAX_KEY: 'fixture-key',
      ZEN_NAYAX_SECRET: 'fixture-secret',
    })
    expect(clean.ok).toBe(true)
    if (!clean.ok) return
    expect(clean.credentials.apiKey).toBe('fixture-key')
    expect(clean.credentials.apiSecret).toBe('fixture-secret')
  })

  it('names the legacy variables when those are the ones set', () => {
    const read = readOrderReadCredentials('Nayax', {
      ZENVENTORY_KEY_NAYAX: 'old-key',
      ZENVENTORY_SECRET_NAYAX: 'old-secret',
    })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.credentials.keySource).toBe('ZENVENTORY_KEY_NAYAX')
    expect(read.credentials.secretSource).toBe('ZENVENTORY_SECRET_NAYAX')
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
