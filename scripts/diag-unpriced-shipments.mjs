// Read-only. Explains WHY shipments end up without a usable client_rate.
//
// That used to read "with client_rate = 0", and the query below used to look
// for exactly that. recalculateShipments() now writes NULL for a shipment it
// cannot price, so both are matched -- see scripts/unpriced-filter.mjs for why
// both, and why the two counts are kept apart rather than added up.
//
// recalculateShipments() marks a shipment `unmatched` only when BOTH paths fail:
//   1. zone matrix  — needs a resolvable zone AND a matching client_zone_rates cell
//   2. legacy card  — needs >=1 row in client_shipping_rates (it always falls back
//                     to the last row, so any row at all guarantees a match)
//
// So unmatched implies: client has ZERO client_shipping_rates rows, and the zone
// path failed too. This script checks that claim against the data instead of
// assuming it, and shows which ingredient each affected client is missing.
//
// SELECTs only. Writes nothing.
import { createClient } from '@supabase/supabase-js'
// Which shipments count as unpriced, pinned to the monitor's scan.
import { UNPRICED_OR, splitUnpriced, unpricedSummary } from './unpriced-filter.mjs'
// What to do when a read fails. This script already refused on a shipments
// error, but every count below was printed as `?? 0` -- and `shipping_rates 0
// zone_rates 0` is precisely the reading that says a client has no rate card,
// which is the verdict this table is consulted for.
import { mustRead, readFailure, unknownLog, UNKNOWN } from './read-or-refuse.mjs'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// A null `data` is refused alongside the error, which the hand-written check
// here did not cover: a null with no error would have reached splitUnpriced,
// which answers an empty population quite happily.
//
// `{ count: 'exact' }` alongside the rows, the way scripts/diag-unrated.mjs and
// scripts/gen-rate-card-worklist.mjs already do it. PostgREST caps a `.select()`
// with no `.range()`, so `data.length` is how many rows CAME BACK and says
// nothing about how many match. Asking for both is what lets them be compared.
const unpricedRes = mustRead('the unpriced-shipments read', await db
  .from('shipments')
  // client_rate is selected because the split reads it.
  .select('id, client_id, carrier, service, weight, zone, recipient_zip, actual_cost, client_rate',
    { count: 'exact' })
  .not('client_id', 'is', null)
  .or(UNPRICED_OR))

const split = splitUnpriced(unpricedRes.data)
const unpriced = split.all

// Not `(count ?? 0)`. A count request that failed answers null, and a count of
// 0 is a real finding -- nothing is unpriced, which is the result this whole
// script hopes for. `readFailure`'s `want: 'count'` mode is what tells the two
// apart; folding them together would turn a broken count into "0 match", and 0
// matching against 33 rows read looks like a cap that is not there.
const countWhy = readFailure(unpricedRes, { want: 'count' })
const unpricedTotal = countWhy ? null : unpricedRes.count
const capped = unpricedTotal != null && unpricedTotal !== unpriced.length

console.log(unpricedSummary(split) + '\n')

// Said before the sections, all of which are computed from the rows that came
// back. A cap here does more than undercount a total: the per-client table
// below is built by GROUPING those rows, so a client whose shipments all sat
// beyond the cap is absent from it entirely -- and an absent client reads as a
// client with nothing unpriced, which is the opposite of the finding.
//
// `fetchAllPages` in src/lib/ledger/load-charge-inputs.ts is the real pager and
// is deliberately not reimplemented here: it handles PGRST103 at the end of the
// table and needs an explicit `.order()`, and it lives in a module importing
// `@/lib/supabase`, an alias Node's type stripping cannot resolve from a .mjs.
// So this says the list is partial rather than growing a second copy of it.
if (capped) {
  console.log(`!! PARTIAL: ${unpricedTotal} shipments match, but only ${unpriced.length} came back --`)
  console.log(`   PostgREST capped the read. Every figure below describes that subset, and`)
  console.log(`   whole clients may be missing from the table: a client who does not appear`)
  console.log(`   is NOT thereby a client with nothing unpriced. Page the query with .range()`)
  console.log(`   and re-run before concluding anything per client.\n`)
}
// A count that never arrived is not a count that agreed. Without it there is
// nothing to check `data.length` against, so whether the sections below cover
// the population is unknown -- which is not the same as knowing they do.
else if (countWhy) {
  console.log(`!! whether these are ALL the matching shipments is ${UNKNOWN}: the exact count`)
  console.log(`   was not returned (${countWhy}), so the ${unpriced.length} rows read cannot be`)
  console.log(`   compared against the number that match. PostgREST caps an unpaged .select(),`)
  console.log(`   so a cap cannot be ruled out here.\n`)
}

// Refused, not UNKNOWN: `origin_zip` is one of the columns being diagnosed, and
// with no client rows every client would show `origin_zip —`, which is how this
// table reports an origin_zip that is actually missing.
const { data: clients } = mustRead('the clients read',
  await db.from('clients').select('id, name, origin_zip'))
