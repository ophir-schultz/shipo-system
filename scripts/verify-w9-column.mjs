// Does referral_partners.w9_received_at exist yet?
//
//   node --env-file=.env.local scripts/verify-w9-column.mjs
//
// src/app/referrals/page.tsx selects w9_received_at. The column was added by
// supabase/partner_w9.sql, and that file may or may not have been run against
// this database -- if it has not, the select fails and the ENTIRE staff
// Referrals screen 500s. Nothing in the app surfaces that as a schema problem;
// it reads as "the Referrals page is broken".
//
// A PostgREST select naming a column that does not exist returns 400 with
// code 42703, so the question is answerable without any DDL privilege and
// without reading pg_catalog. An empty result set is NOT the signal here --
// referral_partners being empty still returns 200 with [] when the column is
// present, which is exactly the state this check has to distinguish from a
// missing column.
//
// Named verify-, not probe-, deliberately: .gitignore ignores scripts/probe-*
// as one-off questions nobody maintains, and this one is meant to be re-run
// after supabase/portal_email_test_partner.sql (which carries the same
// `add column if not exists`) to confirm the paste actually landed.
//
// No secret is printed. The key is read from the environment and used only as
// a header.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

if (!url || !key) {
  console.log('Cannot check: NEXT_PUBLIC_SUPABASE_URL or the service role key is not set.')
  console.log('Run with: node --env-file=.env.local scripts/verify-w9-column.mjs')
  process.exit(2)
}

const headers = { apikey: key, Authorization: `Bearer ${key}` }

// WHICH database. A verdict of "the column is missing" is useless -- worse,
// actively misleading -- if the SQL was pasted into one project and this check
// read another. The project ref is the subdomain of the Supabase URL and is not
// a secret (it is NEXT_PUBLIC_), it is the same ref that appears in the SQL
// editor URL, so print it and let the two be compared by eye.
const ref = new URL(url).hostname.split('.')[0]
console.log(`project  ${ref}`)
console.log(`         SQL editor: https://supabase.com/dashboard/project/${ref}/sql/new`)

// WHO is reading. A row count of 0 from an UNDER-privileged key is not a
// measurement, it is RLS working as designed -- referral_partners with RLS on
// and no anon policy returns [] to a non-service key whether or not rows
// exist. So "referral_partners is EMPTY" can only be asserted by a reader
// that bypasses RLS, and that had been assumed rather than checked.
//
// A Supabase key is a JWT; the middle segment is base64url JSON carrying a
// `role` claim. Decoding it is not reading a secret out -- only the role name
// is printed, never the token, and the signature is neither verified nor
// shown. The point is that the script states its own authority instead of
// leaving the reader to infer it from a variable name, since
// SUPABASE_SERVICE_KEY is a name, not a guarantee of what is in it.
let role = 'unknown'
try {
  const seg = key.split('.')[1]
  role = JSON.parse(Buffer.from(seg, 'base64url').toString()).role ?? 'absent'
} catch {
  role = 'unparseable (not a JWT?)'
}
console.log(`reader   role=${role}`)
if (role !== 'service_role') {
  console.log('         !! NOT service_role. Row COUNTS from this key are not evidence:')
  console.log('         !! RLS can return [] for a populated table. The column check below')
  console.log('         !! is still valid -- 42703 is a parse error and RLS cannot cause it.')
}
console.log()

// A control first. If a column that certainly does not exist returns the same
// status as w9_received_at, this check cannot tell the two apart and its
// verdict is worthless -- so prove the discrimination before trusting it.
const control = await fetch(
  `${url}/rest/v1/referral_partners?select=zzz_control_must_not_exist&limit=1`,
  { headers },
)
if (control.ok) {
  console.log('CONTROL FAILED: a nonexistent column returned HTTP', control.status)
  console.log('This check cannot distinguish present from missing. Verdict withheld.')
  process.exit(1)
}
console.log(`control  zzz_control_must_not_exist -> HTTP ${control.status} (missing is detectable)`)

const res = await fetch(`${url}/rest/v1/referral_partners?select=w9_received_at&limit=1`, {
  headers,
})
console.log(`actual   w9_received_at             -> HTTP ${res.status}`)

if (res.ok) {
  console.log('\nVERDICT: w9_received_at EXISTS. /referrals will not 500 on this column.')
  process.exit(0)
}

const body = await res.text()
console.log(`         ${body.slice(0, 300)}`)
console.log('\nVERDICT: w9_received_at is MISSING. The staff Referrals screen 500s.')
console.log('         Fix: run supabase/partner_w9.sql, or the first statement of')
console.log('         supabase/portal_email_test_partner.sql, which carries the same')
console.log('         `alter table referral_partners add column if not exists`.')
process.exit(1)
