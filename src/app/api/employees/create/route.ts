import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireEmployeeAdmin } from '@/lib/employee-admin'

export async function POST(req: Request) {
  const denied = await requireEmployeeAdmin()
  if (denied) return denied

  const { email, name, role, password } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  // The role below is a display label on the employees screen. It is not
  // copied onto the server-only admin claim, and it does not grant this route.
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, role: role ?? 'employee' },
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ user: data.user })
}
