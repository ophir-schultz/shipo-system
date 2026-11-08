import { describe, expect, it } from 'vitest'
import { chargeKey } from '@/lib/ledger/charge-key'
import type { BuiltCharge } from '@/lib/ledger/calculate-charges'
import {
  APPROVED_ZONE_SOURCE,
  preserveStoredCharges,
  retainApprovedShipping,
  type ApprovedManual,
  type StoredChargeIdentity,
  type StoredShippingCharge,
} from '@/lib/ledger/approved-shipping'

function built(over: Partial<BuiltCharge> = {}): BuiltCharge {
  return {
    order_id: 'order-1',
    client_id: 'client-1',
    charge_key: chargeKey({ chargeType: 'shipping', shipmentId: '900' }),
    charge_type: 'shipping',
    label: 'Shipping',
    quantity: 1,
    unit_rate: null,
    amount: 437.08,
    cost: 437.08,
    cost_basis: 'measured',
    rate_id: 'rate-ship',
    cost_rate_id: null,
    charge_date: '2026-10-09',
    charge_date_source: 'ship_date',
    source: 'calculator',
    is_estimate: false,
    ...over,
  }
}

function zone(over: Partial<StoredShippingCharge> = {}): StoredShippingCharge {
  return {
    order_id: 'order-1',
    client_id: 'client-1',
    charge_key: chargeKey({ chargeType: 'shipping', shipmentId: '900' }),
    charge_type: 'shipping',
    label: 'Shipping',
    quantity: 1,
    unit_rate: 41,
    amount: 41,
    cost: null,
    cost_basis: null,
    rate_id: null,
    cost_rate_id: null,
    charge_date: '2026-10-07',
    charge_date_source: 'ship_date',
    source: APPROVED_ZONE_SOURCE,
    is_estimate: false,
    ...over,
  }
}

function shipping(charges: readonly BuiltCharge[]): BuiltCharge[] {
  return charges.filter((charge) => charge.charge_type === 'shipping')
}

const manual: ApprovedManual = {
  clientId: 'client-1',
  shipmentId: '900',
  amount: 510,
  logDate: '2026-10-09',
}

describe('approved zone shipping', () => {
  it('keeps the zone price when a second run would write at-cost', () => {
    const first = retainApprovedShipping([built()], [zone()])
    const again = retainApprovedShipping([built({ amount: 10, cost: 10 })], [zone()])
    for (const result of [first, again]) {
      expect(shipping(result.charges)).toHaveLength(1)
      expect(shipping(result.charges)[0]).toMatchObject({
        amount: 41,
        unit_rate: 41,
        source: APPROVED_ZONE_SOURCE,
        charge_date: '2026-10-07',
        cost: null,
      })
    }
    expect(again.flags.join('\n')).toMatch(/was not replaced/)
    expect(again.charges.filter((charge) => charge.amount === 10)).toHaveLength(0)
  })

  it('flags an unknown calculator amount and does not replace the zone price', () => {
    const result = retainApprovedShipping([built({ amount: null, cost: null, unit_rate: null })], [zone()])
    expect(shipping(result.charges)[0].amount).toBe(41)
    expect(shipping(result.charges)[0].source).toBe(APPROVED_ZONE_SOURCE)
    expect(result.flags.join('\n')).toMatch(/unknown/)
    expect(result.flags.join('\n')).toMatch(/was not replaced/)
  })

  it('flags a void against an approved zone price and does not write zero', () => {
    const result = retainApprovedShipping([
      built({ amount: 0, cost: 0, label: 'Shipping (voided)' }),
    ], [zone()])
    expect(shipping(result.charges)).toEqual([
      expect.objectContaining({ amount: 41, label: 'Shipping', source: APPROVED_ZONE_SOURCE }),
    ])
    expect(result.flags.join('\n')).toMatch(/was not replaced/)
  })

  it('puts a zone row the calculator omitted back into the write set', () => {
    const result = retainApprovedShipping([], [zone()])
    expect(shipping(result.charges)).toHaveLength(1)
    expect(shipping(result.charges)[0].amount).toBe(41)
    expect(result.flags.join('\n')).toMatch(/did not rebuild/)
  })

  it('does not carry a zone price forward on a cancelled order', () => {
    const result = retainApprovedShipping([], [zone()], [], { cancelled: true })
    expect(result.charges).toHaveLength(0)
    expect(result.flags.join('\n')).toMatch(/cancelled/)
  })
})

