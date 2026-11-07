import { describe, expect, it } from 'vitest'
import { queueDecision, readCustomerOrder, scanCoverage } from './order-lines'

const nayax = {
  customerOrders: [{
    orderNumber: 'SO-100',
    items: [
      { sku: 'BASE', serialized: true, quantityOrdered: 4 },
      { sku: 'EXTRA', serialized: false, quantityOrdered: 2 },
      { sku: 'UNKNOWN', quantityOrdered: 1 },
    ],
  }],
}

describe('customer order lines', () => {
  it('loads serialized flags and required quantities from the order', () => {
    const read = readCustomerOrder(nayax, 'SO-100')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines).toEqual([
      { sku: 'BASE', serialized: true, requiredQty: 4, pickedQty: null },
      { sku: 'EXTRA', serialized: false, requiredQty: 2, pickedQty: null },
      { sku: 'UNKNOWN', serialized: null, requiredQty: 1, pickedQty: null },
    ])
  })

  it('reads a legacy order quantity', () => {
    const read = readCustomerOrder({
      customerorders: [{ ordernumber: 'SO601065056', items: [{ sku: 'READER', orderquantity: 3 }] }],
    }, 'SO601065056')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines[0]).toMatchObject({ sku: 'READER', requiredQty: 3, pickedQty: null })
  })

  it('reports a picked quantity when the order line has one and does not invent one', () => {
    const read = readCustomerOrder({
      customerOrders: [{
        orderNumber: 'SO-100',
        items: [
          { sku: 'BASE', serialized: true, quantityOrdered: 2, pickedquantity: 2 },
          { sku: 'OPEN', serialized: true, quantityOrdered: 1 },
        ],
      }],
    }, 'SO-100')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines.map((line) => [line.sku, line.pickedQty])).toEqual([
      ['BASE', 2],
      ['OPEN', null],
    ])
  })

  it('does not invent a quantity or a serialized flag', () => {
    const read = readCustomerOrder({
      customerOrders: [{ orderNumber: 'SO-100', items: [{ sku: 'BASE' }] }],
    }, 'SO-100')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.lines[0]).toEqual({ sku: 'BASE', serialized: null, requiredQty: null, pickedQty: null })
  })

  it('keeps a partial scan incomplete', () => {
    const read = readCustomerOrder(nayax, 'so-100')
    if (!read.ok) throw new Error('expected the order')
    const coverage = scanCoverage(read.lines, [{ sku: 'BASE', count: 2 }])
    expect(coverage.lines.find((line) => line.sku === 'BASE')).toMatchObject({
      scanned: 2,
      lineComplete: false,
    })
    expect(coverage.allSerializedComplete).toBe(false)
  })

  it('is complete only when every serialized line has its required quantity', () => {
    const read = readCustomerOrder({
      customerOrders: [{
        orderNumber: 'SO-100',
        items: [
          { sku: 'BASE', serialized: true, quantityOrdered: 2 },
          { sku: 'KIT', serialized: true, quantityOrdered: 1 },
          { sku: 'EXTRA', serialized: false, quantityOrdered: 9 },
        ],
      }],
    }, 'SO-100')
    if (!read.ok) throw new Error('expected the order')
    expect(scanCoverage(read.lines, [{ sku: 'BASE', count: 2 }]).allSerializedComplete).toBe(false)
    expect(scanCoverage(read.lines, [
      { sku: 'BASE', count: 2 },
      { sku: 'KIT', count: 1 },
    ]).allSerializedComplete).toBe(true)
  })

  it('does not call an order complete when a serialized flag or quantity is unknown', () => {
    const read = readCustomerOrder(nayax, 'SO-100')
    if (!read.ok) throw new Error('expected the order')
    const coverage = scanCoverage(read.lines, [{ sku: 'BASE', count: 4 }])
    expect(coverage.lines.find((line) => line.sku === 'BASE')?.lineComplete).toBe(true)
    expect(coverage.allSerializedComplete).toBe(false)
  })

  it('does not queue a pick for an unverified line, and refuses a count past the order', () => {
    const loaded = readCustomerOrder(nayax, 'SO-100')
    expect(queueDecision({ loaded, sku: 'BASE', serialCount: 2 }).queue).toBe(true)
    expect(queueDecision({ loaded, sku: 'EXTRA', serialCount: 1 })).toMatchObject({ record: true, queue: false })
    expect(queueDecision({ loaded, sku: 'UNKNOWN', serialCount: 1 }).queue).toBe(false)
    const over = queueDecision({ loaded, sku: 'BASE', serialCount: 5 })
    expect(over).toMatchObject({ record: false, queue: false })
    expect(over.reason).toContain('Nothing was recorded')
    expect(queueDecision({
      loaded: { ok: false, reason: 'No order matches SO-100.' },
      sku: 'BASE',
      serialCount: 1,
    })).toMatchObject({ record: true, queue: false })
  })
})
