import { describe, expect, it } from 'vitest'
import {
  applyZonePrices, hasPricedPick, lineQty, pickPackRows, pickRateOnCard, pickRowsFromCard,
  shippingChargesFromShipments,
} from './statement-source'
import { buildStatement } from './statement'
import { rateText } from './statement-view'
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

  it('splits an Orcam order into the order rate and the extra items', () => {
    const rows = pickPackRows([{
      orderId: 'o1',
      chargeDate: '2026-10-26',
      lines: [{ sku: 'A', qty: 6 }],
    }], orcam)
    expect(rows.map((row) => [row.label, row.quantity, row.unit_rate, row.amount])).toEqual([
      ['Pick & pack', 1, 0.5, 0.5],
      ['Additional items', 2, 0.1, 0.2],
    ])
  })

  it('groups a period into orders times $0.50 and extra items times $0.10', () => {
    const rows = pickPackRows([
      { orderId: 'o1', chargeDate: '2026-10-26', lines: [{ sku: 'A', qty: 6 }] },
      { orderId: 'o2', chargeDate: '2026-10-27', lines: [{ sku: 'B', qty: 4 }] },
    ], orcam)
    const statement = buildStatement(rows, { from: '2026-10-26', to: '2026-11-01' })
    const lines = statement.lines.map((line) => ({
      label: line.label,
      quantity: line.quantity,
      rate: rateText(line),
      amount: line.sum.total,
    }))
    expect(lines).toEqual([
      { label: 'Additional items', quantity: 2, rate: '$0.1000', amount: 0.2 },
      { label: 'Pick & pack', quantity: 2, rate: '$0.5000', amount: 1 },
    ])
  })

  it('uses the picked quantity when one was recorded', () => {
    expect(lineQty(4, 2)).toBe(2)
    expect(lineQty(4, 0)).toBe(4)
    expect(lineQty(null, null)).toBeNull()
  })
})

describe('statement shipping when the ledger has no charges', () => {
  it('prices each live shipment from client_rate and drops a voided label', () => {
    const rows = shippingChargesFromShipments([
      {
        shipstation_shipment_id: 11,
        order_number: 'A-1',
        ship_date: '2026-10-27T02:30:00.000Z',
        client_rate: 18.5,
      },
      {
        shipstation_shipment_id: 12,
        order_number: 'A-2',
        ship_date: '2026-10-28',
        client_rate: 33.31,
        raw_data: { voided: true },
      },
      {
        shipstation_shipment_id: 13,
        order_number: 'A-3',
        ship_date: '2026-10-29',
        client_rate: null,
      },
    ], new Map([['A-1', 'order-1']]))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      amount: 18.5,
      charge_date: '2026-10-26',
      order_id: 'order-1',
      charge_key: 'shipment:11',
    })
    expect(rows[1].amount).toBeNull()
  })
})

describe('pick & pack from the warehouse rate card', () => {
  it('uses the one live pick_n_pack rate and ignores a superseded line', () => {
    const rate = pickRateOnCard([
      { service_type: 'pick_n_pack', rate: 1.2, effective_from: '2026-01-01' },
      { service_type: 'pick_n_pack', rate: 0.9, effective_to: '2025-12-31' },
      { service_type: 'storage', rate: 25 },
    ], '2026-10-26')
    expect(rate).toBe(1.2)
    const rows = pickRowsFromCard([{ orderId: 'o1', chargeDate: '2026-10-26' }], rate ?? 0)
    expect(rows[0]).toMatchObject({ label: 'Pick & pack', amount: 1.2, quantity: 1 })
  })

  it('does not guess when two live pick rates disagree', () => {
    expect(pickRateOnCard([
      { service_type: 'pick_pack', rate: 0.5 },
      { service_type: 'pick_n_pack', rate: 1.2 },
    ], '2026-10-26')).toBeNull()
  })
})
