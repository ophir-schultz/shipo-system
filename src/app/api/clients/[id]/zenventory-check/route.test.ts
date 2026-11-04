import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  single: vi.fn(),
  getCustomerOrders: vi.fn(),
  getInventory: vi.fn(),
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: h.single }),
      }),
    }),
  },
}))
vi.mock('@/lib/api/zenventory', () => ({
  getCustomerOrders: h.getCustomerOrders,
  getInventory: h.getInventory,
}))

const { GET } = await import('./route')

function call() {
  return GET(new Request('http://localhost/api/clients/c1/zenventory-check'), {
    params: Promise.resolve({ id: 'c1' }),
  })
}

beforeEach(() => {
  h.requireStaff.mockReset()
  h.requireStaff.mockResolvedValue(null)
  h.single.mockReset()
  h.getCustomerOrders.mockReset()
  h.getInventory.mockReset()
  process.env.ZEN_ORCAM_KEY = 'fixture-key'
  process.env.ZEN_ORCAM_SECRET = 'fixture-secret'
  delete process.env.ZEN_ORCAM_SECURE
})

describe('GET /api/clients/[id]/zenventory-check', () => {
  it('rejects a non-staff caller before reading the client or Zenventory', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await call()
    expect(res.status).toBe(401)
    expect(h.single).not.toHaveBeenCalled()
    expect(h.getCustomerOrders).not.toHaveBeenCalled()
    expect(h.getInventory).not.toHaveBeenCalled()
  })

  it('returns the 7-day order count, latest date, and inventory count', async () => {
    h.single.mockResolvedValue({ data: { id: 'c1', name: 'Orcam' }, error: null })
    h.getCustomerOrders.mockResolvedValue({
      customerOrders: [
        { orderedDate: '2026-11-03T10:00:00.000Z' },
        { orderedDate: '2026-11-04T09:00:00.000Z' },
      ],
      meta: { totalPages: 1 },
    })
    h.getInventory.mockResolvedValue({ meta: { count: 18 } })

    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.orderCount).toBe(2)
    expect(body.latestOrderDate).toBe('2026-11-04T09:00:00.000Z')
    expect(body.inventoryCount).toBe(18)
    expect(body.error).toBeNull()
    const text = JSON.stringify(body)
    expect(text).not.toContain('fixture-key')
    expect(text).not.toContain('fixture-secret')
    expect(h.getCustomerOrders.mock.calls[0][2]).toMatchObject({
      page: 1,
      perPage: 100,
      orderedSince: expect.any(String),
    })
  })

  it('is not configured when the key and secret are absent, and does not call Zenventory', async () => {
    delete process.env.ZEN_ORCAM_KEY
    delete process.env.ZEN_ORCAM_SECRET
    h.single.mockResolvedValue({ data: { id: 'c1', name: 'Orcam' }, error: null })
    const body = await (await call()).json()
    expect(body.configured).toBe(false)
    expect(body.ok).toBe(false)
    expect(body.orderCount).toBeNull()
    expect(body.error).toContain('not configured')
    expect(h.getCustomerOrders).not.toHaveBeenCalled()
    expect(h.getInventory).not.toHaveBeenCalled()
  })

  it('reports a failed call without dropping the count from the call that worked', async () => {
    h.single.mockResolvedValue({ data: { id: 'c1', name: 'Orcam' }, error: null })
    h.getCustomerOrders.mockResolvedValue({
      customerOrders: [{ orderedDate: new Date().toISOString() }],
      meta: { totalPages: 1 },
    })
    h.getInventory.mockRejectedValue(new Error('Zenventory API error: HTTP 500'))
    const body = await (await call()).json()
    expect(body.configured).toBe(true)
    expect(body.ok).toBe(false)
    expect(body.orderCount).toBe(1)
    expect(body.inventoryCount).toBeNull()
    expect(body.error).toContain('Inventory:')
    expect(body.error).not.toContain('fixture-key')
  })
})
