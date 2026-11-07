import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// Simulated scan station. No database row is written and no Zenventory
// request leaves this process. The order body and the serials below are
// fixtures, not a live unpicked order.

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  rpc: vi.fn(),
  claimReady: { data: true as boolean | null, error: null as { message: string } | null },
  orders: vi.fn(),
  getUser: vi.fn(),
  client: { data: { name: 'Nayax' } as { name: string } | null, error: null as { message: string } | null },
  matchedRows: [] as unknown[],
  fullRows: [] as unknown[],
  serialError: null as { message: string } | null,
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase-server', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser } }),
}))
vi.mock('@/lib/api/zenventory', () => ({
  getCustomerOrders: h.orders,
}))
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    rpc: (fn: string, args?: unknown) => {
      if (fn === 'scan_claim_ready') return Promise.resolve(h.claimReady)
      return h.rpc(fn, args)
    },
    from: (table: string) => {
      if (table === 'clients') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => h.client,
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            or: () => ({
              order: () => ({
                range: async (from: number) => ({ data: from === 0 ? h.matchedRows : [], error: h.serialError }),
              }),
            }),
          }),
          in: () => ({
            eq: () => ({
              order: () => ({
                range: async (from: number) => ({ data: from === 0 ? h.fullRows : [], error: h.serialError }),
              }),
            }),
          }),
        }),
      }
    },
  },
}))

const { POST } = await import('./route')

const ORDER = {
  customerOrders: [{
    orderNumber: 'SIM-ORDER',
    items: [
      { sku: 'SIM-SKU', serialized: true, quantityOrdered: 2 },
      { sku: 'SIM-PLAIN', serialized: false, quantityOrdered: 1 },
    ],
  }],
}

function post(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

function scan(extra: Record<string, unknown> = {}) {
  return post({
    client_id: '00000000-0000-4000-8000-000000000001',
    scan_type: 'box',
    serials: ['SIM-SERIAL-1'],
    order_ref: 'SIM-ORDER',
    sku: 'SIM-SKU',
    ...extra,
  })
}

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.rpc.mockReset().mockResolvedValue({ data: { scan_event_id: 'sim-event', queued: true }, error: null })
  h.claimReady = { data: true, error: null }
  h.orders.mockReset().mockResolvedValue(ORDER)
  h.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'staff-sim' } } })
  h.client = { data: { name: 'Nayax' }, error: null }
  h.matchedRows = []
  h.fullRows = []
  h.serialError = null
  process.env.ZEN_NAYAX_KEY = 'fixture-key-not-live'
  process.env.ZEN_NAYAX_SECRET = 'fixture-secret-not-live'
  delete process.env.ZEN_NAYAX_SECURE
  delete process.env.ZENVENTORY_SECURE_NAYAX
})

afterEach(() => {
  delete process.env.ZEN_NAYAX_KEY
  delete process.env.ZEN_NAYAX_SECRET
})

