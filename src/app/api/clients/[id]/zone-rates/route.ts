import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { rates, carrier = '', service = '' } = await req.json().catch(() => ({}))

  if (!Array.isArray(rates) || rates.length === 0) {
    return NextResponse.json({ error: 'No rates provided' }, { status: 400 })
  }

  // Validate + normalize each matrix cell
  const clean = rates
    .map((r: any) => ({
      client_id: id,
      carrier: String(carrier ?? '').trim(),
      service: String(service ?? '').trim(),
      weight_lb: parseInt(r.weight_lb, 10),
      zone: parseInt(r.zone, 10),
      rate: parseFloat(r.rate),
    }))
    .filter(r =>
      Number.isInteger(r.weight_lb) && r.weight_lb >= 1 &&
      Number.isInteger(r.zone) && r.zone >= 1 && r.zone <= 8 &&
      Number.isFinite(r.rate) && r.rate >= 0
    )

  if (clean.length === 0) {
    return NextResponse.json({ error: 'No valid matrix cells found' }, { status: 400 })
  }

  // Replace existing rates for this client + carrier/service combo only
  await supabaseAdmin
    .from('client_zone_rates')
    .delete()
    .eq('client_id', id)
    .eq('carrier', clean[0].carrier)
    .eq('service', clean[0].service)

  const { error } = await supabaseAdmin.from('client_zone_rates').insert(clean)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, count: clean.length })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { error } = await supabaseAdmin.from('client_zone_rates').delete().eq('client_id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
