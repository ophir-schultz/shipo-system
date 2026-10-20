import { NextResponse } from 'next/server'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import { claimRow } from '@/lib/partner-claims'
import { clientIp } from '@/lib/partner-terms-record'
import {
  BATCH_MAX_PER_DAY,
  batchFold,
  batchReceivedMessage,
  overBatchDailyCap,
  planBatch,
} from '@/lib/partner-batch'

export const dynamic = 'force-dynamic'

// ============================================================
// A partner pastes his whole book at once. Spec 2026-10-20 §3.
//
// ALL OR NOTHING, END TO END. §3.2: *"What must never happen is a
// partial accept. Taking the first 150 of 203 and answering 'Received'
// is Finding 1 wearing a different hat."* planBatch enforces that on the
// text; this handler enforces it on the database. There is no branch
// below that stores some rows and answers as though it stored all of
// them, and no branch that skips a row it could not build.
//
// WHY THE REFUSALS HERE MAY BE SPECIFIC, where the single-claim route's
// are all one sentence. That route conceals whether a company is known
// to Shipo (§3.2 of the 2026-10-13 spec) — any other answer turns the
// form into a lookup against the client list. Every refusal below is
// about the SHAPE OF HIS OWN REQUEST: too long, empty, a line that is
// not a company name, too many lists today. None of them depends on
// anything Shipo knows, and the route documents that exemption itself:
// *"A partner who submitted an empty form learns nothing about any
// company from being told the form was empty."*
//
// WHAT IS STILL NEVER CONCEALED is whether we stored it. Every failed
// write below is a 500. A partner told "Received" over a failed write
// has lost claims worth $300 each plus twelve months of share, and he
// will not re-send a list he watched succeed.
//
// NOTHING IS ATTRIBUTED HERE. Each row goes through claimRow's
// allow-list with `status: 'submitted'` and no `client_id`. Staff
// approve per client at POST /api/referrals/claims, which remains the
// only write that creates money — and §3.5 keeps bulk approve out of
// scope on purpose.
// ============================================================

/**
 * Bytes of request body we will read. 150 rows of four capped fields is
 * about 45KB, so this is ~20x headroom.
 *
 * Checked on content-length BEFORE the body is read: planBatch refuses a
 * 10,000-line paste, but only after something has pulled 10,000 lines
 * into memory.
 */
const BATCH_BODY_MAX = 1_000_000

/** Existing claims read for the dedupe. Far above the store ceiling. */
const EXISTING_SCAN_MAX = 2000

