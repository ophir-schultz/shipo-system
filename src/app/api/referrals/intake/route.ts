import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { normalizeEmail, isEmail } from '@/lib/partner-auth'

// Public webhook: the shipousa.com Partner Program (Forminator) form
// POSTs each sign-up here. We insert the partner as `pending` so it
// shows up in the dashboard for Ophir to review — never auto-active,
// never triggers any payout.
//
// ── AUTH: why the shared secret is STILL optional ───────────────────
//
// REFERRAL_INTAKE_TOKEN is not set in production, so today the check
// below is skipped and this endpoint is an open write into
// referral_partners. That is known, and leaving it open is the lesser
// evil for now: the moment the token becomes mandatory in code, the
// live Forminator form starts receiving 401s and every genuine lead is
// dropped on the floor. A spam row in a review queue costs a click. A
// lost lead costs a client.
//
// Closing it properly takes two changes, and THE ORDER MATTERS:
//
//   1. FIRST, in wp-admin, append `?token=<secret>` to the webhook URL
//      on form 2074. While the env var is unset that parameter is
//      ignored, so this step is a no-op and cannot break anything.
//   2. THEN set REFERRAL_INTAKE_TOKEN in Vercel production to the same
//      secret and redeploy.
//
// Do it in the other order and intake is down for the gap between the
// two: every submission in that window 401s and is gone. Forminator
// keeps no failed-webhook payload we could replay, so there is nothing
// to recover afterwards.
//
// Until then the guards below keep the open window a nuisance rather
// than a free bulk-write primitive: a body-size cap, field length
// caps, email normalisation, and a ceiling on how many rows the form
// can create in a short window.

export const dynamic = 'force-dynamic'

/** Bodies larger than this are not sign-ups. Forminator sends ~1 KB. */
const MAX_BODY_BYTES = 64 * 1024

/** Identity fields. Anything longer is not a real name or company. */
const MAX_IDENTITY = 200

/**
 * The free-text "how will you refer sellers to us" answer. This one is
 * TRUNCATED rather than rejected: a partner who writes an essay should
 * still land in the queue, and the first 2,000 characters are more than
 * enough for Ophir to decide. Rejecting would throw away a real lead
 * over its own verbosity.
 */
const MAX_NARRATIVE = 2000

/** RFC 5321 caps an address at 254 characters. */
const MAX_EMAIL = 254

/**
 * How many rows the website form may create per window, across all
 * submitters.
 *
 * This is a GLOBAL cap, not per-IP, and that is deliberate: a per-IP
 * cap needs somewhere to record the IP, which means a migration that
 * has to be applied by hand before the deploy is safe. A global cap
 * needs no schema change — it counts rows that already carry `source`
 * and `created_at`.
 *
 * The number sits well above any plausible real burst. The program has
 * produced single-digit sign-ups per month; 20 in ten minutes has never
 * happened, and if it did it would itself be worth looking at.
 */
const MAX_SIGNUPS_PER_WINDOW = 20
const RATE_WINDOW_MINUTES = 10

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    for (const actual of Object.keys(obj)) {
      if (actual.toLowerCase().replace(/[^a-z]/g, '') === k) {
        const v = obj[actual]
        if (v != null && String(v).trim() !== '') return String(v).trim()
      }
    }
  }
  return null
}

/**
 * Length-check an identity field. `undefined` means "present but too
 * long to be real" — distinct from `null`, which means "not supplied".
 * The caller turns the first into a 400 and keeps the second.
 */
function identity(value: string | null, max = MAX_IDENTITY): string | null | undefined {
  if (value === null) return null
  return value.length > max ? undefined : value
}

