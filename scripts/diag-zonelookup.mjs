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
// What to do when a read fails. The per-ZIP lookup at the bottom is the reason
// this matters here: it destructured `{ data: hit }` and printed `NOT IN CHART
// ✗` for a falsy hit, so a failed lookup announced cause (b) above -- "the
// lookup itself fails and no amount of recalculating will help" -- which is the
// whole question this script exists to settle.
import { mustRead, unknownLog, UNKNOWN } from './read-or-refuse.mjs'

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

// Both samples are refused, not just the first error found. Each is half of
// the population being examined, and the loop below would simply have iterated
// the half that came back -- while the header still said the sample covers both.
mustRead('the NULL-rated sample read', nullRes)
mustRead('the zero-rated sample read', zeroRes)

const sample = [...nullRes.data, ...zeroRes.data]
if (!sample.length) { console.log('no unpriced shipments found'); process.exit(0) }

/** Counts that could not be read, named once at the end. */
const unread = unknownLog()
const nullCount = unread.soft('the client_rate NULL count', nullCountRes, { want: 'count' })
const zeroCount = unread.soft('the client_rate = 0 count', zeroCountRes, { want: 'count' })
const chartCount = unread.soft('the zone_chart count', await db
  .from('zone_chart').select('*', { count: 'exact', head: true }), { want: 'count' })

// The population the sample came out of, so a reader is never guessing which
// of the two a sampled row represents or how many were not shown.
console.log('population (client assigned):')
console.log(`  client_rate NULL:      ${nullCount.value ?? UNKNOWN}  — rate card does not cover them`)
console.log(`  client_rate exactly 0: ${zeroCount.value ?? UNKNOWN}  — legacy zero, or a card that says free`)
console.log(`sampled below: ${nullRes.data.length} NULL + ${zeroRes.data.length} zero-rated\n`)

console.log(`zone_chart rows in DB: ${chartCount.value ?? UNKNOWN}\n`)

console.log(`columns on shipments (${Object.keys(sample[0]).length}):`)
console.log('  ' + Object.keys(sample[0]).join(', '))

// Which columns plausibly hold a destination ZIP?
const zipCols = Object.keys(sample[0]).filter(k => /zip|postal/i.test(k))
console.log(`\nZIP-ish columns: ${zipCols.join(', ') || '(NONE FOUND)'}`)

console.log('\nper-shipment destination + zone-chart lookup:')
// Its own log, kept apart from the counts above: these two groups answer
// different questions and one tail claiming the other's failures would be
// wrong about which part of the output has holes in it.
const lookups = unknownLog()
for (const s of sample) {
  const vals = zipCols.map(c => `${c}=${JSON.stringify(s[c])}`).join(' ')
  console.log(`\n  id=${s.id ?? '?'}  [${rateKind(s)}]  zone=${JSON.stringify(s.zone)}  ${vals}`)

  for (const c of zipCols) {
    const raw = String(s[c] ?? '').replace(/\D/g, '')
    if (raw.length < 3) { console.log(`    ${c}: no usable ZIP3`); continue }
    const dest = raw.slice(0, 3)
    // `want: 'maybe'` because a null row here is the finding, not a failure:
    // "198 -> this ZIP3 is not in the chart" is cause (b) and exactly what the
    // script is looking for. Only an error means the lookup did not happen, and
    // the two have to print differently -- NOT IN CHART is a verdict a person
    // acts on by adding chart rows.
    const hit = lookups.soft(`198->${dest}`, await db
      .from('zone_chart')
      .select('zone')
      .eq('origin_prefix', '198')
      .eq('dest_prefix', dest)
      .maybeSingle(), { want: 'maybe' })
    const verdict = !hit.ok
      ? `${UNKNOWN} — the chart lookup itself failed (${hit.why})`
      : hit.value ? `zone ${hit.value.zone} ✓` : 'NOT IN CHART ✗'
    console.log(`    ${c}: ZIP3 ${dest} -> ${verdict}`)
  }
}

unread.tail('count reads')
lookups.tail('zone_chart lookups')
