import { describe, expect, it } from 'vitest'
import { applyZonePrices, hasPricedPick, lineQty, pickPackRows } from './statement-source'
import { loadRepoPriceList } from '@/lib/pricing/repo-price-lists'
import type { StatementChargeRow } from './statement-charges'

const charge = (over: Partial<StatementChargeRow> = {}): StatementChargeRow => ({
  charge_type: 'shipping',
  label: 'Shipping',
  quantity: 1,
  unit_rate: null,
  amount: null,
  is_estimate: false,
  charge_date: '2026-10-26',
  order_id: 'o1',
  charge_key: 'shipment:9001',
  ...over,
})

describe('statement shipping uses the zone-matrix price', () => {
  it('fills an unpriced shipping line from client_rate and leaves a miss unknown', () => {
    const rates = new Map<string, number | null>([['9001', 12.4], ['9002', null]])
    const rows = applyZonePrices([
      charge(),
      charge({ charge_key: 'shipment:9002', order_id: 'o2' }),
      charge({ charge_type: 'pick', label: 'Pick', amount: 0.5, unit_rate: 0.5, charge_key: 'pick:1' }),
    ], rates)
    expect(rows[0].amount).toBe(12.4)
    expect(rows[0].unit_rate).toBe(12.4)
    expect(rows[1].amount).toBeNull()
    expect(rows[2].amount).toBe(0.5)
  })

  it('does not add pick & pack when the ledger already priced one', () => {
    expect(hasPricedPick([charge({ charge_type: 'pick', amount: 0.5 })])).toBe(true)
    expect(hasPricedPick([charge({ charge_type: 'pick', amount: null })])).toBe(false)
  })
})

describe('statement pick & pack', () => {
  const orcam = loadRepoPriceList('Orcam').list

  it('prices Orcam as $0.50 for the first four items and $0.10 after', () => {
    const rows = pickPackRows([{
      orderId: 'o1',
      chargeDate: '2026-10-26',
      lines: [{ sku: 'A', qty: 6 }],
    }], orcam)
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe('Pick & pack')
    expect(rows[0].quantity).toBe(6)
    expect(rows[0].amount).toBe(0.7)
    expect(rows[0].charge_key).toBe('pickpack:o1')
  })

  it('uses the picked quantity when one was recorded', () => {
    expect(lineQty(4, 2)).toBe(2)
    expect(lineQty(4, 0)).toBe(4)
    expect(lineQty(null, null)).toBeNull()
  })
})
