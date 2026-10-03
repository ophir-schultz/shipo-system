// Read-only. Replays the EXACT lookups resolveZone/resolveZoneRate perform for
// every unpriced shipment, and prints what the matrix actually contains, so we
// can see which equality check fails rather than guessing.
//
// resolveZoneRate does:
//   client_zone_rates WHERE client_id AND carrier=? AND service=? AND weight_lb=? AND zone=?
// tried twice: exact {carrier, service}, then blanket {carrier:'', service:''}.
// Every one of those is a case-sensitive exact match, so a casing or naming
// difference between shipments.carrier and client_zone_rates.carrier is enough
// to miss on both attempts.
//
// There is also a case where NEITHER equality check runs. resolveZoneRate asks
// weightToLb for the matrix row first, and for an absent, zero, negative, NaN
// or Infinite weight there is no row to ask for, so it answers
// `{ rate: null, error: null }` -- a miss -- before touching the table. Such a
// shipment is unpriced because of its weight, not because of a casing or naming
// difference, and the sections below report it as its own cause rather than
// mixing it into the lookups.
//
// SELECTs only. Writes nothing.
import { createClient } from '@supabase/supabase-js'
// The weight->matrix-row rule, pinned to `weightToLb` in
// src/lib/billing/zones.ts (commit 8ed5bf6). This file used to carry its own
// copy, which still floored an unweighed shipment to row 1 after the real rule
// stopped doing so -- making this diagnostic claim a 1 LB lookup for shipments
// the live biller never looks up at all.
import { weightToLb } from './zone-weight.mjs'
// Which shipments count as unpriced, pinned to the monitor's scan. This file
// used to ask for `.eq('client_rate', 0)` alone, which stopped meaning
// "unpriced" when recalculate.ts began writing NULL instead of 0.
import { UNPRICED_OR, splitUnpriced, unpricedSummary } from './unpriced-filter.mjs'
// What to do when a read fails. The per-client matrix inventory is why this
// matters most here: it printed `NO ROWS AT ALL` for a falsy result, so a
// failed read reported that a client's rate matrix is empty -- the strongest
// claim this script makes, and the one that sends somebody to build a card.
import { mustRead, unknownLog, UNKNOWN } from './read-or-refuse.mjs'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: unpricedRows } = mustRead('the unpriced-shipments read', await db
  .from('shipments')
  // client_rate is selected because the split below reads it; a row that never
  // selected it would answer undefined and be filed under NULL.
  .select('id, client_id, carrier, service, weight, zone, recipient_zip, client_rate')
  .not('client_id', 'is', null)
  .or(UNPRICED_OR))

const split = splitUnpriced(unpricedRows)
// Printed before anything else so that no count further down -- all of which
// are over the union, because a rate-card gap is diagnosed the same way
// whichever value is stored -- gets read as being about one of the two alone.
console.log(unpricedSummary(split) + '\n')
const unpriced = split.all

// Refused, not UNKNOWN: `origin_zip` drives sections 3 and 4, and without the
// client rows every verdict there becomes "origin_zip unusable (undefined)",
// which is one of the real causes those sections exist to distinguish.
const { data: clients } = mustRead('the clients read',
  await db.from('clients').select('id, name, origin_zip'))
const nameOf = Object.fromEntries(clients.map(c => [c.id, c.name]))
const originOf = Object.fromEntries(clients.map(c => [c.id, c.origin_zip]))

/** Per-client and per-shipment reads that failed, named once at the end. */
const unread = unknownLog()

// ---------- 1. what does the matrix actually contain, per client? ----------
console.log('=== client_zone_rates inventory (what the matrix HAS) ===\n')
const affected = [...new Set(unpriced.map(s => s.client_id))]

