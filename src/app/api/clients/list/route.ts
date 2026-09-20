import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const { data } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')
  return NextResponse.json(data ?? [])
}
