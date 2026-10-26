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
  // Every spelling of "how many were picked" we are prepared to read. See
  // PICKED_KEYS below for why this is a list and not one name.
  quantityPicked?: number | string | null
  pickedQuantity?: number | string | null
  quantity_picked?: number | string | null
  picked_quantity?: number | string | null
  qtyPicked?: number | string | null
  category?: string | null
}

/**
 * The keys that may carry the picked quantity, in the order they are tried.
 *
 * WHY THIS IS A LIST, AND WHY IT IS LOUD.
 *
 * This read `line.quantityPicked` and nothing else. Measured 2026-10-26, after
 * eight months of syncing: 3,394 order lines in the database, 3,394 with a
 * quantity ordered, 3,394 with an SKU -- and ZERO with a quantity picked. Not
 * a sparse column. Empty.
 *
 * A hundred per cent of one field and zero per cent of its neighbour is not
 * what missing data looks like; it is what a wrong key looks like. Zenventory's
 * REST documentation names the field `pickedQuantity`, while the quantity
 * ordered is read here as `quantityOrdered ?? quantity` -- two spellings, which
 * is exactly why that one never broke.
 *
 * What it cost: `pick_days` requires `pick_date is not null and
 * quantity_picked > 0`, so not one pick, pack or material charge could ever be
 * generated. 139 warehouse rate lines were agreed with eight clients and
 * nothing was ever billed against any of them.
 *
 * So the fix is not simply the right name -- it is that a name which matches
 * NOTHING must stop being silent. `picked_key` below records which key was
 * found, or null for none, and the sync reports the count. A future Zenventory
 * rename then shows up as a number on the next run instead of as an empty
 * column somebody notices in a year.
 */
export const PICKED_KEYS = [
  'pickedQuantity', 'quantityPicked', 'quantity_picked',
  'picked_quantity', 'qtyPicked',
] as const

export interface NormalisedLine {
  line_ordinal: number
  sku: string | null
  description: string | null
  quantity_ordered: number | null
  quantity_picked: number | null
  is_component: boolean
  classification_source: string
  picked: boolean          // true only when quantity_picked > 0
  /**
   * Which of PICKED_KEYS carried the value, or null when the payload had none
   * of them. null is NOT the same as a key present holding null: the first
   * means we may be reading the wrong field, the second means this line was
   * not picked. Conflating them is what hid the defect above.
   */
  picked_key: string | null
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
    // First key PRESENT on the object wins, not first non-null value: a key
    // that exists and holds null is Zenventory saying "not picked", and
    // falling past it to try other spellings would let a stale alias override
    // the live field.
    const pickedKey = PICKED_KEYS.find(
      (k) => (line as Record<string, unknown>)[k] !== undefined) ?? null
    const picked = pickedKey === null
      ? null
      : toQuantity((line as Record<string, unknown>)[pickedKey])

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
      picked_key: pickedKey,
      is_component: skuClass === 'component',
      classification_source: source,
      picked: picked !== null && picked > 0,
    }
  })
}
