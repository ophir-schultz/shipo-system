// Read-only SIMULATION. If Section A (the 29 additive zone_chart rows) were
// applied and nothing else changed, which of the 33 unpriced shipments would
// price? Replays resolveZone + resolveZoneRate exactly. Writes nothing.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
// The weight->matrix-row rule, pinned to `weightToLb` in
// src/lib/billing/zones.ts (commit 8ed5bf6). Imported rather than restated:
// this file used to floor an unweighed shipment to row 1, so the simulation
// counted it as one Section A WOULD price. It would not -- resolveZoneRate
// refuses that weight before it reaches the table -- and the count this script
// prints is what decides whether applying Section A is worth doing.
import { weightToLb } from './zone-weight.mjs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const usps = JSON.parse(readFileSync('/tmp/usps198.json','utf8'))
const uspsChart = new Map()
for (const col of ['Column0','Column1','Column2','Column3'])
  for (const e of usps[col] ?? []) {
    const z = Number(String(e.Zone).replace(/[^0-9]/g,''))
    const m = e.ZipCodes.match(/^(\d{3})\d*(?:-+(\d{3})\d*)?$/); if (!m) continue
    for (let i=Number(m[1]); i<=(m[2]?Number(m[2]):Number(m[1])); i++) uspsChart.set(String(i).padStart(3,'0'), z)
  }

const { data: dbChart } = await db.from('zone_chart').select('dest_prefix, zone').eq('origin_prefix','198')
const merged = new Map((dbChart ?? []).map(r => [r.dest_prefix, Number(r.zone)]))
let added = 0
for (const [p, z] of uspsChart) if (!merged.has(p)) { merged.set(p, z); added++ }   // Section A only

const { data: clients } = await db.from('clients').select('id, name')
const nameOf = Object.fromEntries(clients.map(c=>[c.id,c.name]))
const { data: unpriced } = await db.from('shipments')
  .select('id, client_id, carrier, service, weight, zone, recipient_zip')
  .not('client_id','is',null).eq('client_rate', 0)

console.log(`simulating Section A only: +${added} zone_chart rows, no zone changes\n`)
const res = { priced: 0, noZone: 0, noCell: 0, noWeight: 0 }
const detail = new Map()
for (const s of unpriced) {
  let zone = (s.zone >= 1 && s.zone <= 8) ? s.zone : null
  if (zone == null) {
    const dp = String(s.recipient_zip ?? '').replace(/\D/g,'').slice(0,3)
    const z = dp.length === 3 ? merged.get(dp) : undefined
    if (z != null && z >= 1 && z <= 8) zone = z
  }
  let outcome
  if (zone == null) { res.noZone++; outcome = 'still NO ZONE' }
  else if (weightToLb(s.weight) === null) {
    // Section A adds zone_chart rows, and this shipment's problem is not its
    // zone. Reported as its own outcome so the headline "would price" figure
    // does not count a shipment that applying Section A cannot fix.
    res.noWeight++; outcome = `zone ${zone} OK, but NO USABLE WEIGHT`
  }
  else {
    const lb = weightToLb(s.weight)
    let rate = null
    for (const a of [{c:s.carrier ?? '', sv:s.service ?? ''},{c:'',sv:''}]) {
      const { data } = await db.from('client_zone_rates').select('rate')
        .eq('client_id', s.client_id).eq('carrier', a.c).eq('service', a.sv)
        .eq('weight_lb', lb).eq('zone', zone).maybeSingle()
      if (data?.rate != null) { rate = Number(data.rate); break }
    }
    if (rate != null) { res.priced++; outcome = `PRICED $${rate.toFixed(2)} (zone ${zone})` }
    else { res.noCell++; outcome = `zone ${zone} OK, but no rate cell` }
  }
  const k = `${nameOf[s.client_id]} :: ${outcome.replace(/\$[\d.]+ /, '')}`
  detail.set(k, (detail.get(k) ?? 0) + 1)
}
for (const [k, n] of [...detail].sort()) console.log(`  ${String(n).padStart(3)}  ${k}`)
console.log(`\n  would price: ${res.priced} of ${unpriced.length}`)
console.log(`  still no zone: ${res.noZone}`)
console.log(`  zone fine, rate card still missing: ${res.noCell}`)
console.log(`  zone fine, but no usable weight: ${res.noWeight}  (Section A cannot fix these; record the weight)`)
