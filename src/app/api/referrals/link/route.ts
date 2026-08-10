import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Link a client to a referral partner and set the two payout clocks:
//   referral_signup_date        -> starts the 12-month 8% window
//   referral_first_payment_date -> releases the $300 bonus
export async function POST(req: Request) {
  const body = await req.json()
  const { client_id, referral_partner_id, referral_signup_date, referral_first_payment_date } = body

  if (!client_id) {
    return NextResponse.json({ error: 'client_id is required.' }, { status: 400 })
  }

  const fields: Record<string, unknown> = {}
  if ('referral_partner_id' in body) fields.referral_partner_id = referral_partner_id || null
  if ('referral_signup_date' in body) fields.referral_signup_date = referral_signup_date || null
  if ('referral_first_payment_date' in body) fields.referral_first_payment_date = referral_first_payment_date || null

  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from('clients').update(fields).eq('id', client_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
