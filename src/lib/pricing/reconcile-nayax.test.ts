import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePriceList } from './parse-price-list'
import {
  countCategories,
  mismatchCsv,
  reconcileOrders,
  type NayaxSheetOrder,
} from './reconcile-nayax'

const ROOT = join(__dirname, '../../..')
const orders = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/nayax-orders.json'), 'utf8'),
) as NayaxSheetOrder[]
const parsed = parsePriceList(JSON.parse(readFileSync(join(ROOT, 'price-lists/nayax.json'), 'utf8')))

describe('Nayax workbook reconciliation', () => {
  it('prices every order and writes the mismatch list', () => {
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(orders).toHaveLength(1315)

    const mismatches = reconcileOrders(parsed.list, orders)
    const csv = mismatchCsv(mismatches)
    const outDir = join(ROOT, 'reports')
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, 'nayax-reconciliation-mismatches.csv')
    writeFileSync(outPath, csv)

    const counts = countCategories(mismatches)
    const ordersWith = (field: 'pick' | 'box' | 'shipping' | 'total') =>
      new Set(mismatches.filter((row) => row.field === field).map((row) => row.orderNumber)).size

    // Locked to this run of the engine against fixtures/nayax-orders.json.
    // A change in a rate or a rule moves these counts, which is the point.
    expect(ordersWith('pick')).toBe(counts.pick_sku_qty_lines + (counts.pick_mismatch ?? 0) + (counts.pick_unpriced ?? 0))
    expect(csv.split('\n')[0]).toBe('order_number,date,field,category,sheet,priced,detail')
    expect(mismatches.length).toBe(Object.values(counts).reduce((s, n) => s + n, 0))

    // Recorded so the PR can quote them. Update both together when a rule changes.
    expect(counts).toEqual({
      pick_mismatch: 1,
      pick_sku_qty_lines: 3,
      box_mismatch: 11,
      box_no_weight_line: 12,
      box_pallet: 1,
      box_sheet_blank: 2,
      box_unknown_code_or_no_rate: 6,
      shipping_after_may_19: 53,
      shipping_before_may_19: 11,
      shipping_no_zone: 13,
      shipping_pallet: 1,
      total_mismatch: 75,
      total_unknown: 20,
    })

    const post = orders.filter((order) => (order.date ?? '') >= '2026-05-19')
    const pre = orders.filter((order) => (order.date ?? '') < '2026-05-19')
    const shippingBad = new Set(mismatches.filter((row) => row.field === 'shipping').map((row) => row.orderNumber))
    expect(post.filter((order) => !shippingBad.has(order.orderNumber))).toHaveLength(1180)
    expect(pre.filter((order) => !shippingBad.has(order.orderNumber))).toHaveLength(57)
    expect(orders.filter((order) => !mismatches.some((row) => row.field === 'pick' && row.orderNumber === order.orderNumber))).toHaveLength(1311)
  })
})
