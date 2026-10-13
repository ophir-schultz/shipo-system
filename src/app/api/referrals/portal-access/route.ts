import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import { sendPortalInvite } from '@/lib/partner-invite'
import { portalAccessBlockedReason } from '@/lib/partner-access'

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
//
// 'invite' requires a signed agreement; 'signout' does not, and is checked
// first for that reason. Cutting someone off must never depend on their
// paperwork being in order — the one time you most need to end a session is
// when something has gone wrong with the relationship.

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
    .select('id, name, email, status, agreement_status')
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

  // The signed agreement comes BEFORE access. This is where that is true:
  // the Referrals screen greys the button out, but a greyed button is a
  // courtesy and this is a POST endpoint, so the rule is enforced here. The
  // conditions live in src/lib/partner-access.ts so the screen and this route
  // cannot drift into disagreeing about who is allowed in.
  const blocked = portalAccessBlockedReason(partner)
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 400 })
  }

  // The email itself lives in src/lib/partner-invite.ts and is NOT rebuilt
  // here. This route and the DocuSign webhook both invite partners, and the
  // two messages have to be indistinguishable: a partner who gets a
  // different-looking email depending on which path fired cannot tell the
  // automated one from a phishing attempt. This file used to hold a second
  // copy, which had already drifted — it carried the old
  // `https://shipousa.com` fallback that resolves to a 404.
  const result = await sendPortalInvite(partner, req.headers.get('origin'))

  if (!result.sent) {
    return NextResponse.json(
      { error: `Could not send the invite (${result.provider}). ${result.error ?? ''}`.trim() },
      { status: 502 },
    )
  }

  // Stamped only after a confirmed send, and deliberately not awaited into the
  // response's success: the email has already gone, so failing the request
  // because the bookkeeping write failed would invite a second send. The
  // webhook stamps the same column on the automatic path — if only one of the
  // two paths recorded it, the column would read as "never invited" for half
  // the partners who were.
  const { error: stampError } = await supabaseAdmin
    .from('referral_partners')
    .update({ portal_invited_at: new Date().toISOString() })
    .eq('id', partner.id)
  if (stampError) {
    console.error('[portal-access] invite sent but portal_invited_at not stamped:', stampError.message)
  }

  return NextResponse.json({ success: true, sentTo: partner.email })
}
