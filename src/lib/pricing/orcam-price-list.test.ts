import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pricePick, priceShipping } from './engine'
import { parsePriceList, withShippingReference } from './parse-price-list'
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

  it('does not invent device, labour, storage or materials rates', () => {
    expect(orcam.list?.devicePick).toBeNull()
    expect(orcam.list?.accessoryPick).toBeNull()
    expect(orcam.list?.storage).toBeNull()
    expect(orcam.list?.labour).toBeNull()
    expect(orcam.list?.materials).toBeNull()
    expect(pricePick(orcam.list!, [{ sku: 'R1', qty: 1 }]).amount).toBeNull()
    expect(orcam.list?.services.find((row) => row.name.startsWith('Pick and pack, up to'))?.amount).toBe(0.5)
    expect(orcam.list?.services.find((row) => row.name.includes('additional'))?.amount).toBe(0.1)
    expect(orcam.list?.ambiguous.length).toBeGreaterThan(0)
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
