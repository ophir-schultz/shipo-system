// Read-only. 100% of shipments are STAMPS_COM (USPS), but zone_chart is a UPS
// ground chart. For every PRICED shipment, compare the rate it got (UPS zone)
// against the rate it would get under the real USPS zone for the same lane.
// Writes nothing. Assumes the client rate cards are USPS-based, which is the
// only reading consistent with 223/223 shipments being USPS.
//
// The weight->matrix-row rule is NOT restated here. It comes from
// ./zone-weight.mjs, which is pinned to `weightToLb` in src/lib/billing/zones.ts
// (commit 8ed5bf6) -- so an unweighed shipment is reported as having no row,
// the way the live biller treats it, instead of being repriced at 1 LB.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { weightToLb } from './zone-weight.mjs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const usps = JSON.parse(readFileSync('/tmp/usps198.json', 'utf8'))
const chart = new Map()
for (const col of ['Column0','Column1','Column2','Column3'])
  for (const e of usps[col] ?? []) {
    const zone = Number(String(e.Zone).replace(/[^0-9]/g, ''))
    const m = e.ZipCodes.match(/^(\d{3})\d*(?:-+(\d{3})\d*)?$/); if (!m) continue
    for (let i = Number(m[1]); i <= (m[2] ? Number(m[2]) : Number(m[1])); i++)
      chart.set(String(i).padStart(3,'0'), zone)
  }

const { data: clients } = await db.from('clients').select('id, name')
const nameOf = Object.fromEntries(clients.map(c => [c.id, c.name]))

const { data: ships } = await db.from('shipments')
  .select('id, client_id, carrier, service, weight, zone, recipient_zip, client_rate')
  .not('client_id','is',null).gt('client_rate', 0)

const rateCache = new Map()
async function rate(cid, carrier, service, lb, zone) {
  const k = `${cid}|${lb}|${zone}`
  if (rateCache.has(k)) return rateCache.get(k)
  let r = null
  for (const a of [{carrier, service}, {carrier:'', service:''}]) {
    const { data } = await db.from('client_zone_rates').select('rate')
      .eq('client_id', cid).eq('carrier', a.carrier).eq('service', a.service)
      .eq('weight_lb', lb).eq('zone', zone).maybeSingle()
    if (data?.rate != null) { r = Number(data.rate); break }
  }
  rateCache.set(k, r); return r
}

let same = 0, diff = 0, noUspsZone = 0, unpriceable = 0, unweighed = 0
let deltaTotal = 0
const perClient = new Map()
const zoneShift = new Map()

for (const s of ships) {
  const dp = String(s.recipient_zip ?? '').replace(/\D/g,'').slice(0,3)
  const uz = chart.get(dp)
  if (!uz) { noUspsZone++; continue }
  if (uz === s.zone) { same++; continue }
  diff++
  const k = `UPS ${s.zone} -> USPS ${uz}`
  zoneShift.set(k, (zoneShift.get(k) ?? 0) + 1)
  // No matrix row can be named for this shipment's weight, so there is no cell
  // to compare against and no delta to report. Counted and named rather than
  // priced at 1 LB: this script used to do that, which reported a plausible
  // repricing for a shipment the live biller refuses to price at all.
  //
  // Note what the count means. These shipments are in this loop because they
  // ALREADY have a client_rate > 0, so whatever priced them did so from a
  // weight that cannot be billed from -- most likely the 1 LB floor this rule
  // used to apply. That makes `unweighed` a list of prices worth re-examining,
  // not rows to skip quietly.
  const lb = weightToLb(s.weight)
  if (lb === null) { unweighed++; continue }
  const newRate = await rate(s.client_id, s.carrier ?? '', s.service ?? '', lb, uz)
  if (newRate == null) { unpriceable++; continue }
  const d = newRate - Number(s.client_rate)
  deltaTotal += d
  const n = nameOf[s.client_id]
  if (!perClient.has(n)) perClient.set(n, { n: 0, delta: 0 })
  const e = perClient.get(n); e.n++; e.delta += d
}

console.log(`priced shipments examined: ${ships.length}`)
console.log(`  zone agrees with USPS chart: ${same}`)
console.log(`  zone DIFFERS from USPS:      ${diff}`)
console.log(`  no USPS zone for dest:       ${noUspsZone}`)
console.log(`  differs but no rate cell:    ${unpriceable}`)
console.log(`  differs but unweighed:       ${unweighed}  (no matrix row can be named; already priced, so re-examine)`)

console.log('\nzone shifts observed:')
for (const [k, n] of [...zoneShift].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)

console.log('\nbilling delta if zones were USPS (positive = client was UNDERcharged):')
for (const [n, e] of [...perClient].sort((a,b)=>Math.abs(b[1].delta)-Math.abs(a[1].delta)))
  console.log(`  ${n.padEnd(16)} ${String(e.n).padStart(4)} shipments   $${e.delta.toFixed(2)}`)
console.log(`\n  TOTAL: $${deltaTotal.toFixed(2)} across ${diff - unpriceable - unweighed} repriced shipments`)
