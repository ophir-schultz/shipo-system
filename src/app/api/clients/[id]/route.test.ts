import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

// THE ROUTE HANDLER, not the parser it calls.
//
// editable-fields.test.ts proves the allowlist decides correctly. It cannot
// prove the handler ASKS it -- the defect being fixed here was exactly that
// `update(await req.json())` consulted nothing, and a module-level test of a
// parser nobody calls would be green on the broken route.
//
// So the subject of this file is the STATEMENT the handler issues. Two
// properties matter and neither is visible from the response status:
//
//   1. On a refusal, no statement is issued at all. A handler that returned
//      400 and then ran the update anyway would satisfy every status
//      assertion while writing the empty name.
//   2. On success, the payload is the CLEANED fields and not the request
//      body. Asserting a 200 cannot tell ' 07001 ' from '07001'.
//
// Both are read off db.calls, which records every statement the double
// executed.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { PATCH, DELETE } = await import('@/app/api/clients/[id]/route')

const CLIENT_ID = '11111111-1111-1111-1111-111111111111'

/** The params shape Next hands a dynamic route: a promise, not an object. */
const routeParams = { params: Promise.resolve({ id: CLIENT_ID }) }

interface Body { error?: string; success?: boolean }

async function patch(body: unknown): Promise<{ status: number; body: Body }> {
  const res = await PATCH(
    new Request(`https://shipo.test/api/clients/${CLIENT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    routeParams,
  )
  return { status: res.status, body: (await res.json()) as Body }
}

/** The statements the double executed, with only the fields assertions use. */
function statements() {
  return h.db.calls.map((c) => ({ table: c.table, verb: c.verb }))
}

beforeEach(() => {
  h.db = createFakeSupabase({
    clients: [{ id: CLIENT_ID, name: 'Acme Corp', origin_zip: '07001' }],
  })
  // Signed in by default. The deny case sets this per test, so every
  // assertion below about a 400 is about the body and not about the guard.
  h.requireStaff.mockReset()
  h.requireStaff.mockResolvedValue(null)
})

describe('PATCH /api/clients/[id] — a refused body reaches the database as nothing', () => {
  // The confirmed production consequence, 2026-10-05: this exact request
  // wrote an empty string into `clients.name`.
  it('refuses an empty name and issues no statement', async () => {
    const { status, body } = await patch({ name: '' })
    expect(status).toBe(400)
    expect(body.error).toContain('must not be blank')
    expect(statements()).toEqual([])
    // And the stored row is untouched, which is the thing the operator cares
    // about -- `statements()` could be empty for the wrong reason.
    expect(h.db.tables.clients[0].name).toBe('Acme Corp')
  })

  it('refuses a whitespace-only name and issues no statement', async () => {
    const { status } = await patch({ name: '   ' })
    expect(status).toBe(400)
    expect(statements()).toEqual([])
    expect(h.db.tables.clients[0].name).toBe('Acme Corp')
  })

  it('refuses a founding-bonus write and issues no statement', async () => {
    // clients_founding_bonus_seq_uniq is a partial UNIQUE index and the launch
    // offer is capped at ten, so this column is set by hand in SQL.
    const { status, body } = await patch({ founding_bonus_seq: 3 })
    expect(status).toBe(400)
    expect(body.error).toContain('founding_bonus_seq')
    expect(statements()).toEqual([])
  })

  it('refuses a referral-payout write and issues no statement', async () => {
    const { status } = await patch({ referral_first_payment_date: '2026-01-01' })
    expect(status).toBe(400)
    expect(statements()).toEqual([])
  })

  it('refuses the whole request when a money column rides along with a valid one', async () => {
    // The tempting half-fix: write the fields you recognise and ignore the
    // rest. That answers 200 to a request that asked to move the bonus.
    const { status } = await patch({ origin_zip: '19104', founding_bonus_seq: 3 })
    expect(status).toBe(400)
    expect(statements()).toEqual([])
    expect(h.db.tables.clients[0].origin_zip).toBe('07001')
  })

  it('refuses an empty object rather than issuing an empty update', async () => {
    const { status } = await patch({})
    expect(status).toBe(400)
    expect(statements()).toEqual([])
  })

  it('answers 400, not 500, when the body is not JSON at all', async () => {
    // req.json() rejects here. Unhandled, that is a 500 -- a server fault
    // reported for a bad request.
    const res = await PATCH(
      new Request(`https://shipo.test/api/clients/${CLIENT_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      routeParams,
    )
    expect(res.status).toBe(400)
    expect(statements()).toEqual([])
  })
})

