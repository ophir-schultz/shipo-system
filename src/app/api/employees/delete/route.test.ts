import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireEmployeeAdmin: vi.fn(),
  staffUserId: vi.fn(),
  deleteUser: vi.fn(),
}))

vi.mock('@/lib/employee-admin', () => ({
  requireEmployeeAdmin: h.requireEmployeeAdmin,
}))

vi.mock('@/lib/require-staff', () => ({
  staffUserId: h.staffUserId,
}))

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    auth: { admin: { deleteUser: h.deleteUser } },
  },
}))

const { POST } = await import('./route')

function post(id: string) {
  return POST(new Request('http://localhost/api/employees/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }))
}

beforeEach(() => {
  h.requireEmployeeAdmin.mockReset()
  h.staffUserId.mockReset()
  h.deleteUser.mockReset().mockResolvedValue({ error: null })
})

describe('POST /api/employees/delete', () => {
  it('does not delete anyone when the caller is outside the admin gate', async () => {
    h.requireEmployeeAdmin.mockResolvedValue(
      NextResponse.json({ error: 'Not authorised to manage employees.' }, { status: 403 }),
    )
    const res = await post('other-user')
    expect(res.status).toBe(403)
    expect(h.deleteUser).not.toHaveBeenCalled()
  })

  it('blocks an allowlisted admin from deleting their own account', async () => {
    h.requireEmployeeAdmin.mockResolvedValue(null)
    h.staffUserId.mockResolvedValue('ME-1')
    const res = await post('me-1')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'You cannot remove your own account.' })
    expect(h.deleteUser).not.toHaveBeenCalled()
  })

  it('deletes a different account for an allowlisted admin', async () => {
    h.requireEmployeeAdmin.mockResolvedValue(null)
    h.staffUserId.mockResolvedValue('me-1')
    const res = await post('other-user')
    expect(res.status).toBe(200)
    expect(h.deleteUser).toHaveBeenCalledWith('other-user')
  })
})
