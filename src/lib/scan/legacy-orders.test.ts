import { describe, expect, it } from 'vitest'
import { legacyMissReason, matchLegacyOrders } from './legacy-orders'

describe('legacy order matching', () => {
  it('matches ordernumber and the documented suffix, and does not take a substring', () => {
    const body = {
      customerorders: [
        { customerorderid: 1, ordernumber: 'SO601065056 - Nayax' },
        { customerorderid: 2, ordernumber: 'OTHER601065056' },
      ],
    }
    const hit = matchLegacyOrders(body, 'SO601065056')
    expect(hit.kind).toBe('one')
    if (hit.kind !== 'one') return
    expect(hit.order.customerorderid).toBe(1)
    expect(matchLegacyOrders(body, '601065056').kind).toBe('none')
  })

  it('says the open list was read when the number is absent', () => {
    const customer = matchLegacyOrders({
      customerorders: [
        { ordernumber: 'OPEN-1', completed: false },
        { ordernumber: 'OPEN-2', completed: false },
      ],
    }, 'SO601065056')
    expect(customer).toEqual({ kind: 'none', ordersSeen: 2 })
    const reason = legacyMissReason('SO601065056', customer, { kind: 'none', ordersSeen: 4 })
    expect(reason).toContain('open orders only')
    expect(reason).toContain('2 orders')
    expect(reason).toContain('Nothing was billed')
    expect(reason).not.toContain('OPEN-1')
  })

  it('does not call an unreadable body a missing order', () => {
    expect(matchLegacyOrders({ unexpected: true }, 'SO601065056').kind).toBe('unreadable')
    const reason = legacyMissReason('SO601065056', { kind: 'unreadable' }, { kind: 'unreadable' })
    expect(reason).toContain('could not be read')
    expect(reason).toContain('not a finding that the order is absent')
  })
})
