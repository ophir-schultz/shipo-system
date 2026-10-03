// Read-only diagnostic: why are N shipments unrated?
// Run: node --env-file=.env.local scripts/diag-unrated.mjs
import { createClient } from '@supabase/supabase-js'
// Which shipments count as unpriced, pinned to the monitor's scan. This script
// asked for `.eq('client_rate', 0)`, which stopped meaning "unpriced" when
// recalculate.ts began writing NULL for a shipment it cannot price.
import { UNPRICED_OR, splitUnpriced, unpricedSummary, rateKind, NO_RATE } from './unpriced-filter.mjs'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data: clients } = await db
  .from('clients')
  .select('id, name, active, origin_zip')

const byId = Object.fromEntries((clients ?? []).map(c => [c.id, c]))

const { data: unpricedRows, count } = await db
  .from('shipments')
  // client_rate is selected because the split reads it.
  .select('client_id, carrier, service, zone, recipient_zip, client_rate', { count: 'exact' })
  .not('client_id', 'is', null)
  .or(UNPRICED_OR)

const split = splitUnpriced(unpricedRows)
console.log(unpricedSummary(split))

// This script asked for an exact count and printed it as the headline while
// grouping over `data`, which PostgREST caps. Keeping the count means the two
// can be compared: if they disagree, every per-client figure below is over a
// subset, and a diagnostic silently describing a subset is the same fault as
// the predicate this file just had fixed.
if (count != null && count !== split.all.length) {
  console.log(
    `\n!! exact count is ${count} but only ${split.all.length} rows came back -- `
    + `PostgREST capped the result. Every per-client figure below is over that `
    + `subset. Re-run with .range() to page through.`
  )
}

const groups = {}
for (const s of split.all) {
  const k = s.client_id
  groups[k] ??= { n: 0, noRate: 0, zero: 0, noZone: 0, carriers: new Set(), noZip: 0 }
  groups[k].n++
  if (rateKind(s) === NO_RATE) groups[k].noRate++
  else groups[k].zero++
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
    // Alongside the total rather than instead of it: a client whose rows are
    // all stored zeros may simply have a card that says free, which is not the
    // same problem as a client the card does not cover at all.
    `  rate_null=${String(g.noRate).padStart(4)}  rate_zero=${String(g.zero).padStart(4)}` +
    `  origin_zip=${c?.origin_zip ?? 'NULL'}` +
    `  zone_rates=${zoneRates}  rate_card=${cardRates}` +
    `  missing_zone=${g.noZone}  missing_zip=${g.noZip}`
  )
  console.log(`    carrier/service seen: ${[...g.carriers].slice(0, 6).join(', ')}`)
}
