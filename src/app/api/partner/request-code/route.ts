import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  normalizeEmail,
  isEmail,
  MAX_CODES_PER_WINDOW,
  RATE_WINDOW_MINUTES,
} from '@/lib/partner-auth'
import { sendSignInEmail } from '@/lib/partner-signin-email'

// Step 1 of partner login: email in, 6-digit code out by email.
//
// Body: { email }
//
// This endpoint ALWAYS reports success, whether or not the email
// belongs to a partner. Anything else turns it into a directory of
// who Shipo's partners are — type an address, watch the response
// change. The only thing a stranger learns from it is that the
// endpoint exists.
//
// WHAT IS NOT IN THIS FILE ANY MORE. Minting the code, hashing it,
// retiring the outstanding one, issuing the one-click link and writing
// the email all live in src/lib/partner-signin-email.ts, which the
// DocuSign webhook and the staff invite button also call.
//
// That is not DRY for its own sake. Two reasons, and the first is the
// one that bites: a partner must receive the SAME message whichever
// path mailed it, because he is being asked to judge whether an email
// carrying a credential is genuine, and a body that differs by path
// makes that judgement impossible. The staff invite already held a
// second copy once and it had drifted. The second reason is that
// "hash before you store" is a rule with one place to get it wrong
// rather than three.
//
// The access gate moved with it. A code is only sent to a partner who
// passes portalAccessBlock() — chiefly, whose agreement is signed —
// and that check now runs INSIDE sendSignInEmail, before any
// credential is minted, so no caller can forget it.

export const dynamic = 'force-dynamic'

const OK = { success: true, message: 'If that email is on file, a code is on its way.' }

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = normalizeEmail((body as { email?: unknown })?.email)
  if (!email || !isEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  const windowStart = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString()

  // Rate limit on the email, not the partner — an unknown address must
  // cost the same as a known one, or the timing gives the answer away.
  //
  // THIS STAYS IN THE ROUTE, and deliberately. It is a property of a
  // public HTTP endpoint anyone can POST to, not of sending a partner
  // his way in: the webhook fires once per signature and the staff
  // button is behind an authenticated screen, so rate-limiting those
  // would only stop Shipo from re-sending an email a partner asked for.
  const { count } = await supabaseAdmin
    .from('partner_login_codes')
    .select('id', { count: 'exact', head: true })
    .eq('email', email)
    .gte('created_at', windowStart)

  if ((count ?? 0) >= MAX_CODES_PER_WINDOW) {
    return NextResponse.json(
      { error: `Too many codes requested. Wait ${RATE_WINDOW_MINUTES} minutes and try again.` },
      { status: 429 },
    )
  }

  const { data: partner } = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, email, status, agreement_status')
    .ilike('email', email)
    .maybeSingle()

  // No partner: stop here, but answer exactly as if a code had been
  // sent.
  if (!partner) {
    return NextResponse.json(OK)
  }

  const result = await sendSignInEmail({
    ...partner,
    // Recorded for forensics, nothing reads it. The only request-derived
    // value this function accepts, and it is accepted because it cannot
    // point anywhere: a forged IP string mislabels a log line, whereas a
    // forged origin would aim the mailed credential at another host.
    request_ip:
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      null,
  })

  if (result.sent) {
    return NextResponse.json(OK)
  }

  // Three outcomes, three answers. The shape of each one is the point.
  switch (result.reason) {
    // THE SILENT REFUSALS. Both return the same OK as an address that is
    // not a partner at all. A specific message here ("your agreement
    // isn't signed") would answer two questions for anyone who types an
    // address — is this person a Shipo partner, and how far along are
    // they. The honest sentence lives in verify-code, where the caller
    // has already proved they hold a mailed code.
    //
    // The log line is for support: when a partner says "no email
    // arrived", this is the only record of why.
    case 'blocked':
      console.error('[partner-login] code not sent:', result.blocked)
      return NextResponse.json(OK)

    // Unreachable in practice — the partner was found BY this address —
    // but answered uniformly rather than asserted away.
    case 'no-email':
      console.error('[partner-login] code not sent: partner has no email address')
      return NextResponse.json(OK)

    case 'insert-failed':
      return NextResponse.json(
        { error: 'Could not start a login right now. Try again shortly.' },
        { status: 500 },
      )

    case 'send-failed':
      // The partner cannot log in and has no way of knowing why, so this
      // is one case where the honest error beats the uniform response.
      // The error text is Shipo's, never the mail provider's raw body.
      return NextResponse.json(
        {
          error: 'We could not send the code. Email Support@shipousa.com and we will get you in.',
          // The PROVIDER NAME, and only the name. sendEmail fails for
          // three reasons that want three different fixes, and until
          // 2026-10-13 this 502 reported all three identically:
          //
          //   'none'   -> no mail env var is set in THIS environment. The
          //               fix is in Vercel, not in Resend. This is the one
          //               that gets misread as "the provider is broken",
          //               because a 502 feels like something was attempted.
          //   'resend' -> the key IS set and Resend REFUSED the send
          //               (bad key, unverified domain). The fix is at the
          //               provider.
          //   'error'  -> sendEmail threw. Network or SMTP, see the log.
          //
          // Safe to return, on two counts. First, this branch is only
          // reachable by an address that is already a partner AND already
          // past the access gate, so the uniform-OK contract above has
          // necessarily been given up before we get here — the provider
          // name discloses nothing further about any partner. Second, it
          // is a NAME, never result.error, which can carry the provider's
          // raw response body and the From address with it.
          //
          // The cost of not having this: a production 502 whose cause can
          // only be read from Vercel runtime logs, which is exactly the
          // access that was unavailable the day this mattered.
          provider: result.provider,
        },
        { status: 502 },
      )
  }
}
