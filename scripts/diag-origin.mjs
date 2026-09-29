// Read-only: does the ShipStation payload already tell us the origin ZIP,
// and is there a zone anywhere in it? Determines whether origin_zip can be
// backfilled from data we already hold.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data } = await db
  .from('shipments')
  .select('order_number, carrier, service, zone, recipient_zip, raw_data')
  .not('client_id', 'is', null)
  .eq('client_rate', 0)
  .limit(400)

const originCounts = {}
const zoneKeysSeen = new Set()
let withAnyZone = 0

function scanForZone(obj, path = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return
  for (const [k, v] of Object.entries(obj)) {
    if (/zone/i.test(k) && (typeof v === 'number' || typeof v === 'string')) {
      zoneKeysSeen.add(`${path}${k} = ${JSON.stringify(v)}`)
    }
    if (v && typeof v === 'object') scanForZone(v, `${path}${k}.`, depth + 1)
  }
}

for (const s of data ?? []) {
  const r = s.raw_data ?? {}
  scanForZone(r)
  if (s.zone != null) withAnyZone++
  const candidates = {
    'shipFrom.postalCode': r?.shipFrom?.postalCode,
    'advancedOptions.warehouseId': r?.advancedOptions?.warehouseId,
    'warehouseId': r?.warehouseId,
    'originZip': r?.originZip,
  }
  for (const [k, v] of Object.entries(candidates)) {
    if (v != null && v !== '') {
      originCounts[k] ??= {}
      originCounts[k][String(v)] = (originCounts[k][String(v)] ?? 0) + 1
    }
  }
}

console.log(`sampled: ${data?.length ?? 0} unrated shipments`)
console.log(`have a zone column value: ${withAnyZone}`)
console.log('\norigin-ish fields found in raw_data:')
console.log(Object.keys(originCounts).length ? originCounts : '  (none)')
console.log('\nany key matching /zone/i anywhere in raw_data:')
console.log(zoneKeysSeen.size ? [...zoneKeysSeen].slice(0, 15) : '  (none)')

console.log('\ntop-level raw_data keys on one sample:')
console.log(Object.keys(data?.[0]?.raw_data ?? {}).join(', ') || '(raw_data empty)')
