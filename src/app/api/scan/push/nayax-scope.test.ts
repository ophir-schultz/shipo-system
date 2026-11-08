import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  runPush: vi.fn(),
  jobs: [] as Array<{ id: string; client_id: string; order_ref: string; sku: string; status: string; attempts: number }>,
  clients: [] as Array<{ id: string; name: string }>,
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/scan/run-push', () => ({ runPush: h.runPush }))
vi.mock('@/lib/scan/zenventory-transport', () => ({
  createZenventoryTransport: () => ({
    async getV2() { throw new Error('must not read Zenventory') },
    async getLegacy() { throw new Error('must not read Zenventory') },
    async putLegacy() { throw new Error('must not pick') },
  }),
}))
vi.mock('@/lib/scan/shipment-tracking', () => ({
  shipmentTrackingByOrder: async () => { throw new Error('must not read shipments') },
}))
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'clients') {
        const query = Promise.resolve({ data: h.clients, error: null })
        return { select: () => ({ in: () => query }) }
      }
      return {
        select: () => ({
          in: () => ({
            order: () => ({
              order: () => ({
                range: async (from: number) => ({ data: from === 0 ? h.jobs : [], error: null }),
              }),
            }),
          }),
        }),
      }
    },
  },
}))

const { POST } = await import('./route')

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.runPush.mockReset()
  h.jobs = []
  h.clients = []
  process.env.ZENVENTORY_PUSH_ENABLED = 'true'
  process.env.ZENVENTORY_PUSH_EXECUTE = 'true'
})

describe('POST /api/scan/push is Nayax only', () => {
  it('does not send a queued Creative Pea job', async () => {
    h.jobs = [{ id: 'job-1', client_id: 'pea', order_ref: 'SO-1', sku: 'SKU', status: 'pending', attempts: 0 }]
    h.clients = [{ id: 'pea', name: 'Creative Pea' }]
    const res = await POST()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.wrote).toBe(false)
    expect(body.error).toContain('Nayax only')
    expect(h.runPush).not.toHaveBeenCalled()
  })

  it('does not send a queued job whose client cannot be named', async () => {
    h.jobs = [{ id: 'job-2', client_id: 'missing', order_ref: 'SO-2', sku: 'SKU', status: 'pending', attempts: 0 }]
    h.clients = []
    const res = await POST()
    expect(res.status).toBe(403)
    expect(h.runPush).not.toHaveBeenCalled()
  })
})
