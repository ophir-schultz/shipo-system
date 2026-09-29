import { describe, expect, it } from 'vitest'
import { sourceForCarrier } from '@/lib/ledger/carrier'

describe('sourceForCarrier', () => {
  it('maps stamps_com to the stamps source', () => {
    expect(sourceForCarrier('stamps_com')).toEqual({ source: 'stamps', known: true })
  })

  it('maps ups_walleted to its own source, not stamps', () => {
    expect(sourceForCarrier('ups_walleted')).toEqual({
      source: 'shipstation_ups',
      known: true,
    })
  })

  it('is case-insensitive, because the sync upper-cases carrier elsewhere', () => {
    expect(sourceForCarrier('UPS_WALLETED').source).toBe('shipstation_ups')
  })

  it('keeps an unknown carrier verbatim and flags it rather than coercing', () => {
    expect(sourceForCarrier('fedex')).toEqual({ source: 'fedex', known: false })
  })

  it('never silently returns stamps for a carrier it does not recognise', () => {
    // The whole point of this module. A wrong-but-plausible value is worse
    // than an obviously unknown one.
    expect(sourceForCarrier('dhl_ecommerce').source).not.toBe('stamps')
  })

  it('treats a missing carrier as unknown, not as stamps', () => {
    expect(sourceForCarrier(null)).toEqual({ source: 'unknown', known: false })
    expect(sourceForCarrier(undefined)).toEqual({ source: 'unknown', known: false })
    expect(sourceForCarrier('')).toEqual({ source: 'unknown', known: false })
  })
})
