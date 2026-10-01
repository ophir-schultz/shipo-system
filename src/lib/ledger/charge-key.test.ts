import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BlankIdentifierError, CHARGE_TYPES, type ChargeType, chargeKey,
} from '@/lib/ledger/charge-key'

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

// ---------------------------------------------------------------------------
// The list of charge types exists twice -- here in TypeScript, and as a check
// constraint in supabase/ledger_03_charges.sql -- because SQL cannot import a
// TypeScript union. Two copies of anything load-bearing drift, and the copy
// that drifts is the one nobody looks at. These tests are what stops the drift
// from being silent.
//
// What drift costs, in each direction:
//
//   TS has a type SQL does not  ->  the calculator emits it, the insert is
//     rejected by the check constraint, and persist-charges fails the whole
//     batch. Loud, and the least bad of the two.
//   SQL has a type TS does not  ->  nothing emits it, so nothing fails. The
//     type is simply unreachable, and the constraint silently permits a value
//     that the leak views do not look for. That is the dangerous direction and
//     it has no symptom at all, which is why equality is asserted rather than
//     TS being checked as a subset.
// ---------------------------------------------------------------------------
describe('CHARGE_TYPES against the database check constraint', () => {
  // Read, not imported: the point is to look at what the migration actually
  // says. Anything that paraphrased the .sql file into a TS constant would be
  // a third copy and would pass while the file it describes said otherwise.
  const sql = readFileSync('supabase/ledger_03_charges.sql', 'utf8')

  /** The literals inside `check (charge_type in (...))`, in file order. */
  function constraintValues(): string[] {
    const m = sql.match(
      /constraint\s+order_charges_charge_type_valid\s+check\s*\(\s*charge_type\s+in\s*\(([^)]*)\)/i)
    if (!m) throw new Error(
      'order_charges_charge_type_valid not found in supabase/ledger_03_charges.sql. '
      + 'If the constraint was renamed, update this test; if it was REMOVED, that '
      + 'is the thing this test exists to report.')
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  }

  // Guards the test itself. A regex that quietly matched nothing would return
  // [] and make the set comparison below trivially informative-looking in the
  // wrong direction -- it is the "assertion that passes because it matched
  // nothing" failure the verify scripts in this repo warn about.
  it('finds the constraint at all', () => {
    expect(constraintValues().length).toBeGreaterThan(0)
  })

  it('permits exactly the types TypeScript can emit -- no more, no fewer', () => {
    expect([...constraintValues()].sort()).toEqual([...CHARGE_TYPES].sort())
  })

  // Not covered by the equality above: the constraint is written out a SECOND
  // time inside the check_violation handler, in the query that names the
  // offending rows. If those two lists differ, the error message reports the
  // wrong rows -- it would tell the operator a row is fine when the constraint
  // rejected it, which is a worse outcome than no message.
  it('uses the same list in the handler that names the offending rows', () => {
    const diag = sql.match(
      /where charge_type not in \(([^)]*)\)\) bad/)
    expect(diag).not.toBeNull()
    const values = [...diag![1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    expect(values.sort()).toEqual([...CHARGE_TYPES].sort())
  })

  // `as const` is what makes CHARGE_TYPES a tuple of literals and ChargeType a
  // union rather than `string`. Dropping it is a one-character edit that
  // disarms the compile-time check on every charge_type written in
  // calculate-charges.ts, and nothing else in this suite notices -- verified by
  // mutation: removing `as const` and writing charge_type: 'Pick' produced no
  // error from tsc and no failing test.
  //
  // Checked at the TYPE level, with no runtime effect. The obvious version --
  // `@ts-expect-error CHARGE_TYPES.push('x')` -- compiles to a real push,
  // because `as const` is erased at runtime and the array is an ordinary
  // mutable one. It would leave 'x' in CHARGE_TYPES for anything that ran
  // afterwards, which is how a test that guards a constant ends up corrupting
  // it.
  //
  // This therefore only bites under `npx tsc --noEmit`; `vitest run` does not
  // typecheck, and will report this test as passing whatever the type says.
  // That is acceptable because tsc is the gate here, but it is the reason the
  // assertion below is worth so little on its own.
  it('keeps ChargeType a union of literals rather than widening to string', () => {
    // If `as const` is removed, ChargeType becomes string, `string extends
    // ChargeType` becomes true, and NotWidened becomes false -- so the
    // initialiser below stops compiling.
    type NotWidened = string extends ChargeType ? false : true
    const narrow: NotWidened = true
    expect(narrow).toBe(true)
  })
})
