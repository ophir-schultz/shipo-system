// Read-only. The zone chart is loaded (903 rows, origin 198) and every client
// has origin_zip=19801, yet all 213 shipments still report missing_zone.
//
// Two possible causes, and this tells them apart:
//   (a) recalculate simply hasn't re-run, so shipments.zone is stale -> the
//       lookup below will SUCCEED for real destination ZIPs.
//   (b) the lookup itself fails (dest ZIP missing/!ZIP3/not in chart) -> it
//       will FAIL here too, and no amount of recalculating will help.
//
// Nothing is written.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

// Pull a sample of the unpriced shipments and look at what destination data
// they actually carry. Column names are discovered, not assumed.
const { data: sample, error } = await db
  .from('shipments')
  .select('*')
  .eq('client_rate', 0)
  .not('client_id', 'is', null)
  .limit(5)

if (error) { console.error(error.message); process.exit(1) }
if (!sample?.length) { console.log('no unpriced shipments found'); process.exit(0) }

console.log(`columns on shipments (${Object.keys(sample[0]).length}):`)
console.log('  ' + Object.keys(sample[0]).join(', '))

// Which columns plausibly hold a destination ZIP?
const zipCols = Object.keys(sample[0]).filter(k => /zip|postal/i.test(k))
console.log(`\nZIP-ish columns: ${zipCols.join(', ') || '(NONE FOUND)'}`)

console.log('\nper-shipment destination + zone-chart lookup:')
for (const s of sample) {
  const vals = zipCols.map(c => `${c}=${JSON.stringify(s[c])}`).join(' ')
  console.log(`\n  id=${s.id ?? '?'}  zone=${JSON.stringify(s.zone)}  ${vals}`)

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
