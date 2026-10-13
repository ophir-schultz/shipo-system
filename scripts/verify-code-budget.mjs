// How many login-code requests can the fixture address still make right now?
//
//   npx tsx --env-file=.env.local scripts/verify-code-budget.mjs
//
// request-code rate-limits on the EMAIL, not the partner:
//
//   count rows in partner_login_codes where email = <addr>
//     and created_at >= now - RATE_WINDOW_MINUTES   ->  429 if >= MAX_CODES_PER_WINDOW
//
// (src/app/api/partner/request-code/route.ts:52-67, with MAX_CODES_PER_WINDOW = 5
// and RATE_WINDOW_MINUTES = 15 from src/lib/partner-auth.ts.)
//
// WHY ASK INSTEAD OF COUNTING MY OWN CALLS
// ----------------------------------------
// Because the budget is shared and I am not the only writer. The rows are keyed
// by email, not by caller, so a code Ophir requests from the login screen spends
// the same budget as a code I request by curl -- and the window is a TRAILING 15
// minutes, so the number also goes UP on its own as rows age out. A tally kept in
// my head is wrong the moment either of those happens, and the way it fails is a
// 429 spent on a host I was trying to measure. A 429 returns before the partner
// lookup and before sendEmail, so it answers NOTHING about that host's mail
// config while still looking like a result.
//
// The limit is also per EMAIL and the partner is looked up BY email, so there is
// no second address that reaches this partner. The budget cannot be widened, only
// waited out -- which makes knowing the exact number worth a round trip.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.log('Cannot check: NEXT_PUBLIC_SUPABASE_URL or the service role key is not set.')
  process.exit(2)
}

const MAX = 5          // MAX_CODES_PER_WINDOW
const WINDOW_MIN = 15  // RATE_WINDOW_MINUTES
const EMAIL = 'ophir+portaltest@shipousa.com'

let role = 'unknown'
try {
  role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role ?? 'absent'
} catch { role = 'unparseable' }
if (role !== 'service_role') {
  // RLS would hide rows from a weaker key, and a budget that reads "5 free"
  // because rows are invisible is worse than no answer: it sends me spending.
  console.log(`!! reader role=${role}, not service_role. Hidden rows would read as free budget.`)
  process.exit(2)
}

const windowStart = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString()
const headers = { apikey: key, Authorization: `Bearer ${key}` }

// Same predicate the route uses: equality on email, created_at within the window.
const res = await fetch(
  `${url}/rest/v1/partner_login_codes` +
    `?select=created_at&email=eq.${encodeURIComponent(EMAIL)}` +
    `&created_at=gte.${encodeURIComponent(windowStart)}` +
    `&order=created_at.asc`,
  { headers },
)
if (!res.ok) {
  console.log(`FAILED to read partner_login_codes: HTTP ${res.status}`)
  console.log(await res.text())
  process.exit(1)
}

const rows = await res.json()
const used = rows.length
const free = Math.max(0, MAX - used)

console.log(`address   ${EMAIL}`)
console.log(`window    last ${WINDOW_MIN} min (since ${windowStart})`)
console.log(`used      ${used} of ${MAX}`)
console.log(`FREE NOW  ${free}`)

if (rows.length) {
  // When the oldest row leaves the window, one slot comes back. That is the
  // answer to "how long do I wait", which is the actual decision here.
  const oldest = new Date(rows[0].created_at)
  const freesAt = new Date(oldest.getTime() + WINDOW_MIN * 60_000)
  const secs = Math.max(0, Math.round((freesAt - Date.now()) / 1000))
  console.log(`\noldest    ${oldest.toISOString()}`)
  console.log(`+1 slot   in ${Math.floor(secs / 60)}m ${secs % 60}s (at ${freesAt.toISOString()})`)

  // Several rows written in the same burst age out together, so the useful
  // figure is often "when do I get N back", not "when do I get one back".
  const last = new Date(rows[rows.length - 1].created_at)
  const allFreeAt = new Date(last.getTime() + WINDOW_MIN * 60_000)
  const allSecs = Math.max(0, Math.round((allFreeAt - Date.now()) / 1000))
  console.log(`all ${MAX}     in ${Math.floor(allSecs / 60)}m ${allSecs % 60}s (at ${allFreeAt.toISOString()})`)
}

console.log(free > 0
  ? `\nSafe to make ${free} request-code call(s) for this address right now.`
  : `\nDO NOT CALL: the next request returns 429, which returns before the partner`
    + `\nlookup and before sendEmail and so measures nothing about mail config.`)
