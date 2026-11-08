import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const CLIENT = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  clientId: '11111111-1111-4111-8111-111111111111',
  requireStaff: vi.fn(),
  staffUserId: vi.fn(),
  fromCalls: [] as string[],
  inserted: [] as unknown[],
  clientResult: { data: { id: '11111111-1111-4111-8111-111111111111', active: true as boolean }, error: null as { message: string } | null },
  insertResult: {
    data: { id: 'm1', amount: 12.5, approved: false, charge_date: '2026-11-06' },
    error: null as { message: string } | null,
  },
  listResult: { data: [] as unknown[], error: null as { message: string } | null },
}))

vi.mock('@/lib/require-staff', () => ({
  requireStaff: h.requireStaff,
  staffUserId: h.staffUserId,
}))

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      h.fromCalls.push(table)
      if (table === 'clients') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => h.clientResult,
            }),
          }),
        }
      }
      return {
        insert: (row: unknown) => ({
          select: () => ({
            single: async () => {
              h.inserted.push(row)
              return h.insertResult
            },
          }),
        }),
        select: () => ({
          order: () => ({
            order: () => ({
              limit: async () => h.listResult,
            }),
          }),
        }),
      }
    },
  },
}))

const { GET, POST } = await import('./route')

function post(body: unknown) {
  return POST(new Request('http://localhost/api/manual-charges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const valid = {
  clientId: CLIENT,
  chargeDate: '2026-11-06',
  description: 'Relabel a carton',
  amount: '12.50',
  approved: true,
}

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.staffUserId.mockReset().mockResolvedValue('user-1')
  h.fromCalls.length = 0
  h.inserted.length = 0
  h.clientResult = { data: { id: CLIENT, active: true }, error: null }
  h.insertResult = {
    data: { id: 'm1', amount: 12.5, approved: false, charge_date: '2026-11-06' },
    error: null,
  }
  h.listResult = { data: [], error: null }
})

describe('manual charges route', () => {
  it('rejects a non-staff caller before any read or insert', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await post(valid)
    expect(res.status).toBe(401)
    expect(h.fromCalls).toEqual([])
    expect(h.inserted).toEqual([])
    const listed = await GET()
    expect(listed.status).toBe(401)
    expect(h.fromCalls).toEqual([])
  })

  it('rejects a bad amount before looking up a client', async () => {
    const res = await post({ ...valid, amount: '-4.00' })
    expect(res.status).toBe(400)
    expect(h.fromCalls).toEqual([])
    expect(h.inserted).toEqual([])
  })

  it('does not insert when the client is missing or inactive', async () => {
    h.clientResult = { data: null, error: null }
    const missing = await post(valid)
    expect(missing.status).toBe(400)
    expect(h.inserted).toEqual([])

    h.clientResult = { data: { id: CLIENT, active: false }, error: null }
    const inactive = await post(valid)
    expect(inactive.status).toBe(400)
    expect(h.inserted).toEqual([])
  })

  it('does not insert when the client cannot be read', async () => {
    h.clientResult = { data: null, error: { message: 'timeout' } }
    const res = await post(valid)
    expect(res.status).toBe(503)
    expect(h.inserted).toEqual([])
    const body = await res.json()
    expect(body.error).toMatch(/nothing was saved/)
  })

  it('inserts only the verified client, the entered day, and the entered amount', async () => {
    const res = await post(valid)
    expect(res.status).toBe(201)
    expect(h.inserted).toEqual([{
      client_id: CLIENT,
      charge_date: '2026-11-06',
      description: 'Relabel a carton',
      amount: 12.5,
      added_by: 'user-1',
    }])
    const body = await res.json()
    expect(body.billing).toMatch(/not approved/)
    expect(body.charge.approved).toBe(false)
  })

  it('returns an empty list when the read succeeds and an error when it does not', async () => {
    const empty = await GET()
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ entries: [] })

    h.listResult = { data: [], error: { message: 'statement timeout' } }
    const failed = await GET()
    expect(failed.status).toBe(503)
    const body = await failed.json()
    expect(body.entries).toBeUndefined()
    expect(body.error).toMatch(/Could not read manual charges/)
  })
})
