// Read-only. Tests ONE hypothesis: Shipo has a single Zenventory account, and each
// order carries a `client` field naming which Shipo client it belongs to — so the
// per-client API keys in the DB are not real API 2.0 credentials, which is why all 8
// return an Apache HTML 404 while the .env.local key works.
//
// GETs only. Prints no credential values.
//
// Run: cd ~/shipo-system && node --env-file=.env.local scripts/diag-zen-client-field.mjs
import { createClient } from '@supabase/supabase-js'

const k = process.env.ZENVENTORY_API_KEY ?? ''
const s = process.env.ZENVENTORY_API_SECRET ?? ''
if (!k || !s) {
  console.error('ZENVENTORY_API_KEY / ZENVENTORY_API_SECRET not set in env. Stopping.')
  process.exit(1)
}
const auth = 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64')

// ---------- 1. Does Shipo's own account work on API 2.0? ----------
const url = 'https://app.zenventory.com/rest/customer-orders?page=1&perPage=100'
const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } })
const raw = await res.text()
const isHtml = /^\s*<!DOCTYPE|^\s*<html/i.test(raw)

console.log(`Shipo account (.env.local) -> HTTP ${res.status} ${isHtml ? 'HTML (Apache)' : 'JSON'}`)
if (res.status !== 200 || isHtml) {
  console.log('Body (first 300 chars):', raw.slice(0, 300).replace(/\s+/g, ' '))
  console.log('\nHypothesis REJECTED: Shipo\'s own key does not work on API 2.0 either.')
  process.exit(0)
}

const body = JSON.parse(raw)
const orders = body.customerOrders ?? []
console.log(`meta: ${JSON.stringify(body.meta ?? {})}`)
console.log(`orders on page 1: ${orders.length}`)

if (!orders.length) {
  console.log('\nNo orders returned — cannot inspect the client field. Widen the date range.')
  process.exit(0)
}

// ---------- 2. Does each order carry a `client` field? ----------
console.log('\ntop-level keys on one order:')
console.log('  ' + Object.keys(orders[0]).join(', '))
console.log('\nsample order.client / order.customer:')
console.log('  client   =', JSON.stringify(orders[0].client ?? null))
console.log('  customer =', JSON.stringify(orders[0].customer ?? null))

// ---------- 3. What distinct client names appear? ----------
const counts = new Map()
for (const o of orders) {
  const name = o?.client?.name ?? '(no client.name)'
  const id = o?.client?.id ?? '?'
  const key = `${name}  [id=${id}]`
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
console.log('\ndistinct client values across page 1:')
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`)
}

// ---------- 4. Do those names match the clients table? ----------
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)
const { data: dbClients, error } = await db.from('clients').select('name, active').eq('active', true)
if (error) { console.error('\nSupabase error:', error.message); process.exit(1) }

const norm = (x) => String(x ?? '').trim().toLowerCase()
const zenNames = new Set([...counts.keys()].map((k) => norm(k.split('  [id=')[0])))
const dbNames = (dbClients ?? []).map((c) => c.name)

console.log('\nmatch check (active clients in DB vs client names seen in Zenventory):')
for (const n of dbNames) {
  console.log(`  ${zenNames.has(norm(n)) ? 'MATCH  ' : 'NO MATCH'}  ${n}`)
}
console.log('\nIf names mostly MATCH, the fix is: pull once with Shipo\'s key and map on')
console.log('order.client.name — drop the per-client API keys entirely.')
