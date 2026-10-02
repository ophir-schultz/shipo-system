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

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: unpriced } = await db
  .from('shipments')
  .select('id, client_id, carrier, service, weight, zone, recipient_zip')
  .not('client_id', 'is', null)
  .eq('client_rate', 0)

const { data: clients } = await db.from('clients').select('id, name, origin_zip')
const nameOf = Object.fromEntries(clients.map(c => [c.id, c.name]))
const originOf = Object.fromEntries(clients.map(c => [c.id, c.origin_zip]))

// ---------- 1. what does the matrix actually contain, per client? ----------
console.log('=== client_zone_rates inventory (what the matrix HAS) ===\n')
const affected = [...new Set(unpriced.map(s => s.client_id))]

for (const cid of affected) {
  const { data: rows } = await db
    .from('client_zone_rates')
    .select('carrier, service, weight_lb, zone')
    .eq('client_id', cid)

  if (!rows?.length) {
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
    const { data } = await db.from('zone_chart').select('zone')
      .eq('origin_prefix', op).eq('dest_prefix', dp).maybeSingle()
    verdict = data?.zone ? `chart HAS zone ${data.zone} (!)` : `no zone_chart row for ${op}->${dp}`
  }
  console.log(`  ${nameOf[s.client_id].padEnd(14)} ${String(s.recipient_zip ?? '—').padEnd(12)} ${verdict}`)
}

// ---------- 4. does the chart cover this origin at all? ----------
const { data: chartRows } = await db.from('zone_chart').select('origin_prefix, dest_prefix')
const origins = new Map()
for (const r of chartRows ?? []) origins.set(r.origin_prefix, (origins.get(r.origin_prefix) ?? 0) + 1)
console.log(`\nzone_chart origin prefixes present: ${[...origins].map(([o, n]) => `${o}(${n} dests)`).join(', ')}`)
console.log('all clients above use origin_zip 19801 -> prefix 198')
