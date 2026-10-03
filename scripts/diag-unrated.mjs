// Read-only diagnostic: why are N shipments unrated?
// Run: node --env-file=.env.local scripts/diag-unrated.mjs
import { createClient } from '@supabase/supabase-js'
// Which shipments count as unpriced, pinned to the monitor's scan. This script
// asked for `.eq('client_rate', 0)`, which stopped meaning "unpriced" when
// recalculate.ts began writing NULL for a shipment it cannot price.
import { UNPRICED_OR, splitUnpriced, unpricedSummary, rateKind, NO_RATE } from './unpriced-filter.mjs'
// What to do when a read fails. Every read here used to be destructured bare,
// and `(clients ?? [])` plus `splitUnpriced(null)` meant a failed read did not
// even throw: it printed "0 unrated shipments" and an empty per-client table,
// which is the single most reassuring output this script can produce.
import { mustRead, unknownLog, UNKNOWN } from './read-or-refuse.mjs'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// Refused rather than reported UNKNOWN: without the client rows every line of
// the per-client table below is keyed by a raw UUID and its origin_zip column
// reads NULL for everyone, which is itself one of the findings this script
// reports. A missing origin_zip and an unread clients table must not look alike.
const { data: clients } = mustRead('the clients read', await db
  .from('clients')
  .select('id, name, active, origin_zip'))

const byId = Object.fromEntries(clients.map(c => [c.id, c]))

const { data: unpricedRows, count } = mustRead('the unpriced-shipments read', await db
  .from('shipments')
  // client_rate is selected because the split reads it.
  .select('client_id, carrier, service, zone, recipient_zip, client_rate', { count: 'exact' })
  .not('client_id', 'is', null)
  .or(UNPRICED_OR))

/** Counts that could not be read, named once at the end. */
const unread = unknownLog()

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

// UNKNOWN rather than refusing: the per-client table is still worth printing
// without it. But not `?? 0` either -- "zone_chart rows: 0" says the chart was
// never loaded, which would send someone to load a chart that is already there.
const zoneChartRows = unread.soft('the zone_chart count', await db
  .from('zone_chart')
  .select('*', { count: 'exact', head: true }), { want: 'count' })
console.log(`zone_chart rows: ${zoneChartRows.value ?? UNKNOWN}`)

console.log('\nper client:')
for (const [id, g] of Object.entries(groups).sort((a, b) => b[1].n - a[1].n)) {
  const c = byId[id]
  const name = c?.name ?? id
  const [zoneRes, cardRes] = await Promise.all([
    db.from('client_zone_rates').select('*', { count: 'exact', head: true }).eq('client_id', id),
    db.from('client_shipping_rates').select('*', { count: 'exact', head: true }).eq('client_id', id),
  ])
  // These two columns are the diagnosis: `zone_rates=0 rate_card=0` is what
  // says this client has no rate card at all, and it is the figure that decides
  // whether somebody is asked to build one. A failed count printed as 0 would
  // manufacture exactly that verdict, so it prints UNKNOWN instead.
  const zoneRates = unread.soft(`${name}: client_zone_rates count`, zoneRes, { want: 'count' })
  const cardRates = unread.soft(`${name}: client_shipping_rates count`, cardRes, { want: 'count' })
  console.log(
    `  ${String(name).padEnd(22)} shipments=${String(g.n).padStart(4)}` +
    // Alongside the total rather than instead of it: a client whose rows are
    // all stored zeros may simply have a card that says free, which is not the
    // same problem as a client the card does not cover at all.
    `  rate_null=${String(g.noRate).padStart(4)}  rate_zero=${String(g.zero).padStart(4)}` +
    `  origin_zip=${c?.origin_zip ?? 'NULL'}` +
    `  zone_rates=${zoneRates.value ?? UNKNOWN}  rate_card=${cardRates.value ?? UNKNOWN}` +
    `  missing_zone=${g.noZone}  missing_zip=${g.noZip}`
  )
  console.log(`    carrier/service seen: ${[...g.carriers].slice(0, 6).join(', ')}`)
}

unread.tail('count reads')
