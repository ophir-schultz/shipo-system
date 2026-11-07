import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { loadScanOrder } from './load-order'

const unauthorized = new Error('Zenventory API error: HTTP 401: {"code":"unauthorized","message":"Invalid API key and/or secret."}')

describe('loadScanOrder', () => {
  it('uses the legacy key after API 2.0 returns 401 and does not pass the secret', async () => {
    const readV2 = vi.fn().mockRejectedValue(unauthorized)
    const readLegacy = vi.fn().mockResolvedValue({ customerorders: [{ ordernumber: 'SO601065056' }] })
    const result = await loadScanOrder({
      orderRef: 'SO601065056',
      credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: 'fixture-secure' },
      secureLabel: 'ZEN_NAYAX_SECURE or ZENVENTORY_SECURE_NAYAX',
      readV2,
      readLegacy,
    })
    expect(result.loaded).toBe(true)
    if (!result.loaded) return
    expect(result.source).toBe('legacy')
    expect(readLegacy).toHaveBeenCalledWith('fixture-secure')
    expect(readLegacy).not.toHaveBeenCalledWith('fixture-secret')
  })

  it('names the missing SecureKey and does not call legacy when API 2.0 is unauthorized', async () => {
    const readLegacy = vi.fn()
    const result = await loadScanOrder({
      orderRef: 'SO601065056',
      credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: null },
      secureLabel: 'ZEN_NAYAX_SECURE or ZENVENTORY_SECURE_NAYAX',
      readV2: vi.fn().mockRejectedValue(unauthorized),
      readLegacy,
    })
    expect(result.loaded).toBe(false)
    if (result.loaded) return
    expect(result.reason).toContain('ZEN_NAYAX_SECURE')
    expect(result.reason).toContain('not used as that key')
    expect(result.reason).not.toContain('fixture-secret')
    expect(readLegacy).not.toHaveBeenCalled()
  })

  it('does not treat the API secret as a SecureKey', async () => {
    const readLegacy = vi.fn()
    const result = await loadScanOrder({
      orderRef: 'SO601065056',
      credentials: { apiKey: '', apiSecret: 'fixture-secret', secureKey: 'fixture-secret' },
      secureLabel: 'ZEN_NAYAX_SECURE or ZENVENTORY_SECURE_NAYAX',
      readV2: vi.fn(),
      readLegacy,
    })
    expect(result.loaded).toBe(false)
    expect(readLegacy).not.toHaveBeenCalled()
  })
})

describe('legacy order read stays a GET', () => {
  it('does not pick', () => {
    const src = readFileSync('src/lib/api/zenventory.ts', 'utf8')
    const fn = src.slice(
      src.indexOf('export async function getLegacyCustomerOrder'),
      src.indexOf('function asLegacyRecord'),
    )
    expect(fn).toContain("'/customerorders'")
    expect(fn).toContain('/items')
    expect(fn).not.toContain('.put(')
    expect(fn).not.toContain('putLegacy')
  })
})
