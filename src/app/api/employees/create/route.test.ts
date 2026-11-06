import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireEmployeeAdmin: vi.fn(),
  createUser: vi.fn(),
}))

vi.mock('@/lib/employee-admin', () => ({
  requireEmployeeAdmin: h.requireEmployeeAdmin,
}))

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: { admin: { createUser: h.createUser } },
  },
}))

const { POST } = await import('./route')

function post(body: unknown) {
  return POST(new Request('http://localhost/api/employees/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  h.requireEmployeeAdmin.mockReset()
  h.createUser.mockReset().mockResolvedValue({ data: { user: { id: 'new' } }, error: null })
})

describe('POST /api/employees/create', () => {
  it('does not create an account for a signed-in user outside the admin gate', async () => {
    h.requireEmployeeAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Not authorised to manage employees.' }, { status: 403 }),
    )
    const res = await post({
      email: 'new-admin@example.com',
      name: 'New Admin',
      role: 'admin',
      password: 'temporary-password',
    })
    expect(res.status).toBe(403)
    expect(h.createUser).not.toHaveBeenCalled()
  })

  it('creates the account for an allowlisted admin without granting app_metadata', async () => {
    h.requireEmployeeAdmin.mockResolvedValue(null)
    const res = await post({
      email: 'new-person@example.com',
      name: 'New Person',
      role: 'employee',
      password: 'temporary-password',
    })
    expect(res.status).toBe(200)
    expect(h.createUser).toHaveBeenCalledTimes(1)
    const payload = h.createUser.mock.calls[0][0]
    expect(payload.email).toBe('new-person@example.com')
    expect(payload.app_metadata).toBeUndefined()
    expect(payload.user_metadata.role).toBe('employee')
  })
})
