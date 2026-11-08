import { describe, expect, it } from 'vitest'
import { isPeakDate, pricePeak } from './engine'
import { loadRepoPriceList } from './repo-price-lists'
import {
  buildOrderActivity,
  clientShippingPrice,
  orderPickParts,
  remainderReading,
} from './order-activity'
import { CLIENT_REPORT_COLUMNS, reportCells } from './client-report'

describe('order pick uses cartons', () => {
  const list = loadRepoPriceList('Nayax').list!

  it('does not price every device unit at the remainder rate', () => {
    const device = list.devicePick!
    const accessory = list.accessoryPick!
    const flat = remainderReading(359, 743, device.remainderRate, accessory.unitRate)
    expect(flat).toBeCloseTo(263.48, 2)
    const perCarton = device.cartonSize * device.remainderRate - device.cartonRate
    expect(flat - 8 * perCarton).toBeCloseTo(224.28, 2)
    const oneCarton = orderPickParts(list, [{ sku: 'R-1', qty: 20 }])
    expect(oneCarton.cartons).toBe(1)
    expect(oneCarton.amount).toBe(device.cartonRate)
    expect(oneCarton.amount).not.toBe(20 * device.remainderRate)
  })

  it('leaves November peak unknown because box is named and missing', () => {
    const peak = list.peak!
    for (const day of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
      expect(isPeakDate(day, peak.fromMonthDay, peak.toMonthDay)).toBe(true)
      expect(isPeakDate(day, '10-15', '01-16')).toBe(true)
    }
    const priced = pricePeak(list, '2026-11-04', {
      devicePick: 75.68,
      accessoryPick: 148.6,
      box: null,
      receiving: null,
      storage: null,
      labour: null,
      materials: null,
    })
    expect(priced.amount).toBeNull()
    expect(priced.reasons.join(' ')).toContain('box')
  })
})

describe('order activity rows', () => {
  const list = loadRepoPriceList('Nayax').list!

  it('keeps a disagreed shipping amount off the client row', () => {
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [{ id: 'o1', orderNumber: 'SO-1', lines: [{ sku: 'C-1', qty: 2 }] }],
      parcels: [{
        id: 'p1',
        orderNumber: 'SO-1',
        shipDate: '2026-11-06',
        recipientName: 'A',
        trackingNumber: 'T',
        zone: '2',
        zipcode: '10001',
        weight: '1',
        volumeWeight: '',
        storedRate: 14,
        shipmentKey: 'shipment:9',
      }],
      charges: [{ chargeKey: 'shipment:9', amount: 10, unitRate: null }],
      serials: [],
    })
    expect(activity.rows[0].shippingPrice).toBe('')
    expect(activity.rows[0].total).toBe('')
    expect(activity.coverage.shippingConflicts).toEqual(['SO-1'])
    expect(activity.rows[0].shippingPrice).not.toContain('10')
    expect(reportCells(activity.rows[0])).toHaveLength(CLIENT_REPORT_COLUMNS.length)
  })

  it('lists a parcel with no order and an order with no date', () => {
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [{ id: 'o2', orderNumber: 'SO-2', lines: [{ sku: 'C-1', qty: 1 }] }],
      parcels: [{
        id: 'p9',
        orderNumber: 'SO-MISSING',
        shipDate: '2026-11-06',
        recipientName: '',
        trackingNumber: '',
        zone: '',
        zipcode: '',
        weight: '',
        volumeWeight: '',
        storedRate: 104.92,
        shipmentKey: 'shipment:404',
      }],
      charges: [],
      serials: [],
    })
    expect(activity.rows).toEqual([])
    expect(activity.coverage.unmatchedParcels).toContain('SO-MISSING')
    expect(activity.coverage.undatedOrders).toContain('SO-2')
    expect(JSON.stringify(activity.rows)).not.toContain('104.92')
  })

  it('does not treat a ledger amount with no stored rate as the client price', () => {
    expect(clientShippingPrice(null, { chargeKey: 'shipment:1', amount: 10, unitRate: null }).amount).toBeNull()
  })
})
