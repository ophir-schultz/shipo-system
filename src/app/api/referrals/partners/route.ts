import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Create or update a referral partner (manual entry / review of a
// website-form sign-up). No money moves here.
export async function POST(req: Request) {
  const body = await req.json()
  const { id, name, company, email, phone, partner_type, refer_method, status, notes } = body

  if (!id && !name) {
    return NextResponse.json({ error: 'Partner name is required.' }, { status: 400 })
  }

  const fields: Record<string, unknown> = {
    name,
    company: company ?? null,
    email: email ?? null,
    phone: phone ?? null,
    partner_type: partner_type ?? null,
    refer_method: refer_method ?? null,
    status: status ?? 'active',
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  }
  // strip undefined so a partial edit doesn't null out columns
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k])

  if (id) {
    const { error } = await supabaseAdmin.from('referral_partners').update(fields).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, id })
  }

  const { data, error } = await supabaseAdmin.from('referral_partners').insert(fields).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}
