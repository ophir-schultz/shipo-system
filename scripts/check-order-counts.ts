// Is the shipments table populated well enough to derive a monthly
// order count from it? Read-only. Run:
//   npx tsx --env-file=.env.local scripts/check-order-counts.ts
//
// This matters because the DTC referral qualification is "more than
// 500 orders in a calendar month". If that number is hand-typed it
// defaults to 0 and silently never qualifies — the exact bug this
// whole change exists to kill. Deriving it from real shipment rows
// avoids that, but only if the rows are there.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const db = createClient(url, key)

const { count: total, error } = await db
  .from('shipments')
  .select('id', { count: 'exact', head: true })

if (error) {
  console.error('shipments query failed:', error.message)
  process.exit(1)
}
console.log(`shipments rows total: ${total}`)

const { count: withShipDate } = await db
  .from('shipments')
  .select('id', { count: 'exact', head: true })
  .not('ship_date', 'is', null)
console.log(`  with a ship_date:   ${withShipDate}`)

const { count: withOrderNo } = await db
  .from('shipments')
  .select('id', { count: 'exact', head: true })
  .not('order_number', 'is', null)
console.log(`  with an order_number: ${withOrderNo}`)

// Per-client, last 3 months: rows vs DISTINCT orders. The gap is the
// multi-package orders — if it is large, counting rows would overstate
// the order count and could qualify a client that has not earned it.
const since = new Date()
since.setMonth(since.getMonth() - 3)

const { data: rows } = await db
  .from('shipments')
  .select('client_id, order_number, ship_date')
  .gte('ship_date', since.toISOString())
  .limit(50000)

const { data: clients } = await db.from('clients').select('id, name')
const nameOf = new Map((clients ?? []).map((c) => [c.id, c.name]))

const buckets = new Map<string, { rows: number; orders: Set<string> }>()
for (const r of rows ?? []) {
  if (!r.ship_date || !r.client_id) continue
  const k = `${r.client_id}|${String(r.ship_date).slice(0, 7)}`
  const b = buckets.get(k) ?? { rows: 0, orders: new Set<string>() }
  b.rows++
  if (r.order_number) b.orders.add(r.order_number)
  buckets.set(k, b)
}

console.log(`\nclient × month, last 3 months (rows vs distinct orders):`)
const sorted = [...buckets.entries()].sort((a, b) => b[1].orders.size - a[1].orders.size)
if (sorted.length === 0) console.log('  (nothing in range)')
for (const [k, b] of sorted.slice(0, 25)) {
  const [cid, month] = k.split('|')
  const orders = b.orders.size
  const flag = orders > 500 ? '  <-- clears the >500 DTC bar' : ''
  console.log(
    `  ${month}  ${String(nameOf.get(cid) ?? cid).slice(0, 28).padEnd(28)} ` +
      `rows ${String(b.rows).padStart(6)}   orders ${String(orders).padStart(6)}${flag}`,
  )
}
