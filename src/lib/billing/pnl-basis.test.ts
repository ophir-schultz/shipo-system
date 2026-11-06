import { describe, expect, it } from 'vitest'
import { DASHBOARD_SHIPPING_BASIS, FULFILLMENT_PNL_BASIS } from './pnl-basis'

describe('fulfillment P&L basis', () => {
  it('names shipment, warehouse, and inbound, and not the shipping-only margin', () => {
    expect(FULFILLMENT_PNL_BASIS).toMatch(/shipment/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/warehouse/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/inbound/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/not the dashboard shipping margin/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/not counted as \$0/i)
    expect(FULFILLMENT_PNL_BASIS).toMatch(/not a full ledger/i)
  })

  it('keeps the dashboard shipping margin on reconciled shipments only', () => {
    expect(DASHBOARD_SHIPPING_BASIS).toMatch(/shipments only/i)
    expect(DASHBOARD_SHIPPING_BASIS).toMatch(/excluded/i)
    expect(DASHBOARD_SHIPPING_BASIS).not.toMatch(/\$12,256\.11|\$17,745\.80/)
  })
})
