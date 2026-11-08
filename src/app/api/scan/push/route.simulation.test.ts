import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// Simulated push gate. The queue read returns no rows. Nothing is sent.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  runPush: vi.fn(),
  transportPuts: 0,
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/scan/run-push', () => ({ runPush: h.runPush }))
vi.mock('@/lib/scan/zenventory-transport', () => ({
  createZenventoryTransport: () => ({
    async getV2() { throw new Error('simulation must not read Zenventory') },
    async getLegacy() { throw new Error('simulation must not read Zenventory') },
    async putLegacy() {
      h.transportPuts += 1
      throw new Error('simulation must not pick')
    },
  }),
}))
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: () => ({
          order: () => ({
            order: () => ({
              range: async () => ({ data: [], error: null }),
            }),
          }),
        }),
        order: () => ({
          range: async () => ({ data: [], error: null }),
        }),
      }),
    }),
  },
}))

const { GET, POST } = await import('./route')

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.runPush.mockReset()
  h.transportPuts = 0
  delete process.env.ZENVENTORY_PUSH_ENABLED
  delete process.env.ZENVENTORY_PUSH_EXECUTE
})

afterEach(() => {
  delete process.env.ZENVENTORY_PUSH_ENABLED
  delete process.env.ZENVENTORY_PUSH_EXECUTE
})

describe('simulated scan push gate', () => {
  it('stops a caller who is not staff', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await POST()
    expect(res.status).toBe(401)
    expect(h.runPush).not.toHaveBeenCalled()
  })

  it('stays off when the enable flag is absent', async () => {
    const res = await POST()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.enabled).toBe(false)
    expect(body.wrote).toBe(false)
    expect(body.message).toContain('Nothing was sent')
    expect(h.runPush).not.toHaveBeenCalled()
    expect(h.transportPuts).toBe(0)
  })

  it('dry-runs an empty queue and does not call the pick', async () => {
    process.env.ZENVENTORY_PUSH_ENABLED = 'true'
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('dry-run')
    expect(body.wrote).toBe(false)
    expect(body.message).toContain('Dry run')
    expect(body.message).toContain('Nothing was sent')
    expect(h.runPush).not.toHaveBeenCalled()
    expect(h.transportPuts).toBe(0)
  })

  it('reaches the sender only when both flags are true, and this simulation does not pick', async () => {
    process.env.ZENVENTORY_PUSH_ENABLED = 'true'
    process.env.ZENVENTORY_PUSH_EXECUTE = 'true'
    h.runPush.mockResolvedValue([])
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('execute')
    expect(body.wrote).toBe(false)
    expect(body.message).toContain('Nothing was marked done')
    expect(h.runPush).toHaveBeenCalledTimes(1)
    expect(h.transportPuts).toBe(0)
  })

  it('does not send from GET even when execute is armed', async () => {
    process.env.ZENVENTORY_PUSH_ENABLED = 'true'
    process.env.ZENVENTORY_PUSH_EXECUTE = 'true'
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('execute')
    expect(body.wrote).toBe(false)
    expect(body.message).toContain('did not send serials')
    expect(h.runPush).not.toHaveBeenCalled()
    expect(h.transportPuts).toBe(0)
  })
})
