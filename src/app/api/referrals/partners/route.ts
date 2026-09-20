import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'

// Create or update a referral partner (manual entry / review of a
// website-form sign-up). No money moves here.
//
// ⚠️ THIS ROUTE NO LONGER STAMPS ANY BONUS TERMS.
//
// It used to admit "Founding Partners" by writing signup_bonus_amount
// = 500 and a pair of volume bars onto the partner row, capped at 10
// partners. That model was wrong about the money: 10 partners each
// referring an unlimited number of clients at $500 a head is an
// unbounded liability, not the $2,000 the old comment claimed.
//
// The launch offer now belongs to the CLIENT — the first 10 referred
// clients that clear the bar earn $500, everyone after them earns the
// standing $300 — and the place is claimed in
// /api/referrals/payouts at the moment a bonus is approved. See
// FOUNDING_CLIENT_TERMS and foundingPlaces() in src/lib/referrals.ts.
//
// The per-partner bar columns still exist and are still honoured by
// qualifyBars(), so a bespoke deal can be written by hand in the DB.
// Nothing in the UI writes them any more.
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

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
