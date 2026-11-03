import { describe, expect, it } from 'vitest'
import { shipmentIssue } from './data-issues'

describe('shipment data issues', () => {
  it('flags a shipment with no client and one with no price', () => {
    expect(shipmentIssue({ client_id: null, client_rate: 12 })).toBe('no_client')
    expect(shipmentIssue({ client_id: 'nayax', client_rate: null })).toBe('no_price')
  })

  it('leaves a priced shipment and a voided label off the list', () => {
    expect(shipmentIssue({ client_id: 'c', client_rate: 33.31 })).toBeNull()
    expect(shipmentIssue({ client_id: null, client_rate: 33.31, raw_data: { voided: true } })).toBeNull()
    expect(shipmentIssue({ client_id: 'c', client_rate: null, raw_data: { voidDate: '2026-10-28' } })).toBeNull()
  })
})
