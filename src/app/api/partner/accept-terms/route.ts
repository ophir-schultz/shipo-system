import { NextResponse } from 'next/server'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import { PARTNER_TERMS_VERSION } from '@/lib/partner-terms'
import { acceptanceRow } from '@/lib/partner-terms-record'

export const dynamic = 'force-dynamic'

// ============================================================
// Records that a partner accepted the CURRENT terms. Spec §2.6.
//
// The one thing this route must never do is tell a partner "accepted"
// without a row to show for it. Every failure path below returns a
// non-200 for exactly that reason -- the table exists to answer "what
// text did this partner agree to, and when", and a cheerful 200 over a
// failed insert destroys the answer while looking like success.
//
// Session cookie only. The body is `{ version }` and nothing else: the
// version the CLIENT claims to be accepting, which is validated and
// then thrown away. The row records the version the SERVER was serving
// (see partner-terms-record.ts), so a stale tab cannot write a row
// claiming it accepted text we no longer show.
// ============================================================

export async function POST(req: Request) {
  // The CONTROL, not the gate. The gate is a render; this is a write,
  // and the partner's row can go inactive or voided in between.
  // getPartnerFromSession re-asks portalAccessBlock on every request,
  // so this one call covers both "is there a session" and "may this
  // person still use the portal".
  const partner = await getPartnerFromSession()
  if (!partner) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const { version } = (body ?? {}) as { version?: unknown }

  // A stale tab accepting last week's text is the failure this guards.
  // 409 and not 400: the request was well formed when the tab was
  // loaded, and the partner's correct next move is to reload and read
  // the text we are actually standing behind today.
  if (version !== PARTNER_TERMS_VERSION) {
    return NextResponse.json(
      { error: 'These terms have changed. Reload the page.' },
      { status: 409 },
    )
  }

  const { data: existing } = await supabaseAdmin
    .from('partner_terms_acceptances')
    .select('id')
    .eq('referral_partner_id', partner.id)
    .eq('terms_version', PARTNER_TERMS_VERSION)
    .limit(1)

  // Already recorded. Idempotent by §2.6, and the row is append-only:
  // a second acceptance of the same text is not a second fact.
  if (existing && existing.length > 0) {
    return NextResponse.json({ success: true })
  }

  const { error } = await supabaseAdmin
    .from('partner_terms_acceptances')
    .insert(
      acceptanceRow({
        partnerId: partner.id,
        forwardedFor: req.headers.get('x-forwarded-for'),
        userAgent: req.headers.get('user-agent'),
      }),
    )

  if (error) {
    // 23505 = unique_violation on partner_terms_acceptances_partner_version_idx.
    // The select above does not serialize, so a double-clicked Accept sends
    // two concurrent POSTs that both read "no acceptance yet" and both
    // insert. Rather than lock, the migration makes the duplicate
    // IMPOSSIBLE and this makes it HARMLESS: somebody else just recorded
    // the same partner accepting the same version, which is the success
    // this request was asking for.
    if (error.code === '23505') {
      return NextResponse.json({ success: true })
    }
    console.error(
      '[accept-terms] insert failed for partner',
      partner.id,
      error.code,
      error.message,
    )
    return NextResponse.json({ error: 'Could not record acceptance.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