describe('simulated POST /api/scan', () => {
  it('refuses a caller who is not staff before any scan is stored', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await scan()
    expect(res.status).toBe(401)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.orders).not.toHaveBeenCalled()
  })

  it('rejects a repeated serial in the same scan and stores nothing', async () => {
    const res = await scan({ serials: ['SIM-SERIAL-1', 'SIM-SERIAL-1'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('SIM-SERIAL-1')
    expect(body.error).toContain('scanned twice')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('rejects a scan with no serials', async () => {
    const res = await scan({ serials: ['  ', 12] })
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('refuses a count above the order quantity and does not store it', async () => {
    const res = await scan({ serials: ['SIM-SERIAL-1', 'SIM-SERIAL-2', 'SIM-SERIAL-3'] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('requires 2')
    expect(body.error).toContain('Nothing was recorded')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('stores a partial line and does not claim a pick was sent', async () => {
    const res = await scan({ serials: ['SIM-SERIAL-1'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pickSent).toBe(false)
    expect(body.success).toBe(true)
    expect(h.rpc).toHaveBeenCalledWith('record_scan', expect.objectContaining({
      p_order_ref: 'SIM-ORDER',
      p_sku: 'SIM-SKU',
      p_serials: ['SIM-SERIAL-1'],
    }))
    const text = JSON.stringify(body)
    expect(text).not.toContain('fixture-key-not-live')
    expect(text).not.toContain('fixture-secret-not-live')
  })

  it('stores an exact quantity and still reports that no pick was sent', async () => {
    const res = await scan({ serials: ['SIM-SERIAL-1', 'SIM-SERIAL-2'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pickSent).toBe(false)
    expect(h.orders).toHaveBeenCalledWith('fixture-key-not-live', 'fixture-secret-not-live', {
      page: 1,
      perPage: 100,
      orderNumber: 'SIM-ORDER',
    })
  })

  it('does not queue a SKU that is not a serialized line on the order', async () => {
    const res = await scan({ sku: 'SIM-PLAIN', serials: ['SIM-SERIAL-1'] })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('record_scan', expect.objectContaining({ p_sku: null }))
    const body = await res.json()
    expect(body.pickSent).toBe(false)
    expect(body.verification).toContain('not queued')
  })

  it('stores an unverified scan when the order read fails and does not queue it', async () => {
    h.orders.mockRejectedValue(new Error('Zenventory API error: HTTP 401'))
    const res = await scan()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pickSent).toBe(false)
    expect(body.verification).toContain('401')
    expect(h.rpc).toHaveBeenCalledWith('record_scan', expect.objectContaining({ p_sku: null }))
  })

  it('refuses a serial already stored on another scan of this client and SKU', async () => {
    const event = {
      id: 'prior-event',
      client_id: '00000000-0000-4000-8000-000000000001',
      sku: 'SIM-SKU',
      order_ref: 'SIM-ORDER',
      scan_type: 'box',
    }
    h.matchedRows = [{ serial: 'SIM-SERIAL-1', scan_event_id: 'prior-event', scan_events: event }]
    h.fullRows = [
      { serial: 'SIM-SERIAL-1', scan_event_id: 'prior-event', scan_events: event },
      { serial: 'SIM-SERIAL-9', scan_event_id: 'prior-event', scan_events: event },
    ]
    const res = await scan({ serials: ['SIM-SERIAL-1'] })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('SIM-SERIAL-1')
    expect(body.error).toContain('this client and SKU')
    expect(body.error).not.toContain('other-client')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.orders).not.toHaveBeenCalled()
  })

  it('accepts the same serial on a different SKU and stores that scan once', async () => {
    const event = {
      id: 'prior-event',
      client_id: '00000000-0000-4000-8000-000000000001',
      sku: 'OTHER-SKU',
      order_ref: 'SIM-ORDER',
      scan_type: 'box',
    }
    h.matchedRows = [{ serial: 'SIM-SERIAL-1', scan_event_id: 'prior-event', scan_events: event }]
    h.fullRows = [{ serial: 'SIM-SERIAL-1', scan_event_id: 'prior-event', scan_events: event }]
    const res = await scan({ serials: ['SIM-SERIAL-1'] })
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('record_scan', expect.objectContaining({
      p_claim_sku: 'SIM-SKU',
      p_serials: ['SIM-SERIAL-1'],
    }))
  })

  it('returns the original event when the same scan is submitted again', async () => {
    const event = {
      id: 'prior-event',
      client_id: '00000000-0000-4000-8000-000000000001',
      sku: 'SIM-SKU',
      order_ref: 'SIM-ORDER',
      scan_type: 'box',
    }
    const rows = [
      { serial: 'SIM-SERIAL-1', scan_event_id: 'prior-event', scan_events: event },
      { serial: 'SIM-SERIAL-2', scan_event_id: 'prior-event', scan_events: event },
    ]
    h.matchedRows = rows
    h.fullRows = rows
    const res = await scan({ serials: ['sim-serial-2', 'SIM-SERIAL-1'] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.idempotent).toBe(true)
    expect(body.scan_event_id).toBe('prior-event')
    expect(body.pickSent).toBe(false)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('does not record when the existing-serial read fails', async () => {
    h.serialError = { message: 'connection refused' }
    const res = await scan()
    expect(res.status).toBe(503)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('drops another client from the read before deciding', async () => {
    h.matchedRows = [{
      serial: 'SIM-SERIAL-1',
      scan_event_id: 'theirs',
      scan_events: {
        id: 'theirs',
        client_id: 'other-client',
        sku: 'SIM-SKU',
        order_ref: 'THEIR-ORDER',
        scan_type: 'box',
      },
    }]
    h.fullRows = []
    const res = await scan()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('other-client')
    expect(JSON.stringify(body)).not.toContain('THEIR-ORDER')
    expect(h.rpc).toHaveBeenCalled()
  })

  it('does not store a scan when the claim migration is absent', async () => {
    h.claimReady = { data: null, error: { message: 'Could not find the function public.scan_claim_ready' } }
    const res = await scan()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toContain('not ready')
    expect(body.recorded).toBe(false)
    expect(body.pickSent).toBe(false)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.orders).not.toHaveBeenCalled()
  })

  it('does not store a scan when the claim probe is false', async () => {
    h.claimReady = { data: false, error: null }
    const res = await scan()
    expect(res.status).toBe(503)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('dry-runs the decision without the migration and without storing', async () => {
    h.claimReady = { data: false, error: null }
    const res = await scan({ dry_run: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dryRun).toBe(true)
    expect(body.recorded).toBe(false)
    expect(body.pickSent).toBe(false)
    expect(body.action).toBe('record')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('turns an already-pushed line into a conflict and does not report success', async () => {
    h.rpc.mockResolvedValue({
      data: null,
      error: { message: 'order SIM-ORDER line SIM-SKU has already been pushed to Zenventory — this carton cannot be added to it' },
    })
    const res = await scan()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('already been pushed')
    expect(body.success).toBeUndefined()
    expect(body.pickSent).toBeUndefined()
  })
})
