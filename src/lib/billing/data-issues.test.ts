import { describe, expect, it } from 'vitest'
import { ambiguousPickCards, shipmentIssue } from './data-issues'

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

  it('lists Kivema when two pick rates are live and leaves a single rate off the list', () => {
    const issues = ambiguousPickCards([
      { client_id: 'k', client_name: 'Kivema', service_type: 'orders_(picks_n_pack)', rate: 1.2 },
      { client_id: 'k', client_name: 'Kivema', service_type: 'pick_n_pack', rate: 1.75 },
      { client_id: 's', client_name: 'SitnStand', service_type: 'orders_(picks_n_pack)', rate: 2 },
      { client_id: 'c', client_name: 'Creative Pea', service_type: 'orders_(picks_n_pack)', rate: 1.2 },
    ], '2026-10-26')
    expect(issues.map((issue) => issue.clientName)).toEqual(['Kivema'])
    expect(issues[0].reason).toContain('$1.20')
    expect(issues[0].reason).toContain('$1.75')
  })

  it('reports Orcam when two different pick services are live and leaves both rows in place', () => {
    const rows = [
      { client_id: 'o', client_name: 'Orcam', service_type: 'orders_(picks_n_pack)', rate: 1.2 },
      { client_id: 'o', client_name: 'Orcam', service_type: 'pick_n_pack', rate: 1.75 },
    ]
    const issues = ambiguousPickCards(rows, '2026-10-26')
    expect(issues.map((issue) => issue.clientName)).toEqual(['Orcam'])
    expect(issues[0].reason).toContain('orders_(picks_n_pack)')
    expect(issues[0].reason).toContain('pick_n_pack')
    expect(rows).toHaveLength(2)
  })
})
