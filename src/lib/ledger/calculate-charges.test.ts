import { describe, it, expect } from 'vitest'
import { buildCharges, type ChargeInput, type RateCardLine } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

// Every rate card in the database today has null effective dates: the columns
// were added by ALTER TABLE after the rows existed. `line()` defaults to that
// state so the suite exercises the path production is actually on, and the
// dating tests below pass the dates explicitly.
const line = (l: Omit<RateCardLine, 'effectiveFrom' | 'effectiveTo'>
                & Partial<Pick<RateCardLine, 'effectiveFrom' | 'effectiveTo'>>): RateCardLine =>
  ({ effectiveFrom: null, effectiveTo: null, ...l })

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
    line({ id: 'rc-pick-d', chargeType: 'pick', variant: 'device',    rate: 0.32, rateType: 'per_unit' }),
    line({ id: 'rc-pick-c', chargeType: 'pick', variant: 'component', rate: 0.20, rateType: 'per_unit' }),
    line({ id: 'rc-ship',   chargeType: 'shipping', variant: null,    rate: null, rateType: 'at_cost' }),
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
      // Currency is compared with a tolerance, never with ===. toMatchObject
      // uses Object.is on primitives, so a bare `amount: 1.28` is an assertion
      // on float identity rather than on money.
      amount: expect.closeTo(1.28, 2),
      cost: expect.closeTo(0.92, 2),
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
    expect(out[0]).toMatchObject({
      unit_rate: 0.20,
      amount: expect.closeTo(1.00, 2),
      cost: expect.closeTo(1.00, 2),
    })
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

  // The skip above is correct and is also unbilled revenue, so it must be
  // audible. It used to be silent, which was tolerable only while the sync
  // stamped a watermark on every picked line it found. It no longer does --
  // during a discontinuity it leaves pick_date null on purpose -- so this is
  // now a state the system reaches by design, and a state reached by design
  // that nobody is told about is how money goes missing quietly.
  it('names the undated picked line it declined to charge', () => {
    const warnings: string[] = []
    buildCharges({ ...base, items: [
      { id: 'i4w', sku: 'R144GUSB01S10', quantityPicked: 3, isComponent: false, pickDate: null },
    ]}, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('undated pick')
    // The three things a person needs to find the line: which line, how much
    // is unbilled, and which SKU. A warning that says only "an undated pick
    // happened" cannot be acted on.
    expect(warnings[0]).toContain('i4w')
    expect(warnings[0]).toContain('R144GUSB01S10')
    expect(warnings[0]).toContain('3 picked')
  })

  // A line with nothing picked and no date is not unbilled revenue -- it is an
  // ordinary unpicked line, and every order in the system has them. Warning on
  // those would bury the real ones.
  it('stays quiet about an unpicked line with no pick date', () => {
    const warnings: string[] = []
    buildCharges({ ...base, items: [
      { id: 'i4q', sku: 'A', quantityPicked: 0, isComponent: true, pickDate: null },
      { id: 'i4r', sku: 'B', quantityPicked: null, isComponent: true, pickDate: null },
    ]}, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))

    expect(warnings).toEqual([])
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
      amount: expect.closeTo(8.20, 2),
      cost: expect.closeTo(8.20, 2),
      cost_basis: 'measured',
      charge_date: '2026-09-02',
      charge_date_source: 'ship_date',
    })
  })

  // A voided label contributes $0 to measured cost. Leaving it in would
  // overstate spend by the amount that was refunded; it is counted instead in
  // the voided-label leak line (Task 15).
  //
  // The two `not.toBeNull()` lines look redundant next to the closeTo matchers
  // and are not: `expect(null).toBeCloseTo(0, 2)` PASSES in vitest, because the
  // matcher coerces. Every zero-versus-null assertion in this file therefore
  // needs an explicit null check beside it or it asserts nothing at all — which
  // is exactly how the stale `amount` expectation below survived unnoticed.
  it('gives a voided shipment zero amount and zero cost', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's2', shipmentId: 556, shipDate: '2026-09-02', actualCost: 9.10, voided: true },
    ]})
    expect(out[0].amount).not.toBeNull()
    expect(out[0].cost).not.toBeNull()
    expect(out[0]).toMatchObject({
      amount: expect.closeTo(0, 2),
      cost: expect.closeTo(0, 2),
    })
  })

  // An unknown carrier cost must stay unknown — in BOTH columns. On an at-cost
  // rate the client is invoiced whatever the carrier charged, so a cost that has
  // not been reported makes the revenue equally unknown. Writing 0 to `amount`
  // reports a label we gave away free and understates revenue everywhere this
  // table is summed; writing 0 to `cost` reports pure profit. Same
  // null-versus-zero error from Task 13, arriving by two different routes.
  it('leaves both cost and amount null when an at-cost carrier cost is unknown', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's3', shipmentId: 557, shipDate: '2026-09-02', actualCost: null, voided: false },
    ]})
    expect(out[0].cost).toBeNull()
    expect(out[0].amount).toBeNull()
  })

  // A voided label is the one case where zero is the honest answer even with no
  // carrier cost: the label was refunded, so we bill nothing and paid nothing.
  // Null here would push a known-free shipment into the "chase the carrier" pile.
  it('still gives a voided shipment zero amount when the carrier cost is unknown', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's3a', shipmentId: 559, shipDate: '2026-09-02', actualCost: null, voided: true },
    ]})
    expect(out[0].amount).not.toBeNull()
    expect(out[0].amount).toBeCloseTo(0, 2)
    expect(out[0].cost).not.toBeNull()
    expect(out[0].cost).toBeCloseTo(0, 2)
  })

  // A flat shipping rate is priced by the rate card, not by the carrier, so an
  // unreported carrier cost leaves the revenue perfectly well known. Only the
  // at-cost path may produce a null amount.
  it('keeps a flat shipping amount known when the carrier cost is unknown', () => {
    const out = buildCharges({
      ...base,
      rateCard: [line({ id: 'rc-ship-flat', chargeType: 'shipping', variant: null,
                       rate: 12.50, rateType: 'flat' })],
      shipments: [{ id: 's3d', shipmentId: 560, shipDate: '2026-09-02', actualCost: null, voided: false }],
    })
    expect(out[0].amount).not.toBeNull()
    expect(out[0].amount).toBeCloseTo(12.50, 2)
    expect(out[0].cost).toBeNull()
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

  // A shipment whose ship date falls outside every shipping line on the card —
  // or a client whose card carries no shipping line at all — used to be dropped
  // entirely, and with it the carrier cost we actually paid. The freight never
  // reached order_charges, so the P&L was flattered by exactly that amount and
  // nothing downstream could see it: every one of the six leaks in
  // leaks_monthly detects under-billing or negative margin, none detects a cost
  // that is simply absent. Spec §7 requires the opposite treatment — "charge
  // recorded with amount = null and flagged, never silently zero".
  //
  // `toBeNull()`, NOT `toBeCloseTo(0, 2)`. `expect(null).toBeCloseTo(0, 2)`
  // PASSES, so the tolerance form would assert nothing at all here and would go
  // on passing against the very bug it was written to catch.
  it('keeps the carrier cost and nulls the revenue when no shipping rate covers the date', () => {
    const warnings: string[] = []
    const out = buildCharges({
      ...base,
      rateCard: [line({ id: 'rc-ship-expired', chargeType: 'shipping', variant: null,
                        rate: null, rateType: 'at_cost',
                        effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01' })],
      shipments: [{ id: 's3e', shipmentId: 561, shipDate: '2026-09-02', actualCost: 8.20, voided: false }],
    }, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))

    expect(out).toHaveLength(1)
    expect(out[0].charge_type).toBe('shipping')
    expect(out[0].charge_key).toBe('shipment:561')
    // The money we genuinely paid survives.
    expect(out[0].cost).toBeCloseTo(8.20, 2)
    expect(out[0].cost_basis).toBe('measured')
    // The money we will bill is UNKNOWN, not zero.
    expect(out[0].amount).toBeNull()
    expect(out[0].unit_rate).toBeNull()
    expect(out[0].rate_id).toBeNull()
    // Measured carrier cost, so nothing here is an estimate.
    expect(out[0].is_estimate).toBe(false)
    // And it is named, so it reaches sync_runs.errors rather than dying here.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unpriced shipment')
  })

  // A SECOND WAY TO HAVE NO PRICE: the card HAS a flat shipping line in effect
  // on the ship date, and its `rate` cell is empty. That read `(rate.rate ?? 0)`
  // and billed the label at exactly $0 — a confident claim that we shipped it
  // free, made on the one charge type where we know money left the bank. It is
  // the identical null-versus-zero confusion the at-cost arm two tests up
  // already refuses, reintroduced by a fallback in the known-price arm.
  //
  // `toBeNull()` and not `toBeCloseTo(0, 2)`, for the reason given above: the
  // tolerance form passes against null and would assert nothing.
  it('leaves the amount unknown when the shipping line in effect carries no rate', () => {
    const warnings: string[] = []
    const out = buildCharges({
      ...base,
      rateCard: [line({ id: 'rc-ship-blank', chargeType: 'shipping', variant: null,
                        rate: null, rateType: 'flat' })],
      shipments: [{ id: 's3g', shipmentId: 563, shipDate: '2026-09-02', actualCost: 7.40, voided: false }],
    }, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))

    expect(out).toHaveLength(1)
    // The cost we paid is kept, exactly as in the no-line case.
    expect(out[0].cost).toBeCloseTo(7.40, 2)
    expect(out[0].amount).toBeNull()
    // The line that failed us is still recorded, which is what distinguishes
    // this case from "no line at all" for whoever goes to fix it.
    expect(out[0].rate_id).toBe('rc-ship-blank')
    expect(out[0].unit_rate).toBeNull()
    // Named, and named as its own cause: "no line in effect" and "line with an
    // empty rate" send someone to two different places in the rate card.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rate card line with no rate')
    expect(warnings[0]).toContain('rc-ship-blank')
  })

  // The same gap on a VOIDED label is not unknown revenue. The carrier refunded
  // it, so we paid nothing and we bill nothing: both figures are a known zero,
  // and nulling the amount here would invent a mystery where there is none.
  it('bills a voided label at a known zero even with no shipping rate', () => {
    const out = buildCharges({
      ...base,
      rateCard: [],
      shipments: [{ id: 's3f', shipmentId: 562, shipDate: '2026-09-02', actualCost: 9.10, voided: true }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBeCloseTo(0, 2)
    expect(out[0].cost).toBeCloseTo(0, 2)
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

  // The row is still not raised — see the comment on the `!rate` branch in
  // calculate-charges.ts for why a dropped pick errs in the loud direction
  // where a dropped shipment errs in the flattering one. What this pins is that
  // it is no longer dropped in SILENCE: the line, the quantity and the date are
  // named, so the alert says which rate card line to go and add.
  it('names the picked line it could not price, and still raises no charge', () => {
    const warnings: string[] = []
    const out = buildCharges({
      ...base,
      rateCard: base.rateCard.filter((r) => r.chargeType !== 'pick'),
      items: [{ id: 'i8', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: '2026-09-01' }],
    }, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))
    expect(out).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('unpriced pick')
    expect(warnings[0]).toContain('i8')
    expect(warnings[0]).toContain('component')
    expect(warnings[0]).toContain('2026-09-01')
  })

  // The other half of the same silence, and a different instruction to the
  // reader: the pick line IS on the card and in effect, and its rate cell is
  // empty. Both conditions used to share one `continue` with no message.
  it('names a picked line whose rate card line carries no rate', () => {
    const warnings: string[] = []
    const out = buildCharges({
      ...base,
      rateCard: [line({ id: 'rc-pick-blank', chargeType: 'pick', variant: 'device',
                        rate: null, rateType: 'per_unit' })],
      items: [{ id: 'i8b', sku: 'B', quantityPicked: 5, isComponent: false, pickDate: '2026-09-01' }],
    }, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))
    expect(out).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rate card line with no rate')
    // The rate_id, because that is the row to go and edit.
    expect(warnings[0]).toContain('rc-pick-blank')
    expect(warnings[0]).toContain('i8b')
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

  // Shipping is excluded from the basis anyway, so an at-cost freight line with
  // a null amount must not reach the reduce — but if the exclusion ever changes,
  // `sum + null` is NaN, and numeric(10,2) rejects NaN, failing the entire
  // order's batch rather than the one line. Pinned so a null amount can never
  // take the surcharge down with it.
  it('keeps the surcharge basis on picks when an at-cost shipping amount is null', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 8,
      items: [{ id: 'i9b', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
      shipments: [{ id: 's4b', shipmentId: 561, shipDate: '2026-09-01', actualCost: null, voided: false }],
    })
    expect(out.find((c) => c.charge_type === 'shipping')?.amount).toBeNull()
    const sur = out.filter((c) => c.charge_type === 'surcharge')
    expect(sur).toHaveLength(1)
    expect(sur[0].amount).not.toBeNull()
    expect(Number.isNaN(sur[0].amount)).toBe(false)
    expect(sur[0].amount).toBeCloseTo(0.26, 2)
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
    expect(out[0].amount).toBeCloseTo(0.96, 2)
  })

  // Math.round(1.005 * 100) is 100, because 1.005 * 100 is 100.49999999999999.
  // Rounding a half-cent DOWN underbills, quietly and for ever. Unreachable at
  // today's per-unit rates; reachable the moment a percentage-based rate lands.
  it('rounds an exact half-cent up rather than down', () => {
    const out = buildCharges({
      ...base,
      rateCard: [line({ id: 'rc-half', chargeType: 'pick', variant: 'device',
                        rate: 1.005, rateType: 'per_unit' })],
      items: [{ id: 'i-half', sku: 'R1', quantityPicked: 1, isComponent: false, pickDate: '2026-09-01' }],
    })
    expect(out[0].amount).toBeCloseTo(1.01, 2)
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
        line({ id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' })],
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
        line({ id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' })],
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

  // ---- effective dating ----------------------------------------------------
  // The cost side has always been dated (findCostRate). Having the cost dated
  // and the revenue not is the worst of the three states: margin moves for a
  // reason that is visible in neither column.

  const dated = (from: string | null, to: string | null, id: string, rate: number) =>
    line({ id, chargeType: 'pick', variant: 'device', rate, rateType: 'per_unit',
           effectiveFrom: from, effectiveTo: to })

  it('prices a pick with the rate in effect on the pick date, not the newest one', () => {
    const out = buildCharges({
      ...base,
      // Deliberately ordered newest-first, which is what a UUID sort can produce.
      // A bare .find() would take the 0.50 and rewrite an August invoice.
      rateCard: [dated('2026-09-01', null, 'rc-new', 0.50),
                 dated('2026-01-01', '2026-09-01', 'rc-old', 0.32)],
      items: [{ id: 'i-aug', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-08-15' }],
    })
    expect(out[0].rate_id).toBe('rc-old')
    expect(out[0].amount).toBeCloseTo(3.20, 2)
  })

  // effective_to is EXCLUSIVE, matching the '[)' daterange the cost rates use.
  // An inclusive upper bound makes the changeover day ambiguous by construction.
  it('treats effective_to as exclusive on the changeover day', () => {
    const out = buildCharges({
      ...base,
      rateCard: [dated('2026-01-01', '2026-09-01', 'rc-old', 0.32),
                 dated('2026-09-01', null, 'rc-new', 0.50)],
      items: [{ id: 'i-cut', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    expect(out[0].rate_id).toBe('rc-new')
    expect(out[0].amount).toBeCloseTo(5.00, 2)
  })

  // Every rate card row in the database today has null effective dates: the
  // columns were added by ALTER TABLE after the rows existed. Reading null as
  // "no match" would unbill every client the moment this shipped.
  it('treats a null effective_from as having always been in effect', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i-null', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2019-01-01' },
    ]})
    expect(out[0].rate_id).toBe('rc-pick-d')
  })

  it('raises no charge when every rate for it expired before the pick date', () => {
    const out = buildCharges({
      ...base,
      rateCard: [dated('2026-01-01', '2026-06-01', 'rc-gone', 0.32)],
      items: [{ id: 'i-gap', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    expect(out).toEqual([])
  })

  // Two rates in effect on the same day is a data error in the card. The result
  // must be named and it must be stable, so the number does not flap between
  // runs while someone fixes it.
  it('warns and picks deterministically when two rates overlap', () => {
    const warnings: string[] = []
    const input: ChargeInput = {
      ...base,
      rateCard: [dated('2026-01-01', null, 'rc-b', 0.40),
                 dated('2026-06-01', null, 'rc-a', 0.32)],
      items: [{ id: 'i-dup', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    }
    const first = buildCharges(input, (ctx, detail) => warnings.push(`${ctx}: ${detail}`))
    const second = buildCharges(input)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ambiguous rate')
    // Latest start wins, so the same row is chosen every run.
    expect(first[0].rate_id).toBe('rc-a')
    expect(second[0].rate_id).toBe('rc-a')
  })

  // The shipping rate is dated too. An at-cost line replaced by a flat line
  // must not retroactively reprice labels bought under the old terms.
  it('dates the shipping rate against the ship date', () => {
    const out = buildCharges({
      ...base,
      rateCard: [
        line({ id: 'rc-ship-old', chargeType: 'shipping', variant: null, rate: null,
               rateType: 'at_cost', effectiveFrom: '2026-01-01', effectiveTo: '2026-09-01' }),
        line({ id: 'rc-ship-new', chargeType: 'shipping', variant: null, rate: 12,
               rateType: 'flat', effectiveFrom: '2026-09-01', effectiveTo: null }),
      ],
      shipments: [{ id: 's-aug', shipmentId: 900, shipDate: '2026-08-20', actualCost: 8.20, voided: false }],
    })
    expect(out[0].rate_id).toBe('rc-ship-old')
    expect(out[0].amount).toBeCloseTo(8.20, 2)
  })

  // The peak percentage is a rate card line like any other and must be dated
  // like one. A surcharge that ended in January must not be levied in September.
  it('does not levy a peak surcharge whose rate card line has expired', () => {
    const out = buildCharges({
      ...base,
      // The undated fallback still says 8. The card's dated line must win.
      peakSurchargePct: 8,
      rateCard: [...base.rateCard,
        line({ id: 'rc-peak', chargeType: 'surcharge', variant: 'peak', rate: 8,
               rateType: 'percent', effectiveFrom: '2026-01-01', effectiveTo: '2026-02-01' })],
      items: [{ id: 'i-peak', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    expect(out.some((c) => c.charge_type === 'surcharge')).toBe(false)
  })

  it('levies a peak surcharge from the dated card line when one is in effect', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 0,
      rateCard: [...base.rateCard,
        line({ id: 'rc-peak', chargeType: 'surcharge', variant: 'peak', rate: 8,
               rateType: 'percent', effectiveFrom: '2026-01-01', effectiveTo: null })],
      items: [{ id: 'i-peak2', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    const sur = out.find((c) => c.charge_type === 'surcharge')!
    expect(sur.amount).toBeCloseTo(0.26, 2)
    expect(sur.rate_id).toBe('rc-peak')
  })
})
