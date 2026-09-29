// Read-only. Isolates ONE variable: the date filter.
//
// diag-client-api20.mjs proves 6 of 8 clients return HTTP 200 on
// /rest/customer-orders?page=1&perPage=1. But the live sync reports an Apache HTML
// 404 for every client. The sync's only extra ingredient is the Customer Order
// Advanced Filter pair that getCustomerOrders() adds:
//     modifiedDate=<iso>&modifiedDateConditional=on_or_after
//
// This sends the identical request twice per client — once without the filter, once
// with — so any difference is attributable to the filter alone.
//
// GETs only. Prints no credential values.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data } = await db
  .from('clients')
  .select('name, zenventory_api_key, zenventory_api_secret')
  .eq('active', true)
  .not('zenventory_api_key', 'is', null)
  .order('name')

const since = new Date()
since.setDate(since.getDate() - 30)
const iso = since.toISOString()

// Variants to compare. The first is the known-good control.
const variants = [
  ['no filter                    ', { page: '1', perPage: '100' }],
  ['modifiedDate + Conditional   ', { page: '1', perPage: '100', modifiedDate: iso, modifiedDateConditional: 'on_or_after' }],
  ['modifiedDate only            ', { page: '1', perPage: '100', modifiedDate: iso }],
  ['date-only value (YYYY-MM-DD) ', { page: '1', perPage: '100', modifiedDate: iso.slice(0, 10), modifiedDateConditional: 'on_or_after' }],
]

for (const c of data ?? []) {
  const auth =
    'Basic ' + Buffer.from(`${c.zenventory_api_key}:${c.zenventory_api_secret}`).toString('base64')
  console.log(`\n--- ${c.name} ---`)
  for (const [label, params] of variants) {
    const u = `https://app.zenventory.com/rest/customer-orders?${new URLSearchParams(params)}`
    try {
      const r = await fetch(u, { headers: { Authorization: auth, Accept: 'application/json' } })
      const t = await r.text()
      const html = /^\s*<!DOCTYPE|^\s*<html/i.test(t)
      let note = ''
      if (!html && r.status === 200) {
        try {
          const b = JSON.parse(t)
          note = `count=${b.meta?.count ?? '?'} orders=${(b.customerOrders ?? []).length}`
        } catch { note = '(unparseable)' }
      } else {
        note = t.slice(0, 60).replace(/\s+/g, ' ')
      }
      console.log(`  ${label} HTTP ${r.status} ${(html ? 'HTML' : 'JSON').padEnd(5)} ${note}`)
    } catch (e) {
      console.log(`  ${label} request failed: ${e.message}`)
    }
  }
}