describe('PATCH /api/clients/[id] — an accepted body is written cleaned', () => {
  it('writes the trimmed ZIP, not the submitted one', async () => {
    // A 200 cannot distinguish these. The payload can.
    const { status, body } = await patch({ origin_zip: ' 19104 ' })
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(h.db.calls).toHaveLength(1)
    expect(h.db.calls[0].verb).toBe('update')
    expect(h.db.calls[0].payload[0]).toEqual({ origin_zip: '19104' })
    expect(h.db.tables.clients[0].origin_zip).toBe('19104')
  })

  it('writes a blank credential as null, so the sync stops selecting the client', async () => {
    // syncClientAssignments filters `.not('zenventory_api_key', 'is', null)`.
    // '' is not null, so writing '' here leaves a client in the sync with an
    // empty key -- failing every scheduled run. null removes it.
    const { status } = await patch({
      zenventory_api_key: '',
      zenventory_api_secret: '  sk-abc\n',
      zenventory_secure_key: 'legacy-1',
    })
    expect(status).toBe(200)
    expect(h.db.calls[0].payload[0]).toEqual({
      zenventory_api_key: null,
      zenventory_api_secret: 'sk-abc',
      zenventory_secure_key: 'legacy-1',
    })
  })

  it('writes a trimmed name', async () => {
    const { status } = await patch({ name: '  Globex  ' })
    expect(status).toBe(200)
    expect(h.db.calls[0].payload[0]).toEqual({ name: 'Globex' })
    expect(h.db.tables.clients[0].name).toBe('Globex')
  })

  it('scopes the update to the one client in the URL', async () => {
    // Dropping .eq('id', id) would rewrite every client's ZIP and still
    // answer 200 on a one-row fixture, so the filter is asserted directly.
    await patch({ origin_zip: '19104' })
    expect(h.db.calls[0].filters).toEqual([{ op: 'eq', column: 'id', value: CLIENT_ID }])
  })

  it('leaves a second client alone', async () => {
    const other = '22222222-2222-2222-2222-222222222222'
    h.db.tables.clients.push({ id: other, name: 'Globex', origin_zip: '90210' })
    await patch({ origin_zip: '19104' })
    expect(h.db.tables.clients.find((c) => c.id === other)!.origin_zip).toBe('90210')
  })

  it('reports a database failure as a 500 and not as a success', async () => {
    h.db.failOn = (call) => (call.verb === 'update' ? { message: 'connection refused' } : null)
    const { status, body } = await patch({ origin_zip: '19104' })
    expect(status).toBe(500)
    expect(body.error).toBe('connection refused')
  })
})

describe('PATCH /api/clients/[id] — the staff guard still comes first', () => {
  it('returns the guard response and issues no statement', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const { status } = await patch({ origin_zip: '19104' })
    expect(status).toBe(401)
    expect(statements()).toEqual([])
  })

  it('rejects before parsing, so a bad body cannot leak which columns exist', async () => {
    // Order matters: a 400 naming the allowlist would answer an unauthenticated
    // caller's question about the schema.
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const { status, body } = await patch({ founding_bonus_seq: 3 })
    expect(status).toBe(401)
    expect(body.error).toBe('Not authorised.')
  })
})

describe('DELETE /api/clients/[id]', () => {
  // Not changed by this commit, and sharing the file with PATCH. Here so that
  // a later edit to the module both handlers import cannot break it silently.
  it('deletes the one client and reports success', async () => {
    const res = await DELETE(new Request(`https://shipo.test/api/clients/${CLIENT_ID}`), routeParams)
    expect(res.status).toBe(200)
    expect(h.db.tables.clients).toEqual([])
  })

  it('honours the staff guard', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await DELETE(new Request(`https://shipo.test/api/clients/${CLIENT_ID}`), routeParams)
    expect(res.status).toBe(401)
    expect(h.db.tables.clients).toHaveLength(1)
  })
})
