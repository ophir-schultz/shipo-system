// Device versus component, per spec §5.6.
//
// Precedence is SKU prefix, then Zenventory's native `category`, then
// component. The prefix wins deliberately: `category` is blank on
// R144GUSB01S10 and R144GUSY01S10, the two highest-volume readers, so a
// category-first rule would demote both to the lower pick rate and the
// shortfall would never appear anywhere as an error.

export type SkuClass = 'device' | 'component'
export type ClassificationSource = 'sku_prefix' | 'category' | 'default'

const DEVICE_PREFIXES = ['R', 'D'] as const

export function classifySku(input: {
  sku: string
  category?: string | null
}): { skuClass: SkuClass; source: ClassificationSource } {
  const sku = (input.sku ?? '').trim().toUpperCase()

  if (DEVICE_PREFIXES.some((p) => sku.startsWith(p))) {
    return { skuClass: 'device', source: 'sku_prefix' }
  }

  const category = (input.category ?? '').trim().toLowerCase()
  if (category === 'device') {
    return { skuClass: 'device', source: 'category' }
  }
  if (category === 'component' || category === 'accessory') {
    return { skuClass: 'component', source: 'category' }
  }

  return { skuClass: 'component', source: 'default' }
}
