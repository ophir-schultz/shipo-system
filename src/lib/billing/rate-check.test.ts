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
    expect(row.reason).toMatch(/Not a pass/)
    expect(row.shipDate).toBe('2026-10-27')
    expect(row.storedShipDay).toBeNull()
    expect(row).not.toHaveProperty('iclCost')
    expect(row).not.toHaveProperty('actualCost')
  })

  it('shows a date-only ship day and does not copy a raw cost onto the row', () => {
    const dated = checkShipment(sheet(), {
      id: 's-date', clientName: 'SitnStand', orderNumber: 'SO1',
      shipDate: '2026-10-01T00:00:00.000Z', weight: 16, weightUnit: 'ounces',
      length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps', zone: 3,
      raw: { shipDate: '2026-10-01', secretCost: 'secret-cost-87873' },
      service: 'usps_ground_advantage', clientRate: 25,
    })
    expect(dated.shipDate).toBe('2026-10-01')
    expect(dated.storedShipDay).toBe('2026-09-30')
    expect(JSON.stringify(dated)).not.toContain('secret-cost-87873')
    const late = checkShipment(sheet(), {
      id: 's-late', clientName: 'SitnStand', orderNumber: 'SO2',
      shipDate: '2026-11-01T03:30:00.000Z', weight: 16, weightUnit: 'ounces',
      length: 1, width: 1, height: 1, dimWeight: null, carrier: 'usps', zone: 3,
      raw: {}, service: 'usps_ground_advantage', clientRate: 25,
    })
    expect(late.shipDate).toBe('2026-10-31')
    expect(late.storedShipDay).toBeNull()
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
      priceGaps: 0,
      unknownBilled: 0,
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
    expect(byName.Nayax.priceGaps).toBe(0)
    expect(byName.Nayax.billedTotal).toBeNull()
  })

  it('reports Suteka sheet leakage without calling the matched rows a pass', () => {
    const gaps = Array.from({ length: 26 }, (_, index) => ({
      id: `s${index}`,
      clientName: 'Suteka',
      orderNumber: String(index),
      shipDate: '2026-10-27',
      weightOz: 16,
      zone: 4,
      service: 'ground',
      sheetPrice: 10,
      clientRate: index === 0 ? 213.87 : 10,
      difference: index === 0 ? 203.87 : 0,
      reason: index === 0 ? 'Billed rate differs from the sheet. Not a pass.' : null,
      kind: 'matched' as const,
    }))
    const aside = [
      { ...gaps[0], id: 'nayax', clientName: 'Nayax', kind: 'no_sheet' as const, sheetPrice: null, clientRate: 12, difference: null, reason: 'no sheet rates' },
      { ...gaps[0], id: 'orcam', clientName: 'Orcam', kind: 'no_sheet' as const, sheetPrice: null, clientRate: 8, difference: null, reason: 'no sheet rates' },
      { ...gaps[0], id: 'none', clientName: null, kind: 'no_sheet' as const, sheetPrice: null, clientRate: null, difference: null, reason: 'no sheet rates' },
    ]
    const byName = Object.fromEntries(summarizeRateCheck([...gaps, ...aside]).map((row) => [row.clientName, row]))
    expect(byName.Suteka.matched).toBe(26)
    expect(byName.Suteka.priceGaps).toBe(1)
    expect(byName.Suteka.difference).toBe(203.87)
    expect(byName.Suteka.difference).not.toBe(0)
    expect(byName.Nayax.notCompared).toBe(1)
    expect(byName.Nayax.matched).toBe(0)
    expect(byName.Nayax.difference).toBeNull()
    expect(byName.Orcam.difference).toBeNull()
    expect(byName['No client'].difference).toBeNull()
    expect(byName['No client'].notCompared).toBe(1)
  })
})
