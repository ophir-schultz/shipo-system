import { describe, it, expect } from 'vitest'
import { classifySku } from '@/lib/billing/classify-sku'

describe('classifySku', () => {
  it('classifies an R-prefix SKU as a device', () => {
    expect(classifySku({ sku: 'R144GUSB01S10' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('classifies a D-prefix SKU as a device', () => {
    expect(classifySku({ sku: 'D200X' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  // The measured finding from spec §5.6: category is blank on exactly the two
  // highest-volume readers. If prefix did not win, both would be demoted to
  // component rate and the loss would never surface.
  it('prefers the prefix over a blank category on the two known readers', () => {
    for (const sku of ['R144GUSB01S10', 'R144GUSY01S10']) {
      expect(classifySku({ sku, category: '' }))
        .toEqual({ skuClass: 'device', source: 'sku_prefix' })
    }
  })

  // Precedence, stated as a test rather than as a comment: even an actively
  // wrong category loses to the prefix.
  it('prefers the prefix over a contradicting category', () => {
    expect(classifySku({ sku: 'R144GUSB01S10', category: 'Accessory' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('falls back to category when the prefix does not recognise the SKU', () => {
    expect(classifySku({ sku: 'CABLE-01', category: 'Device' }))
      .toEqual({ skuClass: 'device', source: 'category' })
  })

  it('matches category case-insensitively', () => {
    expect(classifySku({ sku: 'CABLE-01', category: 'DEVICE' }))
      .toEqual({ skuClass: 'device', source: 'category' })
  })

  it('defaults to component when neither signal fires', () => {
    expect(classifySku({ sku: 'CABLE-01', category: null }))
      .toEqual({ skuClass: 'component', source: 'default' })
    expect(classifySku({ sku: 'CABLE-01' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })

  // Lower-case SKUs arrive from at least one storefront. Treating 'r144g...'
  // as a component would be a silent 12-cent leak per unit.
  it('matches the prefix case-insensitively', () => {
    expect(classifySku({ sku: 'r144gusb01s10' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('ignores surrounding whitespace on the SKU', () => {
    expect(classifySku({ sku: '  D200X  ' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  // A prefix rule must match a prefix, not a substring. 'XR100' contains an R
  // but does not start with one.
  it('does not match R or D appearing later in the SKU', () => {
    expect(classifySku({ sku: 'XR100' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })

  it('treats a blank SKU as a component rather than throwing', () => {
    expect(classifySku({ sku: '' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })
})
