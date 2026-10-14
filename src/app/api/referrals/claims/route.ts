import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff, staffEmail } from '@/lib/require-staff'
import {
  approvalConflict,
  CLAIM_NOTE_MAX,
  needsAttribution,
  reattributionConflict,
  type ClaimStatus,
} from '@/lib/partner-claims'

export const dynamic = 'force-dynamic'

// ============================================================
// The staff claims queue. Spec §3.4.
//
// APPROVAL IS THE SINGLE WRITE THAT CREATES MONEY in this whole plan.
// Everything a partner can do is a request; this is the decision. It
// sets `clients.referral_partner_id`, and that column is what makes
// $300 plus twelve months of 5% of net profit payable.
//
// STAFF-AUTHENTICATED BY ITS OWN CALL. src/proxy.ts excludes `api/`
// from its matcher — nothing under src/app/api is authenticated by it —
// so `requireStaff()` is the only thing standing between this handler
// and the internet. Do not remove it on the belief that the proxy has
// it covered: it does not, and the comment in src/proxy.ts says so.
//
// A HUMAN ACT WITH A NAME ATTACHED. Every decision stamps `decided_by`
// (the signed-in employee's email) and `decided_at`. A decision with no
// name on it is an approval nobody made, and this one moves money.
//
// NOTHING HERE IS REACHABLE BY A PARTNER. The resemblance hints the
// queue shows are built in the component from the staff screen's own
// reads; `decision_note` is written here and never selected on a
// partner path (see src/components/partner/Statement.tsx).
// ============================================================

type Decision = 'approve' | 'reject' | 'duplicate'

const DECISIONS: readonly Decision[] = ['approve', 'reject', 'duplicate']

function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

/**
 * The claim as this route needs it. Columns named, never '*'.
 *
 * `client_id` is here because a SECOND approval has to be able to see the
 * FIRST. Without it the route could not tell a fresh approval from one
 * re-pointed at a different client, and the client named the first time
 * kept this partner's id forever — see reattributionConflict.
 */
const CLAIM_COLUMNS = 'id, referral_partner_id, company_name, status, client_id, created_at'

/**
 * GET — the queue. Submitted first and newest first, which is the index
 * in supabase/partner_client_claims.sql.
 *
 * Staff MAY see decision_note (§3.3 says it must never reach the PARTNER
 * surface), so it is selected here and nowhere under /partner or
 * /api/partner.
 */
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const { data, error } = await supabaseAdmin
    .from('partner_client_claims')
    .select(
      // `over_cap` is here because it is the whole reason the row was
      // kept: the submission route stores claims past the daily cap
      // instead of destroying them, and a flag nobody selects is the same
      // loss as the discard arriving one step later.
      'id, referral_partner_id, company_name, website, contact_name, contact_email, note, status, client_id, decided_by, decided_at, decision_note, over_cap, created_at',
    )
    .order('created_at', { ascending: false })

  if (error) {
    // Named rather than swallowed: an empty queue and an unreadable
    // queue look identical on screen, and the second one means claims
    // are piling up unseen.
    console.error('[referrals/claims] queue read failed', error.code, error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ claims: data ?? [] })
}

