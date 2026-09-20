import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase'
import {
  sha256Hex,
  generateSessionToken,
  timingSafeEqual,
  normalizeEmail,
  isEmail,
  SESSION_COOKIE,
  SESSION_DAYS,
  MAX_CODE_ATTEMPTS,
} from '@/lib/partner-auth'

// Step 2 of partner login: email + code in, session cookie out.
//
// Body: { email, code }
//
// Every failure returns the same message. Distinguishing "no code on
// file" from "wrong code" would tell an attacker which addresses are
// partners, which is exactly what request-code refuses to leak.
//
// A code is single-use, expires in 10 minutes, and dies permanently
// after 5 wrong guesses.

export const dynamic = 'force-dynamic'

const BAD = { error: 'That code is not valid. Request a new one.' }

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { email: rawEmail, code: rawCode } = (body ?? {}) as { email?: unknown; code?: unknown }
  const email = normalizeEmail(rawEmail)
  const code = typeof rawCode === 'string' ? rawCode.replace(/\D/g, '') : ''

  if (!email || !isEmail(email) || code.length !== 6) {
    return NextResponse.json(BAD, { status: 400 })
  }

  const { data: row } = await supabaseAdmin
    .from('partner_login_codes')
    .select('id, referral_partner_id, code_hash, expires_at, consumed_at, attempts')
    .eq('email', email)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!row) return NextResponse.json(BAD, { status: 401 })
  if (new Date(row.expires_at).getTime() <= Date.now()) return NextResponse.json(BAD, { status: 401 })
  if ((row.attempts ?? 0) >= MAX_CODE_ATTEMPTS) return NextResponse.json(BAD, { status: 401 })

  const given = await sha256Hex(code)
  if (!timingSafeEqual(given, row.code_hash)) {
    // Burn an attempt. Five wrong guesses and this code is dead even
    // if the real one is later typed correctly.
    await supabaseAdmin
      .from('partner_login_codes')
      .update({ attempts: (row.attempts ?? 0) + 1 })
      .eq('id', row.id)
    return NextResponse.json(BAD, { status: 401 })
  }

  const { data: partner } = await supabaseAdmin
    .from('referral_partners')
    .select('id, status')
    .eq('id', row.referral_partner_id)
    .maybeSingle()

  if (!partner || partner.status === 'inactive') return NextResponse.json(BAD, { status: 401 })

  // Correct code — consume it before minting anything, so a race
  // cannot spend the same code twice.
  const { data: consumed } = await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle()

  if (!consumed) return NextResponse.json(BAD, { status: 401 })

  const token = generateSessionToken()
  const tokenHash = await sha256Hex(token)
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)

  const { error: sessionError } = await supabaseAdmin.from('partner_sessions').insert({
    referral_partner_id: partner.id,
    token_hash: tokenHash,
    expires_at: expiresAt.toISOString(),
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 400) || null,
  })

  if (sessionError) {
    return NextResponse.json({ error: 'Could not sign you in right now. Try again shortly.' }, { status: 500 })
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  await supabaseAdmin
    .from('referral_partners')
    .update({ portal_last_seen_at: new Date().toISOString() })
    .eq('id', partner.id)

  return NextResponse.json({ success: true })
}
