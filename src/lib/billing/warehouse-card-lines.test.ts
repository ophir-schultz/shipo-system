import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_NOTE,
  ENTERED_NOTE,
  billableWarehouse,
  cardLines,
  isAutomaticPair,
  priceLogLine,
  type RateCardRow,
} from './warehouse-card-lines'

const DATE = '2026-11-03'

const row = (over: Partial<RateCardRow> = {}): RateCardRow => ({
  id: 'r1',
  service_type: null,
  charge_type: 'pick',
  variant: 'order',
  label: 'Pick & pack',
  rate: 0.5,
  rate_type: 'per_order',
  unit: 'per_order',
  effective_from: '2026-01-01',
  effective_to: null,
  ...over,
})

describe('cardLines', () => {
  it('keys a structured line with no service_type as charge_type:variant', () => {
    const [line] = cardLines([row()], DATE)
    expect(line.key).toBe('pick:order')
    expect(line.label).toBe('Pick & pack')
    expect(line.automatic).toBe(false)
    expect(line.pricing).toBe('fixed')
  })

  it('keeps a service_type as the key when the row has one', () => {
    const [line] = cardLines([row({ service_type: 'pick_pack', charge_type: 'pick', variant: 'order' })], DATE)
    expect(line.key).toBe('pick_pack')
    expect(line.automatic).toBe(false)
  })

  it('marks only the pairs the ledger writes to order charges as automatic', () => {
    expect(isAutomaticPair('pick', 'device')).toBe(true)
    expect(isAutomaticPair('pick', 'component')).toBe(true)
    expect(isAutomaticPair('shipping', null)).toBe(true)
    expect(isAutomaticPair('surcharge', 'peak')).toBe(true)
    expect(isAutomaticPair('storage', 'pallet')).toBe(true)
    expect(isAutomaticPair('storage', 'shelf')).toBe(true)
    expect(isAutomaticPair('pick', 'order')).toBe(false)
    expect(isAutomaticPair('pick', 'additional_item')).toBe(false)
    expect(isAutomaticPair(null, null)).toBe(false)

    const lines = cardLines([
      row({ id: 'd', charge_type: 'pick', variant: 'device', label: 'Device pick', rate: 0.32 }),
      row({ id: 'p', service_type: 'pick_pack', charge_type: 'pick', variant: 'order', label: 'Pick & pack' }),
      row({ id: 's', charge_type: 'shipping', variant: null, label: 'Shipping', rate: null, rate_type: 'at_cost' }),
      row({ id: 'k', charge_type: 'surcharge', variant: 'peak', label: 'Peak', rate: 8, rate_type: 'percentage' }),
      row({ id: 'st', charge_type: 'storage', variant: 'pallet', label: 'Pallet', rate: 25, rate_type: 'per_pallet' }),
    ], DATE)
    const byKey = Object.fromEntries(lines.map((line) => [line.key, line.automatic]))
    expect(byKey['pick:device']).toBe(true)
    expect(byKey.pick_pack).toBe(false)
    expect(byKey['shipping:']).toBe(true)
    expect(byKey['surcharge:peak']).toBe(true)
    expect(byKey['storage:pallet']).toBe(true)
  })

  it('prints cost-plus from the percent on the row', () => {
    const [line] = cardLines([
      row({ charge_type: 'material', variant: 'packing', label: 'Packing materials', rate: 15, rate_type: 'cost_plus' }),
    ], DATE)
    expect(line.pricing).toBe('entered')
    expect(line.rateText).toBe('cost + 15%')
    expect(line.automatic).toBe(false)
  })

  it('drops a line that is not in effect and warns on two live rows', () => {
    const lines = cardLines([
      row({ id: 'old', effective_to: '2026-11-01' }),
      row({ id: 'a', service_type: 'special_task', label: 'Special tasks', rate: 48 }),
      row({ id: 'b', service_type: 'special_task', label: 'Special tasks', rate: 45 }),
    ], DATE)
    expect(lines.map((line) => line.key)).toEqual(['special_task'])
    expect(lines[0].problem).toContain('2 rate lines')
    expect(lines[0].automatic).toBe(false)
  })
})

describe('priceLogLine', () => {
  const fixed = cardLines([row({ service_type: 'box_sorting', label: 'Box sorting', rate: 0.6 })], DATE)[0]
  const entered = cardLines([
    row({ charge_type: 'material', variant: 'packing', label: 'Packing materials', rate: 15, rate_type: 'cost_plus' }),
  ], DATE)[0]
  const automatic = cardLines([
    row({ charge_type: 'pick', variant: 'device', label: 'Device pick', rate: 0.32, rate_type: 'per_unit' }),
  ], DATE)[0]

  it('refuses an entered line with no amount above 0', () => {
    expect(priceLogLine({ line: entered, quantity: 2, amount: null, notes: null }).error)
      .toContain('above 0')
    expect(priceLogLine({ line: entered, quantity: 2, amount: 0, notes: null }).error)
      .toContain('above 0')
  })

  it('saves an entered amount as the total and the rate as amount divided by quantity', () => {
    const priced = priceLogLine({ line: entered, quantity: 4, amount: 10, notes: 'boxes' })
    expect(priced.error).toBeNull()
    expect(priced.total).toBe(10)
    expect(priced.rate).toBe(2.5)
    expect(priced.notes?.startsWith(ENTERED_NOTE)).toBe(true)
    expect(priced.unpricedReason).toBeNull()
  })

  it('records an automatic line with no total and does not call it unpriced', () => {
    const priced = priceLogLine({ line: automatic, quantity: 3, amount: 99, notes: null })
    expect(priced.total).toBeNull()
    expect(priced.rate).toBeNull()
    expect(priced.notes).toBe(AUTOMATIC_NOTE)
    expect(priced.unpricedReason).toBeNull()
    expect(priced.error).toBeNull()
  })

  it('saves a duplicate unpriced', () => {
    const line = cardLines([
      row({ id: 'a', service_type: 'special_task', rate: 48 }),
      row({ id: 'b', service_type: 'special_task', rate: 45 }),
    ], DATE)[0]
    const priced = priceLogLine({ line, quantity: 1, amount: null, notes: null })
    expect(priced.total).toBeNull()
    expect(priced.unpricedReason).toContain('ambiguous')
  })

  it('multiplies a fixed rate by the quantity', () => {
    const priced = priceLogLine({ line: fixed, quantity: 5, amount: null, notes: null })
    expect(priced.total).toBe(3)
    expect(priced.rate).toBe(0.6)
  })
})

describe('billableWarehouse', () => {
  it('leaves recorded-only automatic rows out of the revenue sum', () => {
    const rows = billableWarehouse([
      { total: 12, notes: 'boxes' },
      { total: null, notes: AUTOMATIC_NOTE },
      { total: null, notes: `${AUTOMATIC_NOTE} counted 4` },
      { total: null, notes: 'missing rate' },
    ])
    expect(rows).toEqual([
      { total: 12, notes: 'boxes' },
      { total: null, notes: 'missing rate' },
    ])
  })
})
