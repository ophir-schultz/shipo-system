import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendEmail } from '@/lib/email'
import {
  sha256Hex,
  generateCode,
  normalizeEmail,
  isEmail,
  CODE_TTL_MINUTES,
  MAX_CODES_PER_WINDOW,
  RATE_WINDOW_MINUTES,
} from '@/lib/partner-auth'
import { portalAccessBlockedReason } from '@/lib/partner-access'
import { generateLinkToken, signInLinkUrl, linkExpiresAt } from '@/lib/partner-login-link'
import { isMissingLinkColumn, loginLinkLines, signInLinkOrigin } from '@/lib/partner-login-issue'

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
// The code itself is never returned, never logged, and never stored
// in the clear — only its SHA-256 hash goes to the database.
//
// A code is only sent to a partner who passes
// portalAccessBlockedReason() — chiefly, whose agreement is signed.
// Before that check existed, every address in referral_partners could
// sign in the moment an email provider was configured, and "signed
// before access" was enforced only by nobody having pressed the staff
// invite button yet. That is not a control.

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

  // The agreement comes before access. Same gate as the staff invite
  // button — portalAccessBlockedReason is the single definition of who
  // may be in the portal, and this is the front door.
  //
  // The refusal is SILENT on purpose: it returns the same OK as an
  // address that is not a partner at all. A specific message here
  // ("your agreement isn't signed") would answer two questions for
  // anyone who types an address — is this person a Shipo partner, and
  // how far along are they. The honest sentence lives in verify-code,
  // where the caller has already proved they hold a mailed code.
  //
  // The log line is for support: when a partner says "no email
  // arrived", this is the only record of why.
  const blocked = portalAccessBlockedReason(partner)
  if (blocked) {
    console.error('[partner-login] code not sent:', blocked)
    return NextResponse.json(OK)
  }

  const code = generateCode()
  const codeHash = await sha256Hex(code)
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString()

  // The one-click link, issued on the SAME ROW as the code. Spec §2.1.
  //
  // One row with two ways to redeem it, sharing one consumed_at, is the
  // design and not an economy: signing in by link must retire the code
  // that travelled in the same email, and vice versa. Two rows, or two
  // consumed flags, would leave a live credential sitting in a mailbox
  // after its owner was already inside.
  //
  // signInLinkUrl returns null over http or a missing origin, and the
  // email simply omits the link in that case — the code in the same
  // message is a working way in, so a missing link degrades the email
  // while a leaking one breaks it.
  const linkToken = generateLinkToken()
  const linkTokenHash = await sha256Hex(linkToken)
  const linkUrl = signInLinkUrl(signInLinkOrigin(), linkToken)

  // Any code still outstanding for this partner is retired first, so
  // asking for a new one always invalidates the old. This now retires
  // an outstanding LINK too, through the shared consumed_at — which is
  // correct: a partner asking for a fresh code is telling us the email
  // he already has is no use to him.
  await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('referral_partner_id', partner.id)
    .is('consumed_at', null)

  const row = {
    referral_partner_id: partner.id,
    email,
    code_hash: codeHash,
    expires_at: expiresAt,
    attempts: 0,
    request_ip:
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      null,
  }

  let { error: insertError } = await supabaseAdmin.from('partner_login_codes').insert({
    ...row,
    link_token_hash: linkTokenHash,
    link_expires_at: linkExpiresAt().toISOString(),
  })

  // DEGRADE, DO NOT FAIL. supabase/partner_login_link.sql is applied by
  // hand in the Supabase SQL editor and nothing sequences it against a
  // deploy, so this code can reach production before the two columns
  // do. PostgREST answers that with 42703 — and this route is the live
  // front door for every partner. Treating it as fatal would turn "the
  // migration is a day late" into "nobody can log in", which is far
  // worse than "no link in the email today".
  //
  // So on a missing-column error only, retry code-only. The partner
  // gets exactly today's behaviour: a 6-digit code that works. The log
  // line names the file to apply, because this failure is otherwise
  // invisible — every email looks fine, and the links in them are the
  // thing that silently does not exist.
  //
  // Narrow by isMissingLinkColumn, never a blanket retry: a unique
  // violation or a dead connection must still surface as a 500.
  let linkIssued = linkUrl !== null
  if (insertError && isMissingLinkColumn(insertError)) {
    console.error(
      '[partner-login] link columns missing — apply supabase/partner_login_link.sql. ' +
        'Sending a code-only email:',
      insertError.message,
    )
    linkIssued = false
    ;({ error: insertError } = await supabaseAdmin.from('partner_login_codes').insert(row))
  }

  if (insertError) {
    return NextResponse.json({ error: 'Could not start a login right now. Try again shortly.' }, { status: 500 })
  }

  // Only after the row is written. An email offering a link whose hash
  // never landed is an email whose link is guaranteed to be refused.
  const linkLines = loginLinkLines(linkIssued ? linkUrl : null)

  const firstName = (partner.name ?? '').split(' ')[0] || 'there'
  const result = await sendEmail({
    to: partner.email as string,
    subject: `${code} is your Shipo partner login code`,
    // Support@ is the only address this email names -- in its own footer, and
    // in the 502 below that tells a partner to write there when no code
    // arrives. A reply here is either "this code doesn't work" or "I didn't
    // ask for this", and both want a staffed mailbox. security@ is not one:
    // it is the default From identity shared by all system mail, so a reply
    // that landed there would be addressed to nobody in particular.
    replyTo: 'Support@shipousa.com',
    text:
      `Hi ${firstName},\n\n` +
      `Your Shipo partner portal code is ${code}\n\n` +
      `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\n` +
      linkLines.text +
      `If you didn't ask for this, you can ignore this email — nobody can get in without the code.\n\n` +
      `Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 · Support@shipousa.com`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="margin:0 0 16px">Hi ${firstName},</p>` +
      `<p style="margin:0 0 8px">Your Shipo partner portal code is:</p>` +
      `<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>` +
      `<p style="margin:0 0 16px;color:#555">It expires in ${CODE_TTL_MINUTES} minutes and can be used once.</p>` +
      linkLines.html +
      `<p style="margin:0 0 24px;color:#555">If you didn&rsquo;t ask for this, you can ignore this email &mdash; nobody can get in without the code.</p>` +
      `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
      `<p style="margin:0;font-size:12px;color:#888">Shipo LLC &middot; 310 Cornell Dr, Suite B4, Wilmington, DE 19801 &middot; Support@shipousa.com</p>` +
      `</div>`,
  })

  if (!result.sent) {
    // The partner cannot log in and has no way of knowing why, so this
    // is one case where the honest error beats the uniform response.
    // The error text is Shipo's, never the mail provider's raw body.
    console.error('[partner-login] email send failed:', result.provider, result.error)
    return NextResponse.json(
      {
        error: 'We could not send the code. Email Support@shipousa.com and we will get you in.',
        // The PROVIDER NAME, and only the name. sendEmail() fails for
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
        // past portalAccessBlockedReason(), so the uniform-OK contract
        // above has necessarily been given up before we get here -- the
        // provider name discloses nothing further about any partner.
        // Second, it is a NAME, never result.error, which can carry the
        // provider's raw response body and the From address with it.
        //
        // The cost of not having this: a production 502 whose cause can
        // only be read from Vercel runtime logs, which is exactly the
        // access that was unavailable the day this mattered.
        provider: result.provider,
      },
      { status: 502 },
    )
  }

  return NextResponse.json(OK)
}
