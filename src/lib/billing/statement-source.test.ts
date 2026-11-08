import { describe, expect, it } from 'vitest'
import {
  applyManualFullFreight, applyZonePrices, decidePickRate, hasPricedPick, isPickPackService, lineQty,
  shippingDisagreements, uncoveredShipmentCharges, withholdDisagreedShipping,
  nayaxManualFreight, pickOrdersFromShipments, pickPackRows, pickRateOnCard, pickRowsFromCard,
  shippingChargesFromShipments,
} from './statement-source'
import { statementAmountDueCell, statementFigures } from './statement-view'
import { monthlyMinimumBill } from './monthly-minimum'
import { buildStatement } from './statement'
import { chargeRateCell, rateText } from './statement-view'
import { pricePick } from '@/lib/pricing/engine'
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

describe('Nayax freight with no zone price', () => {
  const atCost = (id: string, amount: number, date = '2026-10-09'): StatementChargeRow => charge({
    charge_key: `shipment:${id}`,
    amount,
    unit_rate: null,
    label: 'Shipping',
    charge_date: date,
  })
  const october = { from: '2026-10-01', to: '2026-10-31' }
  const agreed = {
    status: 'standard' as const,
    dollars: 395,
    reason: 'The matching rate sheet uses the standard monthly minimum.',
  }

  it('is only the Nayax approval, not every at-cost client', () => {
    expect(nayaxManualFreight('Nayax')).toBe(true)
    expect(nayaxManualFreight('Orcam')).toBe(false)
  })

  it('does not bill the carrier cost when no manual full price is linked', () => {
    const costs = [437.08, 105.65, 140.88, 77.75, 117.37]
    const rows = applyManualFullFreight(
      costs.map((amount, index) => atCost(String(1600 + index), amount)),
      [],
    ).charges
    expect(rows.map((row) => row.amount)).toEqual([null, null, null, null, null])
    expect(rows.every((row) => row.label === 'Shipping (full price pending)')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('437.08')
    expect(JSON.stringify(rows)).not.toContain('actual_cost')
    const statement = buildStatement([
      ...rows,
      charge({ charge_type: 'pick', label: 'Pick & pack', amount: 1548.64, unit_rate: 0.5, charge_key: 'pick:1' }),
    ], october)
    const figures = statementFigures(statement, monthlyMinimumBill({
      from: october.from, to: october.to, rows: statement.lines.flatMap(() => []), agreed,
    }))
    expect(statement.sum.unpriced).toBe(5)
    expect(statement.sum.total).toBeCloseTo(1548.64, 2)
    expect(figures.subtotalLabel).toBe('Known subtotal (partial)')
    expect(statementAmountDueCell(figures)).toBe('not final')
  })

  it('uses one linked full price and does not also keep the carrier cost', () => {
    const rows = applyManualFullFreight(
      [atCost('900', 437.08)],
      [{ shipmentId: '900', amount: 510, logDate: '2026-10-09' }],
    ).charges
    expect(rows).toEqual([expect.objectContaining({ amount: 510, unit_rate: null, label: 'Shipping' })])
    expect(JSON.stringify(rows)).not.toContain('437.08')
    expect(JSON.stringify(rows)).not.toContain('freight_cost')
  })

  it('leaves the charge unknown when two manual prices name the same shipment', () => {
    const rows = applyManualFullFreight(
      [atCost('900', 437.08)],
      [
        { shipmentId: '900', amount: 510, logDate: '2026-10-09' },
        { shipmentId: '900', amount: 520, logDate: '2026-10-09' },
      ],
    ).charges
    expect(rows[0].amount).toBeNull()
    expect(rows[0].label).toBe('Shipping (full price pending)')
    expect(JSON.stringify(rows)).not.toMatch(/510|520|437\.08/)
  })

  it('does not match a manual price by amount or by a missing shipment id', () => {
    const rows = applyManualFullFreight(
      [atCost('900', 437.08)],
      [
        { shipmentId: '', amount: 437.08, logDate: '2026-10-09' },
        { shipmentId: '901', amount: 999, logDate: '2026-10-09' },
      ],
    ).charges
    expect(rows[0].amount).toBeNull()
    expect(JSON.stringify(rows)).not.toContain('999')
  })

  it('does not replace a ledger amount with a different stored rate', () => {
    const before = [atCost('900', 10)]
    const rates = new Map<string, number | null>([['900', 14]])
    const zoned = applyZonePrices(before, rates)
    expect(zoned[0].amount).toBe(10)
    const held = withholdDisagreedShipping(before, zoned, rates)
    expect(held[0].amount).toBeNull()
    expect(held[0].label).toBe('Shipping (price not final)')
    expect(JSON.stringify(held)).not.toContain('14')
    expect(shippingDisagreements(before, rates)[0]).toContain('disagree')
  })

  it('keeps a linked full freight price when the stored rate differs', () => {
    const before = [atCost('900', 437.08)]
    const rates = new Map<string, number | null>([['900', 22.4]])
    const zoned = applyZonePrices(before, rates)
    const applied = applyManualFullFreight(zoned, [{ shipmentId: '900', amount: 510, logDate: '2026-10-09' }])
    const held = withholdDisagreedShipping(before, applied.charges, rates)
    expect(held[0].amount).toBe(510)
    expect(JSON.stringify(held)).not.toContain('437.08')
    expect(JSON.stringify(held)).not.toContain('22.4')
  })

  it('lists a shipment with no ledger shipping charge and does not price it', () => {
    const rows = uncoveredShipmentCharges([
      { id: 's1', shipstation_shipment_id: '77', order_number: 'SO-9', ship_date: '2026-11-06', client_rate: 104.92 },
    ], new Set(['shipment:1']), '2026-11-01')
    expect(rows).toEqual([expect.objectContaining({
      charge_key: 'shipment:77',
      amount: null,
      label: 'Shipping (not on the ledger)',
    })])
    expect(JSON.stringify(rows)).not.toContain('104.92')
  })

  it('does not drop a voided zero, a pick, or a non-freight shipping line', () => {
    const rows = applyManualFullFreight([
      charge({ charge_key: 'shipment:1', label: 'Shipping (voided)', amount: 0, unit_rate: null, charge_date: '2026-10-09' }),
      charge({ charge_type: 'pick', label: 'Pick & pack', amount: 4.2, unit_rate: null, charge_key: 'pickpack:1' }),
      charge({ charge_key: 'shipment:2', label: 'Delivery area', amount: 3.95, unit_rate: null, charge_date: '2026-10-09' }),
    ], []).charges
    expect(rows.map((row) => row.amount)).toEqual([0, 4.2, 3.95])
  })

  it('does not apply a manual total when the staff date is a different day', () => {
    const applied = applyManualFullFreight(
      [atCost('900', 437.08, '2026-10-09')],
      [{ shipmentId: '900', amount: 510, logDate: '2026-10-10' }],
    )
    expect(applied.charges[0].amount).toBeNull()
    expect(applied.reviews[0]).toMatch(/2026-10-10/)
    expect(JSON.stringify(applied.charges)).not.toContain('510')
  })
})

describe('pick is per order, not every device unit at the remainder rate', () => {
  it('charges one carton at the carton rate', () => {
    const list = loadRepoPriceList('Nayax').list
    expect(list?.devicePick).toBeTruthy()
    const priced = pricePick(list!, [{ sku: 'R-100', qty: 20 }])
    expect(priced.amount).toBe(list!.devicePick!.cartonRate)
    expect(priced.amount).not.toBe(20 * list!.devicePick!.remainderRate)
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

  it('does not price a Nayax order from the R/D prefix when scan requirement is missing', () => {
    const nayax = loadRepoPriceList('Nayax').list
    expect(nayax).not.toBeNull()
    const lines = [{ sku: 'R100', qty: 21 }, { sku: 'CABLE', qty: 2 }]
    const rows = pickPackRows([{ orderId: 'o1', chargeDate: '2026-10-08', lines }], nayax)
    expect(rows[0].amount).toBeNull()
    expect(rows[0].label).toBe('Pick & pack (classification unknown)')
    const classified = [{ sku: 'R100', qty: 20, scannable: true }, { sku: 'CABLE', qty: 100, scannable: false }]
    const priced = pickPackRows([{ orderId: 'o1', chargeDate: '2026-10-08', lines: classified }], nayax)
    expect(priced[0].amount).toBe(21.5)
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

  it('keeps a date-only ship day stored at UTC midnight, and shifts a real midnight', () => {
    const rows = shippingChargesFromShipments([
      {
        shipstation_shipment_id: 21,
        order_number: 'N-1',
        ship_date: '2026-10-01T00:00:00.000Z',
        client_rate: 10,
        raw_data: { shipDate: '2026-10-01' },
      },
      {
        shipstation_shipment_id: 22,
        order_number: 'N-2',
        ship_date: '2026-10-01T00:00:00.000Z',
        client_rate: 11,
      },
    ])
    expect(rows.map((row) => row.charge_date)).toEqual(['2026-10-01', '2026-09-30'])
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

  // schema.sql and public/templates/warehouse-rates-template.csv only name
  // pick_pack. Nayax's seed is charge_type 'pick' with service_type null.
  // warehouse_rate_card_copy_2026_10.sql never writes the live service_type
  // strings. Suteka and SitnStand are the lines the retest named. Creative
  // Pea and Kivema have a pick line under one of the other spellings that
  // retest listed; the dollar amount here is the rate on that row.
  it.each([
    ['Suteka', 'pick_n_pack', 1.2],
    ['SitnStand', 'orders_(picks_n_pack)', 2],
    ['Creative Pea', 'picks', 1.5],
    ['Creative Pea', 'pick_n_pack_(per_order)', 1.5],
    ['Kivema', 'orders_(pick_n_pack)', 1.5],
    ['Kivema', 'picks', 1.5],
  ])('%s is billed from %s', (_client, service, rate) => {
    expect(pickRateOnCard([
      { service_type: service, rate },
      { service_type: 'storage', rate: 25 },
      { service_type: 'additional_item', rate: 0.2 },
      { service_type: 'inbound_pallet_handling', rate: 7 },
    ], '2026-10-26')).toBe(rate)
  })

  it.each([
    'pick_pack',
    'pick_n_pack',
    'orders_(picks_n_pack)',
    'orders_(pick_n_pack)',
    'picks',
    'pick',
    'pick_n_pack_(per_order)',
    'Pick & pack',
    'picks and pack',
  ])('treats %s as pick & pack', (service) => {
    expect(isPickPackService(service)).toBe(true)
  })

  it('bills Creative Pea from the one live line and ignores a rate that ended that day', () => {
    const decision = decidePickRate([
      { service_type: 'orders_(picks_n_pack)', rate: 1.2, effective_from: '2026-10-26' },
      { service_type: 'pick_n_pack', rate: 1.75, effective_to: '2026-10-26' },
      { service_type: 'storage', rate: 25 },
    ], '2026-10-26')
    expect(decision.billed).toBe(true)
    expect(decision.rate).toBe(1.2)
    expect(decision.reason).toContain('orders_(picks_n_pack)')
  })

  it('bills Orcam from the base pick rate and leaves the additional item off that rate', () => {
    expect(isPickPackService('pick_pack')).toBe(true)
    expect(isPickPackService('pick_pack_additional_item')).toBe(false)
    const rows = [
      { service_type: 'pick_pack', rate: 0.5, effective_from: '2026-11-03' },
      { service_type: 'pick_pack_additional_item', rate: 0.1, effective_from: '2026-11-03' },
    ]
    const decision = decidePickRate(rows, '2026-11-06')
    expect(decision.billed).toBe(true)
    expect(decision.rate).toBe(0.5)
    expect(decision.reason).toContain('pick_pack')
    expect(decision.reason).not.toContain('additional')
    expect(rows[0].rate).toBe(0.5)
    expect(rows[1].rate).toBe(0.1)
  })

  it('keeps Kivema skipped and names both live rates', () => {
    const decision = decidePickRate([
      { service_type: 'orders_(picks_n_pack)', rate: 1.2 },
      { service_type: 'pick_n_pack', rate: 1.75 },
    ], '2026-10-26')
    expect(decision.billed).toBe(false)
    expect(decision.rate).toBeNull()
    expect(decision.reason).toContain('more than one live rate')
    expect(decision.reason).toContain('orders_(picks_n_pack) $1.20')
    expect(decision.reason).toContain('pick_n_pack $1.75')
  })

  it('says when the only pick line is outside the statement date', () => {
    const decision = decidePickRate([
      { service_type: 'orders_(picks_n_pack)', rate: 1.2, effective_from: '2026-11-02' },
    ], '2026-10-26')
    expect(decision.billed).toBe(false)
    expect(decision.reason).toContain('not in effect on 2026-10-26')
    expect(decision.reason).toContain('$1.20')
  })

  it('bills Creative Pea per order number when the orders join misses', () => {
    const orders = pickOrdersFromShipments([
      { shipstation_shipment_id: 1, order_number: 'CP-1', ship_date: '2026-10-27', client_rate: 10 },
      { shipstation_shipment_id: 2, order_number: 'CP-1', ship_date: '2026-10-28', client_rate: 11 },
      { shipstation_shipment_id: 3, order_number: 'CP-2', ship_date: '2026-10-28', client_rate: 12 },
    ], new Map())
    expect(orders).toHaveLength(2)
    expect(orders.every((order) => order.orderId === null)).toBe(true)
    const rows = pickRowsFromCard(orders, 1.2)
    expect(rows.map((row) => row.amount)).toEqual([1.2, 1.2])
    expect(new Set(rows.map((row) => row.charge_key)).size).toBe(2)
  })

  it('does not treat the rest of the card as pick & pack', () => {
    for (const service of [
      'storage',
      'additional_item',
      'pick_pack_additional_item',
      'inbound_pallet_handling',
      'special_tasks_(kitting,_bundling,_counting,_repackaging,_labelling)',
      'loose_case',
      null,
      '',
    ]) {
      expect(isPickPackService(service)).toBe(false)
    }
    expect(pickRateOnCard([
      { service_type: null, rate: 0.32 },
      { service_type: 'additional_item', rate: 0.2 },
    ], '2026-10-26')).toBeNull()
  })
})
