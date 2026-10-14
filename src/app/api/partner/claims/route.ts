import { NextResponse } from 'next/server'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import { CLAIM_RECEIVED, CLAIM_STORE_CEILING, claimAdmission, claimRow } from '@/lib/partner-claims'

export const dynamic = 'force-dynamic'

// ============================================================
// A partner claims a client he says he referred. Spec §3.1-§3.3.
//
// TWO RULES THAT POINT IN OPPOSITE DIRECTIONS, and the wrong instinct is
// to make them agree:
//
//   CONCEAL whether the company is known to Shipo.
//   NEVER CONCEAL whether we stored the claim.
//
// The first is §3.2: the response is the same sentence whether the
// company is new, is already a Shipo client, or was already claimed by
// another partner. Anything else turns this form into a lookup against
// Shipo's client list and lets a partner enumerate the customer base one
// guess at a time.
//
// The second is why a failed insert is a 500 and not a cheerful
// "Received". A partner told "received" over a failed write has silently
// lost a claim worth $300 plus twelve months of share, and he has no way
// to find out — he will not resubmit something he watched succeed.
//
// NOTHING IS ATTRIBUTED HERE. The insert carries no `client_id`: see
// claimRow, which builds the row by allow-list so a body carrying a real
// client's uuid or `status: 'approved'` cannot reach the table. Approval
// is a staff action (§3.4) and it is the only thing that attributes
// money.
// ============================================================

export async function POST(req: Request) {
  // THE CONTROL, not the gate (Review Focus 5). The dashboard form is a
  // render and a render stops nobody with curl. getPartnerFromSession
  // re-asks portalAccessBlock on every request, so this one call answers
  // both "is there a session" and "may this person still use the portal"
  // — a partner deactivated or voided since login cannot file a claim.
  //
  // FIRST, before the body is read, because every step below takes a
  // partner id: the cap count would otherwise count nobody's claims and
  // the insert would have no owner.
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

  // ---- The cap, counted server-side, failing CLOSED ----
  //
  // Rolling 24 hours rather than a calendar day: a calendar boundary
  // hands out a fresh allowance at midnight and a scripted submitter
  // would simply wait for it.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await supabaseAdmin
    .from('partner_client_claims')
    .select('id', { count: 'exact', head: true })
    .eq('referral_partner_id', partner.id)
    .gte('created_at', since)

  // A COUNT WE COULD NOT READ IS NOT A CAP REFUSAL, and conflating the
  // two was this route's worst bug. `overDailyCap(null)` is true and that
  // is right — a ceiling that cannot be measured must refuse — but the
  // refusal below is deliberately INDISTINGUISHABLE from success (§3.2),
  // so "the claims table does not exist" came out as "Received." over a
  // claim that was never stored, and the statement's claims panel then
  // told him not to re-send it. He loses $300 plus twelve months of
  // share and never finds out.
  //
  // §3.2 is not weakened by answering 500 here. A 500 says OUR WRITE
  // FAILED — the same thing the failed-insert path below says, and the
  // one thing we must never conceal. It says nothing about whether any
  // company is a Shipo client, which is all §3.2 is about.
  if (countError) {
    console.error('[partner/claims] cap count failed', countError.code, countError.message)
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  // §3.2: "if the count query errors, refuse the submission." The error
  // is handled above; this is the cap itself. `count ?? null` still
  // reaches the decision as null if supabase ever answers neither an
  // error nor a number — do NOT copy /api/referrals/intake, whose
  // ceiling fails OPEN on a failed COUNT. That is a judgement about a
  // public WordPress form, and this is a claim on $300 plus twelve
  // months of commission.
  //
  // REFUSE AND RECORD, NOT REFUSE AND DISCARD. The cap was doing two
  // jobs with one answer: §3.2's concealment, which the identical
  // response does, and flood protection, which the discard did. Only the
  // second needed the row thrown away — so claims past the cap are
  // STORED AND FLAGGED and only CLAIM_STORE_CEILING stops keeping them.
  // Before this, claim six in a rolling day was destroyed while the
  // partner read "Received." and his claims panel told him nothing he
  // submitted had been discarded. See claimAdmission.
  const admission = claimAdmission(count ?? null)

  if (admission === 'discard') {
    // 200 AND THE SAME SENTENCE. Not a 429: a distinguishable rate-limit
    // response is itself a signal — it tells a script that it is being
    // counted, without it needing to read the body. The refusal is
    // recorded in the log instead, where only staff can see it.
    //
    // This is the ONE path that answers without writing, and it is
    // reached only above the ceiling — far past anything a person files
    // by hand.
    console.warn(
      '[partner/claims] discarded above the store ceiling for partner',
      partner.id,
      `count ${count} >= ${CLAIM_STORE_CEILING}`,
    )
    return NextResponse.json({ message: CLAIM_RECEIVED })
  }

  if (admission === 'flag') {
    // Logged distinctly from the discard above, because the two causes
    // that reach here are different facts: over the allowance, or a count
    // that came back as neither an error nor a number. The stored row
    // carries one boolean for both — it means "do not read this as an
    // ordinary claim" — and the log is where the cause lives.
    console.warn(
      '[partner/claims] over the daily cap, storing flagged for partner',
      partner.id,
      `count ${count ?? 'unreadable'}`,
    )
  }

  // ---- Shape ----
  //
  // This response MAY differ from the others, because it is about the
  // request's shape and not about Shipo's client list. A partner who
  // submitted an empty form learns nothing about any company from being
  // told the form was empty.
  const built = claimRow(
    partner.id,
    (body ?? {}) as Record<string, unknown>,
    req.headers.get('x-forwarded-for'),
    admission === 'flag',
  )
  if (!built.ok) {
    return NextResponse.json(
      { error: 'Please give the company name of the client you referred.' },
      { status: 400 },
    )
  }

  const { error } = await supabaseAdmin.from('partner_client_claims').insert(built.row)

  if (error) {
    // The partner id and the Postgres code, and NOT the typed company
    // name: a claim is a partner telling us he dealt with a company, and
    // the log is read by whoever is debugging rather than by whoever is
    // allowed to know that.
    console.error('[partner/claims] insert failed for partner', partner.id, error.code, error.message)
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({ message: CLAIM_RECEIVED })
}
