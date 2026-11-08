import { describe, expect, it, vi } from 'vitest'

// This release keeps production record_scan. The claim function is not
// applied, so the route must not call record_scan_claimed or refuse a
// scan because that function is absent.

const h = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: { rpc: h.rpc },
}))
vi.mock('@/lib/supabase-server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'staff-sim' } } }) },
  }),
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: async () => null }))

const { POST } = await import('@/app/api/scan/route')

describe('production scan route', () => {
  it('records through record_scan and does not require the claim function', async () => {
    h.rpc.mockResolvedValue({ data: 'event-1', error: null })
    const res = await POST(new Request('https://shipo.test/api/scan', {
      method: 'POST',
      body: JSON.stringify({
        client_id: '00000000-0000-4000-8000-000000000001',
        scan_type: 'box',
        serials: ['SIM-SERIAL-1'],
        order_ref: 'SIM-ORDER',
      }),
    }))
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('record_scan', expect.objectContaining({
      p_serials: ['SIM-SERIAL-1'],
    }))
    expect(h.rpc.mock.calls.some((call) => call[0] === 'record_scan_claimed')).toBe(false)
  })
})
