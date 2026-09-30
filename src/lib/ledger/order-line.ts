import { classifySku } from '@/lib/billing/classify-sku'

// Normalises Zenventory order lines into order_items shape.
//
// Two decisions here are load-bearing and neither is obvious from the shape of
// the data:
//
//   quantity_picked = 0  means NOT PICKED. It raises no pick charge.
//   quantity_picked < 0  is corrupt input, not a credit. It throws.
//
// Accepting a negative quantity would produce a negative charge, which appears
// on the P&L as the business paying a client to have their order picked. That
// has no meaning and would be very hard to trace back to here.

export interface RawZenLine {
  sku?: string | null
  description?: string | null
  quantity?: number | string | null
  quantityOrdered?: number | string | null
  quantityPicked?: number | string | null
  category?: string | null
}

export interface NormalisedLine {
  line_ordinal: number
  sku: string | null
  description: string | null
  quantity_ordered: number | null
  quantity_picked: number | null
  is_component: boolean
  classification_source: string
  picked: boolean          // true only when quantity_picked > 0
}

export class NegativeQuantityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NegativeQuantityError'
  }
}

// Unknown is null, never 0. A quantity we could not parse is not a quantity of
// nothing, and the difference decides whether a charge exists.
function toQuantity(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

export function normaliseLines(raw: RawZenLine[]): NormalisedLine[] {
  return (raw ?? []).map((line, i) => {
    const ordinal = i + 1
    const sku = line.sku?.trim() || null

    const ordered = toQuantity(line.quantityOrdered ?? line.quantity)
    const picked = toQuantity(line.quantityPicked)

    for (const [name, value] of [['ordered', ordered], ['picked', picked]] as const) {
      if (value !== null && value < 0) {
        throw new NegativeQuantityError(
          `Negative ${name} quantity ${value} on line ${ordinal} `
          + `(SKU ${sku ?? 'none'}). A negative quantity is a data error, `
          + `not a credit, and will not be written.`
        )
      }
    }

    const { skuClass, source } = classifySku({
      sku: sku ?? '',
      category: line.category,
    })

    return {
      line_ordinal: ordinal,
      sku,
      description: line.description?.trim() || null,
      quantity_ordered: ordered,
      quantity_picked: picked,
      is_component: skuClass === 'component',
      classification_source: source,
      picked: picked !== null && picked > 0,
    }
  })
}
