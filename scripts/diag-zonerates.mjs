// Read-only: what carrier/service/weight/zone coverage does each client's
// loaded zone matrix actually have? Determines whether the UPS zone chart
// in scripts/ups-zone-chart-198.txt is the right map for these shipments.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: clients } = await db.from('clients').select('id, name, origin_zip')
const { count: chartRows } = await db
  .from('zone_chart')
  .select('*', { count: 'exact', head: true })
console.log(`zone_chart rows: ${chartRows}`)
console.log(`clients with origin_zip set: ${(clients ?? []).filter(c => c.origin_zip).length} of ${clients?.length}\n`)

for (const c of clients ?? []) {
  const { data: rows } = await db
    .from('client_zone_rates')
    .select('carrier, service, weight_lb, zone, rate')
    .eq('client_id', c.id)
  if (!rows?.length) { console.log(`${c.name}: no zone rates`); continue }

  const combos = {}
  for (const r of rows) {
    const k = `${r.carrier || '(blank)'} / ${r.service || '(blank)'}`
    combos[k] ??= { n: 0, weights: new Set(), zones: new Set() }
    combos[k].n++
    combos[k].weights.add(r.weight_lb)
    combos[k].zones.add(r.zone)
  }
  console.log(`${c.name}  (origin_zip=${c.origin_zip ?? 'NULL'})`)
  for (const [k, v] of Object.entries(combos)) {
    const w = [...v.weights].sort((a, b) => a - b)
    const z = [...v.zones].sort((a, b) => a - b)
    console.log(`   ${k.padEnd(42)} rows=${String(v.n).padStart(4)}  weight_lb ${w[0]}-${w[w.length - 1]} (${w.length})  zones ${z.join(',')}`)
  }
}
