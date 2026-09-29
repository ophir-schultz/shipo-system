// Read-only diagnostic: why are N shipments unrated?
// Run: node --env-file=.env.local scripts/diag-unrated.mjs
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: clients } = await db
  .from('clients')
  .select('id, name, active, origin_zip')

const byId = Object.fromEntries((clients ?? []).map(c => [c.id, c]))

const { data: unpriced, count } = await db
  .from('shipments')
  .select('client_id, carrier, service, zone, recipient_zip', { count: 'exact' })
  .not('client_id', 'is', null)
  .eq('client_rate', 0)

console.log(`unpriced shipments (client assigned, client_rate = 0): ${count}`)

const groups = {}
for (const s of unpriced ?? []) {
  const k = s.client_id
  groups[k] ??= { n: 0, noZone: 0, carriers: new Set(), noZip: 0 }
  groups[k].n++
  if (s.zone == null) groups[k].noZone++
  if (!s.recipient_zip) groups[k].noZip++
  groups[k].carriers.add(`${s.carrier ?? '?'}/${s.service ?? '?'}`)
}

const { count: zoneChartRows } = await db
  .from('zone_chart')
  .select('*', { count: 'exact', head: true })
console.log(`zone_chart rows: ${zoneChartRows}`)

console.log('\nper client:')
for (const [id, g] of Object.entries(groups).sort((a, b) => b[1].n - a[1].n)) {
  const c = byId[id]
  const [{ count: zoneRates }, { count: cardRates }] = await Promise.all([
    db.from('client_zone_rates').select('*', { count: 'exact', head: true }).eq('client_id', id),
    db.from('client_shipping_rates').select('*', { count: 'exact', head: true }).eq('client_id', id),
  ])
  console.log(
    `  ${(c?.name ?? id).padEnd(22)} shipments=${String(g.n).padStart(4)}` +
    `  origin_zip=${c?.origin_zip ?? 'NULL'}` +
    `  zone_rates=${zoneRates}  rate_card=${cardRates}` +
    `  missing_zone=${g.noZone}  missing_zip=${g.noZip}`
  )
  console.log(`    carrier/service seen: ${[...g.carriers].slice(0, 6).join(', ')}`)
}
