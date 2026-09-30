import { describe, expect, it } from 'vitest'
import { BlankIdentifierError, chargeKey } from '@/lib/ledger/charge-key'

describe('chargeKey', () => {
  it('keys a shipping charge on the ShipStation shipment id', () => {
    expect(chargeKey({ chargeType: 'shipping', shipmentId: '91827364' }))
      .toBe('shipment:91827364')
  })

  it('keys pick and pack separately for the same order line', () => {
    const item = { orderItemId: 'a1b2c3' }
    expect(chargeKey({ chargeType: 'pick', ...item })).toBe('item:a1b2c3:pick')
    expect(chargeKey({ chargeType: 'pack', ...item })).toBe('item:a1b2c3:pack')
  })

  it('includes the variant in a material key, so two box sizes do not collide', () => {
    expect(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_small' }))
      .toBe('item:a1:material:box_small')
    expect(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_large' }))
      .not.toBe(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_small' }))
  })

  it('keys storage on the month, because storage has no order', () => {
    expect(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01' }))
      .toBe('storage:2026-09-01')
  })

  it('keys a surcharge on the shipment and the surcharge code', () => {
    expect(chargeKey({ chargeType: 'surcharge', shipmentId: '55', surchargeCode: 'peak' }))
      .toBe('shipment:55:peak')
  })

  it('is stable: the same input always produces the same key', () => {
    const input = { chargeType: 'pick' as const, orderItemId: 'zz' }
    expect(chargeKey(input)).toBe(chargeKey(input))
  })

  // --- Review Focus item 2 -------------------------------------------------
  // 14 labels a month carry a blank order number. If a blank identifier
  // produced a key, every one of them would collapse onto 'shipment:' and the
  // unique index would make them overwrite each other -- silent data loss
  // wearing idempotency as a disguise. Refusing to build the key is the only
  // safe answer; the caller reports it as unattributed spend instead.
  it('refuses to build a key from a blank identifier', () => {
    expect(() => chargeKey({ chargeType: 'shipping', shipmentId: '' }))
      .toThrow(BlankIdentifierError)
    expect(() => chargeKey({ chargeType: 'shipping', shipmentId: '   ' }))
      .toThrow(BlankIdentifierError)
  })

  it('refuses a null or undefined identifier just as firmly', () => {
    // @ts-expect-error deliberately passing a bad value the DB could yield
    expect(() => chargeKey({ chargeType: 'pick', orderItemId: null }))
      .toThrow(BlankIdentifierError)
    // @ts-expect-error deliberately passing a bad value the DB could yield
    expect(() => chargeKey({ chargeType: 'pick', orderItemId: undefined }))
      .toThrow(BlankIdentifierError)
  })

  it('names the offending field in the error, so the log is actionable', () => {
    expect(() => chargeKey({ chargeType: 'storage', periodMonth: '' }))
      .toThrow(/periodMonth/)
  })
})
