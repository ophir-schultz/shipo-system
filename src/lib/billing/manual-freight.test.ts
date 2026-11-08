import { describe, expect, it } from 'vitest'
import {
  freightColumnMissing, freightFullTotal, prepareFreightLines,
} from './manual-freight'

const ship = (shipmentRef: string, clientId = 'nayax', zonePriced = false) => ({
  shipmentRef, clientId, zonePriced,
})

describe('manual freight lines', () => {
  it('adds a second line for a second shipment on the same date', () => {
    const prepared = prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '900', carrierCost: 437.08, markup: 40 },
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '901', carrierCost: 105.65, markup: 0 },
    ], [ship('900'), ship('901')], [])
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.lines.map((line) => line.shipmentRef)).toEqual(['900', '901'])
    expect(prepared.lines.map((line) => line.date)).toEqual(['2026-10-09', '2026-10-09'])
    expect(prepared.lines[0].fullTotal).toBe(freightFullTotal(437.08, 40))
    expect(prepared.lines[1].fullTotal).toBe(105.65)
    expect(prepared.lines[0].fullTotal).not.toBe(437.08)
  })

  it('does not assume a markup and does not overwrite a saved shipment', () => {
    expect(prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '900', carrierCost: 10, markup: null },
    ], [ship('900')], []).ok).toBe(false)
    const again = prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-13', shipmentRef: '900', carrierCost: 10, markup: 2 },
    ], [ship('900')], ['900'])
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error).toMatch(/not replaced/)
  })

  it('rejects a repeated shipment, another client, and a missing shipment', () => {
    expect(prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '900', carrierCost: 1, markup: 1 },
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '900', carrierCost: 2, markup: 2 },
    ], [ship('900')], []).ok).toBe(false)
    const other = prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: '900', carrierCost: 1, markup: 1 },
    ], [ship('900', 'orcam')], [])
    expect(other.ok).toBe(false)
    if (other.ok) return
    expect(other.error).toMatch(/another client/)
    expect(prepareFreightLines([
      { clientId: 'nayax', date: '2026-10-09', shipmentRef: 'missing', carrierCost: 1, markup: 1 },
    ], [], []).ok).toBe(false)
  })

  it('names a missing shipment column without treating it as a failed log', () => {
    expect(freightColumnMissing({ code: '42703', message: 'column shipment_ref does not exist' })).toBe(true)
    expect(freightColumnMissing(null)).toBe(false)
    expect(freightColumnMissing({ message: 'permission denied' })).toBe(false)
  })
})
