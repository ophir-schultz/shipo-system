// Load the verified UPS zone chart for origin 198 into zone_chart, and set
// clients.origin_zip to the ShipStation default warehouse ZIP.
//
//   node --env-file=.env.local scripts/load-zone-chart.mjs          # dry run
//   node --env-file=.env.local scripts/load-zone-chart.mjs --apply  # writes
//
// Source of truth: scripts/ups-zone-chart-198.txt (UPS .xls, verified 2026-09-03).
// Mirrors what POST /api/clients/[id]/zone-chart does: delete by origin_prefix,
// then insert. Same zone 1-8 filter, so Puerto Rico (zones 25/45) is excluded
// exactly as the route would exclude it.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const ORIGIN_ZIP = '19801' // ShipStation warehouse 683005, SHIPO LLC, isDefault
const ORIGIN_PREFIX = '198'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// ── parse ───────────────────────────────────────────────────────────────────
const text = readFileSync(new URL('./ups-zone-chart-198.txt', import.meta.url), 'utf8')
const rows = []
const seen = new Map()
let dupes = 0

for (const rawLine of text.split('\n')) {
  const line = rawLine.trim()
  if (!line || line.startsWith('#')) continue
  // Mainland tokens look like 005=2 or 010-034=3. The Puerto Rico lines use
  // Ground=45 / 2ndDayAir=25, which cannot match this pattern — by design.
  for (const tok of line.split(/\s+/)) {
    const m = /^(\d{3})(?:-(\d{3}))?=(\d{1,2})$/.exec(tok)
    if (!m) continue
    const from = parseInt(m[1], 10)
    const to = m[2] ? parseInt(m[2], 10) : from
    const zone = parseInt(m[3], 10)
    if (!(zone >= 1 && zone <= 8)) continue // route's own filter
    for (let p = from; p <= to; p++) {
      const dest = String(p).padStart(3, '0')
      if (seen.has(dest)) { dupes++; continue }
      seen.set(dest, zone)
      rows.push({ origin_prefix: ORIGIN_PREFIX, dest_prefix: dest, zone })
    }
  }
}

const byZone = {}
for (const r of rows) byZone[r.zone] = (byZone[r.zone] ?? 0) + 1

console.log(`parsed ${rows.length} destination prefixes (duplicates skipped: ${dupes})`)
console.log('per zone:', byZone)

// The file header states 903 mainland prefixes (906 total, 3 of them Puerto
// Rico at zones 25/45). Anything else means the parse drifted — refuse.
if (rows.length !== 903) {
  console.error(`\nREFUSING: expected 903 mainland prefixes per the file header, got ${rows.length}.`)
  console.error('Parse and source disagree — fix before writing anything.')
  process.exit(1)
}
console.log('✓ matches the 903 mainland prefixes the source file documents')

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.')
  console.log(`would set clients.origin_zip = ${ORIGIN_ZIP} where origin_zip is null`)
  console.log(`would replace zone_chart rows for origin_prefix ${ORIGIN_PREFIX}`)
  process.exit(0)
}

// ── write ───────────────────────────────────────────────────────────────────
const { data: updated, error: upErr } = await db
  .from('clients')
  .update({ origin_zip: ORIGIN_ZIP })
  .is('origin_zip', null)
  .select('id, name')
if (upErr) throw new Error(`origin_zip update failed: ${upErr.message}`)
console.log(`\nset origin_zip=${ORIGIN_ZIP} on ${updated?.length ?? 0} clients`)

const { error: delErr } = await db.from('zone_chart').delete().eq('origin_prefix', ORIGIN_PREFIX)
if (delErr) throw new Error(`zone_chart delete failed: ${delErr.message}`)

for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500)
  const { error } = await db.from('zone_chart').insert(chunk)
  if (error) throw new Error(`zone_chart insert failed at row ${i}: ${error.message}`)
}

const { count } = await db
  .from('zone_chart')
  .select('*', { count: 'exact', head: true })
  .eq('origin_prefix', ORIGIN_PREFIX)
console.log(`zone_chart now holds ${count} rows for origin ${ORIGIN_PREFIX}`)

// Spot-check against the corrections documented in the source file.
const expect = { '191': 2, '100': 2, '276': 3, '303': 6, '606': 5, '752': 6, '900': 8 }
console.log('\nspot-check vs the file\'s own verified corrections:')
for (const [dest, want] of Object.entries(expect)) {
  const { data } = await db
    .from('zone_chart')
    .select('zone')
    .eq('origin_prefix', ORIGIN_PREFIX)
    .eq('dest_prefix', dest)
    .maybeSingle()
  const got = data?.zone
  console.log(`  ${dest} -> zone ${got}  ${got === want ? '✓' : `✗ expected ${want}`}`)
}
