import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await req.json()

  if (!id) {
    return NextResponse.json({ error: 'User ID required.' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
