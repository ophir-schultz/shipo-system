import { describe, expect, it } from 'vitest'
import { profitInstants, profitPeriod, profitRows } from './profit-view'
import type { ShipmentMoney } from './order-profit'

const row = (over: Partial<ShipmentMoney> = {}): ShipmentMoney => ({
  id: 's1',
  clientId: 'c1',
  clientName: 'Nayax',
  orderNumber: 'SO1',
  shipDate: '2026-11-03T15:00:00.000Z',
  trackingNumber: '1Z',
  clientRate: 20,
  actualCost: 8,
  ...over,
})

describe('staff profit period', () => {
  it('opens a week on Monday', () => {
    const period = profitPeriod({ grain: 'week', today: '2026-11-03', from: '', to: '' })
    expect(period).toEqual({ from: '2026-11-02', to: '2026-11-08', error: null })
    expect(profitInstants(period.from, period.to).start).toBe('2026-11-02T05:00:00.000Z')
  })

  it('keeps a custom range and refuses a backwards one', () => {
    expect(profitPeriod({ grain: 'custom', today: '2026-11-03', from: '2026-10-01', to: '2026-10-03' }).from)
      .toBe('2026-10-01')
    expect(profitPeriod({ grain: 'custom', today: '2026-11-03', from: '2026-10-03', to: '2026-10-01' }).error)
      .toContain('from')
  })
})

describe('staff profit rows', () => {
  it('shows price, ShipStation cost, and profit, and leaves a missing cost blank', () => {
    const rows = profitRows('shipment', [row(), row({
      id: 's2', orderNumber: 'SO2', clientRate: 10, actualCost: null,
    })])
    expect(rows[0]['Price ($)']).toBe('20.00')
    expect(rows[0]['ShipStation cost ($)']).toBe('8.00')
    expect(rows[0]['Profit ($)']).toBe('12.00')
    expect(rows[1]['Profit ($)']).toBe('')
  })

  it('rolls an order and a client from the same shipments', () => {
    const shipments = [
      row(),
      row({ id: 's2', clientRate: 5, actualCost: 1 }),
    ]
    expect(profitRows('order', shipments)[0]['Profit ($)']).toBe('16.00')
    expect(profitRows('client', shipments)[0]['Profit ($)']).toBe('16.00')
  })
})
