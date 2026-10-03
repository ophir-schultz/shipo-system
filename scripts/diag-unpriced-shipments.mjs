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

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: unpricedRows, error } = await db
  .from('shipments')
  // client_rate is selected because the split reads it.
  .select('id, client_id, carrier, service, weight, zone, recipient_zip, actual_cost, client_rate')
  .not('client_id', 'is', null)
  .or(UNPRICED_OR)

if (error) { console.error('shipments query failed:', error.message); process.exit(1) }

const split = splitUnpriced(unpricedRows)
const unpriced = split.all

console.log(unpricedSummary(split) + '\n')

const { data: clients } = await db.from('clients').select('id, name, origin_zip')
const nameOf = Object.fromEntries((clients ?? []).map(c => [c.id, c.name]))
const originOf = Object.fromEntries((clients ?? []).map(c => [c.id, c.origin_zip]))

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
  const [{ count: shipRates }, { count: zoneRates }] = await Promise.all([
    db.from('client_shipping_rates').select('*', { count: 'exact', head: true }).eq('client_id', clientId),
    db.from('client_zone_rates').select('*', { count: 'exact', head: true }).eq('client_id', clientId),
  ])
  const cs = splitUnpriced(rows)
  console.log(
    `${String(nameOf[clientId] ?? clientId).slice(0, 24).padEnd(24)}  ${String(rows.length).padStart(8)}  ` +
    `${String(cs.noRate.length).padStart(6)}  ${String(cs.zero.length).padStart(6)}  ` +
    `${String(originOf[clientId] ?? '—').padEnd(10)}  ${String(shipRates ?? 0).padStart(14)}  ${String(zoneRates ?? 0).padStart(10)}`
  )
}

// ---------- why the zone path failed ----------
let noZone = 0, hasZone = 0
for (const s of unpriced) {
  if (s.zone && s.zone >= 1 && s.zone <= 8) hasZone++
  else noZone++
}
console.log(`\nzone resolution on these shipments: ${hasZone} have a zone, ${noZone} do not`)

const { count: zoneChartRows } = await db
  .from('zone_chart').select('*', { count: 'exact', head: true })
console.log(`zone_chart rows in DB: ${zoneChartRows ?? 0}`)

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
const { count: totalWithClient } = await db
  .from('shipments').select('*', { count: 'exact', head: true }).not('client_id', 'is', null)
console.log(`\nshipments with a client assigned: ${totalWithClient ?? 0}`)
console.log(`of those, unpriced:               ${unpriced.length}`)
console.log(`  client_rate NULL:               ${split.noRate.length}`)
console.log(`  client_rate exactly 0:          ${split.zero.length}`)
