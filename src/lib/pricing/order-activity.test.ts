import { describe, expect, it } from 'vitest'
import { isPeakDate, pricePeak } from './engine'
import { loadRepoPriceList } from './repo-price-lists'
import {
  buildOrderActivity,
  clientShippingPrice,
  orderPickParts,
  remainderReading,
} from './order-activity'
import { CLIENT_REPORT_COLUMNS, reportCells, reportToCsv } from './client-report'

describe('order pick uses cartons', () => {
  const list = loadRepoPriceList('Nayax').list!

  it('does not price every device unit at the remainder rate', () => {
    const device = list.devicePick!
    const accessory = list.accessoryPick!
    const flat = remainderReading(359, 743, device.remainderRate, accessory.unitRate)
    expect(flat).toBeCloseTo(263.48, 2)
    const perCarton = device.cartonSize * device.remainderRate - device.cartonRate
    expect(flat - 8 * perCarton).toBeCloseTo(224.28, 2)
    const oneCarton = orderPickParts(list, [{ sku: 'R-1', qty: 20, scannable: true }])
    const missing = orderPickParts(list, [{ sku: 'R-1', qty: 20 }])
    expect(missing.amount).toBeNull()
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
    expect(activity.rows[0].shippingStatus).toContain('disagree')
    expect(reportCells(activity.rows[0])).toHaveLength(CLIENT_REPORT_COLUMNS.length)
    expect(reportToCsv([activity.rows[0]])).not.toContain('Shipping pending')
  })

  it('blanks SO601065103 shipping because the stored rate and the ledger charge differ, not because the charge date differs', () => {
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [{
        id: 'o103',
        orderNumber: 'SO601065103',
        lines: [{ sku: 'R144GUSY01S10', qty: 36, picked: 36, scannable: true, pickDate: '2026-11-04' }],
      }],
      parcels: [{
        id: 'p103',
        orderNumber: 'SO601065103',
        shipDate: '2026-11-04',
        recipientName: 'Ethan Kohan',
        trackingNumber: '1Z16D13WYW46417373',
        zone: '6',
        zipcode: '76111-2266',
        weight: '192',
        volumeWeight: '192',
        weightUnit: 'ounces',
        storedRate: 24.24,
        shipmentKey: 'shipment:345810929',
      }],
      charges: [{ chargeKey: 'shipment:345810929', amount: 17.52, unitRate: null }],
      serials: [],
      billRateCard: true,
    })
    const row = activity.rows[0]
    expect(row.date).toBe('2026-11-04')
    expect(row.shippingPrice).toBe('24.24')
    expect(row.shippingPrice).not.toContain('17.52')
    expect(row.shippingStatus).toBe('')
    expect(row.weight).toBe('192')
    expect(row.weightNote).toContain('12 lb')
    const staff = activity.coverage.shippingStaff.join(' ')
    expect(staff).toContain('24.24')
    expect(staff).toContain('17.52')
    expect(staff).toContain('approved correction')
    expect(staff).toContain('charge date is not read')
    expect(reportCells(row)[10]).toBe('24.24')
    expect(reportToCsv([row])).toContain('24.24')
    expect(reportToCsv([row])).not.toContain('17.52')
  })

  it('leaves Nayax shipping pending when the rate card has no price', () => {
    const priced = clientShippingPrice(null, {
      chargeKey: 'shipment:404', amount: 104.92, unitRate: null,
    }, { billRateCard: true })
    expect(priced.amount).toBeNull()
    expect(priced.clientReason).toContain('Shipping pending')
    expect(priced.clientReason).not.toContain('104.92')
  })

  it('shows an undated order with nothing picked as non-billed zero', () => {
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [{ id: 'idle', orderNumber: 'SO601065551', lines: [{ sku: 'C-9', qty: 40, picked: 0, scannable: null }] }],
      parcels: [],
      charges: [],
      serials: [],
    })
    expect(activity.coverage.undatedOrders).toEqual(['SO601065551'])
    expect(activity.coverage.datedOrders).toBe(0)
    expect(activity.rows[0]).toMatchObject({
      orderNumber: 'SO601065551',
      date: '',
      qty: '0',
      pickPrice: '0.00',
      total: '',
    })
    expect(activity.coverage.picks[0].status).toBe('nothing picked')
    expect(activity.coverage.picks[0].status).not.toBe('classification unknown')
    expect(activity.coverage.pickKnown).toBe(0)
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

  it('prices 105 scannable units at 9.10 and leaves a prefix-only line unknown', () => {
    const flagged = orderPickParts(list, [{ sku: 'C-9', qty: 105, scannable: true }])
    expect(flagged.cartons).toBe(5)
    expect(flagged.remainder).toBe(5)
    expect(flagged.amount).toBe(9.1)
    const accessory = orderPickParts(list, [{ sku: 'R-9', qty: 105, scannable: false }])
    expect(accessory.cartons).toBe(0)
    expect(accessory.amount).toBe(21)
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [
        { id: 'o105', orderNumber: 'SO-105', lines: [{ sku: 'C-9', qty: 400, picked: 105, scannable: true, pickDate: '2026-11-04' }] },
        { id: 'oR', orderNumber: 'SO-R', lines: [{ sku: 'R-9', qty: 105, picked: 105, scannable: null, pickDate: '2026-11-04' }] },
      ],
      parcels: [
        {
          id: 'p105',
          orderNumber: 'SO-105',
          shipDate: '2026-11-04',
          recipientName: 'A',
          trackingNumber: 'T105',
          zone: '2',
          zipcode: '10001',
          weight: '1',
          volumeWeight: '',
          storedRate: 1,
          shipmentKey: 'shipment:105',
        },
        {
          id: 'pR',
          orderNumber: 'SO-R',
          shipDate: '2026-11-04',
          recipientName: 'A',
          trackingNumber: 'TR',
          zone: '2',
          zipcode: '10001',
          weight: '1',
          volumeWeight: '',
          storedRate: 1,
          shipmentKey: 'shipment:r',
        },
      ],
      charges: [
        { chargeKey: 'shipment:105', amount: 1, unitRate: 1 },
        { chargeKey: 'shipment:r', amount: 1, unitRate: 1 },
      ],
      serials: [],
    })
    const priced = activity.rows.find((row) => row.orderNumber === 'SO-105')
    const unknown = activity.rows.find((row) => row.orderNumber === 'SO-R')
    expect(priced?.pickPrice).toBe('9.10')
    expect(priced?.qty).toBe('105')
    expect(priced?.total).toBe('10.10')
    expect(unknown?.pickPrice).toBe('')
    expect(unknown?.total).toBe('')
    expect(activity.coverage.pickKnown).toBeNull()
  })

  it('keeps an undated pick off the row and does not price ordered units', () => {
    const activity = buildOrderActivity({
      clientId: 'nayax',
      from: '2026-11-01',
      to: '2026-11-30',
      list,
      orders: [
        { id: 'dated', orderNumber: 'SO-DATED', lines: [{ sku: 'C-9', qty: 400, picked: 105, scannable: true, pickDate: '2026-11-04' }] },
        { id: 'open', orderNumber: 'SO-OPEN', lines: [{ sku: 'C-9', qty: 400, picked: 105, scannable: true, pickDate: null }] },
        { id: 'idle', orderNumber: 'SO-IDLE', lines: [{ sku: 'C-9', qty: 400, picked: 0, scannable: true, pickDate: null }] },
      ],
      parcels: ['SO-DATED', 'SO-OPEN', 'SO-IDLE'].map((orderNumber) => ({
        id: orderNumber,
        orderNumber,
        shipDate: '2026-11-04',
        recipientName: 'A',
        trackingNumber: orderNumber,
        zone: '2',
        zipcode: '10001',
        weight: '1',
        volumeWeight: '',
        storedRate: 1,
        shipmentKey: `shipment:${orderNumber}`,
      })),
      charges: ['SO-DATED', 'SO-OPEN', 'SO-IDLE'].map((orderNumber) => ({
        chargeKey: `shipment:${orderNumber}`,
        amount: 1,
        unitRate: 1,
      })),
      serials: [],
    })
    const dated = activity.rows.find((row) => row.orderNumber === 'SO-DATED')
    const open = activity.rows.find((row) => row.orderNumber === 'SO-OPEN')
    const idle = activity.rows.find((row) => row.orderNumber === 'SO-IDLE')
    expect(dated?.pickPrice).toBe('9.10')
    expect(dated?.qty).toBe('105')
    expect(open?.pickPrice).toBe('')
    expect(open?.qty).toBe('105')
    expect(idle?.pickPrice).toBe('0.00')
    expect(idle?.qty).toBe('0')
    expect(activity.coverage.pickDateUnknown).toEqual(['SO-OPEN'])
    expect(activity.coverage.nothingPicked).toEqual(['SO-IDLE'])
    expect(activity.coverage.picks.find((pick) => pick.orderNumber === 'SO-OPEN')?.amount).toBe(9.1)
    expect(activity.coverage.pickKnown).toBeNull()
  })

  it('does not treat a ledger amount with no stored rate as the client price', () => {
    expect(clientShippingPrice(null, { chargeKey: 'shipment:1', amount: 10, unitRate: null }).amount).toBeNull()
  })
})
