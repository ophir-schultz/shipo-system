import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  client: { data: { id: 'c1', name: 'Nayax' } as { id: string; name: string } | null, error: null as { message: string } | null },
  orders: vi.fn(),
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => h.client,
        }),
      }),
    }),
  },
}))
vi.mock('@/lib/api/zenventory', () => ({
  getCustomerOrders: h.orders,
}))
vi.mock('@/lib/zenventory/client-env', () => ({
  readZenventoryClientCredentials: () => ({
    ok: true,
    credentials: { slug: 'NAYAX', apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: null },
  }),
}))

const { GET } = await import('./route')

function call(order = 'SO-100') {
  return GET(new Request(`http://localhost/api/scan/order?client_id=c1&order_ref=${order}`))
}

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.orders.mockReset()
  h.client = { data: { id: 'c1', name: 'Nayax' }, error: null }
})

describe('GET /api/scan/order', () => {
  it('returns the order lines and does not return credentials', async () => {
    h.orders.mockResolvedValue({
      customerOrders: [{
        orderNumber: 'SO-100',
        items: [
          { sku: 'BASE', serialized: true, quantityOrdered: 4 },
          { sku: 'EXTRA', serialized: false, quantityOrdered: 1 },
        ],
      }],
    })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.loaded).toBe(true)
    expect(body.lines).toEqual([
      { sku: 'BASE', serialized: true, requiredQty: 4, pickedQty: null },
      { sku: 'EXTRA', serialized: false, requiredQty: 1, pickedQty: null },
    ])
    expect(body.secureConfigured).toBe(false)
    const text = JSON.stringify(body)
    expect(text).not.toContain('fixture-key')
    expect(text).not.toContain('fixture-secret')
    expect(h.orders).toHaveBeenCalledWith('fixture-key', 'fixture-secret', {
      page: 1,
      perPage: 100,
      orderNumber: 'SO-100',
    })
  })

  it('does not turn a failed read into an empty order', async () => {
    h.orders.mockRejectedValue(new Error('Zenventory API error: HTTP 401'))
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.loaded).toBe(false)
    expect(body.lines).toBeNull()
    expect(body.reason).toContain('401')
  })

  it('rejects a caller who is not staff before reading the order', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await call()
    expect(res.status).toBe(401)
    expect(h.orders).not.toHaveBeenCalled()
  })

  it('does not call a pick or a legacy write', () => {
    const src = readFileSync('src/app/api/scan/order/route.ts', 'utf8')
    expect(src).not.toContain('putLegacy')
    expect(src).not.toContain('getShippingOrders')
    expect(src).not.toContain('/items/pick')
  })
})
