import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase'
import {
  sha256Hex,
  generateSessionToken,
  SESSION_COOKIE,
  SESSION_DAYS,
} from '@/lib/partner-auth'
import { linkTokenFromQuery } from '@/lib/partner-login-link'
import { portalAccessPartnerMessage } from '@/lib/partner-access'

// Redeem a one-click sign-in link. Spec §2.1.
//
// Body: { token }
//
// ============================================================
// THERE IS NO GET EXPORT IN THIS FILE, AND THAT IS THE FEATURE.
//
// The emailed URL points at /partner/signin, a page that renders a
// Continue button. The button POSTs here. Nothing is redeemed by
// fetching anything.
//
// The reason is not CSRF and it is not guessing — 32 bytes of CSPRNG is
// not guessable. It is that mail infrastructure fetches links. Defender,
// Proofpoint, Gmail's proxy, iOS Mail's preview and every corporate
// gateway open URLs in messages before a human does. A single-use
// credential redeemed on GET is spent by a machine, and the partner's
// first contact with his own portal is "this link has expired" — with
// no way for support to tell that from an attack.
//
// If a GET handler is ever added here, this file stops being the
// mechanism it was built as. src/lib/partner-login-link.test.ts asserts
// the absence.
//
// WHY THE WORDING IS UNIFORM AND THE AGREEMENT GATE IS NOT
//
// Every failure up to and including the hash lookup returns the same
// sentence. There is no email in the request, so there is nothing to
// enumerate — but there is still no reason to tell a holder of a wrong
// token whether it was unknown, expired or already used, and "request a
// new one" is the same remedy for all three.
//
// Past the lookup the rule inverts, exactly as in verify-code:
// presenting a valid token proves the caller read the email, so the
// person reading the next sentence is the partner it is about. A partner
// who has been paused, or whose agreement was voided after the link was
// issued, is told which — in the PARTNER wording, never the staff
// wording, because the staff sentences are instructions aimed at Shipo
// ("Reactivate them first") and handing those to a partner tells him to
// do something only we can do.
// ============================================================

export const dynamic = 'force-dynamic'

const BAD = {
  error: 'That sign-in link is no longer valid. Enter your email below and we will send you a code.',
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Shape-checked before it is hashed. Anything at all hashes to a
  // valid-looking digest, so without this every malformed value becomes
  // a database lookup — and an array, which is what `?t=a&t=b` becomes
  // on the page, would stringify to "a,b" and be queried as if it were
  // a credential.
  const token = linkTokenFromQuery((body as { token?: unknown })?.token)
  if (!token) return NextResponse.json(BAD, { status: 400 })

  const tokenHash = await sha256Hex(token)

  // The token is the whole credential: the row it matches names the
  // partner. There is no email in this request to cross-check against,
  // which is why the hash column is UNIQUE in the migration — two rows
  // on one hash would make "whose link is this" ambiguous.
  //
  // `.is('consumed_at', null)` is in the predicate rather than checked
  // after the read so a spent link cannot even be fetched.
  const { data: row, error: readError } = await supabaseAdmin
    .from('partner_login_codes')
    .select('id, referral_partner_id, link_expires_at, consumed_at')
    .eq('link_token_hash', tokenHash)
    .is('consumed_at', null)
    .maybeSingle()

  // A read that ERRORED is not a wrong token. The most likely cause is
  // supabase/partner_login_link.sql not having been applied, in which
  // case link_token_hash does not exist and every link in every email
  // is refused as invalid. Saying so in the log is the difference
  // between a five-minute fix and a hunt through mail provider
  // dashboards. The partner still sees BAD — the 6-digit code on the
  // same page is a working way in either way.
  if (readError) {
    console.error('[partner/verify-link] lookup failed:', readError.message)
    return NextResponse.json(BAD, { status: 401 })
  }

  if (!row) return NextResponse.json(BAD, { status: 401 })
  if (!row.link_expires_at) return NextResponse.json(BAD, { status: 401 })
  if (new Date(row.link_expires_at).getTime() <= Date.now()) {
    return NextResponse.json(BAD, { status: 401 })
  }

  const { data: partner } = await supabaseAdmin
    .from('referral_partners')
    .select('id, email, status, agreement_status')
    .eq('id', row.referral_partner_id)
    .maybeSingle()

  if (!partner) return NextResponse.json(BAD, { status: 401 })

  // RE-ASKED HERE, not trusted from issuance. This link is created when
  // staff create the partner row and lives for seven days; a partner can
  // be paused, or his agreement declined or voided, inside that window.
  // Holding the link proves he read the email. It does not prove he may
  // still be in the portal.
  //
  // BEFORE the link is consumed, deliberately. The DocuSign webhook can
  // flip agreement_status while a click is in flight, and burning the
  // link on a refusal would strand a partner who signed a minute ago.
  // An unspent credential is still good.
  //
  // 403, not 401: the credential was correct and the answer is still no.
  const blocked = portalAccessPartnerMessage(partner)
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 })
  }

  // Consume before minting. The `.is('consumed_at', null)` on the UPDATE
  // is what makes "single use" true under a race rather than merely
  // intended: two simultaneous POSTs both read an unconsumed row, and
  // only the one whose update returns a row may continue.
  //
  // ONE consumed_at covers both credentials on this row, which is the
  // design and not an accident — signing in by link must retire the
  // 6-digit code that travelled in the same email.
  const { data: consumed } = await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle()

  if (!consumed) return NextResponse.json(BAD, { status: 401 })

  const sessionToken = generateSessionToken()
  const sessionHash = await sha256Hex(sessionToken)
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)

  const { error: sessionError } = await supabaseAdmin.from('partner_sessions').insert({
    referral_partner_id: partner.id,
    token_hash: sessionHash,
    expires_at: expiresAt.toISOString(),
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 400) || null,
  })

  if (sessionError) {
    // The link is already spent and cannot be re-clicked, so this
    // message must not say "try the link again". The code flow is the
    // honest remedy.
    console.error('[partner/verify-link] session insert failed:', sessionError.message)
    return NextResponse.json(
      {
        error:
          'We could not sign you in right now. Enter your email below and we will send you a code.',
      },
      { status: 500 },
    )
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, sessionToken, {
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