export async function POST(req: Request) {
  // FIRST, before the body is read, for the reason the single-claim
  // route documents: every step below needs a partner id, and
  // getPartnerFromSession re-asks portalAccessBlock so a partner
  // deactivated since login cannot file.
  const partner = await getPartnerFromSession()
  if (!partner) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BATCH_BODY_MAX) {
    return NextResponse.json(
      { error: 'That list is too large to send in one go. Please split it.' },
      { status: 413 },
    )
  }

  // Pasted text, or the text of a CSV the browser read for us. One code
  // path on purpose: multipart parsing here would be a second way to
  // reach the same planner, and the file is the partner's own export
  // either way — the client reads it and posts its contents.
  let raw = ''
  try {
    const contentType = req.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as { list?: unknown }
      raw = typeof body?.list === 'string' ? body.list : ''
    } else {
      raw = await req.text()
    }
  } catch {
    raw = ''
  }

  // ---- Rate limit: per BATCH, and failing closed ----
  //
  // §3.2 is explicit that this path must NOT consult CLAIM_DAILY_CAP or
  // CLAIM_STORE_CEILING. Those bound how many times a partner fills in
  // the single-claim form; a batch is one submission, and running a
  // 100-row first upload through a 5-per-day cap would flag or discard
  // 95 legitimate rows.
  //
  // Rolling 24 hours, like the single route: a calendar boundary hands
  // out a fresh allowance at midnight.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error: countError } = await supabaseAdmin
    .from('partner_claim_batches')
    .select('id', { count: 'exact', head: true })
    .eq('referral_partner_id', partner.id)
    .gte('created_at', since)

  if (countError) {
    // §3.2: "a count that errors refuses with a 500, because a write we
    // could not verify must never be reported as received." The usual
    // cause is this migration not being applied yet, and answering
    // "Received" over a missing table is the exact failure the
    // single-claim route was fixed for.
    console.error('[partner/claims/batch] count failed', countError.code, countError.message)
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  if (overBatchDailyCap(count ?? null)) {
    // Honest, unlike the single route's cap refusal — and a 429 rather
    // than a 200. There the identical response IS the concealment; here
    // the sentence is about how many lists HE has sent us today, which
    // says nothing about any company.
    return NextResponse.json(
      {
        error: `You have already sent us ${BATCH_MAX_PER_DAY} lists in the last 24 hours. Email Support@shipousa.com and we will take the rest from you directly.`,
      },
      { status: 429 },
    )
  }

  // ---- His own earlier claims, for the fold ----
  //
  // §3.3: the dedupe spans the batch AND the claims he has already
  // filed. Named column, never select('*'): a star here would carry
  // decision_note and client_id into this handler, and the single-claim
  // table's header says why that must not become routine.
  //
  // A READ WE COULD NOT DO IS A 500, not a batch filed without the
  // fold. Storing 150 rows that duplicate his existing claims puts
  // double rows on his own claims panel and a pile on the staff queue,
  // and he would have no way to tell that from a bug. A retry costs him
  // one click.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('partner_client_claims')
    .select('company_name')
    .eq('referral_partner_id', partner.id)
    .order('created_at', { ascending: false })
    .limit(EXISTING_SCAN_MAX)

  if (existingError) {
    console.error(
      '[partner/claims/batch] existing read failed for partner',
      partner.id,
      existingError.code,
      existingError.message,
    )
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  const existingFolded = (existing ?? [])
    .map((r) => (typeof r.company_name === 'string' ? batchFold(r.company_name) : ''))
    .filter((k) => k.length > 0)

  const plan = planBatch(raw, existingFolded)
  if (!plan.ok) {
    // All three reasons are shape facts about his paste, and the message
    // is written for him. 400 rather than 200: he has to change
    // something, and a success code over a stored-nothing answer is the
    // confusion this whole feature is shaped to avoid.
    return NextResponse.json({ error: plan.message }, { status: 400 })
  }

  if (plan.rows.length === 0) {
    // Every company was already on his claims. Nothing to write — and
    // deliberately NOT an empty batch row, which would hang a header
    // over zero claims on the staff queue. He still gets both numbers.
    return NextResponse.json({
      message: batchReceivedMessage(plan.rawCount, 0),
      pasted: plan.rawCount,
      kept: 0,
    })
  }

  const forwardedFor = req.headers.get('x-forwarded-for')

  // Build every row BEFORE writing anything. claimRow refuses a row with
  // no company name, which planBatch has already made impossible — but
  // if it ever happened, skipping the row would be the partial accept,
  // so the whole batch fails instead and nothing is stored.
  const claims: Record<string, unknown>[] = []
  for (const row of plan.rows) {
    const built = claimRow(partner.id, row, forwardedFor)
    if (!built.ok) {
      console.error(
        '[partner/claims/batch] planned row refused by claimRow for partner',
        partner.id,
        built.reason,
      )
      return NextResponse.json(
        { error: 'We could not record that — please try again.' },
        { status: 500 },
      )
    }
    claims.push(built.row)
  }

  const { data: batch, error: batchError } = await supabaseAdmin
    .from('partner_claim_batches')
    .insert({
      referral_partner_id: partner.id,
      row_count: plan.rows.length,
      submitted_raw_count: plan.rawCount,
      submitted_ip: clientIp(forwardedFor),
    })
    .select('id')
    .single()

  if (batchError || !batch?.id) {
    console.error(
      '[partner/claims/batch] batch insert failed for partner',
      partner.id,
      batchError?.code,
      batchError?.message,
    )
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  // One statement for all of them, so there is no partially-stored list.
  // The spread is of a row THIS FILE built from claimRow's allow-list,
  // never of anything off the network.
  const { error: claimsError } = await supabaseAdmin
    .from('partner_client_claims')
    .insert(claims.map((c) => ({ ...c, batch_id: batch.id })))

  if (claimsError) {
    console.error(
      '[partner/claims/batch] claim insert failed for partner',
      partner.id,
      claimsError.code,
      claimsError.message,
    )
    // The batch header would otherwise sit on the staff queue claiming
    // a row count it has no rows for. Best effort: if the delete also
    // fails, the log is the only record, and the partner still gets an
    // honest 500 rather than a "Received" over nothing.
    const { error: cleanupError } = await supabaseAdmin
      .from('partner_claim_batches')
      .delete()
      .eq('id', batch.id)
    if (cleanupError) {
      console.error(
        '[partner/claims/batch] orphan batch left behind',
        batch.id,
        cleanupError.code,
        cleanupError.message,
      )
    }
    return NextResponse.json(
      { error: 'We could not record that — please try again.' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    message: batchReceivedMessage(plan.rawCount, plan.rows.length),
    pasted: plan.rawCount,
    kept: plan.rows.length,
  })
}
