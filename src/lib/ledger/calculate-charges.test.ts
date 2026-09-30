import { describe, it, expect } from 'vitest'
import { buildCharges, type ChargeInput } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

const costRates: CostRateRow[] = [
  { id: 'cr-pick-d', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.23, effective_from: '2026-01-01', effective_to: null, basis: 'derived' },
  { id: 'cr-pick-c', cost_type: 'pick', variant: 'component', unit: 'per_unit',
    rate: 0.20, effective_from: '2026-01-01', effective_to: null, basis: 'estimated' },
]

const base: ChargeInput = {
  order: { id: 'o1', clientId: 'c1', cancelled: false },
  items: [],
  shipments: [],
  rateCard: [
    { id: 'rc-pick-d', chargeType: 'pick', variant: 'device',    rate: 0.32, rateType: 'per_unit' },
    { id: 'rc-pick-c', chargeType: 'pick', variant: 'component', rate: 0.20, rateType: 'per_unit' },
    { id: 'rc-ship',   chargeType: 'shipping', variant: null,    rate: null, rateType: 'at_cost' },
  ],
  costRates,
  peakSurchargePct: 0,
}

describe('buildCharges', () => {
  it('raises no charges for an order with nothing picked and nothing shipped', () => {
    expect(buildCharges(base)).toEqual([])
  })

  it('raises a pick charge per picked line, keyed on the line', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i1', sku: 'R144GUSB01S10', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      charge_key: 'item:i1:pick',
      charge_type: 'pick',
      quantity: 4,
      unit_rate: 0.32,
      amount: 1.28,
      cost: expect.closeTo(0.92, 6),
      cost_basis: 'derived',
      cost_rate_id: 'cr-pick-d',
      rate_id: 'rc-pick-d',
      charge_date: '2026-09-01',
    })
  })

  it('prices a component pick at the component rate', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i2', sku: 'CABLE-01', quantityPicked: 5, isComponent: true, pickDate: '2026-09-01' },
    ]})
    expect(out[0]).toMatchObject({ unit_rate: 0.20, amount: 1.00, cost: expect.closeTo(1.00, 6) })
  })

  // REVIEW FOCUS 5, at the charge layer. Task 12 stops a zero-picked line at
  // the normaliser; this stops it again here, because order_items may also be
  // written by the ShipStation path.
  it('raises no pick charge for a line with zero picked', () => {
    expect(buildCharges({ ...base, items: [
      { id: 'i3', sku: 'A', quantityPicked: 0, isComponent: true, pickDate: '2026-09-01' },
    ]})).toEqual([])
  })

  it('raises no pick charge for a line whose picked quantity is unknown', () => {
    expect(buildCharges({ ...base, items: [
      { id: 'i3b', sku: 'A', quantityPicked: null, isComponent: true, pickDate: '2026-09-01' },
    ]})).toEqual([])
  })

  it('raises no pick charge for a line with no pick date', () => {
    expect(buildCharges({ ...base, items: [
      { id: 'i4', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: null },
    ]})).toEqual([])
  })

  // A corrupt quantity is not an absent one. Null and zero mean "not picked",
  // which is a normal state; a negative or non-finite quantity means the data
  // is wrong and a person has to go and fix it. Swallowing it here as "no
  // charge" would hide that, and recording it as an unknown COST would send
  // someone to enter a cost rate that was never the problem. costOf() throws;
  // buildCharges lets it through to the per-order boundary in persist-charges.
  it('refuses a non-finite picked quantity rather than silently skipping it', () => {
    expect(() => buildCharges({ ...base, items: [
      { id: 'i4a', sku: 'A', quantityPicked: Number.POSITIVE_INFINITY,
        isComponent: true, pickDate: '2026-09-01' },
    ]})).toThrow(RangeError)
  })

  it('refuses a negative picked quantity rather than silently skipping it', () => {
    expect(() => buildCharges({ ...base, items: [
      { id: 'i4b', sku: 'A', quantityPicked: -3, isComponent: true, pickDate: '2026-09-01' },
    ]})).toThrow(RangeError)
  })

  it('raises no charges at all for a cancelled order', () => {
    expect(buildCharges({
      ...base,
      order: { ...base.order, cancelled: true },
      items: [{ id: 'i5', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: '2026-09-01' }],
    })).toEqual([])
  })

  it('bills shipping at cost and records the carrier cost', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's1', shipmentId: 555, shipDate: '2026-09-02', actualCost: 8.20, voided: false },
    ]})
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      charge_key: 'shipment:555',
      charge_type: 'shipping',
      amount: 8.20,
      cost: 8.20,
      cost_basis: 'measured',
      charge_date: '2026-09-02',
      charge_date_source: 'ship_date',
    })
  })

  // A voided label contributes $0 to measured cost. Leaving it in would
  // overstate spend by the amount that was refunded; it is counted instead in
  // the voided-label leak line (Task 15).
  it('gives a voided shipment zero amount and zero cost', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's2', shipmentId: 556, shipDate: '2026-09-02', actualCost: 9.10, voided: true },
    ]})
    expect(out[0]).toMatchObject({ amount: 0, cost: 0 })
  })

  // An unknown carrier cost must stay unknown. Writing 0 here would report a
  // free shipment, which is the null-versus-zero error from Task 13 arriving
  // by a different route.
  it('leaves cost null when the carrier cost is unknown', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's3', shipmentId: 557, shipDate: '2026-09-02', actualCost: null, voided: false },
    ]})
    expect(out[0].cost).toBeNull()
    expect(out[0].amount).toBe(0)
  })

  // charge_date is `not null` in order_charges, so an undated shipment cannot
  // be written at all: including it would fail the whole batch upsert and take
  // every other charge on the order down with it.
  it('raises no shipping charge for a shipment with no ship date', () => {
    expect(buildCharges({ ...base, shipments: [
      { id: 's3b', shipmentId: 558, shipDate: '', actualCost: 8.20, voided: false },
    ]})).toEqual([])
  })

  // shipstation_shipment_id is nullable, and String(null) is the string 'null'.
  // Every unidentified label on an order would key to 'shipment:null', and
  // because (order_id, charge_key) is unique they would collapse into a single
  // row — losing shipping revenue quietly instead of loudly. Unidentified
  // labels belong in leaks_monthly.unattributed_label_spend, not here.
  it('raises no shipping charge for a shipment with no stable id', () => {
    expect(buildCharges({ ...base, shipments: [
      { id: 's3c', shipmentId: Number.NaN, shipDate: '2026-09-02', actualCost: 8.20, voided: false },
    ]})).toEqual([])
  })

  it('leaves cost null and flags an estimate when no cost rate covers the date', () => {
    const out = buildCharges({
      ...base,
      items: [{ id: 'i6', sku: 'A', quantityPicked: 2, isComponent: true, pickDate: '2025-06-01' }],
    })
    expect(out[0].cost).toBeNull()
    expect(out[0].cost_basis).toBeNull()
    expect(out[0].is_estimate).toBe(true)
  })

  it('flags an estimate when the cost rate itself is estimated', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i7', sku: 'CABLE', quantityPicked: 1, isComponent: true, pickDate: '2026-09-01' },
    ]})
    expect(out[0].cost_basis).toBe('estimated')
    expect(out[0].is_estimate).toBe(true)
  })

  it('raises no charge when the client has no rate card line for it', () => {
    const out = buildCharges({
      ...base,
      rateCard: base.rateCard.filter((r) => r.chargeType !== 'pick'),
      items: [{ id: 'i8', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: '2026-09-01' }],
    })
    expect(out).toEqual([])
  })

  // Peak surcharge is 8% of pick and pack only. It must NOT apply to
  // at-cost carrier freight — a surcharge on a pass-through cost is
  // overbilling — and must not compound on itself.
  it('applies the peak surcharge to picks but not to shipping', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 8,
      items: [{ id: 'i9', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
      shipments: [{ id: 's4', shipmentId: 558, shipDate: '2026-09-01', actualCost: 8.20, voided: false }],
    })
    const sur = out.filter((c) => c.charge_type === 'surcharge')
    expect(sur).toHaveLength(1)
    // 10 * 0.32 = 3.20, 8% of which is 0.256 -> 0.26
    expect(sur[0].amount).toBeCloseTo(0.26, 2)
    expect(sur[0].cost).toBeNull()
    // A constant key, not a chargeKey() call: the surcharge is levied on the
    // order, not on a shipment, and (order_id, charge_key) is the unique index.
    expect(sur[0].charge_key).toBe('surcharge:peak')
  })

  it('raises no surcharge when the percentage is zero', () => {
    const out = buildCharges({ ...base, peakSurchargePct: 0, items: [
      { id: 'i10', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out.some((c) => c.charge_type === 'surcharge')).toBe(false)
  })

  // Idempotency is the whole point of charge_key. Three crons a day against a
  // non-deterministic key would triple the P&L.
  it('produces identical keys on repeated calls', () => {
    const input = { ...base, items: [
      { id: 'i11', sku: 'R1', quantityPicked: 2, isComponent: false, pickDate: '2026-09-01' },
    ]}
    expect(buildCharges(input).map((c) => c.charge_key))
      .toEqual(buildCharges(input).map((c) => c.charge_key))
  })

  it('rounds amounts to cents', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i12', sku: 'R1', quantityPicked: 3, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out[0].amount).toBe(0.96)
  })

  // Nayax's quote folds packing into the pick rate, so their card has no
  // ('pack', ...) line and no pack charge may appear. If one does, every Nayax
  // order is being overbilled.
  it('raises no pack charge for a client whose card has no pack line', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i13', sku: 'R1', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out.some((c) => c.charge_type === 'pack')).toBe(false)
  })

  // The same calculator, given a card that DOES price packing separately, must
  // raise it without anyone editing the code. This is the test that proves the
  // three outstanding rate cards slot in rather than requiring rework.
  it('raises a pack charge when the card prices packing separately', () => {
    const out = buildCharges({
      ...base,
      rateCard: [...base.rateCard,
        { id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' }],
      items: [{ id: 'i14', sku: 'R1', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' }],
    })
    const pack = out.filter((c) => c.charge_type === 'pack')
    expect(pack).toHaveLength(1)
    expect(pack[0].amount).toBeCloseTo(0.60, 6)
    expect(pack[0].charge_key).toBe('item:i14:pack')
  })

  // Peak surcharge is 8% of pick AND pack. With both present the base is the
  // sum, not the pick alone -- an easy off-by-one-line error that underbills.
  it('includes pack in the peak surcharge base', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 8,
      rateCard: [...base.rateCard,
        { id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' }],
      items: [{ id: 'i15', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    // pick 10 * 0.32 = 3.20, pack 10 * 0.15 = 1.50, base 4.70, 8% = 0.376 -> 0.38
    const sur = out.find((c) => c.charge_type === 'surcharge')!
    expect(sur.amount).toBeCloseTo(0.38, 2)
  })

  // A surcharge percentage that arrived as NaN from a numeric column would make
  // `> 0` false and the line vanish, which is the right outcome, but a
  // percentage of Infinity would pass and produce an amount of Infinity that
  // numeric(10,2) then rejects — failing the whole order's upsert.
  it('raises no surcharge when the percentage is not a real number', () => {
    for (const pct of [Number.NaN, Number.POSITIVE_INFINITY, -8]) {
      const out = buildCharges({ ...base, peakSurchargePct: pct, items: [
        { id: 'i16', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' },
      ]})
      expect(out.some((c) => c.charge_type === 'surcharge')).toBe(false)
    }
  })
})
