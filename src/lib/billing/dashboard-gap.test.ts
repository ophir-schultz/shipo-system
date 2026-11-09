import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { reconcile } from '@/lib/billing/profit-rollup'
import {
  gapReason, isCostedWithoutRate, staffMarginWarning, summarizeRateGaps,
  type GapShipment,
} from '@/lib/billing/dashboard-gap'

function row(over: Partial<GapShipment> = {}): GapShipment {
  return {
    client_id: 'nayax',
    client_rate: null,
    actual_cost: 12.5,
    zone: null,
    raw_data: { shipTo: { country: 'US' } },
    ...over,
  }
}

describe('costed rows with no stored rate', () => {
  it('keeps a stored rate, including a deliberate zero, out of the gap', () => {
    expect(isCostedWithoutRate(row({ client_rate: 18.4 }))).toBe(false)
    expect(isCostedWithoutRate(row({ client_rate: 0 }))).toBe(false)
    expect(gapReason(row({ client_rate: 18.4 }))).toBeNull()
  })

  it('does not treat a missing rate as zero, and still requires a known cost', () => {
    expect(isCostedWithoutRate(row())).toBe(true)
    expect(isCostedWithoutRate(row({ actual_cost: 0 }))).toBe(true)
    expect(isCostedWithoutRate(row({ actual_cost: null }))).toBe(false)
  })
})

describe('gap reasons from fields already on the shipment', () => {
  it('names an unmapped store and does not assign a client', () => {
    const shipment = row({
      client_id: null,
      raw_data: { advancedOptions: { storeId: 202015 }, shipTo: { country: 'US' } },
    })
    expect(gapReason(shipment)).toBe('unmapped')
    const gaps = summarizeRateGaps([shipment])
    expect(gaps.unmapped).toEqual([{ storeId: '202015', count: 1 }])
    expect(gaps.international).toBe(0)
    expect(gaps.noRate).toBe(0)
  })

  it('counts an unmapped store once even when the destination is also foreign', () => {
    const shipment = row({
      client_id: null,
      raw_data: { storeId: '166519', shipTo: { country: 'CA' } },
    })
    expect(gapReason(shipment)).toBe('unmapped')
    expect(summarizeRateGaps([shipment]).international).toBe(0)
  })

  it('calls a recorded non-US destination with no zone international', () => {
    const shipment = row({
      raw_data: { shipTo: { country: 'DE', postalCode: '10115' } },
    })
    expect(gapReason(shipment)).toBe('international')
  })

  it('does not call a missing country international', () => {
    expect(gapReason(row({ raw_data: {} }))).toBe('no_rate')
    expect(gapReason(row({ raw_data: { shipTo: { country: 'USA' } } }))).toBe('no_rate')
  })

  it('does not call a foreign parcel that already has a zone a no-zone gap', () => {
    expect(gapReason(row({
      zone: 4,
      raw_data: { shipTo: { country: 'CA' } },
    }))).toBe('no_rate')
  })

  it('leaves heavy freight and a wrong-carrier cell as no agreed zone rate', () => {
    const heavy = row({
      client_id: 'nayax',
      zone: 8,
      raw_data: { weight: { value: 163, units: 'pounds' }, shipTo: { country: 'US' } },
    })
    expect(gapReason(heavy)).toBe('no_rate')
    const warning = staffMarginWarning(reconcile([heavy]), summarizeRateGaps([heavy]))
    expect(warning.toLowerCase()).not.toContain('overweight')
    expect(warning).not.toContain('163')
    expect(warning).not.toMatch(/\$[1-9]/)
  })
})