/**
 * POST — decide one claim.
 *
 * Body: `{ claim_id, decision: 'approve' | 'reject' | 'duplicate',
 *          client_id?, decision_note? }`
 *
 * `client_id` is required for an approval and is the STAFF's choice of
 * which real client the typed company name refers to. It is deliberately
 * not derived from `company_name`: a name match is a guess, and a guess
 * here attributes somebody's money. §3.1 — the typed name is a request,
 * the foreign key is the decision.
 */
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const claimId = typeof body.claim_id === 'string' ? body.claim_id.trim() : ''
  if (!claimId) {
    return NextResponse.json({ error: 'claim_id is required.' }, { status: 400 })
  }
  if (!isDecision(body.decision)) {
    return NextResponse.json(
      { error: `decision must be one of ${DECISIONS.join(', ')}.` },
      { status: 400 },
    )
  }
  const decision: Decision = body.decision

  const note =
    typeof body.decision_note === 'string' && body.decision_note.trim().length > 0
      ? body.decision_note.trim().slice(0, CLAIM_NOTE_MAX)
      : null

  // ---- Read the claim. It carries the partner we would be crediting ----
  //
  // From the TABLE, never from the request body. A claim_id plus a
  // referral_partner_id in the same body would let a mistyped field
  // credit the wrong partner, and the row already knows the answer.
  const { data: claim, error: claimError } = await supabaseAdmin
    .from('partner_client_claims')
    .select(CLAIM_COLUMNS)
    .eq('id', claimId)
    .maybeSingle()

  if (claimError) {
    console.error('[referrals/claims] claim read failed', claimError.code, claimError.message)
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }
  if (!claim) {
    return NextResponse.json({ error: 'That claim no longer exists.' }, { status: 404 })
  }

  const decidedBy = await staffEmail()
  const stamp = {
    decided_by: decidedBy,
    decided_at: new Date().toISOString(),
    decision_note: note,
  }

  // ---- reject / duplicate: a status and a note, no attribution ----
  //
  // Both are told to the partner as "not approved" and nothing else
  // (see claimPartnerState) — `duplicate` IS a reason, and a reason on
  // his screen is the §3.2 leak by another door. The distinction is kept
  // in the table because staff need it; it just never travels.
  if (decision !== 'approve') {
    const { error } = await supabaseAdmin
      .from('partner_client_claims')
      .update({ status: decision, ...stamp })
      .eq('id', claimId)

    if (error) {
      console.error('[referrals/claims] decision write failed', error.code, error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, status: decision })
  }

  // ---- approve: the write that creates money ----

  const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : ''
  if (!clientId) {
    // Not derivable from the typed company name. A name match is a
    // guess; this attribution is not a thing to guess at.
    return NextResponse.json(
      { error: 'Choose which client this claim refers to before approving it.' },
      { status: 400 },
    )
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id, name, referral_partner_id')
    .eq('id', clientId)
    .maybeSingle()

  if (clientError) {
    console.error('[referrals/claims] client read failed', clientError.code, clientError.message)
    return NextResponse.json({ error: clientError.message }, { status: 500 })
  }
  if (!client) {
    return NextResponse.json({ error: 'That client no longer exists.' }, { status: 404 })
  }

  // THE CONFLICT CHECK COMES BEFORE EVERY WRITE, including the claim's
  // own status. §3.4: "must raise a conflict, not silently re-point the
  // row." A 409 that had already marked the claim approved would leave
  // a row saying a decision was made that was not.
  const conflict = approvalConflict({
    claimPartnerId: claim.referral_partner_id as string,
    client: client as { id: string; referral_partner_id: string | null },
  })
  if (conflict) {
    console.warn('[referrals/claims] approval refused by conflict', claimId, clientId)
    return NextResponse.json({ error: conflict }, { status: 409 })
  }

  // AND THE CONFLICT THE CHECK ABOVE CANNOT SEE: this claim was already
  // approved against a DIFFERENT client, and that client still carries
  // this partner's id. approvalConflict is asked only about the client
  // named this time, which is unattributed, so it says yes. Approving
  // would leave two clients attributed to one referral.
  const stranded = reattributionConflict({
    status: claim.status as ClaimStatus,
    existingClientId: (claim.client_id as string | null) ?? null,
    clientId,
  })
  if (stranded) {
    console.warn('[referrals/claims] approval refused — would strand an earlier one', claimId)
    return NextResponse.json({ error: stranded }, { status: 409 })
  }

  // ATTRIBUTION FIRST, then the claim's status.
  //
  // There is no transaction available through this client, so the order
  // is chosen by which half-written state is recoverable. Attribution
  // without a status means a claim that still reads "under review" on
  // the partner's screen while his commission has started — visible to
  // staff in the queue, and correctable by deciding it again. The
  // reverse — a claim marked approved with no attribution — tells the
  // partner he has been credited when he has not, and nothing on any
  // screen contradicts it.
  // SKIPPED when the column already names exactly this partner, which is
  // the idempotent half of the recovery path the 500 below promises: the
  // write carries `.is(..., null)` and would now correctly refuse a row
  // it already set.
  if (needsAttribution(claim.referral_partner_id as string, client as { referral_partner_id: string | null })) {
    // `.is('referral_partner_id', null)` IS THE CONFLICT CHECK, RUN AT
    // THE WRITE. The check above ran against a row read moments earlier.
    // Two employees working the queue at once both read the column as
    // null, both pass the check, and the second update silently moves the
    // commission the first one created — the §3.4 failure arriving
    // through a window the check cannot close.
    //
    // So the update matches only while the column is still blank, and
    // `.select('id')` is what lets us tell "wrote it" from "matched
    // nothing". A write that matched nothing is not an error: it is the
    // 409 the check would have returned had it seen the row as it is now.
    const { data: linked, error: linkError } = await supabaseAdmin
      .from('clients')
      .update({ referral_partner_id: claim.referral_partner_id })
      .eq('id', clientId)
      .is('referral_partner_id', null)
      .select('id')

    if (linkError) {
      console.error('[referrals/claims] attribution write failed', linkError.code, linkError.message)
      return NextResponse.json(
        { error: 'Could not attribute the client. Nothing was changed on the claim.' },
        { status: 500 },
      )
    }

    if (!linked || linked.length === 0) {
      console.warn('[referrals/claims] attribution lost a race', claimId, clientId)
      return NextResponse.json(
        {
          error:
            'Somebody attributed this client while you were deciding. Nothing was changed. Reload the queue and look at it again.',
        },
        { status: 409 },
      )
    }
  }

  const { error: statusError } = await supabaseAdmin
    .from('partner_client_claims')
    .update({ status: 'approved', client_id: clientId, ...stamp })
    .eq('id', claimId)

  if (statusError) {
    // Says exactly what happened, because the two halves are now out of
    // step and whoever reads this log is the person who can fix it.
    console.error(
      '[referrals/claims] claim approved and client attributed, but the claim status write failed',
      claimId,
      clientId,
      statusError.code,
      statusError.message,
    )
    return NextResponse.json(
      {
        error:
          'The client was attributed but the claim could not be marked approved. Approve it again to finish — re-approving the same partner is not a conflict.',
      },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true, status: 'approved', client_id: clientId })
}