for (const cid of affected) {
  const read = unread.soft(`${nameOf[cid] ?? cid}: client_zone_rates inventory`, await db
    .from('client_zone_rates')
    .select('carrier, service, weight_lb, zone')
    .eq('client_id', cid))

  // UNKNOWN before the empty check, because `NO ROWS AT ALL` and "we could not
  // find out" are opposite instructions: the first says build this client a
  // card, the second says nothing at all about their card.
  if (!read.ok) {
    console.log(`${nameOf[cid] ?? cid}: ${UNKNOWN} — client_zone_rates read failed (${read.why})`)
    console.log(`   Not an empty matrix. What this client's card contains is not known,`)
    console.log(`   so section 2 below says what their shipments asked for without`)
    console.log(`   anything to compare it against.\n`)
    continue
  }
  const rows = read.value

  if (!rows.length) {
    console.log(`${nameOf[cid]}: NO ROWS AT ALL\n`)
    continue
  }
  const pairs = new Map()
  for (const r of rows) {
    const k = `carrier=${JSON.stringify(r.carrier)} service=${JSON.stringify(r.service)}`
    if (!pairs.has(k)) pairs.set(k, { n: 0, lb: new Set(), z: new Set() })
    const p = pairs.get(k)
    p.n++; p.lb.add(r.weight_lb); p.z.add(r.zone)
  }
  console.log(`${nameOf[cid]}  (${rows.length} rows)`)
  for (const [k, p] of pairs) {
    const lbs = [...p.lb].sort((a, b) => a - b)
    const zs = [...p.z].sort((a, b) => a - b)
    console.log(`   ${k}`)
    console.log(`      rows=${p.n}  weight_lb ${lbs[0]}..${lbs[lbs.length - 1]}  zones ${zs.join(',')}`)
  }
  console.log()
}

// ---------- 2. what did each shipment ASK for? ----------
console.log(`\n=== what the ${unpriced.length} unpriced shipments ASKED for ===\n`)
const asked = new Map()
for (const s of unpriced) {
  const k = `${nameOf[s.client_id]} | carrier=${JSON.stringify(s.carrier)} service=${JSON.stringify(s.service)}`
  if (!asked.has(k)) asked.set(k, { n: 0, lb: new Set(), z: new Set(), unweighed: 0 })
  const a = asked.get(k)
  a.n++
  // Kept OUT of the lb set rather than added as null. Two reasons, and the
  // second is the one that matters: a null in there sorts as NaN and prints as
  // an empty string, so it would show up as a stray comma; and it would read as
  // a weight_lb this shipment asked the matrix for, when in fact no query ran.
  const lb = weightToLb(s.weight)
  if (lb === null) a.unweighed++
  else a.lb.add(lb)
  a.z.add(s.zone ?? 'NULL')
}
for (const [k, a] of [...asked].sort((x, y) => y[1].n - x[1].n)) {
  console.log(`${String(a.n).padStart(3)}x  ${k}`)
  const lbs = [...a.lb].sort((p, q) => p - q).join(',') || '(none)'
  console.log(`      weight_lb asked: ${lbs}   zone asked: ${[...a.z].join(',')}`)
  if (a.unweighed) {
    console.log(`      ${a.unweighed} of these have no usable weight, so NO matrix lookup happens`)
    console.log(`      for them at all -- the weight is the reason they are unpriced.`)
  }
}

const unweighedTotal = unpriced.filter(s => weightToLb(s.weight) === null).length
console.log(`\nunpriced because no matrix row can be named for the weight: ${unweighedTotal} of ${unpriced.length}`)
if (unweighedTotal) {
  console.log('  (weight absent, 0, negative or non-finite. Not a carrier/service')
  console.log('   casing problem -- recording the weight is what fixes these.)')
}

