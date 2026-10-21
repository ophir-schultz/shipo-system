// Read-only: which of the four pending partner migrations actually applied?
//
// Four SQL files are written, committed, and applied BY HAND in the Supabase
// editor. Nothing sequences them against a deploy, so the code can reach
// production before its tables do — and three of the four were in the state
// "nobody knows", which is worse than "missing" because a missing table at
// least produces a symptom somebody reports.
//
//   supabase/partner_client_claims.sql   -> partner_client_claims
//   supabase/partner_claim_batches.sql   -> partner_claim_batches + claims.batch_id
//   supabase/partner_order_units.sql     -> partner_order_units (a VIEW)
//   supabase/partner_login_link.sql      -> partner_login_codes.link_token_hash
//                                           partner_login_codes.link_expires_at
//
// WHAT THIS CAN AND CANNOT SEE, stated up front so a green run is not read as
// more than it is. PostgREST answers "does this relation exist" and "does this
// column exist" exactly, and it answers "can anon read this" by being asked
// with the anon key. It CANNOT see indexes, whether RLS is enabled, or whether
// a column is nullable. Those four questions need the SQL editor and live in
// supabase/partner_unblock_2026_10_21.sql PART D. This script closes the
// question that matters first — is the object there at all — without needing
// anybody to paste anything.
//
// Nothing here writes. Run:
//   node --env-file=.env.local scripts/verify-pending-migrations.mjs

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !service) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

// Does not exist and must never exist. Green here means the probe cannot see
// absence, and then every PASS below is a sentence that would print whether or
// not anything had been applied. Borrowed from verify-partner-ledger.mjs,
// where the same control caught a throwaway preview certifying a table that
// did not exist.
const CONTROL = 'zzz_control_must_not_exist'

let failures = 0
let unknowns = 0

function pass(msg) { console.log(`PASS     ${msg}`) }
function fail(msg) { console.log(`MISSING  ${msg}`); failures++ }
function unknown(msg) { console.log(`UNKNOWN  ${msg}`); unknowns++ }

// Any 2xx. A request carrying `Range: 0-0` answers 206 whenever the relation
// holds more rows than the range asked for, and 200 only when it is EMPTY —
// so `status === 200` means "empty", not "readable", and reads backwards on
// exactly the tables that have data. verify-partner-ledger.mjs reported both
// populated tables as unreadable that way.
const readable = (status) => status >= 200 && status < 300

async function q(key, path, extraHeaders = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...extraHeaders },
  })
  let body = null
  try { body = await res.json() } catch { /* empty body is fine */ }
  return { status: res.status, body, range: res.headers.get('content-range') }
}

// Asks for a real row, never a HEAD/count. A HEAD request returns no body, so
// PostgREST's 42P01 never reaches the caller and a MISSING relation renders
// identically to an EMPTY one.
async function relation(name) {
  const r = await q(service, `${name}?select=*&limit=1`, { Prefer: 'count=exact', Range: '0-0' })
  return {
    exists: readable(r.status),
    status: r.status,
    count: readable(r.status) ? Number(r.range?.split('/')[1] ?? 0) : null,
    code: r.body?.code ?? '',
    detail: r.body?.code ? `${r.body.code}: ${r.body.message ?? ''}` : '',
  }
}

// A column, asked for BY NAME. An unselected column is the failure this whole
// family of bugs is made of: PostgREST answers 42703 for a column that is not
// there, and an absent column read through the app arrives as `undefined` —
// which every caller downstream reads as "not recorded" rather than "we never
// asked".
async function column(table, col) {
  const r = await q(service, `${table}?select=${col}&limit=1`)
  return {
    exists: readable(r.status),
    status: r.status,
    code: r.body?.code ?? '',
    detail: r.body?.code ? `${r.body.code}: ${r.body.message ?? ''}` : '',
  }
}

// ---- 0. can this script see absence at all ---------------------------
console.log('--- control ---')
const control = await relation(CONTROL)
let trustworthy = true
if (control.exists) {
  trustworthy = false
  fail(
    `the control relation ${CONTROL} READ BACK (HTTP ${control.status}). It does not ` +
      'exist, so this probe cannot tell a missing table from an empty one and NOTHING ' +
      'below is evidence. Fix the probe before believing any other line.',
  )
} else {
  pass(`control ${CONTROL} is absent (HTTP ${control.status}) — absence is visible to this probe`)
}

// ---- 1. partner_client_claims ---------------------------------------
// Confirmed missing from the live /referrals screen on 2026-10-20 ("Could not
// read the claims queue"). This is the one that must land before the claims
// route is reachable: with no table the insert fails, and the route's daily
// cap is built to REFUSE AND RECORD — with nothing to record into, a refusal
// becomes a discard behind the word "Received."
console.log('\n--- partner_client_claims (supabase/partner_client_claims.sql) ---')
const claims = await relation('partner_client_claims')
if (!claims.exists) {
  fail(`partner_client_claims is ABSENT (HTTP ${claims.status}) ${claims.detail}`)
  fail('  -> a filed claim is stored NOWHERE. Apply PART A before the claims route ships.')
} else {
  pass(`partner_client_claims exists — ${claims.count} row(s)`)
  for (const c of ['over_cap', 'client_id', 'decision_note', 'submitted_ip']) {
    const r = await column('partner_client_claims', c)
    if (r.exists) pass(`  column ${c}`)
    else fail(`  column ${c} is ABSENT ${r.detail}`)
  }
}

