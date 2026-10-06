import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

// The create half of the same defect. `if (!name)` is a check on truthiness,
// and ' ' is truthy, so a single space passed both this guard and the form's
// HTML `required` and became a client whose name renders as nothing. The
// subject here, as in the PATCH test beside it, is the STATEMENT: a refused
// body must reach the table as no insert at all.
const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { POST } = await import('@/app/api/clients/route')

interface Body { error?: string; id?: string; name?: string; email?: string | null; phone?: string | null }

async function post(body: unknown): Promise<{ status: number; body: Body }> {
  const res = await POST(
    new Request('https://shipo.test/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as Body }
}

beforeEach(() => {
  h.db = createFakeSupabase({ clients: [] })
  h.requireStaff.mockReset()
  h.requireStaff.mockResolvedValue(null)
})

describe('POST /api/clients — a blank name cannot become a client', () => {
  it('refuses a single space and inserts nothing', async () => {
    const { status, body } = await post({ name: ' ', email: '', phone: '' })
    expect(status).toBe(400)
    expect(body.error).toContain('must not be blank')
    expect(h.db.calls).toEqual([])
    expect(h.db.tables.clients).toEqual([])
  })

  it('refuses the empty string and inserts nothing', async () => {
    const { status } = await post({ name: '', email: '', phone: '' })
    expect(status).toBe(400)
    expect(h.db.tables.clients).toEqual([])
  })

  it('refuses a missing name', async () => {
    const { status, body } = await post({ email: 'a@b.co' })
    expect(status).toBe(400)
    expect(body.error).toContain('name is required')
    expect(h.db.tables.clients).toEqual([])
  })

  it('refuses an array in the name, which also clears a truthiness guard', async () => {
    // [] is truthy and String([]) is '', so a coercing implementation stores
    // the empty name.
    const { status } = await post({ name: [] })
    expect(status).toBe(400)
    expect(h.db.tables.clients).toEqual([])
  })

  it('refuses a column that is not settable at creation', async () => {
    const { status, body } = await post({ name: 'Acme', founding_bonus_seq: 1 })
    expect(status).toBe(400)
    expect(body.error).toContain('founding_bonus_seq')
    expect(h.db.tables.clients).toEqual([])
  })

  it('answers 400, not 500, when the body is not JSON', async () => {
    const res = await POST(new Request('https://shipo.test/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }))
    expect(res.status).toBe(400)
    expect(h.db.tables.clients).toEqual([])
  })
})

describe('POST /api/clients — an accepted body is inserted cleaned', () => {
  it('stores the trimmed name and nulls for the blank optional fields', async () => {
    const { status, body } = await post({ name: '  Acme Corp  ', email: '', phone: '' })
    expect(status).toBe(200)
    expect(h.db.calls).toHaveLength(1)
    expect(h.db.calls[0].verb).toBe('insert')
    expect(h.db.calls[0].payload[0]).toEqual({ name: 'Acme Corp', email: null, phone: null })
    // The route returns the inserted row, which the form reads `data.id` from
    // to redirect.
    expect(body.name).toBe('Acme Corp')
    expect(body.id).toBeTruthy()
  })

  it('stores the trimmed email and phone when they are given', async () => {
    await post({ name: 'Acme', email: ' billing@acme.co ', phone: ' +1 555 ' })
    expect(h.db.calls[0].payload[0]).toEqual({
      name: 'Acme',
      email: 'billing@acme.co',
      phone: '+1 555',
    })
  })

  it('reports a database failure as a 500', async () => {
    h.db.failOn = (call) => (call.verb === 'insert' ? { message: 'duplicate key' } : null)
    const { status, body } = await post({ name: 'Acme' })
    expect(status).toBe(500)
    expect(body.error).toBe('duplicate key')
  })

  it('honours the staff guard before inserting', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const { status } = await post({ name: 'Acme' })
    expect(status).toBe(401)
    expect(h.db.tables.clients).toEqual([])
  })
})
