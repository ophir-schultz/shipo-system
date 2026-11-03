import { priceOf } from '@/lib/billing/unpriced'
import { inEffect, type WarehouseRateRow } from '@/lib/billing/warehouse-log-rate'
import { cents } from '@/lib/ledger/calculate-charges'

// Every rate line in effect for one client on one day, including the
// structured rows that have no service_type. Those are keyed
// `charge_type:variant`, which is how the log stores them.
//
// Automatic lines are exactly the pairs the ledger already writes onto
// order_charges: pick device, pick component, shipping, the peak surcharge,
// and pallet or shelf storage. Orcam's pick_pack rows are not in that set.
// The calculator never reads them, so logging one must still be able to
// bill it. An automatic line is recorded with a null total and a note, and
// the revenue screens skip that note so it is not reported as unpriced.

export const ENTERED_NOTE = '[Entered amount]'

export const AUTOMATIC_NOTE =
  '[AUTOMATIC SERVICE - recorded only, billed by the automatic charge, not from this log]'

/** Pairs calculate-charges.ts and storage-charges.ts write onto order_charges. */
export const AUTOMATIC_PAIRS: ReadonlyArray<{ chargeType: string; variant: string | null }> = [
  { chargeType: 'pick', variant: 'device' },
  { chargeType: 'pick', variant: 'component' },
  { chargeType: 'shipping', variant: null },
  { chargeType: 'surcharge', variant: 'peak' },
  { chargeType: 'storage', variant: 'pallet' },
  { chargeType: 'storage', variant: 'shelf' },
]

export type LinePricing = 'fixed' | 'entered'

export interface RateCardRow extends WarehouseRateRow {
  charge_type?: string | null
  variant?: string | null
  label?: string | null
  rate_type?: string | null
  markup?: number | string | null
}

export interface CardLine {
  key: string
  label: string
  rate: number | null
  /** What to print beside the quantity. Empty when the number itself is the rate. */
  rateText: string
  unit: string | null
  pricing: LinePricing
  automatic: boolean
  automaticReason: string | null
  problem: string | null
}

export interface PricedLogLine {
  rate: number | null
  total: number | null
  notes: string | null
  /** Set when the row is saved with no total and should be reported as unpriced. */
  unpricedReason: string | null
  /** Set when the request must be refused. Nothing is written. */
  error: string | null
}

const ENTERED_TYPES = new Set(['cost_plus', 'at_cost', 'percentage', 'percent'])

export function lineKey(row: RateCardRow): string | null {
  const service = row.service_type?.trim()
  if (service) return service
  const charge = row.charge_type?.trim()
  if (!charge) return null
  return `${charge}:${row.variant?.trim() ?? ''}`
}

export function isAutomaticPair(
  chargeType: string | null | undefined,
  variant: string | null | undefined,
): boolean {
  const charge = chargeType?.trim() ?? ''
  if (!charge) return false
  const variantNorm = variant?.trim() ? variant.trim() : null
  return AUTOMATIC_PAIRS.some((pair) => pair.chargeType === charge && pair.variant === variantNorm)
}

export function isRecordedOnlyNote(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.startsWith(AUTOMATIC_NOTE)
}

export function billableWarehouse<T extends { notes?: string | null }>(
  rows: readonly T[] | null | undefined,
): T[] {
  return (rows ?? []).filter((row) => !isRecordedOnlyNote(row.notes))
}

function rateTypeOf(row: RateCardRow): string {
  return (row.rate_type ?? '').trim().toLowerCase()
}

function pricingOf(row: RateCardRow): LinePricing {
  if (ENTERED_TYPES.has(rateTypeOf(row))) return 'entered'
  if (priceOf(row.rate) === null) return 'entered'
  return 'fixed'
}

function percentOf(row: RateCardRow): number | null {
  return priceOf(row.rate) ?? priceOf(row.markup)
}

/** cost-plus prints as `cost + X%`, with X taken off the row. */
export function rateTextOf(row: RateCardRow): string {
  const type = rateTypeOf(row)
  if (type === 'cost_plus') {
    const n = percentOf(row)
    return n === null ? 'cost + %' : `cost + ${n}%`
  }
  if (type === 'at_cost') return 'at cost'
  if (type === 'percentage' || type === 'percent') {
    const n = priceOf(row.rate)
    return n === null ? '%' : `${n}%`
  }
  return ''
}

