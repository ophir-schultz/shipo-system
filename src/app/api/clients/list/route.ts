import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')

  // The error used to be dropped on the floor: `const { data } = ...` followed
  // by `data ?? []`, so a failed read returned 200 with an empty array. Every
  // screen that picks a client from this list then renders "no clients" --
  // indistinguishable from a database that genuinely has none, and on the
  // warehouse log that reads as "there is no work to log today". Same reason
  // lib/db/read.ts exists: a failed read must not be able to impersonate an
  // empty one.
  if (error) {
    return NextResponse.json(
      { error: `Could not read the client list: ${error.message}` },
      { status: 503 },
    )
  }
  return NextResponse.json(data ?? [])
}
