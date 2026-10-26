import { describe, it, expect } from 'vitest'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'

describe('normaliseLines', () => {
  it('numbers lines from 1 in the order received', () => {
    const out = normaliseLines([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }])
    expect(out.map((l) => l.line_ordinal)).toEqual([1, 2, 3])
    expect(out.map((l) => l.sku)).toEqual(['A', 'B', 'C'])
  })

  // Kits repeat a SKU across lines. SKU is not a key; line_ordinal is.
  it('keeps two lines with the same SKU distinct', () => {
    const out = normaliseLines([{ sku: 'KIT-A' }, { sku: 'KIT-A' }])
    expect(out).toHaveLength(2)
    expect(out[0].line_ordinal).toBe(1)
    expect(out[1].line_ordinal).toBe(2)
  })

  it('classifies each line and records which rule fired', () => {
    const out = normaliseLines([
      { sku: 'R144GUSB01S10', category: '' },
      { sku: 'CABLE-01', category: 'Accessory' },
      { sku: 'CABLE-02' },
    ])
    expect(out[0].is_component).toBe(false)
    expect(out[0].classification_source).toBe('sku_prefix')
    expect(out[1].is_component).toBe(true)
    expect(out[1].classification_source).toBe('category')
    expect(out[2].is_component).toBe(true)
    expect(out[2].classification_source).toBe('default')
  })

  // REVIEW FOCUS 5, first half. Zero picked means not picked. If `picked`
  // were true here, Task 14 would raise a pick charge of quantity 0 and the
  // order would carry a $0.00 line that looks like a completed pick.
  it('treats a picked quantity of zero as not picked', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: 5, quantityPicked: 0 }])
    expect(out[0].quantity_picked).toBe(0)
    expect(out[0].picked).toBe(false)
  })

  it('treats a missing picked quantity as not picked, not as zero picked', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: 5 }])
    expect(out[0].quantity_picked).toBeNull()
    expect(out[0].picked).toBe(false)
  })

  // REVIEW FOCUS 5, second half. A negative picked quantity is corrupt input.
  // Silently accepting it produces a negative charge, which reads on the P&L
  // as us paying the client to pick their order.
  it('refuses a negative picked quantity rather than crediting it', () => {
    expect(() => normaliseLines([{ sku: 'A', quantityPicked: -2 }]))
      .toThrow(NegativeQuantityError)
  })

  it('refuses a negative ordered quantity', () => {
    expect(() => normaliseLines([{ sku: 'A', quantityOrdered: -1 }]))
      .toThrow(NegativeQuantityError)
  })

  // The ordinal is asserted as 'line 2', not as a bare '2'. A bare '2' also
  // matches the quantity -2 printed in the same message, so the old assertion
  // passed against an implementation that never named the ordinal at all.
  it('names the offending line in the error, so it can be found', () => {
    const call = () => normaliseLines([{ sku: 'A' }, { sku: 'BAD-SKU', quantityPicked: -2 }])
    expect(call).toThrow(NegativeQuantityError)
    expect(call).toThrow(/BAD-SKU/)
    expect(call).toThrow(/line 2\b/)
  })

  // Zenventory returns quantities as strings on some endpoints.
  it('accepts numeric strings', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: '5', quantityPicked: '3' }])
    expect(out[0].quantity_ordered).toBe(5)
    expect(out[0].quantity_picked).toBe(3)
    expect(out[0].picked).toBe(true)
  })

  it('treats an unparseable quantity as unknown, not as zero', () => {
    const out = normaliseLines([{ sku: 'A', quantityPicked: 'n/a' }])
    expect(out[0].quantity_picked).toBeNull()
    expect(out[0].picked).toBe(false)
  })

  it('falls back to `quantity` when `quantityOrdered` is absent', () => {
    const out = normaliseLines([{ sku: 'A', quantity: 4 }])
    expect(out[0].quantity_ordered).toBe(4)
  })

  it('returns an empty array for an order with no lines', () => {
    expect(normaliseLines([])).toEqual([])
  })

  it('keeps a line with no SKU rather than dropping it', () => {
    const out = normaliseLines([{ description: 'Freight surcharge', quantity: 1 }])
    expect(out).toHaveLength(1)
    expect(out[0].sku).toBeNull()
    expect(out[0].is_component).toBe(true)
  })
})