// ---------- 3. why is the zone null for the ones that have none? ----------
const noZone = unpriced.filter(s => !(s.zone >= 1 && s.zone <= 8))
console.log(`\n=== zone resolution failures (${noZone.length}) ===\n`)
for (const s of noZone) {
  const originZip = originOf[s.client_id]
  const op = String(originZip ?? '').replace(/\D/g, '').slice(0, 3)
  const dp = String(s.recipient_zip ?? '').replace(/\D/g, '').slice(0, 3)
  let verdict
  if (op.length !== 3) verdict = `origin_zip unusable (${JSON.stringify(originZip)})`
  else if (dp.length !== 3) verdict = `recipient_zip unusable (${JSON.stringify(s.recipient_zip)}) — likely international`
  else {
    // `want: 'maybe'`: a null row is "no chart row for this pair", which is the
    // ordinary answer this section reports. Only an error means the lookup did
    // not happen -- and `chart HAS zone N (!)` versus `no zone_chart row` are
    // the two conclusions in play, so neither may be printed on a failed read.
    const hit = unread.soft(`zone_chart ${op}->${dp}`, await db.from('zone_chart').select('zone')
      .eq('origin_prefix', op).eq('dest_prefix', dp).maybeSingle(), { want: 'maybe' })
    verdict = !hit.ok
      ? `${UNKNOWN} — chart lookup failed (${hit.why})`
      : hit.value?.zone ? `chart HAS zone ${hit.value.zone} (!)` : `no zone_chart row for ${op}->${dp}`
  }
  console.log(`  ${nameOf[s.client_id].padEnd(14)} ${String(s.recipient_zip ?? '—').padEnd(12)} ${verdict}`)
}

// ---------- 4. does the chart cover this origin at all? ----------
// On a failed read `chartRows ?? []` left `origins` empty, which printed
// "origin prefixes present: " and then made the coverage check at the bottom
// unanimously true -- "at least one of those prefixes has NO rows in
// zone_chart", for every prefix, from a read that never happened. UNKNOWN
// rather than a refusal so that sections 1-3 and the tail still print, but the
// verdict itself is withheld.
const chartRead = unread.soft('the zone_chart inventory read',
  await db.from('zone_chart').select('origin_prefix, dest_prefix'))
const origins = new Map()
for (const r of chartRead.value ?? []) origins.set(r.origin_prefix, (origins.get(r.origin_prefix) ?? 0) + 1)
if (!chartRead.ok) {
  console.log(`\nzone_chart origin prefixes present: ${UNKNOWN} — the read failed (${chartRead.why})`)
  console.log('  Not an empty chart, and not a chart missing an origin.')
} else {
  console.log(`\nzone_chart origin prefixes present: ${[...origins].map(([o, n]) => `${o}(${n} dests)`).join(', ')}`)
}

// Derived, not asserted. This line read 'all clients above use origin_zip
// 19801 -> prefix 198', which was true of the clients present when it was
// written and is the claim the section exists to check -- so stating it from
// memory rather than from the rows makes the check vacuous.
const originsUsed = new Map()
for (const cid of affected) {
  const zip = originOf[cid]
  const prefix = String(zip ?? '').replace(/\D/g, '').slice(0, 3)
  const k = `${JSON.stringify(zip ?? null)} -> prefix ${prefix.length === 3 ? prefix : 'UNUSABLE'}`
  originsUsed.set(k, (originsUsed.get(k) ?? 0) + 1)
}
console.log('origin_zip used by the clients above:')
for (const [k, n] of [...originsUsed].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} client(s)  origin_zip ${k}`)
}
// Withheld on a failed chart read. `origins` would be empty, so this verdict
// would fire for every client -- naming the loudest finding in the script as a
// certainty, on no evidence.
if (!chartRead.ok) {
  console.log(`  ^ whether zone_chart covers those prefixes is ${UNKNOWN}: its read failed.`)
} else {
  const covered = [...originsUsed.keys()].every(k => origins.has(k.match(/prefix (\S+)$/)?.[1]))
  if (!covered) console.log('  ^ at least one of those prefixes has NO rows in zone_chart')
}

unread.tail('reads')
