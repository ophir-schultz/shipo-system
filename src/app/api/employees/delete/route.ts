import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireEmployeeAdmin } from '@/lib/employee-admin'
import { staffUserId } from '@/lib/require-staff'

export async function POST(req: Request) {
  const denied = await requireEmployeeAdmin()
  if (denied) return denied

  const { id } = await req.json()

  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'User ID required.' }, { status: 400 })
  }

  const me = await staffUserId()
  if (me && me.toLowerCase() === id.toLowerCase()) {
    return NextResponse.json({ error: 'You cannot remove your own account.' }, { status: 403 })
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
