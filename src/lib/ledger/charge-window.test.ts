import { describe, expect, it } from 'vitest'
import { lateOrderNumbers, shipmentInChargeWindow } from './charge-window'

const WINDOW = '2026-10-07'

describe('charge window', () => {
  it('includes an October 6 order whose date-only shipment is October 7', () => {
    const numbers = lateOrderNumbers(WINDOW, [], [{
      orderNumber: 'SO601060842',
      shipDate: '2026-10-07T00:00:00.000Z',
      raw: { shipDate: '2026-10-07' },
    }])
    expect(numbers).toEqual(['SO601060842'])
  })

  it('does not include an order that was not shipped, a void, or a real midnight before the window', () => {
    expect(lateOrderNumbers(WINDOW, [], [])).toEqual([])
    expect(shipmentInChargeWindow({
      orderNumber: 'SO1',
      shipDate: '2026-10-07T00:00:00.000Z',
      raw: { shipDate: '2026-10-07', voided: true },
    }, WINDOW)).toBe(false)
    expect(shipmentInChargeWindow({
      orderNumber: 'SO2',
      shipDate: '2026-10-07T03:30:00.000Z',
      raw: { shipDate: '2026-10-07T03:30:00.000Z' },
    }, WINDOW)).toBe(false)
    expect(shipmentInChargeWindow({
      orderNumber: 'SO3',
      shipDate: '2026-10-06T00:00:00.000Z',
      raw: { shipDate: '2026-10-06' },
    }, WINDOW)).toBe(false)
  })

  it('adds one order when two labels share it, and skips an order already in the window', () => {
    const numbers = lateOrderNumbers(WINDOW, ['SO601060842'], [
      {
        orderNumber: 'so601060842',
        shipDate: '2026-10-07T00:00:00.000Z',
        raw: { shipDate: '2026-10-07' },
      },
      {
        orderNumber: 'SO601060842',
        shipDate: '2026-10-07T00:00:00.000Z',
        raw: { shipDate: '2026-10-07' },
      },
      {
        orderNumber: 'SO601061054',
        shipDate: '2026-10-07T00:00:00.000Z',
        raw: { shipDate: '2026-10-07' },
      },
    ])
    expect(numbers).toEqual(['SO601061054'])
  })
})
