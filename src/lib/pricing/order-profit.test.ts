import { describe, expect, it } from 'vitest'
import { rollupClients, rollupOrders, type ShipmentMoney } from './order-profit'

function row(over: Partial<ShipmentMoney> = {}): ShipmentMoney {
  return {
    id: 's1',
    clientId: 'c1',
    clientName: 'Nayax',
    orderNumber: 'SO1',
    shipDate: '2026-06-01',
    trackingNumber: '1Z',
    clientRate: 10,
    actualCost: 7,
    ...over,
  }
}

describe('order profit', () => {
  it('subtracts ShipStation cost from the client price, per order', () => {
    const [order] = rollupOrders([row()])
    expect(order.clientPrice).toBe(10)
    expect(order.shipstationCost).toBe(7)
    expect(order.profit).toBe(3)
  })

  it('sums a multi-box order and does not treat a missing cost as zero', () => {
    const orders = rollupOrders([
      row({ id: 'a', clientRate: 10, actualCost: 4 }),
      row({ id: 'b', clientRate: 6, actualCost: null }),
    ])
    expect(orders).toHaveLength(1)
    expect(orders[0].shipments).toBe(2)
    expect(orders[0].clientPrice).toBe(16)
    expect(orders[0].shipstationCost).toBeNull()
    expect(orders[0].profit).toBeNull()
  })

  it('rolls clients up from priced orders only and counts the rest', () => {
    const orders = rollupOrders([
      row({ id: 'a', orderNumber: 'SO1', clientRate: 10, actualCost: 4 }),
      row({ id: 'b', orderNumber: 'SO2', clientRate: null, actualCost: 8 }),
      row({ id: 'c', clientId: 'c2', clientName: 'Other', orderNumber: 'SO3', clientRate: 5, actualCost: 9 }),
    ])
    const clients = rollupClients(orders)
    const nayax = clients.find((client) => client.clientName === 'Nayax')
    const other = clients.find((client) => client.clientName === 'Other')
    expect(nayax?.pricedOrders).toBe(1)
    expect(nayax?.unpricedOrders).toBe(1)
    expect(nayax?.profit).toBe(6)
    expect(other?.profit).toBe(-4)
  })
})