describe('normaliseLines: which key the picked quantity came from', () => {
  // Measured 2026-10-26: 3,394 order lines in production, 3,394 with a
  // quantity ordered, 3,394 with an SKU, ZERO with a quantity picked. This
  // read `line.quantityPicked` and nothing else, while Zenventory's REST docs
  // name the field `pickedQuantity`. Eight months of syncing, 139 agreed
  // warehouse rate lines, and not one pick, pack or material charge could be
  // generated, because pick_days needs quantity_picked > 0.
  //
  // The old mapping passes every test below that uses `quantityPicked`, which
  // is how it survived: the suite agreed with the code about the field name
  // and neither of them had seen the payload.

  it('reads the name Zenventory actually documents', () => {
    const [line] = normaliseLines([{ sku: 'A', pickedQuantity: 3 }])
    expect(line.quantity_picked).toBe(3)
    expect(line.picked).toBe(true)
    expect(line.picked_key).toBe('pickedQuantity')
  })

  it('still reads the name this code used before', () => {
    // Kept, not replaced. The live payload has not been inspected directly --
    // the field name came from documentation -- so dropping the old spelling
    // would trade one guess for another.
    const [line] = normaliseLines([{ sku: 'A', quantityPicked: 2 }])
    expect(line.quantity_picked).toBe(2)
    expect(line.picked_key).toBe('quantityPicked')
  })

  it('reads snake_case and abbreviated spellings too', () => {
    expect(normaliseLines([{ quantity_picked: 4 }])[0].quantity_picked).toBe(4)
    expect(normaliseLines([{ picked_quantity: 5 }])[0].quantity_picked).toBe(5)
    expect(normaliseLines([{ qtyPicked: 6 }])[0].quantity_picked).toBe(6)
  })

  it('reports picked_key = null when the payload has none of them', () => {
    // THE WHOLE POINT. Without this the sync cannot tell "nobody picked it"
    // from "we are reading the wrong field", because both write null.
    const [line] = normaliseLines([{ sku: 'A', quantity: 10 }])
    expect(line.quantity_picked).toBeNull()
    expect(line.picked_key).toBeNull()
  })

  it('distinguishes a key that is present and null from a key that is absent', () => {
    // Present-and-null is Zenventory saying "not picked" -- a fact. Absent is
    // us not knowing how to ask. Same stored value, opposite meanings, and
    // conflating them is exactly what hid this for eight months.
    const absent = normaliseLines([{ sku: 'A' }])[0]
    const present = normaliseLines([{ sku: 'A', pickedQuantity: null }])[0]
    expect(absent.quantity_picked).toBeNull()
    expect(present.quantity_picked).toBeNull()
    expect(absent.picked_key).toBeNull()
    expect(present.picked_key).toBe('pickedQuantity')
  })

  it('takes the first key PRESENT, not the first that holds a value', () => {
    // If the live field says null and a legacy alias still carries a stale
    // number, the live field wins. Falling through to the alias would
    // resurrect an old pick count as though it were current.
    const [line] = normaliseLines([{ pickedQuantity: null, quantityPicked: 9 }])
    expect(line.quantity_picked).toBeNull()
    expect(line.picked_key).toBe('pickedQuantity')
  })

  it('keeps zero meaning NOT PICKED, whichever key carried it', () => {
    const [line] = normaliseLines([{ sku: 'A', pickedQuantity: 0 }])
    expect(line.quantity_picked).toBe(0)
    expect(line.picked).toBe(false)
  })

  it('still refuses a negative quantity under the new key', () => {
    // The guard that stops a negative pick charge -- the business paying a
    // client to have their order picked -- must cover every spelling, not
    // only the one it was written against.
    expect(() => normaliseLines([{ sku: 'A', pickedQuantity: -1 }]))
      .toThrow(NegativeQuantityError)
  })
})