/**
 * The unit the charge calculator prices with.
 *
 * Structured rows leave `unit` at the column default `per_unit`
 * (ledger_05_seed_nayax.sql). `rate_type` is what the calculator reads:
 * devanning is `flat`, a pallet line is `per_pallet`.
 */
export function displayUnit(row: RateCardRow): string | null {
  const rateType = row.rate_type?.trim()
  if (rateType) return rateType
  const unit = row.unit?.trim()
  return unit || null
}

function labelOf(row: RateCardRow, key: string): string {
  const label = row.label?.trim()
  if (label) return label
  return key.replace(/[_:]/g, ' ')
}

function reasonFor(row: RateCardRow): string {
  const charge = row.charge_type?.trim() ?? ''
  const variant = row.variant?.trim()
  const pair = variant ? `${charge}/${variant}` : charge
  return `Billed by the automatic ${pair} charge. This log records the work and does not bill it again.`
}

/**
 * One line per key in effect on `date`. Two live rows for the same key
 * collapse to one line whose problem says the save will be unpriced.
 */
export function cardLines(card: readonly RateCardRow[], date: string): CardLine[] {
  const groups = new Map<string, RateCardRow[]>()
  for (const row of card) {
    if (!inEffect(row, date)) continue
    const key = lineKey(row)
    if (!key) continue
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const lines: CardLine[] = []
  for (const [key, rows] of groups) {
    const row = rows[0]
    const duplicate = rows.length > 1
    const automatic = !duplicate && isAutomaticPair(row.charge_type, row.variant)
    const pricing = pricingOf(row)
    lines.push({
      key,
      label: labelOf(row, key),
      rate: priceOf(row.rate) ?? (pricing === 'entered' ? percentOf(row) : null),
      rateText: rateTextOf(row),
      unit: displayUnit(row),
      pricing,
      automatic,
      automaticReason: automatic ? reasonFor(row) : null,
      problem: duplicate
        ? `${rows.length} rate lines for '${key}' are in effect on ${date}, so which one applies is ambiguous. This line is saved unpriced.`
        : null,
    })
  }

  lines.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
  return lines
}

function prefixNote(prefix: string, notes: string | null): string {
  const rest = (notes ?? '').trim()
  return rest ? `${prefix} ${rest}` : prefix
}

/**
 * What one submitted line is worth.
 *
 * An entered line with no amount above 0 refuses the request. An automatic
 * line records the quantity and writes no total. A duplicate writes no
 * total and is reported as unpriced.
 */
export function priceLogLine(input: {
  line: CardLine | undefined
  quantity: number
  amount: number | null
  notes: string | null
}): PricedLogLine {
  const notes = input.notes?.trim() ? input.notes.trim() : null
  if (!input.line) {
    return {
      rate: null,
      total: null,
      notes,
      unpricedReason: 'no rate line is in effect for this service',
      error: null,
    }
  }
  if (input.line.problem) {
    return {
      rate: null,
      total: null,
      notes,
      unpricedReason: input.line.problem,
      error: null,
    }
  }
  if (input.line.automatic) {
    return {
      rate: null,
      total: null,
      notes: prefixNote(AUTOMATIC_NOTE, notes),
      unpricedReason: null,
      error: null,
    }
  }
  if (input.line.pricing === 'entered') {
    if (input.amount === null || !(input.amount > 0)) {
      return {
        rate: null,
        total: null,
        notes,
        unpricedReason: null,
        error: 'an entered amount above 0 is required',
      }
    }
    return {
      rate: cents(input.amount / input.quantity),
      total: cents(input.amount),
      notes: prefixNote(ENTERED_NOTE, notes),
      unpricedReason: null,
      error: null,
    }
  }
  const rate = input.line.rate
  return {
    rate,
    total: rate === null ? null : cents(rate * input.quantity),
    notes,
    unpricedReason: rate === null ? 'the rate line has no rate' : null,
    error: null,
  }
}