// ---- 2. partner_claim_batches ---------------------------------------
console.log('\n--- partner_claim_batches (supabase/partner_claim_batches.sql) ---')
const batches = await relation('partner_claim_batches')
if (!batches.exists) {
  fail(`partner_claim_batches is ABSENT (HTTP ${batches.status}) ${batches.detail}`)
  fail('  -> the batch route 500s. A partner pasting a list of companies meets an error page.')
} else {
  pass(`partner_claim_batches exists — ${batches.count} row(s)`)
}

// batch_id lives on the CLAIMS table and is the compatibility hinge: null
// means "filed one at a time", which is every claim written before the batch
// route existed. Checked separately from the batches table because the two
// halves of that migration can land independently.
if (claims.exists) {
  const bid = await column('partner_client_claims', 'batch_id')
  if (bid.exists) pass('  partner_client_claims.batch_id')
  else fail(`  partner_client_claims.batch_id is ABSENT ${bid.detail} -> the batch insert cannot attribute its rows`)
} else {
  unknown('  partner_client_claims.batch_id — the claims table is absent, so this is unanswerable')
}

// ---- 3. partner_order_units (a VIEW) --------------------------------
// The loudest of the four: the activity view and the CSV report 503 outright
// without it. Also the safest, because it carries NO MONEY COLUMN at all by
// construction — no future component can leak a figure that is not in it.
console.log('\n--- partner_order_units (supabase/partner_order_units.sql) ---')
const units = await relation('partner_order_units')
if (!units.exists) {
  fail(`partner_order_units is ABSENT (HTTP ${units.status}) ${units.detail}`)
  fail('  -> /partner/activity and the CSV report answer 503 until PART C is applied.')
} else {
  pass(`partner_order_units exists — ${units.count} row(s)`)
  // The view joins orders to clients to partners. An open grant on it is
  // cross-partner visibility, so ask the database with the anon key rather
  // than trusting the revoke in the file: a stray grant or an
  // `alter default privileges` re-opens it with nobody editing that SQL.
  if (!anon) {
    unknown('  NEXT_PUBLIC_SUPABASE_ANON_KEY absent — could not check the view is closed to anon')
  } else {
    const r = await q(anon, 'partner_order_units?select=*&limit=1')
    if (readable(r.status) && Array.isArray(r.body)) {
      fail(`  anon CAN READ partner_order_units (${r.body.length} row(s)) — the revoke did not take. This is every referred client's orders.`)
    } else {
      pass(`  anon is refused on partner_order_units (HTTP ${r.status})`)
    }
  }
}

// ---- 4. partner_login_link ------------------------------------------
// The one that degrades QUIETLY, which makes it the worst to leave unknown.
// src/lib/partner-signin-email.ts catches PostgREST 42703 on purpose and sends
// a code-only email rather than failing — correct behaviour, and it means the
// absence of these two columns produces no error anywhere. The email just
// carries no one-click link and nobody finds out.
console.log('\n--- partner_login_link (supabase/partner_login_link.sql) ---')
const codes = await relation('partner_login_codes')
if (!codes.exists) {
  fail(`partner_login_codes itself is ABSENT (HTTP ${codes.status}) ${codes.detail} — apply supabase/partner_login.sql first`)
} else {
  for (const c of ['link_token_hash', 'link_expires_at']) {
    const r = await column('partner_login_codes', c)
    if (r.exists) pass(`  partner_login_codes.${c}`)
    else fail(`  partner_login_codes.${c} is ABSENT ${r.detail} -> sign-in emails carry no link, SILENTLY`)
  }
}

// ---- 5. is there anybody to test any of this with --------------------
// Not a migration, and the thing that blocks every partner-facing check
// regardless of which tables exist. referral_partners read 0 rows on
// 2026-10-20: with no partner row, /api/partner/request-code answers its
// uniform OK for every address by design, so the whole portal is untestable
// end to end no matter how much of the schema is in place.
console.log('\n--- is the portal testable at all ---')
const partners = await relation('referral_partners')
if (!partners.exists) {
  fail(`referral_partners is UNREADABLE (HTTP ${partners.status}) ${partners.detail}`)
} else if (partners.count === 0) {
  fail('referral_partners has 0 rows — nobody can sign in, so no partner-facing path can be exercised')
} else {
  pass(`referral_partners has ${partners.count} row(s)`)
}

// ---- summary ---------------------------------------------------------
console.log('\n--- what this run did NOT check ---')
console.log('  indexes, RLS enabled/no-policies, and column nullability are invisible to')
console.log('  PostgREST. Run PART D of supabase/partner_unblock_2026_10_21.sql in the SQL')
console.log('  editor for those four. A green run here is "the objects exist", not "applied')
console.log('  correctly".')

if (!trustworthy) {
  console.log('\nCONTROL FAILED — the probe cannot see absence. Read nothing above as a result.')
  process.exit(1)
}
console.log(
  failures === 0
    ? `\nALL PRESENT${unknowns ? ` (${unknowns} unanswerable)` : ''}`
    : `\n${failures} MISSING${unknowns ? `, ${unknowns} unanswerable` : ''}`,
)
process.exit(failures === 0 ? 0 : 1)
