import { describe, expect, it } from 'vitest'
import {
  billablePounds,
  isPeakDate,
  money,
  priceBoxes,
  priceClientReport,
  priceLabour,
  priceMaterials,
  pricePeak,
  pricePick,
  priceReceiving,
  priceShipping,
  priceStorage,
  splitPick,
} from './engine'
import type { PriceListDocument } from './types'

function list(over: Partial<PriceListDocument> = {}): PriceListDocument {
  return {
    name: 'Sample',
    clientName: 'Sample',
    devicePick: { cartonSize: 20, cartonRate: 1.5, remainderRate: 0.32, skuPrefixes: ['R', 'D'] },
    accessoryPick: { unitRate: 0.2 },
    boxes: [
      { code: '7/6/6', rate: 0.92 },
      { code: '21/19/8', rate: 0 },
      { code: '14/10/6', rate: 1.11 },
    ],
    noBoxListed: { weightLabel: '1lb', rate: 0.8 },
    receiving: { perCarton: 0.85 },
    storage: { perPallet: 25, perShelf: 12 },
    labour: { perHour: 48 },
    materials: { markupPct: 15 },
    peak: {
      pct: 8,
      fromMonthDay: '10-15',
      toMonthDay: '01-15',
      appliesTo: ['device_pick', 'accessory_pick', 'box'],
    },
    shipping: {
      schedules: [
        { effectiveFrom: null, effectiveTo: '2026-05-19', divideBy: 1.03 },
        { effectiveFrom: '2026-05-19', effectiveTo: null, divideBy: 1 },
      ],
      cells: [
        { weightLb: 1, zone: 6, rate: 14.2 },
        { weightLb: 2, zone: 6, rate: 14.95 },
        { weightLb: 3, zone: 6, rate: 15.56 },
        { weightLb: 3, zone: 8, rate: 17.23 },
        { weightLb: 7, zone: 5, rate: 18.78 },
        { weightLb: 20, zone: 5, rate: 28.4 },
      ],
    },
    ...over,
  }
}

describe('pricePick', () => {
  it('bills full cartons at the carton rate and the remainder at the unit rate', () => {
    const priced = pricePick(list(), [
      { sku: 'R144GUSY01S10', qty: 30 },
    ])
    expect(priced.amount).toBe(money(1.5 + 10 * 0.32))
  })

  it('sums device units across lines before the carton split', () => {
    const priced = pricePick(list(), [
      { sku: 'r144gusy01s10', qty: 12 },
      { sku: 'D600005S10', qty: 8 },
    ])
    expect(priced.amount).toBe(1.5)
  })

  it('bills accessories per unit and does not give them the carton rate', () => {
    const priced = pricePick(list(), [{ sku: 'C140001', qty: 1000 }])
    expect(priced.amount).toBe(200)
  })

  it('adds device and accessory amounts on one order', () => {
    const priced = pricePick(list(), [
      { sku: 'R144GUSY01S10', qty: 15 },
      { sku: 'C130026', qty: 15 },
    ])
    expect(priced.amount).toBe(money(15 * 0.32 + 15 * 0.2))
  })

  it('treats every SKU as an accessory when the list defines no device class', () => {
    const priced = pricePick(list({ devicePick: null }), [{ sku: 'R1', qty: 1 }])
    expect(priced.amount).toBe(0.2)
  })

  it('does not invent an accessory rate for a SKU the device prefixes do not claim', () => {
    const priced = pricePick(list({ accessoryPick: null }), [{ sku: 'C1', qty: 4 }])
    expect(priced.amount).toBeNull()
  })
})

describe('priceBoxes', () => {
  it('prices each box and keeps a listed zero', () => {
    const priced = priceBoxes(list(), [
      { statedLb: 20, volumeLb: 20, boxCode: '21/19/8', weightLabel: '20lbs' },
      { statedLb: 7, volumeLb: 5, boxCode: '14/10/6', weightLabel: '7lbs' },
    ])
    expect(priced.amount).toBe(1.11)
  })

  it('uses the no-box rate only for the listed weight label', () => {
    const one = priceBoxes(list(), [
      { statedLb: 1, volumeLb: 1, boxCode: null, weightLabel: '1lb' },
    ])
    const three = priceBoxes(list(), [
      { statedLb: 3, volumeLb: 3, boxCode: null, weightLabel: '3lbs' },
    ])
    expect(one.amount).toBe(0.8)
    expect(three.amount).toBeNull()
  })

  it('does not price an unknown box as zero', () => {
    const priced = priceBoxes(list(), [
      { statedLb: 2, volumeLb: 2, boxCode: '8/8/7', weightLabel: '2lbs' },
    ])
    expect(priced.amount).toBeNull()
    expect(priced.reasons[0]).toContain('8/8/7')
  })
})