const nameOf = Object.fromEntries(clients.map(c => [c.id, c.name]))
const originOf = Object.fromEntries(clients.map(c => [c.id, c.origin_zip]))

/** Counts that could not be read, named once at the end. */
const unread = unknownLog()

// ---------- per-client breakdown ----------
const byClient = new Map()
for (const s of unpriced) {
  const k = s.client_id
  if (!byClient.has(k)) byClient.set(k, [])
  byClient.get(k).push(s)
}

// NULL and $0 are their own columns rather than one 'unpriced' total. A client
// whose rows are all stored zeros may have a card that says free; a client
// whose rows are all NULL certainly does not have a card that covers them. One
// column could not tell those two clients apart, and they need different work.
console.log('client                    unpriced    NULL      $0  origin_zip  shipping_rates  zone_rates')
console.log('-'.repeat(95))

for (const [clientId, rows] of [...byClient].sort((a, b) => b[1].length - a[1].length)) {
  const name = nameOf[clientId] ?? clientId
  const [shipRes, zoneRes] = await Promise.all([
    db.from('client_shipping_rates').select('*', { count: 'exact', head: true }).eq('client_id', clientId),
    db.from('client_zone_rates').select('*', { count: 'exact', head: true }).eq('client_id', clientId),
  ])
  // The header comment above claims unmatched implies "client has ZERO
  // client_shipping_rates rows", and says this script checks that claim against
  // the data instead of assuming it. A failed count rendered as 0 would confirm
  // the claim by default, which is the opposite of checking it.
  const shipRates = unread.soft(`${name}: client_shipping_rates count`, shipRes, { want: 'count' })
  const zoneRates = unread.soft(`${name}: client_zone_rates count`, zoneRes, { want: 'count' })
  const cs = splitUnpriced(rows)
  console.log(
    `${String(name).slice(0, 24).padEnd(24)}  ${String(rows.length).padStart(8)}  ` +
    `${String(cs.noRate.length).padStart(6)}  ${String(cs.zero.length).padStart(6)}  ` +
    `${String(originOf[clientId] ?? '—').padEnd(10)}  ` +
    `${String(shipRates.value ?? UNKNOWN).padStart(14)}  ${String(zoneRates.value ?? UNKNOWN).padStart(10)}`
  )
}

// ---------- why the zone path failed ----------
let noZone = 0, hasZone = 0
for (const s of unpriced) {
  if (s.zone && s.zone >= 1 && s.zone <= 8) hasZone++
  else noZone++
}
console.log(`\nzone resolution on these shipments: ${hasZone} have a zone, ${noZone} do not`)

// `?? 0` here read as "the zone chart was never loaded", which is a concrete
// and actionable wrong conclusion: somebody would go and load a chart that is
// already in the table.
const zoneChartRows = unread.soft('the zone_chart count', await db
  .from('zone_chart').select('*', { count: 'exact', head: true }), { want: 'count' })
console.log(`zone_chart rows in DB: ${zoneChartRows.value ?? UNKNOWN}`)

// ---------- carrier/service spread ----------
const combos = new Map()
for (const s of unpriced) {
  const k = `${s.carrier ?? '—'} / ${s.service ?? '—'}`
  combos.set(k, (combos.get(k) ?? 0) + 1)
}
console.log('\ncarrier / service on unpriced shipments:')
for (const [k, n] of [...combos].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${k}`)
}

// ---------- is this the whole population, or just some? ----------
// This is the denominator the whole report is read against -- "is this the
// whole population, or just some?". As `?? 0` it said there are no shipments
// with a client assigned, while the lines directly beneath it listed some.
const totalWithClient = unread.soft('the assigned-shipments count', await db
  .from('shipments').select('*', { count: 'exact', head: true }).not('client_id', 'is', null),
  { want: 'count' })
console.log(`\nshipments with a client assigned: ${totalWithClient.value ?? UNKNOWN}`)
// This section asks "is this the whole population, or just some?", and until
// the count above was requested the answer printed here was `unpriced.length`
// -- the size of the subset, offered as the size of the population. The two are
// the same number only when the read was not capped, so when it was, the count
// that matched is what goes on this line and the rows read are named as such.
if (capped) {
  console.log(`of those, unpriced:               ${unpricedTotal}  (only ${unpriced.length} were read — see PARTIAL above)`)
} else if (countWhy) {
  console.log(`of those, unpriced:               ${unpriced.length} rows read  (the exact count is ${UNKNOWN}; a cap cannot be ruled out)`)
} else {
  console.log(`of those, unpriced:               ${unpriced.length}`)
}
// The split is over the rows in hand either way, so it is labelled when those
// are known to be a subset rather than left to be read as the whole breakdown.
const ofRead = capped ? '  (of the rows read)' : ''
console.log(`  client_rate NULL:               ${split.noRate.length}${ofRead}`)
console.log(`  client_rate exactly 0:          ${split.zero.length}${ofRead}`)

unread.tail('count reads')
