import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import { sendEmail } from '@/lib/email'

// Staff-side control of a partner's portal access.
//
// Body: { partner_id, action: 'invite' | 'signout' }
//
//   'invite'  — email the partner the portal address and tell them how
//               to sign in. This does NOT send a code and does NOT
//               create a session. The partner requests their own code
//               from the login screen, so nothing that arrives in this
//               email is a credential.
//   'signout' — revoke every live session for that partner.
//
// There is no "revoke access" action here on purpose: deactivating the
// partner in the Referrals screen already blocks every login and every
// existing session (see getPartnerFromSession).

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // /api/ is excluded from the proxy's auth redirect, so this route
  // guards itself. It touches partner access — it must never be
  // callable by an anonymous request.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const partner_id = (body as { partner_id?: string } | null)?.partner_id
  const action = (body as { action?: string } | null)?.action

  if (!partner_id || !action) {
    return NextResponse.json({ error: 'partner_id and action are required.' }, { status: 400 })
  }

  const { data: partner, error: partnerError } = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, email, status')
    .eq('id', partner_id)
    .maybeSingle()

  if (partnerError || !partner) {
    return NextResponse.json({ error: 'Partner not found.' }, { status: 404 })
  }

  if (action === 'signout') {
    const { error } = await supabaseAdmin
      .from('partner_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('referral_partner_id', partner.id)
      .is('revoked_at', null)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  }

  if (action !== 'invite') {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  if (!partner.email) {
    return NextResponse.json(
      { error: 'This partner has no email address. Add one first — the portal login is by email.' },
      { status: 400 },
    )
  }
  if (partner.status === 'inactive') {
    return NextResponse.json(
      { error: 'This partner is inactive, so they cannot sign in. Reactivate them first.' },
      { status: 400 },
    )
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    req.headers.get('origin') ??
    `https://${req.headers.get('host') ?? 'shipousa.com'}`
  const loginUrl = `${origin.replace(/\/$/, '')}/partner/login`
  const firstName = (partner.name ?? '').split(' ')[0] || 'there'

  const result = await sendEmail({
    to: partner.email,
    subject: 'Your Shipo partner statement is ready',
    text:
      `Hi ${firstName},\n\n` +
      `Your Shipo partner portal is now open. It shows every client you referred, ` +
      `the monthly figures on their account, and exactly what you have earned.\n\n` +
      `Sign in here: ${loginUrl}\n\n` +
      `There is no password. Enter this email address (${partner.email}) and we'll send you ` +
      `a 6-digit code to get in.\n\n` +
      `Questions about any figure? Just reply to this email.\n\n` +
      `Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 · Support@shipousa.com`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="margin:0 0 16px">Hi ${firstName},</p>` +
      `<p style="margin:0 0 16px">Your Shipo partner portal is now open. It shows every client you referred, the monthly figures on their account, and exactly what you have earned.</p>` +
      `<p style="margin:0 0 24px"><a href="${loginUrl}" style="display:inline-block;background:#00AAFF;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Open your statement</a></p>` +
      `<p style="margin:0 0 16px;color:#555">There is no password. Enter this email address (<strong>${partner.email}</strong>) and we&rsquo;ll send you a 6-digit code to get in.</p>` +
      `<p style="margin:0 0 24px;color:#555">Questions about any figure? Just reply to this email.</p>` +
      `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
      `<p style="margin:0;font-size:12px;color:#888">Shipo LLC &middot; 310 Cornell Dr, Suite B4, Wilmington, DE 19801 &middot; Support@shipousa.com</p>` +
      `</div>`,
  })

  if (!result.sent) {
    return NextResponse.json(
      { error: `Could not send the invite (${result.provider}). ${result.error ?? ''}`.trim() },
      { status: 502 },
    )
  }

  return NextResponse.json({ success: true, sentTo: partner.email })
}
