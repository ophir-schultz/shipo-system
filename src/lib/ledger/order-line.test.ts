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

  it('names the offending line in the error, so it can be found', () => {
    try {
      normaliseLines([{ sku: 'A' }, { sku: 'BAD-SKU', quantityPicked: -2 }])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('BAD-SKU')
      expect((e as Error).message).toContain('2')   // the line ordinal
    }
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
