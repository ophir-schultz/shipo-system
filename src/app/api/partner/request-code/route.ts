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

  // Any code still outstanding for this partner is retired first, so
  // asking for a new one always invalidates the old.
  await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('referral_partner_id', partner.id)
    .is('consumed_at', null)

  const { error: insertError } = await supabaseAdmin.from('partner_login_codes').insert({
    referral_partner_id: partner.id,
    email,
    code_hash: codeHash,
    expires_at: expiresAt,
    attempts: 0,
    request_ip:
      req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
      req.headers.get('x-real-ip') ??
      null,
  })

  if (insertError) {
    return NextResponse.json({ error: 'Could not start a login right now. Try again shortly.' }, { status: 500 })
  }

  const firstName = (partner.name ?? '').split(' ')[0] || 'there'
  const result = await sendEmail({
    to: partner.email as string,
    subject: `${code} is your Shipo partner login code`,
    text:
      `Hi ${firstName},\n\n` +
      `Your Shipo partner portal code is ${code}\n\n` +
      `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\n` +
      `If you didn't ask for this, you can ignore this email — nobody can get in without the code.\n\n` +
      `Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 · Support@shipousa.com`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="margin:0 0 16px">Hi ${firstName},</p>` +
      `<p style="margin:0 0 8px">Your Shipo partner portal code is:</p>` +
      `<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>` +
      `<p style="margin:0 0 16px;color:#555">It expires in ${CODE_TTL_MINUTES} minutes and can be used once.</p>` +
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
      { error: 'We could not send the code. Email Support@shipousa.com and we will get you in.' },
      { status: 502 },
    )
  }

  return NextResponse.json(OK)
}
