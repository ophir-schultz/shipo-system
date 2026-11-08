import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePriceList, summarizePriceList } from './parse-price-list'
import { priceLabour, priceMaterials, pricePick, priceReceiving, priceStorage } from './engine'

describe('parsePriceList', () => {
  it('rejects a document that does not name a client', () => {
    const parsed = parsePriceList({ name: 'Card' })
    expect(parsed.ok).toBe(false)
  })

  it('keeps a rate of zero and does not fill in rates the file omitted', () => {
    const parsed = parsePriceList({
      name: 'Thin',
      clientName: 'Thin',
      boxes: [{ code: '21/19/8', rate: 0 }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.list.boxes[0].rate).toBe(0)
    expect(parsed.list.devicePick).toBeNull()
    expect(parsed.list.shipping).toBeNull()
  })
})

describe('Nayax price list file', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, '../../../price-lists/nayax.json'), 'utf8'))
  const parsed = parsePriceList(raw)

  it('parses, and the owner rates are the ones in the file', () => {
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const list = parsed.list
    expect(pricePick(list, [{ sku: 'R1', qty: 20 }]).amount).toBe(1.5)
    expect(pricePick(list, [{ sku: 'R1', qty: 1 }]).amount).toBe(0.32)
    expect(pricePick(list, [{ sku: 'C1', qty: 1 }]).amount).toBe(0.2)
    expect(list.boxes.find((b) => b.code === '7/6/6')?.rate).toBe(0.92)
    expect(list.boxes.find((b) => b.code === '10/8/6')?.rate).toBe(0.81)
    expect(list.boxes.find((b) => b.code === '14/10/6')?.rate).toBe(1.11)
    expect(list.boxes.find((b) => b.code === '14/6/6')?.rate).toBe(1.11)
    expect(list.boxes.find((b) => b.code === '14/12/10')?.rate).toBe(2.25)
    expect(list.boxes.find((b) => b.code === '14/12/8')?.rate).toBe(1.44)
    expect(list.boxes.find((b) => b.code === '20/16/14')?.rate).toBe(2.88)
    expect(list.boxes.find((b) => b.code === '21/19/8')?.rate).toBe(0)
    expect(list.boxes.find((b) => b.code === '12/19/8')?.rate).toBe(0)
    expect(list.boxes.find((b) => b.code === '21/14/10')?.rate).toBe(0)
    expect(list.noBoxListed).toEqual({ weightLabel: '1lb', rate: 0.8 })
    expect(priceReceiving(list, 1).amount).toBe(0.85)
    expect(priceStorage(list, 1, 0).amount).toBe(25)
    expect(priceStorage(list, 0, 1).amount).toBe(12)
    expect(priceLabour(list, 1).amount).toBe(48)
    expect(priceMaterials(list, 100).amount).toBe(115)
    expect(list.peak?.pct).toBe(8)
    expect(list.peak?.fromMonthDay).toBe('10-15')
    expect(list.peak?.toMonthDay).toBe('01-15')
    expect(list.peak?.appliesTo).not.toContain('shipping')
    expect(list.shipping?.cells.length).toBe(800)
    expect(list.shipping?.schedules).toEqual([
      { effectiveFrom: null, effectiveTo: '2026-05-19', divideBy: 1.03 },
      { effectiveFrom: '2026-05-19', effectiveTo: null, divideBy: 1 },
    ])
    expect(summarizePriceList(list).some((line) => line.startsWith('Devices:'))).toBe(true)
  })
})
