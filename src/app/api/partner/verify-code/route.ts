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
import { portalAccessPartnerMessage } from '@/lib/partner-access'

// Step 2 of partner login: email + code in, session cookie out.
//
// Body: { email, code }
//
// Every failure UP TO AND INCLUDING the code comparison returns the
// same message. Distinguishing "no code on file" from "wrong code"
// would tell an attacker which addresses are partners, which is
// exactly what request-code refuses to leak.
//
// Past that point the rule inverts. Presenting a correct code proves
// the caller read the email, so there is no longer a stranger to keep
// in the dark — and a partner who has signed, been paused, or never
// finished DocuSign needs to be told which of those it is. So the
// agreement gate below answers specifically, with 403.
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
    .select('id, email, status, agreement_status')
    .eq('id', row.referral_partner_id)
    .maybeSingle()

  if (!partner) return NextResponse.json(BAD, { status: 401 })

  // The agreement gate, checked a second time and for real. request-code
  // declines silently; this is where the partner is told why.
  //
  // Two decisions about placement:
  //
  // AFTER the hash comparison, because reaching this line proves the
  // caller received the emailed code. The specific sentence therefore
  // leaks nothing a stranger could use — the only person who sees it is
  // the partner it is about.
  //
  // BEFORE consuming the code, because the DocuSign webhook can flip
  // agreement_status to 'signed' while a code is in flight. Burning the
  // code on a refusal would force a partner who signed thirty seconds
  // ago to request a second email for no reason. A code that was not
  // spent is still good.
  //
  // 403, not 401: the credential was correct and the answer is still
  // no. 401 would send the login form round to "request a new code",
  // which would produce another refusal and no explanation.
  //
  // The PARTNER wording, not the staff wording. Same decision — one
  // function makes it — but the staff sentences are instructions aimed
  // at Shipo ("Reactivate them first", "Send a new one"), and handing
  // those to a partner tells them to do something only we can do.
  const blocked = portalAccessPartnerMessage(partner)
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 })
  }

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
