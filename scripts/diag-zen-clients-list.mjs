// Read-only. Enumerates the Zenventory clients that actually appear in the window the
// sync cares about (last N days), so each Shipo client row can be mapped to a stable
// Zenventory client ID instead of a fragile name match ("Crisp Power" in our DB vs
// "Crisp Power Inc" in Zenventory).
//
// Sampling note: orders come back grouped, so the first pages are all one client.
// This samples pages spread across the whole result set instead of reading the front.
//
// GETs only. Prints no credential values.
import { createClient } from '@supabase/supabase-js'

const DAYS = Number(process.env.DAYS ?? 30)
const k = process.env.ZENVENTORY_API_KEY ?? ''
const s = process.env.ZENVENTORY_API_SECRET ?? ''
const H = {
  Authorization: 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64'),
  Accept: 'application/json',
}

const since = new Date()
since.setDate(since.getDate() - DAYS)
const sinceISO = since.toISOString()

function url(page, filtered) {
  const p = new URLSearchParams({ page: String(page), perPage: '100' })
  if (filtered) {
    p.set('modifiedDate', sinceISO)
    p.set('modifiedDateConditional', 'on_or_after')
  }
  return `https://app.zenventory.com/rest/customer-orders?${p}`
}

async function get(page, filtered) {
  const r = await fetch(url(page, filtered), { headers: H })
  if (r.status !== 200) return { err: `HTTP ${r.status}` }
  return r.json()
}

for (const filtered of [true, false]) {
  const label = filtered ? `last ${DAYS} days (what the sync pulls)` : 'ALL TIME'
  const first = await get(1, filtered)
  if (first.err) { console.log(`\n=== ${label} === ${first.err}`); continue }

  const total = first.meta?.totalPages ?? 1
  const count = first.meta?.count ?? 0
  console.log(`\n=== ${label} ===`)
  console.log(`count=${count} totalPages=${total}`)

  // Sample up to 30 pages spread evenly across the range.
  const N = Math.min(30, total)
  const pages = [...new Set(
    Array.from({ length: N }, (_, i) => 1 + Math.floor((i * (total - 1)) / Math.max(1, N - 1)))
  )]

  const seen = new Map()
  for (const p of pages) {
    const b = p === 1 ? first : await get(p, filtered)
    if (b.err) continue
    for (const o of b.customerOrders ?? []) {
      if (o?.client?.id != null) seen.set(o.client.id, o.client.name)
    }
  }
  console.log(`sampled ${pages.length} pages -> ${seen.size} distinct clients:`)
  for (const [id, name] of [...seen].sort((a, b) => String(a[1]).localeCompare(String(b[1])))) {
    console.log(`  id=${String(id).padEnd(8)} ${name}`)
  }
  globalThis.__last = seen
}

// Map to our DB rows using the widest sample we collected.
const zenClients = [...(globalThis.__last ?? new Map())].map(([id, name]) => ({ id, name }))
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const { data: rows } = await db.from('clients').select('id, name, active').eq('active', true)

const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const strip = (x) => norm(x).replace(/(inc|llc|ltd|limited|corp|co|company)$/g, '')

console.log('\nsuggested mapping (our client -> zenventory client):')
for (const r of rows ?? []) {
  const exact = zenClients.find((z) => norm(z.name) === norm(r.name))
  const loose = exact ?? zenClients.find((z) => strip(z.name) === strip(r.name))
  const pref =
    loose ??
    zenClients.find(
      (z) => strip(z.name).startsWith(strip(r.name)) || strip(r.name).startsWith(strip(z.name))
    )
  const how = exact ? 'exact' : loose ? 'suffix-stripped' : pref ? 'prefix' : '—'
  console.log(
    `  ${r.name.padEnd(24)} -> ${pref ? `id=${String(pref.id).padEnd(6)} ${pref.name} (${how})` : 'NO CANDIDATE'}`
  )
}
