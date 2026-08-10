import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Public webhook: the shipousa.com Partner Program (Forminator) form
// POSTs each sign-up here. We insert the partner as `pending` so it
// shows up in the dashboard for Ophir to review — never auto-active,
// never triggers any payout.
//
// Optional shared secret: set REFERRAL_INTAKE_TOKEN in env, then the
// form must include ?token=... (or an X-Intake-Token header).

export const dynamic = 'force-dynamic'

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    for (const actual of Object.keys(obj)) {
      if (actual.toLowerCase().replace(/[^a-z]/g, '') === k) {
        const v = obj[actual]
        if (v != null && String(v).trim() !== '') return String(v).trim()
      }
    }
  }
  return null
}

export async function POST(req: Request) {
  // --- optional auth ---
  const expected = process.env.REFERRAL_INTAKE_TOKEN
  if (expected) {
    const url = new URL(req.url)
    const token = url.searchParams.get('token') || req.headers.get('x-intake-token')
    if (token !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // --- parse JSON or form-encoded bodies ---
  let data: Record<string, unknown> = {}
  const ct = req.headers.get('content-type') || ''
  try {
    if (ct.includes('application/json')) {
      data = await req.json()
    } else {
      const form = await req.formData()
      form.forEach((v, k) => {
        data[k] = typeof v === 'string' ? v : ''
      })
    }
  } catch {
    return NextResponse.json({ error: 'Could not parse body.' }, { status: 400 })
  }

  const name = pick(data, ['fullname', 'name', 'firstname'])
  const email = pick(data, ['email', 'emailaddress'])
  const company = pick(data, ['company', 'companyname', 'business'])
  const phone = pick(data, ['phone', 'phonenumber'])
  const partner_type = pick(data, ['partnertype', 'type'])
  const refer_method = pick(data, ['howwillyourefersellerstous', 'refermethod', 'howwillyourefer', 'message'])

  if (!name && !email) {
    return NextResponse.json({ error: 'Sign-up needs at least a name or email.' }, { status: 400 })
  }

  // de-dupe by email when present
  if (email) {
    const { data: existing } = await supabaseAdmin
      .from('referral_partners')
      .select('id')
      .eq('email', email)
      .limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json({ success: true, deduped: true, id: existing[0].id })
    }
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('referral_partners')
    .insert({
      name: name ?? email,
      email,
      company,
      phone,
      partner_type,
      refer_method,
      status: 'pending',
      source: 'website_form',
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: inserted?.id })
}
