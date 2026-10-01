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

  // Storage has no order, so it keys on the month -- AND on the variant. A
  // month-only key collides pallet onto shelf: both rows carry the same
  // (client_id, charge_key), the partial unique index keeps only one, and half
  // the storage revenue vanishes with no error anywhere.
  it('keys storage on the month AND the variant, so pallet does not collide with shelf', () => {
    expect(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01', variant: 'pallet' }))
      .toBe('storage:2026-09-01:pallet')
    expect(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01', variant: 'shelf' }))
      .toBe('storage:2026-09-01:shelf')
    expect(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01', variant: 'shelf' }))
      .not.toBe(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01', variant: 'pallet' }))
  })

  it('refuses a storage key with a blank variant', () => {
    expect(() => chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01', variant: '' }))
      .toThrow(/variant/)
  })

  it('keys a surcharge on the shipment and the surcharge code', () => {
    expect(chargeKey({ chargeType: 'surcharge', shipmentId: '55', surchargeCode: 'peak' }))
      .toBe('shipment:55:peak')
  })

  // These two shared a `case` and so shared a key. Since (order_id, charge_key)
  // is unique, a return would have UPDATED the outbound shipping charge rather
  // than joining it: the freight revenue replaced by the credit, silently.
  // Nothing emits 'return' yet, which is why this never showed up in the data.
  it('keys a return separately from the shipping charge it reverses', () => {
    expect(chargeKey({ chargeType: 'shipping', shipmentId: '91827364' }))
      .toBe('shipment:91827364')
    expect(chargeKey({ chargeType: 'return', shipmentId: '91827364' }))
      .toBe('return:91827364')
    expect(chargeKey({ chargeType: 'return', shipmentId: '91827364' }))
      .not.toBe(chargeKey({ chargeType: 'shipping', shipmentId: '91827364' }))
  })

  // The return key is deliberately NOT 'shipment:<id>:return'. Surcharge codes
  // arrive from the carrier and are not validated against a list, so that form
  // would collide again the day a carrier names a surcharge 'return'. This test
  // fails if someone later "tidies" the return key into the shipment namespace.
  it('cannot be collided with by a surcharge code, whatever the carrier calls it', () => {
    expect(chargeKey({ chargeType: 'surcharge', shipmentId: '77', surchargeCode: 'return' }))
      .not.toBe(chargeKey({ chargeType: 'return', shipmentId: '77' }))
  })

  it('refuses a blank shipment id on a return, as it does everywhere else', () => {
    expect(() => chargeKey({ chargeType: 'return', shipmentId: '  ' }))
      .toThrow(BlankIdentifierError)
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
    expect(() => chargeKey({ chargeType: 'storage', periodMonth: '', variant: 'pallet' }))
      .toThrow(/periodMonth/)
  })
})