describe('manual full freight', () => {
  it('keeps one shipping charge and does not add an at-cost duplicate', () => {
    const atCost = built()
    const first = retainApprovedShipping([atCost], [], [manual])
    const second = retainApprovedShipping([atCost], [], [manual])
    for (const result of [first, second]) {
      expect(shipping(result.charges)).toHaveLength(1)
      expect(shipping(result.charges)[0].amount).toBe(437.08)
      expect(shipping(result.charges)[0].charge_key).toBe(atCost.charge_key)
      expect(result.flags.join('\n')).toMatch(/no second charge was added/)
    }
  })

  it('leaves a date clash flagged and does not replace the calculator amount', () => {
    const result = retainApprovedShipping(
      [built()],
      [],
      [{ ...manual, logDate: '2026-10-10' }],
    )
    expect(shipping(result.charges)[0].amount).toBe(437.08)
    expect(result.flags.join('\n')).toMatch(/2026-10-10/)
    expect(result.flags.join('\n')).toMatch(/was not replaced/)
    expect(shipping(result.charges)).toHaveLength(1)
  })

  it('does not apply a manual total beside or over an approved zone price', () => {
    const result = retainApprovedShipping([built()], [zone()], [manual])
    expect(shipping(result.charges)).toHaveLength(1)
    expect(shipping(result.charges)[0].amount).toBe(41)
    expect(result.flags.join('\n')).toMatch(/approved zone price/)
    expect(result.flags.join('\n')).toMatch(/manual freight line was not applied/)
  })
})

describe('preserve stored dates and amounts', () => {
  function stored(over: Partial<StoredChargeIdentity> = {}): StoredChargeIdentity {
    return {
      order_id: 'order-1',
      client_id: 'client-1',
      charge_key: 'shipment:900',
      charge_type: 'shipping',
      label: 'Shipping',
      quantity: 1,
      unit_rate: null,
      amount: 14.78,
      cost: 8.22,
      cost_basis: 'measured',
      rate_id: 'rate-ship',
      cost_rate_id: null,
      charge_date: '2026-10-08',
      charge_date_source: 'ship_date',
      source: 'calculator',
      is_estimate: false,
      ...over,
    }
  }

  it('keeps a preexisting date and amount when the calculator would move them', () => {
    const result = preserveStoredCharges([
      built({ charge_date: '2026-10-09', amount: 10, cost: 10 }),
    ], [stored()])
    expect(shipping(result.charges)[0]).toMatchObject({
      charge_date: '2026-10-08',
      amount: 14.78,
      cost: 8.22,
      source: 'calculator',
    })
    expect(result.flags.join('\n')).toMatch(/Kept stored/)
  })

  it('keeps a repaired date on the next run instead of writing the old day back', () => {
    const repaired = stored({ charge_date: '2026-10-09', amount: 14.78 })
    const easternAgain = built({ charge_date: '2026-10-08', amount: 14.78 })
    const result = preserveStoredCharges([easternAgain], [repaired])
    expect(shipping(result.charges)[0].charge_date).toBe('2026-10-09')
    expect(shipping(result.charges)[0].amount).toBe(14.78)
    expect(result.flags.join('\n')).toMatch(/2026-10-09/)
    expect(result.flags.join('\n')).toMatch(/2026-10-08/)
  })

  it('lets a new shipment take the carrier day and does not add the October 6 set', () => {
    const result = preserveStoredCharges([
      built({ charge_key: 'shipment:new', charge_date: '2026-11-08', amount: 12 }),
    ], [stored()])
    const rows = shipping(result.charges)
    expect(rows.map((row) => row.charge_key).sort()).toEqual(['shipment:900', 'shipment:new'])
    expect(rows.find((row) => row.charge_key === 'shipment:new')).toMatchObject({
      charge_date: '2026-11-08',
      amount: 12,
    })
    expect(rows.find((row) => row.charge_key === 'shipment:900')?.amount).toBe(14.78)
  })
})

describe('rates the calculator already owns', () => {
  it('leaves at-cost, flat, and a pick alone when nothing approved is stored', () => {
    const pick: BuiltCharge = {
      ...built(),
      charge_key: 'item:line:pick',
      charge_type: 'pick',
      label: 'Pick',
      amount: 2,
      unit_rate: 2,
      cost: 0.5,
    }
    const flat = built({ amount: 9, unit_rate: 9, cost: 4, rate_id: 'flat' })
    const result = retainApprovedShipping([built(), flat, pick], [], [])
    expect(result.charges.map((charge) => charge.amount)).toEqual([437.08, 9, 2])
    expect(result.flags).toHaveLength(0)
  })

  it('does not replace a flat rate with a manual total', () => {
    const flat = built({ amount: 9, unit_rate: 9 })
    const result = retainApprovedShipping([flat], [], [manual])
    expect(shipping(result.charges)[0].amount).toBe(9)
    expect(result.flags.join('\n')).toMatch(/unit rate/)
  })
})