export async function POST(req: Request) {
  // --- auth (active only once the secret is configured; see header) ---
  const expected = process.env.REFERRAL_INTAKE_TOKEN
  if (expected) {
    const url = new URL(req.url)
    const token = url.searchParams.get('token') || req.headers.get('x-intake-token')
    if (token !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else {
    // One line per submission in the Vercel log, naming the fix. An
    // open write endpoint should not be quiet about being open.
    console.warn(
      '[referrals/intake] accepting an UNAUTHENTICATED sign-up: ' +
        'REFERRAL_INTAKE_TOKEN is not set in this environment.',
    )
  }

  // --- size guard, before the body is read into memory ---
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Body too large.' }, { status: 413 })
  }

  // --- parse JSON or form-encoded bodies ---
  let parsed: unknown = {}
  const ct = req.headers.get('content-type') || ''
  try {
    if (ct.includes('application/json')) {
      parsed = await req.json()
    } else {
      const form = await req.formData()
      const collected: Record<string, unknown> = {}
      form.forEach((v, k) => {
        collected[k] = typeof v === 'string' ? v : ''
      })
      parsed = collected
    }
  } catch {
    return NextResponse.json({ error: 'Could not parse body.' }, { status: 400 })
  }

  // A JSON body may legally be an array, a bare string, a number or
  // null. `Object.keys(null)` throws, and the rest read as an object
  // with no usable keys, so settle the shape before reaching into it.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Expected a JSON object.' }, { status: 400 })
  }
  const data = parsed as Record<string, unknown>

  const name = identity(pick(data, ['fullname', 'name', 'firstname']))
  const company = identity(pick(data, ['company', 'companyname', 'business']))
  const phone = identity(pick(data, ['phone', 'phonenumber']), 50)
  const partner_type = identity(pick(data, ['partnertype', 'type']), 100)

  if (
    name === undefined ||
    company === undefined ||
    phone === undefined ||
    partner_type === undefined
  ) {
    return NextResponse.json(
      { error: 'A field is longer than this form allows.' },
      { status: 400 },
    )
  }

  const narrative = pick(data, [
    'howwillyourefersellerstous',
    'refermethod',
    'howwillyourefer',
    'message',
  ])
  const refer_method =
    narrative && narrative.length > MAX_NARRATIVE
      ? narrative.slice(0, MAX_NARRATIVE) + '… [truncated at intake]'
      : narrative

  // Lower-cased and trimmed before anything else touches it. The
  // de-dupe below is an equality match, so without this "A@x.com" and
  // "a@x.com" are two different partners. (Rows written before this
  // normalisation existed may still carry mixed case and will not
  // de-dupe against a new submission — that is a duplicate in the
  // review queue, not a payout error, and one click resolves it.)
  const rawEmail = pick(data, ['email', 'emailaddress'])
  const normalized = normalizeEmail(rawEmail)
  const emailValid = normalized !== '' && normalized.length <= MAX_EMAIL && isEmail(normalized)
  const email = emailValid ? normalized : null

  // A malformed address does not throw the lead away as long as there
  // is a name to follow up on — a typo is a human being who tried. With
  // neither a usable address nor a name there is nothing to act on.
  if (!email && !name) {
    return NextResponse.json(
      { error: 'Sign-up needs a valid email address or a name.' },
      { status: 400 },
    )
  }

  // --- ceiling on form-created rows ---
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString()
  const { count: recent, error: countErr } = await supabaseAdmin
    .from('referral_partners')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'website_form')
    .gte('created_at', since)

  // A failed COUNT is not a reason to refuse a genuine sign-up — that
  // would hand anyone who can break this one query the power to close
  // the form. Log it and carry on without the ceiling.
  if (countErr) {
    console.error('[referrals/intake] rate-ceiling count failed:', countErr.message)
  } else if ((recent ?? 0) >= MAX_SIGNUPS_PER_WINDOW) {
    console.warn(
      `[referrals/intake] rate ceiling hit: ${recent} website sign-ups in the ` +
        `last ${RATE_WINDOW_MINUTES} minutes.`,
    )
    return NextResponse.json(
      { error: 'Too many sign-ups right now. Please try again shortly.' },
      { status: 429 },
    )
  }

  // de-dupe by email when present
  if (email) {
    const { data: existing } = await supabaseAdmin
      .from('referral_partners')
      .select('id')
      .eq('email', email)
      .limit(1)
    if (existing && existing.length > 0) {
      return NextResponse.json({ success: true, deduped: true, id: existing[0].id })
    }
  }

  const { data: inserted, error } = await supabaseAdmin
    .from('referral_partners')
    .insert({
      // `name` is NOT NULL. When only a malformed address came through,
      // its raw text is the only identifying thing we have — better a
      // row Ophir can read and correct than no row at all.
      name: name ?? email ?? (rawEmail ? rawEmail.slice(0, MAX_IDENTITY) : 'Unnamed sign-up'),
      email,
      company,
      phone,
      partner_type,
      refer_method,
      status: 'pending',
      source: 'website_form',
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: inserted?.id })
}
