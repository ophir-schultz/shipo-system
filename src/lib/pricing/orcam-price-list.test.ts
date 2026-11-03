import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { priceLabour, priceOrderPick, pricePalletBuild, pricePick, priceReturns, priceShipping } from './engine'
import { parsePriceList, summarizePriceList, withShippingReference } from './parse-price-list'
import { loadRepoPriceList } from './repo-price-lists'

const orcamRaw = readFileSync(join(process.cwd(), 'price-lists/orcam.json'), 'utf8')

describe('Orcam price list', () => {
  const nayax = loadRepoPriceList('Nayax')
  const orcam = loadRepoPriceList('Orcam')

  it('names Nayax and does not embed a shipping table', () => {
    const parsed = JSON.parse(orcamRaw) as { shipping?: unknown; shippingSameAs?: string }
    expect(parsed.shippingSameAs).toBe('Nayax')
    expect(parsed.shipping).toBeUndefined()
    expect(orcamRaw).not.toContain('weightLb')
    expect(orcamRaw).not.toContain('divideBy')
    expect(orcamRaw).not.toContain('9.45')
  })

  it('prices shipping from the Nayax card object itself', () => {
    expect(nayax.error).toBeNull()
    expect(orcam.error).toBeNull()
    expect(nayax.list?.shipping).toBeTruthy()
    expect(orcam.list?.shipping).toEqual(nayax.list?.shipping)

    const boxes = [{ statedLb: 3, volumeLb: 3, boxCode: '7/6/6', weightLabel: '3lbs' }]
    const fromNayax = priceShipping(nayax.list!, '2026-06-01', 8, boxes)
    const fromOrcam = priceShipping(orcam.list!, '2026-06-01', 8, boxes)
    expect(fromOrcam).toEqual(fromNayax)
    expect(fromOrcam.amount).not.toBeNull()
  })

  it('prices the confirmed order pick, labour, returns and pallet build', () => {
    const list = orcam.list!
    expect(list.devicePick).toBeNull()
    expect(list.accessoryPick).toBeNull()
    expect(list.storage).toBeNull()
    expect(list.materials).toBeNull()
    expect(list.orderPick).toEqual({ includedItems: 4, orderRate: 0.5, additionalRate: 0.1 })
    expect(pricePick(list, [{ sku: 'A', qty: 4 }]).amount).toBe(0.5)
    expect(priceOrderPick(list, [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 5 }]).amount).toBe(0.7)
    expect(list.labour).toEqual({ perHour: 48 })
    expect(priceLabour(list, 2).amount).toBe(96)
    expect(priceReturns(list, 1, 0).amount).toBe(3.5)
    expect(priceReturns(list, 1, 2).amount).toBe(4.5)
    expect(priceReturns(list, 2, 1).amount).toBe(7.5)
    expect(list.palletBuild).toEqual({ perPallet: 15 })
    expect(pricePalletBuild(list, 3).amount).toBe(45)
    expect(summarizePriceList(list).some((line) => line.startsWith('Pallet build:'))).toBe(true)
    expect(orcamRaw).not.toContain('shrink wrap')
    expect(pricePalletBuild(list, 0).amount).toBe(0)
    expect(priceReturns(list, 0, 2).amount).toBeNull()
    expect(pricePick(list, []).amount).toBe(0)
  })

  it('leaves packing materials and the rack off the engine fields', () => {
    expect(orcam.list?.materials).toBeNull()
    expect(orcam.list?.storage).toBeNull()
    expect(orcam.list?.services.find((row) => row.name === 'Packing materials')?.basis).toBe('prices of the materials +15%')
    expect(orcam.list?.services.find((row) => row.name.includes('rack'))?.amount).toBe(60)
    expect(orcam.list?.ambiguous.map((row) => row.source).join('\n')).toContain('Packing materials')
    expect(orcam.list?.ambiguous.map((row) => row.source).join('\n')).toContain('Rack')
  })

  it('refuses a reference that also embeds cells', () => {
    const parsed = parsePriceList({
      name: 'Both',
      clientName: 'Both',
      shippingSameAs: 'Nayax',
      shipping: { schedules: [{ effectiveFrom: null, effectiveTo: null, divideBy: 1 }], cells: [] },
    })
    expect(parsed.ok).toBe(false)
  })

  it('does not copy cells when the reference is applied', () => {
    const parsed = parsePriceList(JSON.parse(orcamRaw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || !nayax.list) return
    const resolved = withShippingReference(parsed.list, { Nayax: nayax.list })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.list.shipping).toBe(nayax.list.shipping)
  })
})
