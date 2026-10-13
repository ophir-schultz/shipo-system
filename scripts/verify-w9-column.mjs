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
