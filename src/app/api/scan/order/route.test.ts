import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  client: { data: { id: 'c1', name: 'Nayax' } as { id: string; name: string } | null, error: null as { message: string } | null },
  orders: vi.fn(),
  legacy: vi.fn(),
  creds: {
    ok: true as boolean,
    credentials: {
      slug: 'NAYAX',
      apiKey: 'fixture-key',
      apiSecret: 'fixture-secret',
      secureKey: null as string | null,
      keySource: 'ZEN_NAYAX_KEY',
      secretSource: 'ZEN_NAYAX_SECRET',
    },
    notice: '',
  },
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
  getScanCustomerOrder: h.orders,
  getLegacyCustomerOrder: h.legacy,
}))
vi.mock('@/lib/zenventory/client-env', () => ({
  readOrderReadCredentials: () => h.creds.ok
    ? { ok: true, credentials: h.creds.credentials }
    : { ok: false, notice: h.creds.notice },
  zenventoryEnvNames: () => ({
    key: 'ZEN_NAYAX_KEY',
    secret: 'ZEN_NAYAX_SECRET',
    secure: 'ZEN_NAYAX_SECURE',
    legacyKey: 'ZENVENTORY_KEY_NAYAX',
    legacySecret: 'ZENVENTORY_SECRET_NAYAX',
    legacySecure: 'ZENVENTORY_SECURE_NAYAX',
  }),
}))

const { GET } = await import('./route')

function call(order = 'SO-100') {
  return GET(new Request(`http://localhost/api/scan/order?client_id=c1&order_ref=${order}`))
}

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.orders.mockReset()
  h.legacy.mockReset()
  h.creds = {
    ok: true,
    credentials: {
      slug: 'NAYAX',
      apiKey: 'fixture-key',
      apiSecret: 'fixture-secret',
      secureKey: null,
      keySource: 'ZEN_NAYAX_KEY',
      secretSource: 'ZEN_NAYAX_SECRET',
    },
    notice: '',
  }
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
    expect(h.orders).toHaveBeenCalledWith('fixture-key', 'fixture-secret', 'SO-100')
  })

  it('reads the legacy order when API 2.0 returns 401 and does not send the secret as the key', async () => {
    h.creds.credentials.secureKey = 'fixture-secure'
    h.orders.mockRejectedValue(new Error('Zenventory API error: HTTP 401: {"code":"unauthorized","message":"Invalid API key and/or secret."}'))
    h.legacy.mockResolvedValue({
      customerorders: [{
        ordernumber: 'SO-100',
        customerorderid: 55,
        items: [{ sku: 'BASE', serialized: true, orderquantity: 2, pickedquantity: 2 }],
      }],
    })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('legacy')
    expect(body.lines).toEqual([
      { sku: 'BASE', serialized: true, requiredQty: 2, pickedQty: 2 },
    ])
    expect(h.legacy).toHaveBeenCalledWith('fixture-secure', 'SO-100')
    expect(h.legacy).not.toHaveBeenCalledWith('fixture-secret', 'SO-100')
    expect(JSON.stringify(body)).not.toContain('fixture-secret')
    expect(JSON.stringify(body)).not.toContain('fixture-secure')
  })

  it('does not call the legacy read with the API secret when no SecureKey is set', async () => {
    h.orders.mockRejectedValue(new Error('Zenventory API error: HTTP 401: {"code":"unauthorized"}'))
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.loaded).toBe(false)
    expect(body.lines).toBeNull()
    expect(body.reason).toContain('ZEN_NAYAX_SECURE')
    expect(body.reason).toContain('not used as that key')
    expect(body.reason).not.toContain('fixture-secret')
    expect(h.legacy).not.toHaveBeenCalled()
  })

  it('does not turn a failed read into an empty order', async () => {
    h.orders.mockRejectedValue(new Error('Zenventory API error: HTTP 401'))
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.loaded).toBe(false)
    expect(body.lines).toBeNull()
    expect(body.reason).toContain('401')
    expect(body.reason).toContain('ZEN_NAYAX_KEY')
    expect(body.reason).toContain('ZEN_NAYAX_SECRET')
    expect(body.reason).not.toContain('fixture-key')
    expect(body.reason).not.toContain('fixture-secret')
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
