import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function GET() {
  const { data } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')
  return NextResponse.json(data ?? [])
}
