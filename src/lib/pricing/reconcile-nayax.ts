// Prices every order on the Nayax billing workbook and lists where the
// price list does not land on the sheet's figure.
//
// The workbook is not read here. Callers pass orders already taken off the
// sheet (fixtures/nayax-orders.json), so this stays pure and the fixture can
// omit recipient names, tracking numbers and serials.

import {
  money,
  parseQty,
  priceBoxes,
  pricePick,
  priceShipping,
} from './engine'
import type { BoxLine, PriceListDocument, SkuQty } from './types'

export interface NayaxSheetOrder {
  orderNumber: string
  date: string | null
  skuLines: string[]
  qtyLines: string[]
  qtyCount: number | null
  pick: number | null
  box: number | null
  shipping: number | null
  total: number | null
  zone: string | null
  weight: string | null
  volume: string | null
}

export interface Mismatch {
  orderNumber: string
  date: string
  field: 'pick' | 'box' | 'shipping' | 'total'
  category: string
  sheet: string
  priced: string
  detail: string
}

const CLOSE = 0.015

function lines(value: string | null): string[] {
  return (value ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

function close(priced: number | null, sheet: number | null): boolean {
  if (priced === null || sheet === null) return false
  return Math.abs(priced - sheet) < CLOSE
}

function cell(n: number | null): string {
  return n === null ? '' : n.toFixed(2)
}

export function parseZone(zone: string | null): number | null {
  const match = (zone ?? '').match(/(\d+)/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) ? n : null
}

/**
 * One weight line is one box. Volume weight is paired by line when the
 * two columns have the same number of lines. A different count is reported
 * and the scale weight is what gets priced.
 */
export function parseWeightLines(
  weight: string | null,
  volume: string | null,
): { boxes: BoxLine[]; error: string | null; volumeAligned: boolean } {
  const weightLines = lines(weight)
  const volumeLines = lines(volume)
  if (weightLines.length === 0) {
    return { boxes: [], error: 'no weight line', volumeAligned: false }
  }
  if (weightLines.some((l) => l.toUpperCase() === 'PALLET')) {
    return { boxes: [], error: 'weight line is PALLET, which is not a parcel box', volumeAligned: false }
  }
  const boxes: BoxLine[] = []
  for (const line of weightLines) {
    const match = line.match(/^(\d+(?:\.\d+)?)(\s*lbs?)\s*(.*)$/i)
    if (!match) return { boxes: [], error: `weight line not understood: ${line}`, volumeAligned: false }
    const statedLb = Number(match[1])
    const weightLabel = `${match[1]}${match[2]}`.replace(/\s+/g, '')
    const boxCode = match[3].trim() || null
    boxes.push({ statedLb, volumeLb: null, boxCode, weightLabel })
  }
  const volumeAligned = volumeLines.length === boxes.length
  if (volumeAligned) {
    for (let i = 0; i < boxes.length; i++) {
      const n = Number(volumeLines[i].replace(/,/g, ''))
      boxes[i].volumeLb = Number.isFinite(n) ? n : null
    }
  }
  return { boxes, error: null, volumeAligned }
}

function skuQty(order: NayaxSheetOrder): { lines: SkuQty[]; error: string | null } {
  if (order.skuLines.length !== order.qtyLines.length) {
    return {
      lines: [],
      error: `SKU lines (${order.skuLines.length}) and QTY lines (${order.qtyLines.length}) do not match`,
    }
  }
  const out: SkuQty[] = []
  for (let i = 0; i < order.skuLines.length; i++) {
    const qty = parseQty(order.qtyLines[i])
    if (qty === null) return { lines: [], error: `quantity "${order.qtyLines[i]}" is not a number` }
    out.push({ sku: order.skuLines[i], qty })
  }
  return { lines: out, error: null }
}

export function reconcileOrder(list: PriceListDocument, order: NayaxSheetOrder): Mismatch[] {
  const out: Mismatch[] = []
  const date = order.date ?? ''
  const skus = skuQty(order)
  const weights = parseWeightLines(order.weight, order.volume)
  const zone = parseZone(order.zone)

  const pick = skus.error ? { amount: null as number | null, reasons: [skus.error] } : pricePick(list, skus.lines)
  const box = weights.error
    ? { amount: null as number | null, reasons: [weights.error] }
    : priceBoxes(list, weights.boxes)
  // A weight line we could not read has no boxes to price. Asking the zone
  // card anyway reports "no zone" for a pallet, which sends someone to the
  // wrong column.
  const shipping = weights.error
    ? { amount: null as number | null, reasons: [weights.error] }
    : !date
      ? { amount: null as number | null, reasons: ['no date'] }
      : priceShipping(list, date, zone, weights.boxes)

  const push = (
    field: Mismatch['field'],
    sheet: number | null,
    priced: number | null,
    reasons: string[],
    category: string,
  ) => {
    if (close(priced, sheet)) return
    out.push({
      orderNumber: order.orderNumber,
      date,
      field,
      category,
      sheet: cell(sheet),
      priced: cell(priced),
      detail: reasons.filter(Boolean).join('; '),
    })
  }

  push('pick', order.pick, pick.amount, pick.reasons, pickCategory(skus.error, pick.amount, order.pick))
  push('box', order.box, box.amount, box.reasons, boxCategory(weights.error, box.amount, order.box))
  push(
    'shipping',
    order.shipping,
    shipping.amount,
    [
      ...shipping.reasons,
      weights.volumeAligned ? '' : 'volume-weight lines do not line up with weight lines',
    ],
    shippingCategory(order, shipping.amount, zone, weights.error),
  )

  const pricedTotal = pick.amount === null || box.amount === null || shipping.amount === null
    ? null
    : money(pick.amount + box.amount + shipping.amount)
  push('total', order.total, pricedTotal, [], pricedTotal === null ? 'total_unknown' : 'total_mismatch')

  return out
}

function pickCategory(error: string | null, priced: number | null, sheet: number | null): string {
  if (error) return 'pick_sku_qty_lines'
  if (priced === null) return 'pick_unpriced'
  if (sheet === null) return 'pick_sheet_blank'
  return 'pick_mismatch'
}

function boxCategory(error: string | null, priced: number | null, sheet: number | null): string {
  if (error?.includes('PALLET')) return 'box_pallet'
  if (error?.includes('no weight')) return 'box_no_weight_line'
  if (error?.includes('not understood')) return 'box_weight_unparsed'
  if (priced === null && error === null) return 'box_unknown_code_or_no_rate'
  if (priced === null) return 'box_unpriced'
  if (sheet === null) return 'box_sheet_blank'
  return 'box_mismatch'
}

function shippingCategory(
  order: NayaxSheetOrder,
  priced: number | null,
  zone: number | null,
  weightError: string | null,
): string {
  if (weightError?.includes('PALLET')) return 'shipping_pallet'
  if (!order.date) return 'shipping_no_date'
  if (zone === null) return 'shipping_no_zone'
  if (weightError) return 'shipping_weight_unparsed'
  if (priced === null) return 'shipping_unpriced'
  if (order.date < '2026-05-19') return 'shipping_before_may_19'
  return 'shipping_after_may_19'
}

export function reconcileOrders(list: PriceListDocument, orders: NayaxSheetOrder[]): Mismatch[] {
  return orders.flatMap((order) => reconcileOrder(list, order))
}

export function mismatchCsv(rows: Mismatch[]): string {
  const header = ['order_number', 'date', 'field', 'category', 'sheet', 'priced', 'detail']
  const body = rows.map((row) => [
    row.orderNumber,
    row.date,
    row.field,
    row.category,
    row.sheet,
    row.priced,
    row.detail,
  ].map(csvCell).join(','))
  return [header.join(','), ...body].join('\n') + '\n'
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function countCategories(rows: Mismatch[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.category] = (counts[row.category] ?? 0) + 1
  return counts
}
