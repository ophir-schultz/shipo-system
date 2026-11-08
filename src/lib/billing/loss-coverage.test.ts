import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  barShare,
  classifyParcel,
  centsBetween,
  readIdChunks,
  shippingChargeKey,
  summarizeCoverage,
  type CoverageOrder,
  type LossParcel,
  type ShippingChargeRow,
} from './loss-coverage'

const OK = { charges: 'ok' as const, orders: 'ok' as const }

function parcel(over: Partial<LossParcel> = {}): LossParcel {
  return {
    clientId: 'nayax',
    orderNumber: 'SO-1',
    shipstationShipmentId: '900',
    carrierCost: 10,
    ...over,
  }
}

function charge(over: Partial<ShippingChargeRow> = {}): ShippingChargeRow {
  return {
    client_id: 'nayax',
    charge_key: 'shipment:900',
    charge_type: 'shipping',
    amount: 10,
    ...over,
  }
}

const ORDER: CoverageOrder = { client_id: 'nayax', order_key: 'SO-1' }

describe('recorded shipping charge versus rate-card shortfall', () => {
  it('keeps a rate card below cost from turning an at-cost charge into a recorded loss', () => {
    const row = classifyParcel(parcel({ carrierCost: 16.47 }), [charge({ amount: 16.47 })], [ORDER], OK)
    expect(row.kind).toBe('recorded')
    expect(row.recordedMinusCost).toBe(0)
    expect(row.recordedAmount).toBe(16.47)
  })

  it('does not treat a missing charge as $0 when no order exists', () => {
    const row = classifyParcel(parcel(), [], [], OK)
    expect(row.kind).toBe('no_order')
    expect(row.recordedAmount).toBeNull()
    expect(row.recordedMinusCost).toBeNull()
  })

  it('does not treat a missing charge as $0 when the order has no shipping charge for this parcel', () => {
    const row = classifyParcel(parcel(), [], [ORDER], OK)
    expect(row.kind).toBe('order_without_shipping_charge')
    expect(row.recordedMinusCost).toBeNull()
  })

  it('does not allocate either charge when one order has two shipping charges and this parcel has no id', () => {
    const charges = [
      charge({ charge_key: 'shipment:1', amount: 45.33 }),
      charge({ charge_key: 'shipment:2', amount: 7.26 }),
    ]
    const row = classifyParcel(parcel({ shipstationShipmentId: null }), charges, [ORDER], OK)
    expect(row.kind).toBe('no_shipment_id')
    expect(JSON.stringify(row)).not.toContain('45.33')
    expect(JSON.stringify(row)).not.toContain('7.26')
  })

  it('uses only the charge whose key is this parcel when the order has another label', () => {
    const charges = [
      charge({ charge_key: 'shipment:900', amount: 12 }),
      charge({ charge_key: 'shipment:901', amount: 80 }),
    ]
    const row = classifyParcel(parcel({ carrierCost: 18 }), charges, [ORDER], OK)
    expect(row).toMatchObject({ kind: 'recorded', recordedAmount: 12, recordedMinusCost: -6 })
    expect(JSON.stringify(row)).not.toContain('80')
  })

  it('refuses two charges that share this parcel key', () => {
    const row = classifyParcel(
      parcel(),
      [charge({ amount: 4 }), charge({ amount: 9 })],
      [ORDER],
      OK,
    )
    expect(row.kind).toBe('ambiguous_charges')
    expect(row.recordedAmount).toBeNull()
  })

  it('does not use another client’s charge, even when the key matches', () => {
    const row = classifyParcel(
      parcel(),
      [charge({ client_id: 'orcam', amount: 999 })],
      [ORDER],
      OK,
    )
    expect(row.kind).toBe('client_mismatch')
    expect(JSON.stringify(row)).not.toContain('999')
  })

  it('does not turn an unpriced matching charge or an empty list into zero', () => {
    const unpriced = classifyParcel(parcel(), [charge({ amount: null })], [ORDER], OK)
    expect(unpriced.kind).toBe('charge_unpriced')
    expect(unpriced.recordedAmount).toBeNull()
    const none = summarizeCoverage([])
    expect(none.matched).toBe(0)
    expect(none.recordedMinusCost).toBeNull()
    const atCost = summarizeCoverage([
      classifyParcel(parcel({ carrierCost: 4 }), [charge({ amount: 4 })], [ORDER], OK),
    ])
    expect(atCost.matched).toBe(1)
    expect(atCost.recordedMinusCost).toBe(0)
  })

  it('does not call a failed order read “no order”', () => {
    const row = classifyParcel(parcel(), [], [], { charges: 'ok', orders: 'failed' })
    expect(row.kind).toBe('orders_unreadable')
  })

  it('does not invent a difference when the carrier cost is unreadable', () => {
    const row = classifyParcel(parcel({ carrierCost: null }), [charge({ amount: 8 })], [ORDER], OK)
    expect(row.kind).toBe('cost_unknown')
    expect(row.recordedMinusCost).toBeNull()
  })

  it('sizes a bar against the largest amount, not the first label', () => {
    expect(barShare(19.94, 362.74)).toBeLessThan(100)
    expect(barShare(362.74, 362.74)).toBe(100)
    expect(barShare(10, 0)).toBe(0)
    expect(centsBetween(10.1, 10)).toBe(0.1)
  })

  it('refuses a non-digit shipment id and a surcharge key', () => {
    expect(shippingChargeKey('900')).toBe('shipment:900')
    expect(shippingChargeKey('900:fuel')).toBeNull()
    expect(shippingChargeKey(null)).toBeNull()
  })

  it('discards a chunk read that fails instead of keeping a prefix', async () => {
    const result = await readIdChunks(['a', 'b'], async () => ({ data: [{ id: 'a' }], error: { message: 'down' } }))
    expect(result.rows).toEqual([])
    expect(result.error).toBe('down')
  })
})

describe('loss page wording', () => {
  const page = readFileSync('src/app/losses/page.tsx', 'utf8')

  it('does not call the rate-card shortfall what we charged, paid, or confirmed', () => {
    expect(page).not.toContain('what we charged')
    expect(page).not.toContain('We Paid')
    expect(page).not.toContain('Money we lost')
    expect(page).toContain('rate-card shortfall')
    expect(page).toContain('not an invoice')
    expect(page).toContain('barShare')
    expect(page).not.toContain('byZone[0]')
  })
})
