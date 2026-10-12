// Read-only verification that supabase/partner_ledger.sql actually applied.
//
// Four questions, in order of what they'd cost if the answer is wrong:
//
//  1. Can anon or the partner-portal's `authenticated` role read these views?
//     That is every referred client's revenue and margin joined to the
//     partner who referred them, plus their order numbers. The SQL revokes
//     it; this asks the database rather than trusting the file.
//  2. Do both views exist and answer at all?
//  3. Do the two views RECONCILE? They group the same rows the same way, so
//     a difference means one WHERE/GROUP BY was edited without the other —
//     and the symptom is a partner seeing a transaction list that does not
//     add up to their own total.
//  4. Is cost_labour_not_deducted non-zero anywhere? If it reads 0.00 across
//     the board the charge_type names drifted, and the figure standing in
//     for our real margin on /pnl becomes indistinguishable from the
//     partner's inflated one.
//
// Nothing here writes. Run: node --env-file=.env.local scripts/verify-partner-ledger.mjs

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const service = process.env.SUPABASE_SERVICE_ROLE_KEY
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !service) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

const VIEWS = ['partner_client_monthly', 'partner_order_transactions']
let failures = 0

function pass(msg) { console.log(`PASS  ${msg}`) }
function fail(msg) { console.log(`FAIL  ${msg}`); failures++ }

async function q(key, path, extraHeaders = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...extraHeaders },
  })
  let body = null
  try { body = await res.json() } catch { /* empty body is fine */ }
  return { status: res.status, body, range: res.headers.get('content-range') }
}

// ---- 1. the exposure check -------------------------------------------
// Asking the DATABASE, not the migration file. `alter default privileges`
// or a stray grant can re-open a view without anyone editing that file.
console.log('--- exposure ---')
if (!anon) {
  fail('NEXT_PUBLIC_SUPABASE_ANON_KEY absent — could NOT verify the views are closed to anon')
} else {
  for (const v of VIEWS) {
    const r = await q(anon, `${v}?select=*&limit=1`)
    // A revoked view answers 401/403, or PostgREST reports it as undefined.
    if (r.status === 200 && Array.isArray(r.body)) {
      fail(`anon CAN READ ${v} (${r.body.length} row(s)) — the revoke did not take. This is every referred client's economics. Do not treat the file as applied.`)
    } else {
      pass(`anon is refused on ${v} (HTTP ${r.status})`)
    }
  }
}

// ---- 2. do they exist for the service role ---------------------------
console.log('\n--- existence ---')
const counts = {}
for (const v of VIEWS) {
  const r = await q(service, `${v}?select=*&limit=1`, { Prefer: 'count=exact', Range: '0-0' })
  if (r.status !== 200) {
    fail(`${v} is NOT readable by the service role (HTTP ${r.status}): ${JSON.stringify(r.body)}`)
    counts[v] = null
  } else {
    const total = Number(r.range?.split('/')[1] ?? 0)
    counts[v] = total
    pass(`${v} exists — ${total} row(s)`)
  }
}

// ---- 3. the two views must add up ------------------------------------
console.log('\n--- reconciliation ---')
if (counts[VIEWS[0]] === null || counts[VIEWS[1]] === null) {
  fail('skipped — a view is unreadable, so there is nothing to reconcile')
} else if (counts[VIEWS[0]] === 0) {
  console.log('SKIP  no rows in partner_client_monthly yet — nothing to reconcile.')
  console.log('      That is expected if no referred client has charges. It is NOT')
  console.log('      evidence the views agree; re-run once charges exist.')
} else {
  const months = (await q(service, 'partner_client_monthly?select=period_month,client_id,client_name,revenue')).body ?? []
  const txns = (await q(service, 'partner_order_transactions?select=period_month,client_id,amount_billed')).body ?? []

  const txTotal = new Map()
  for (const t of txns) {
    const k = `${t.client_id}:${t.period_month}`
    // null amount_billed means every line in that order is unpriced. Track
    // it as null rather than 0 so it cannot silently read as agreement.
    const prev = txTotal.get(k)
    const add = t.amount_billed === null ? null : Number(t.amount_billed)
    txTotal.set(k, prev === null || add === null ? (prev === undefined ? add : null) : (prev ?? 0) + add)
  }

  const drift = []
  for (const m of months) {
    const k = `${m.client_id}:${m.period_month}`
    const a = m.revenue === null ? null : Number(m.revenue)
    const b = txTotal.has(k) ? txTotal.get(k) : null
    const same = a === null && b === null ? true : a !== null && b !== null && Math.abs(a - b) < 0.005
    if (!same) drift.push({ month: m.period_month, client: m.client_name, monthView: a, txnView: b })
  }

  if (drift.length === 0) pass(`all ${months.length} client-month(s) reconcile between the two views`)
  else {
    fail(`${drift.length} client-month(s) DISAGREE between the two views:`)
    for (const d of drift.slice(0, 15)) {
      console.log(`        ${d.month}  ${d.client}  month=${d.monthView}  txns=${d.txnView}`)
    }
  }
}

// ---- 4. the labour column -------------------------------------------
console.log('\n--- labour column (reported, never deducted) ---')
if (!counts[VIEWS[0]]) {
  console.log('SKIP  no rows yet.')
} else {
  const rows = (await q(service, 'partner_client_monthly?select=cost_labour_not_deducted,payable,revenue_unknown_charges,cost_unknown_charges')).body ?? []
  const anyLabour = rows.some((r) => Number(r.cost_labour_not_deducted) > 0)
  if (anyLabour) pass('cost_labour_not_deducted is non-zero somewhere — charge_type names look intact')
  else fail('cost_labour_not_deducted is 0.00 on EVERY row. Either pick/pack costs are unpriced, or the charge_type names drifted — /pnl would then show our margin as identical to the partner-facing one.')

  const payable = rows.filter((r) => r.payable).length
  console.log(`      ${payable}/${rows.length} month(s) payable; ` +
    `${rows.filter((r) => Number(r.revenue_unknown_charges) > 0).length} with unknown revenue, ` +
    `${rows.filter((r) => Number(r.cost_unknown_charges) > 0).length} with unknown deducted cost`)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
