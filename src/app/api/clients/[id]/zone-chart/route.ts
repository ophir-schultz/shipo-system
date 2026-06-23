import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { entries } = await req.json().catch(() => ({}))

  if (!Array.isArray(entries) || entries.length === 0) {
    return NextResponse.json({ error: 'No entries provided' }, { status: 400 })
  }

  // Get origin ZIP for this client
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('origin_zip')
    .eq('id', id)
    .single()

  const originZip = String(client?.origin_zip ?? '').replace(/\D/g, '').slice(0, 3)
  if (originZip.length !== 3) {
    return NextResponse.json({ error: 'Please set the client\'s Origin ZIP first' }, { status: 400 })
  }

  // Validate & normalize
  const clean = entries
    .map((e: any) => ({
      origin_prefix: originZip,
      dest_prefix: String(e.dest_prefix ?? '').replace(/\D/g, '').slice(0, 3),
      zone: parseInt(e.zone, 10),
    }))
    .filter(e => e.dest_prefix.length === 3 && e.zone >= 1 && e.zone <= 8)

  if (clean.length === 0) {
    return NextResponse.json({ error: 'No valid zone chart entries found. Need columns: dest_prefix (3-digit ZIP), zone (1-8).' }, { status: 400 })
  }

  // Replace all entries for this origin prefix
  await supabaseAdmin.from('zone_chart').delete().eq('origin_prefix', originZip)
  const { error } = await supabaseAdmin.from('zone_chart').insert(clean)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, count: clean.length, origin_prefix: originZip })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: client } = await supabaseAdmin.from('clients').select('origin_zip').eq('id', id).single()
  const originPrefix = String(client?.origin_zip ?? '').replace(/\D/g, '').slice(0, 3)
  if (originPrefix.length !== 3) return NextResponse.json({ entries: [], count: 0 })
  const { data, count } = await supabaseAdmin
    .from('zone_chart')
    .select('*', { count: 'exact' })
    .eq('origin_prefix', originPrefix)
  return NextResponse.json({ entries: data ?? [], count: count ?? 0 })
}
