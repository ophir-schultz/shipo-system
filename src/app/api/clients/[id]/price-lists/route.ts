import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff, staffEmail } from '@/lib/require-staff'
import { parsePriceList } from '@/lib/pricing/parse-price-list'

// Inserts a price list. It does not delete or replace an earlier upload:
// the newest row is the one the screens read, and the older ones stay.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Send a JSON price list.' }, { status: 400 })
  }
  const document = (body as { document?: unknown }).document ?? body
  const parsed = parsePriceList(document)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const filename = (body as { filename?: unknown }).filename
  const { error } = await supabaseAdmin.from('client_price_lists').insert({
    client_id: id,
    name: parsed.list.name,
    document: parsed.list,
    source_filename: typeof filename === 'string' ? filename : null,
    uploaded_by: await staffEmail(),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, name: parsed.list.name })
}
