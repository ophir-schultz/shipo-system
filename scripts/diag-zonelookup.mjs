// Read-only. The zone chart is loaded, every client has an origin_zip, and yet
// shipments still report missing_zone.
//
// Two possible causes, and this tells them apart:
//   (a) recalculate simply hasn't re-run, so shipments.zone is stale -> the
//       lookup below will SUCCEED for real destination ZIPs.
//   (b) the lookup itself fails (dest ZIP missing/!ZIP3/not in chart) -> it
//       will FAIL here too, and no amount of recalculating will help.
//
// The header used to open "the zone chart is loaded (903 rows, origin 198) and
// every client has origin_zip=19801, yet all 213 shipments still report
// missing_zone". Those were the figures on the day it was written, stated as
// standing fact; the chart row count is now read from the table and printed
// below, where it can be checked.
//
// Nothing is written.
import { createClient } from '@supabase/supabase-js'
// Which shipments count as unpriced, pinned to the monitor's scan. This script
// asked for `.eq('client_rate', 0)`, which stopped meaning "unpriced" when
// recalculate.ts began writing NULL.
import { onlyNoRate, onlyZeroRate, rateKind } from './unpriced-filter.mjs'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// Pull a sample of the unpriced shipments and look at what destination data
// they actually carry. Column names are discovered, not assumed.
//
// Sampled as two queries rather than one `.or()` with a limit. The destination
// data is the question here and it does not depend on which value the rate
// column holds -- but PostgREST promises no ordering, so a limit over the union
// could return five NULL-rated rows and leave the stored zeros unexamined
// without ever saying so.
const base = () => db.from('shipments').select('*').not('client_id', 'is', null)
const [nullRes, zeroRes, nullCountRes, zeroCountRes] = await Promise.all([
  onlyNoRate(base()).limit(3),
  onlyZeroRate(base()).limit(3),
  onlyNoRate(db.from('shipments').select('id', { count: 'exact', head: true }).not('client_id', 'is', null)),
  onlyZeroRate(db.from('shipments').select('id', { count: 'exact', head: true }).not('client_id', 'is', null)),
])

const error = nullRes.error ?? zeroRes.error
if (error) { console.error(error.message); process.exit(1) }

const sample = [...(nullRes.data ?? []), ...(zeroRes.data ?? [])]
if (!sample.length) { console.log('no unpriced shipments found'); process.exit(0) }

// The population the sample came out of, so a reader is never guessing which
// of the two a sampled row represents or how many were not shown.
console.log('population (client assigned):')
console.log(`  client_rate NULL:      ${nullCountRes.count ?? '(count failed)'}  — rate card does not cover them`)
console.log(`  client_rate exactly 0: ${zeroCountRes.count ?? '(count failed)'}  — legacy zero, or a card that says free`)
console.log(`sampled below: ${nullRes.data?.length ?? 0} NULL + ${zeroRes.data?.length ?? 0} zero-rated\n`)

const { count: zoneChartRows } = await db
  .from('zone_chart').select('*', { count: 'exact', head: true })
console.log(`zone_chart rows in DB: ${zoneChartRows ?? '(count failed)'}\n`)

console.log(`columns on shipments (${Object.keys(sample[0]).length}):`)
console.log('  ' + Object.keys(sample[0]).join(', '))

// Which columns plausibly hold a destination ZIP?
const zipCols = Object.keys(sample[0]).filter(k => /zip|postal/i.test(k))
console.log(`\nZIP-ish columns: ${zipCols.join(', ') || '(NONE FOUND)'}`)

console.log('\nper-shipment destination + zone-chart lookup:')
for (const s of sample) {
  const vals = zipCols.map(c => `${c}=${JSON.stringify(s[c])}`).join(' ')
  console.log(`\n  id=${s.id ?? '?'}  [${rateKind(s)}]  zone=${JSON.stringify(s.zone)}  ${vals}`)

  for (const c of zipCols) {
    const raw = String(s[c] ?? '').replace(/\D/g, '')
    if (raw.length < 3) { console.log(`    ${c}: no usable ZIP3`); continue }
    const dest = raw.slice(0, 3)
    const { data: hit } = await db
      .from('zone_chart')
      .select('zone')
      .eq('origin_prefix', '198')
      .eq('dest_prefix', dest)
      .maybeSingle()
    console.log(`    ${c}: ZIP3 ${dest} -> ${hit ? `zone ${hit.zone} ✓` : 'NOT IN CHART ✗'}`)
  }
}
