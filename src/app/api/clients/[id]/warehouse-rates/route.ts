import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { rates } = await req.json()
  if (!rates?.length) return NextResponse.json({ error: 'No rates provided' }, { status: 400 })

  await supabaseAdmin.from('client_warehouse_rates').delete().eq('client_id', id)

  const { error } = await supabaseAdmin.from('client_warehouse_rates').insert(rates)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, count: rates.length })
}
