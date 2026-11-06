import { describe, expect, it } from 'vitest'
import { checkShipment, summarizeRateCheck } from './rate-check'
import { loadRateSheet } from './rate-sheet'

const sheet = () => loadRateSheet()

describe('rate check rows', () => {
  it('compares the sheet price with the billed rate and leaves cost off the row', () => {
    const row = checkShipment(sheet(), {
      id: 's1',
      clientName: 'SitnStand',
      orderNumber: '100',
      shipDate: '2026-10-27T15:00:00.000Z',
      weight: 16,
      weightUnit: 'ounces',
      length: 1,
      width: 1,
      height: 1,
      dimWeight: null,
      carrier: 'usps',
      zone: 3,
      raw: null,
      service: 'usps_ground_advantage',
      clientRate: 25,
    })
    expect(row.sheetPrice).toBe(24.51)
    expect(row.difference).toBe(0.49)
    expect(row.reason).toBeNull()
    expect(row).not.toHaveProperty('iclCost')
    expect(row).not.toHaveProperty('actualCost')
  })

  it('names the reason when the zone was never stored', () => {
    const row = checkShipment(sheet(), {
      id: 's2',
      clientName: 'Kivema',
      orderNumber: '2',
      shipDate: '2026-10-26',
      weight: 8,
      weightUnit: 'ounces',
      length: 1,
      width: 1,
      height: 1,
      dimWeight: null,
      carrier: 'usps',
      zone: null,
      raw: {},
      service: 'usps_ground_advantage',
      clientRate: 10,
    })
    expect(row.sheetPrice).toBeNull()
    expect(row.reason).toMatch(/No zone/)
  })

  it('reads a carrier zone off the shipment payload when the column is empty', () => {
    const row = checkShipment(sheet(), {
      id: 's3',
      clientName: 'SitnStand',
      orderNumber: '3',
      shipDate: '2026-10-26',
      weight: 16,
      weightUnit: 'ounces',
      length: 1,
      width: 1,
      height: 1,
      dimWeight: null,
      carrier: 'usps',
      zone: null,
      raw: { zone: '8' },
      service: 'ground',
      clientRate: 33.31,
    })
    expect(row.zone).toBe(8)
    expect(row.sheetPrice).toBe(33.31)
    expect(row.difference).toBe(0)
  })

  it('summarizes matched sheet totals against what was billed', () => {
    const rows = [
      checkShipment(sheet(), {
        id: 'a', clientName: 'SitnStand', orderNumber: '1', shipDate: '2026-10-26',
        weight: 16, weightUnit: 'ounces', length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps',
        zone: 8, raw: null, service: 'ground', clientRate: 33.31,
      }),
      checkShipment(sheet(), {
        id: 'b', clientName: 'SitnStand', orderNumber: '2', shipDate: '2026-10-26',
        weight: 16, weightUnit: 'ounces', length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps',
        zone: null, raw: null, service: 'ground', clientRate: 10,
      }),
      checkShipment(sheet(), {
        id: 'c', clientName: 'Nayax', orderNumber: '3', shipDate: '2026-10-26',
        weight: 16, weightUnit: 'ounces', length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps',
        zone: 4, raw: null, service: 'ground', clientRate: 12,
      }),
      checkShipment(sheet(), {
        id: 'd', clientName: 'Suteka', orderNumber: '4', shipDate: '2026-10-26',
        weight: 7 * 16, weightUnit: 'ounces', length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps',
        zone: 4, raw: null, service: 'ground', clientRate: 40,
      }),
    ]
    const byName = Object.fromEntries(summarizeRateCheck(rows).map((row) => [row.clientName, row]))
    expect(byName.SitnStand).toEqual({
      clientName: 'SitnStand',
      shipments: 2,
      matched: 1,
      notCompared: 0,
      billedTotal: 33.31,
      sheetTotal: 33.31,
      difference: 0,
    })
    expect(byName.Nayax.matched).toBe(0)
    expect(byName.Nayax.notCompared).toBe(1)
    expect(byName.Nayax.difference).toBeNull()
    expect(rows.find((row) => row.id === 'c')?.reason).toBe('no sheet rates')
    expect(byName.Suteka.notCompared).toBe(1)
    expect(byName.Suteka.matched).toBe(0)
    expect(rows.find((row) => row.id === 'd')?.reason).toBe('Needs manual price (client approval)')
  })
})