describe('staff margin warning', () => {
  it('is empty when every row reconciled, including an empty week', () => {
    expect(staffMarginWarning(reconcile([]))).toBe('')
    expect(staffMarginWarning(reconcile([row({ client_rate: 10, actual_cost: 4 })]))).toBe('')
  })

  it('says the November shape once, and does not call it unrated and unpriced', () => {
    const rows = [
      row({ client_rate: 40, actual_cost: 20 }),
      row({
        client_id: null,
        actual_cost: 9,
        raw_data: { advancedOptions: { storeId: 202015 }, shipTo: { country: 'US' } },
      }),
      row({
        client_id: null,
        actual_cost: 8,
        raw_data: { advancedOptions: { storeId: 202015 } },
      }),
      row({
        client_id: null,
        actual_cost: 7,
        raw_data: { advancedOptions: { storeId: 202015 } },
      }),
      row({
        client_id: null,
        actual_cost: 4,
        raw_data: { storeId: '352718', shipTo: { country: 'US' } },
      }),
      row({
        client_id: null,
        actual_cost: 3,
        raw_data: { storeId: 352718 },
      }),
      row({
        client_id: 'suteka',
        actual_cost: 11,
        raw_data: { shipTo: { country: 'GB' } },
      }),
      row({ client_id: 'nayax', actual_cost: 104.92, zone: 8 }),
    ]
    const reconciled = reconcile(rows)
    expect(reconciled.counted).toBe(8)
    expect(reconciled.reconciled).toBe(1)
    expect(reconciled.unrated).toBe(7)
    expect(reconciled.revenue).toBe(40)
    expect(reconciled.cost).toBe(20)
    const gaps = summarizeRateGaps(rows)
    expect(gaps.unmapped).toEqual([
      { storeId: '202015', count: 3 },
      { storeId: '352718', count: 2 },
    ])
    expect(gaps.international).toBe(1)
    expect(gaps.noRate).toBe(1)
    const warning = staffMarginWarning(reconciled, gaps)
    expect(warning).toContain('7 of 8 shipments left out of these figures')
    expect(warning).toContain('left out of the margin')
    expect(warning).toContain('It is not $0')
    expect(warning).toContain('5 from unmapped stores 202015 (3), 352718 (2)')
    expect(warning).toContain('No client is assigned')
    expect(warning).toContain('1 international shipment with no zone')
    expect(warning).toContain('1 with no agreed zone rate')
    expect(warning.toLowerCase()).not.toContain('unpriced')
    expect(warning.toLowerCase()).not.toContain('unrated')
    expect(warning.match(/7 of 8/g)).toHaveLength(1)
  })

  it('does not repeat a plain no-rate cohort as a second count', () => {
    const rows = [row(), row({ actual_cost: 4 })]
    const warning = staffMarginWarning(reconcile(rows), summarizeRateGaps(rows))
    expect(warning).toBe(
      '2 of 2 shipments left out of these figures. '
      + 'The carrier cost on shipments with no agreed rate is left out of the margin. It is not $0.',
    )
    expect(warning.toLowerCase()).not.toContain('unpriced')
  })

  it('keeps awaiting carrier cost in the same warning, not as a second unpriced line', () => {
    const rows = [
      row({ client_rate: 10, actual_cost: null }),
      row({ client_id: null, raw_data: { storeId: '202015' } }),
    ]
    const warning = staffMarginWarning(reconcile(rows), summarizeRateGaps(rows))
    expect(warning).toContain('2 of 2 shipments left out')
    expect(warning).toContain('1 from unmapped store 202015')
    expect(warning).toContain('1 awaiting carrier cost')
    expect(warning.toLowerCase()).not.toContain('unpriced')
    expect(warning.match(/left out/g)?.length).toBeLessThanOrEqual(3)
  })
})

describe('the dashboard renders that warning once', () => {
  const page = readFileSync('src/app/dashboard/page.tsx', 'utf8')

  it('does not print the unrated sentence and the unpriced sentence together', () => {
    expect(page).not.toContain('Excluded this period:')
    expect(page).not.toContain('unpricedNote(p.billableUnpriced)')
    expect(page).toContain('staffMarginWarning')
    expect(page).toContain('summarizeRateGaps')
  })
})