describe('priceShipping', () => {
  it('uses the in-effect schedule and prices each box', () => {
    const boxes = [
      { statedLb: 20, volumeLb: 20, boxCode: '21/19/8', weightLabel: '20lbs' },
      { statedLb: 7, volumeLb: 5, boxCode: '14/10/6', weightLabel: '7lbs' },
    ]
    const after = priceShipping(list(), '2026-05-19', 5, boxes)
    const before = priceShipping(list(), '2026-05-12', 5, boxes)
    expect(billablePounds(7, 5)).toBe(7)
    expect(after.amount).toBe(money(28.4 + 18.78))
    expect(before.amount).toBe(money(money(28.4 / 1.03) + money(18.78 / 1.03)))
  })

  it('bills the higher of scale weight and volume weight', () => {
    const priced = priceShipping(list(), '2026-06-01', 6, [
      { statedLb: 2, volumeLb: 3, boxCode: '7/6/6', weightLabel: '2lbs' },
    ])
    expect(priced.amount).toBe(15.56)
  })

  it('leaves shipping unknown when the zone is missing', () => {
    const priced = priceShipping(list(), '2026-06-01', null, [
      { statedLb: 3, volumeLb: 3, boxCode: '7/6/6', weightLabel: '3lbs' },
    ])
    expect(priced.amount).toBeNull()
  })
})

describe('warehouse fees and peak', () => {
  const card = list()

  it('prices receiving, storage, labour and materials from the list', () => {
    expect(priceReceiving(card, 2).amount).toBe(1.7)
    expect(priceStorage(card, 1, 1).amount).toBe(37)
    expect(priceLabour(card, 2).amount).toBe(96)
    expect(priceMaterials(card, 10).amount).toBe(11.5)
  })

  it('applies peak only inside the window and only to the named fees', () => {
    expect(isPeakDate('2026-10-14', '10-15', '01-15')).toBe(false)
    expect(isPeakDate('2026-10-15', '10-15', '01-15')).toBe(true)
    expect(isPeakDate('2027-01-15', '10-15', '01-15')).toBe(true)
    expect(isPeakDate('2027-01-16', '10-15', '01-15')).toBe(false)
    expect(isPeakDate('2026-05-20', '10-15', '01-15')).toBe(false)

    const parts = {
      devicePick: 10,
      accessoryPick: 0,
      box: 2,
      receiving: 5,
      storage: 25,
      labour: 48,
      materials: 11.5,
    }
    const on = pricePeak(card, '2026-11-01', parts)
    const off = pricePeak(card, '2026-05-20', parts)
    // 8% of device + accessory + box only. Receiving and the rest are not named.
    expect(on.amount).toBe(money(12 * 0.08))
    expect(off.amount).toBe(0)
  })

  it('does not turn an unknown warehouse fee into a peak of zero', () => {
    const priced = pricePeak(card, '2026-12-01', {
      devicePick: null,
      accessoryPick: 0,
      box: 1,
      receiving: null,
      storage: null,
      labour: null,
      materials: null,
    })
    expect(priced.amount).toBeNull()
  })
})

describe('priceClientReport', () => {
  it('totals pick, box and shipping and withholds the total when one part is unknown', () => {
    const ok = priceClientReport(
      list(),
      '2026-06-01',
      8,
      [{ sku: 'R144GUSY01S10', qty: 1 }, { sku: 'C130001', qty: 1 }],
      [{ statedLb: 3, volumeLb: 3, boxCode: '7/6/6', weightLabel: '3lbs' }],
    )
    expect(ok.pick.amount).toBe(0.52)
    expect(ok.box.amount).toBe(0.92)
    expect(ok.shipping.amount).toBe(17.23)
    expect(ok.total).toBe(money(0.52 + 0.92 + 17.23))

    const missing = priceClientReport(list(), '2026-06-01', null, [], [
      { statedLb: 1, volumeLb: 1, boxCode: null, weightLabel: '1lb' },
    ])
    expect(missing.total).toBeNull()
  })

  it('splits pick so peak can see devices and accessories apart', () => {
    const split = splitPick(list(), [
      { sku: 'R144GUSY01S10', qty: 1 },
      { sku: 'M300004', qty: 2 },
    ])
    expect(split.device.amount).toBe(0.32)
    expect(split.accessory.amount).toBe(0.4)
  })
})
