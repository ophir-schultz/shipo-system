// Is the throwaway portal fixture actually on file, and is it safe?
//
//   npx tsx --env-file=.env.local scripts/verify-fixture-partner.mjs
//
// Reads referral_partners from outside the SQL editor and prints what is
// really there. Written because the editor reported one row from
// supabase/portal_email_test_partner.sql while scripts/verify-partner-ledger.mjs
// reported referral_partners EMPTY, and those cannot both be right.
//
// WHY NOT JUST TRUST THE LEDGER SCRIPT
// ------------------------------------
// It infers emptiness from the status of a `Range: 0-0` request: PostgREST
// answers 206 when the table holds more rows than the requested range and 200
// when the range covers everything. That is sound for 0 rows and for many
// rows, and WRONG for exactly one -- a single row satisfies 0-0 completely, so
// it answers 200 and reads as EMPTY. The fixture is a one-row table by
// construction, which is precisely the case the inference cannot see.
//
// So this asks for the count instead of deducing it. `Prefer: count=exact`
// puts the true total in Content-Range as `0-N/TOTAL`, which is an answer
// rather than an inference.
//
// WHAT IT CHECKS BEYOND EXISTENCE
// -------------------------------
// The row only earns its keep if it can actually sign in, and it is only safe
// if it owes nobody money. Both are checked, because "the row exists" is not
// the question anyone cares about:
//
//   - the access gate in src/lib/partner-access.ts, reimplemented here against
//     the real values, so the answer is "it will be refused a code, and here is
//     which branch refuses it" rather than a row dump to squint at;
//   - clients attributed, which MUST be zero. A client pointing at this
//     partner means a real commission obligation -- 5% of net profit for 12
//     months plus a $300 bonus -- attached to a row whose whole justification
//     is that it represents nobody.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.log('Cannot check: NEXT_PUBLIC_SUPABASE_URL or the service role key is not set.')
  process.exit(2)
}

const ref = new URL(url).hostname.split('.')[0]
let role = 'unknown'
try {
  role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role ?? 'absent'
} catch {
  role = 'unparseable'
}
console.log(`project ${ref}   reader role=${role}`)
if (role !== 'service_role') {
  console.log('!! NOT service_role -- RLS can hide rows and a count of 0 would prove nothing.')
}
console.log()

const headers = { apikey: key, Authorization: `Bearer ${key}` }

const res = await fetch(`${url}/rest/v1/referral_partners?select=*`, {
  headers: { ...headers, Prefer: 'count=exact' },
})
if (!res.ok) {
  console.log(`FAILED to read referral_partners: HTTP ${res.status}`)
  console.log(await res.text())
  process.exit(1)
}

// `0-4/5`, or `*/0` when there is nothing at all.
const total = (res.headers.get('content-range') || '').split('/')[1] ?? '?'
const rows = await res.json()
console.log(`referral_partners: ${total} row(s) (exact count, not inferred)`)

if (!rows.length) {
  // An empty table returns [] with no keys, so `select=*` says nothing about
  // which columns exist -- and the next move is to hand someone an INSERT,
  // which fails outright if it names a column that is not there.
  // portal_email_test_partner.sql sets agreement_status in a SEPARATE update
  // specifically because it was unsure the column existed, so the uncertainty
  // is real and worth settling before writing another statement against it.
  // Each column is asked for by name: 200 means present, 42703 means absent.
  console.log('Table is empty, so `select=*` reveals no columns. Asking for each by name:')
  const wanted = [
    'id', 'name', 'company', 'email', 'status', 'source', 'notes',
    'agreement_status', 'w9_received_at', 'created_at',
  ]
  const present = []
  for (const col of wanted) {
    const r = await fetch(`${url}/rest/v1/referral_partners?select=${col}&limit=1`, { headers })
    console.log(`  ${col.padEnd(18)} ${r.ok ? 'present' : 'ABSENT'}`)
    if (r.ok) present.push(col)
  }
  console.log(`\n  An INSERT may safely name: ${present.join(', ')}`)

  console.log('\nVERDICT: no partner rows. The do-block did not commit.')
  console.log('         If the editor showed a row, it showed one inside a transaction')
  console.log('         that was then rolled back -- the select and the insert share a')
  console.log('         transaction and it cannot miss its own work.')
  process.exit(1)
}

// The gate, from src/lib/partner-access.ts. Kept in the same order so a
// refusal here names the same branch the app would take.
const blockOf = (p) =>
  !p.email ? 'no_email'
  : p.status === 'inactive' ? 'inactive'
  : p.agreement_status === 'declined' ? 'declined'
  : p.agreement_status === 'voided' ? 'voided'
  : p.agreement_status !== 'signed' ? 'unsigned'
  : null

const counts = await fetch(
  `${url}/rest/v1/clients?select=id,referral_partner_id&referral_partner_id=not.is.null`,
  { headers },
).then((r) => (r.ok ? r.json() : []))

let bad = 0
for (const p of rows) {
  const block = blockOf(p)
  const attributed = counts.filter((c) => c.referral_partner_id === p.id).length
  console.log(`\n  name              ${p.name}`)
  console.log(`  email             ${p.email}`)
  console.log(`  status            ${p.status ?? 'NULL'}`)
  console.log(`  agreement_status  ${p.agreement_status ?? 'NULL'}`)
  console.log(`  can request code  ${block ? `NO -- blocked: ${block}` : 'YES'}`)
  console.log(`  clients attributed ${attributed}`)
  if (block) {
    console.log('  !! This row cannot receive a login code, so it cannot prove the mail path.')
    bad++
  }
  if (attributed > 0) {
    console.log('  !! CARRIES A COMMISSION OBLIGATION (5% of net profit, 12 months, +$300).')
    console.log('  !! A fixture must have none. Run the UNDO.')
    bad++
  }
}

console.log()
if (bad) {
  console.log('VERDICT: a row is present but not usable as written. See the !! lines.')
  process.exit(1)
}
console.log('VERDICT: partner row is active, signed, and owes nothing.')
console.log('         /api/partner/request-code will now reach sendEmail for this address,')
console.log('         so its answer finally carries information: a delivered code, or a 502.')
console.log('         REMEMBER THE UNDO in supabase/portal_email_test_partner.sql.')
