import { describe, expect, it } from 'vitest'
import {
  SHIP_DATE_FILTER_NOTE,
  presentShipDay,
  shipDateWithStored,
  shipmentDateColumns,
  shipmentMatchesStoredRange,
} from './ship-day-label'

describe('ship date presentation', () => {
  it('keeps a date-only October 1 and reads a real midnight as September 30', () => {
    const dated = presentShipDay('2026-10-01T00:00:00.000Z', { shipDate: '2026-10-01' })
    expect(dated.shipDate).toBe('2026-10-01')
    expect(dated.storedShipDay).toBe('2026-09-30')
    expect(dated.differs).toBe(true)
    expect(shipmentDateColumns('2026-10-01T00:00:00.000Z', { shipDate: '2026-10-01' })).toEqual({
      'Ship Date': '2026-10-01',
      'Stored ship day': '2026-09-30',
    })

    const instant = presentShipDay('2026-10-01T00:00:00Z', { shipDate: '2026-10-01T00:00:00Z' })
    expect(instant.shipDate).toBe('2026-09-30')
    expect(instant.storedShipDay).toBe('2026-09-30')
    expect(instant.differs).toBe(false)
    expect(shipmentDateColumns('2026-10-01T00:00:00Z', { shipDate: '2026-10-01T00:00:00Z' })['Stored ship day']).toBe('')
  })

  it('does not move a date-only October 1 into October, or a late instant out of it', () => {
    const october = { from: '2026-10-01', to: '2026-10-31' }
    const september = { from: '2026-09-01', to: '2026-09-30' }
    expect(shipmentMatchesStoredRange('2026-10-01T00:00:00.000Z', october.from, october.to)).toBe(false)
    expect(shipmentMatchesStoredRange('2026-10-01T00:00:00.000Z', september.from, september.to)).toBe(true)
    expect(shipmentMatchesStoredRange('2026-10-09T00:00:00.000Z', october.from, october.to)).toBe(true)
    expect(shipmentMatchesStoredRange('2026-11-01T03:30:00.000Z', october.from, october.to)).toBe(true)
    expect(presentShipDay('2026-11-01T03:30:00.000Z', {}).shipDate).toBe('2026-10-31')
    expect(shipDateWithStored('2026-10-09T00:00:00.000Z', { shipDate: '2026-10-09', secretCost: 'secret-cost-87873' }))
      .toBe('2026-10-09 (stored 2026-10-08)')
    expect(shipDateWithStored('2026-10-09 00:00:00+00', { shipDate: '2026-10-09' }))
      .toBe('2026-10-09 (stored 2026-10-08)')
    expect(shipDateWithStored('2026-10-09 00:00:00+00', '{"shipDate":"2026-10-09"}'))
      .toBe('2026-10-09 (stored 2026-10-08)')
    expect(shipDateWithStored('2026-10-27T15:00:00.000Z', { secretCost: 'secret-cost-87873' }))
      .toBe('2026-10-27')
    expect(SHIP_DATE_FILTER_NOTE).toMatch(/stored ship instant/)
    expect(SHIP_DATE_FILTER_NOTE).toMatch(/charge date is not used/)
  })
})
