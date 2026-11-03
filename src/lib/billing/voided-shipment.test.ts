import { describe, expect, it } from 'vitest'
import { isVoidedShipment, withoutVoided } from './voided-shipment'

describe('voided shipments', () => {
  it('recognises the three payload spellings the ledger already uses', () => {
    expect(isVoidedShipment({ voided: true })).toBe(true)
    expect(isVoidedShipment({ voidDate: '2026-10-28' })).toBe(true)
    expect(isVoidedShipment({ voideDate: '2026-10-28' })).toBe(true)
    expect(isVoidedShipment({ voided: false })).toBe(false)
    expect(isVoidedShipment(null)).toBe(false)
  })

  it('drops voided rows from a money list and keeps the rest', () => {
    const rows = withoutVoided([
      { id: 'live', raw_data: { voided: false }, client_rate: 10 },
      { id: 'void', raw_data: { voided: true }, client_rate: 33.31 },
    ])
    expect(rows.map((row) => row.id)).toEqual(['live'])
  })
})
