// Read-only. Does EACH CLIENT's stored API 2.0 credential actually work against
// /rest/customer-orders? This is the exact call the "Test API 2.0" button makes.
// A GET, nothing written. Prints HTTP status only — never a credential value.
//
// Why this exists: .env.local's key returns 200 on this URL, but the UI button
// returned an Apache HTML 404. Same code, same URL, different credential — so
// the credential is the only remaining variable. A 404 across a whole API tree
// is the signature of the tree not existing FOR THAT ACCOUNT (e.g. API 2.0 not
// enabled), as opposed to a 401, which means the tree exists and the key is bad.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data, error } = await db
  .from('clients')
  .select('name, active, zenventory_api_key, zenventory_api_secret')
  .order('name')

if (error) { console.error(error.message); process.exit(1) }

const URL_ = 'https://app.zenventory.com/rest/customer-orders?page=1&perPage=1'

for (const c of data ?? []) {
  const k = c.zenventory_api_key
  const s = c.zenventory_api_secret
  const name = (c.name ?? '?').padEnd(24)

  if (!k || !s) {
    console.log(`${name} (no key/secret stored — skipped)`)
    continue
  }

  try {
    const res = await fetch(URL_, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${k}:${s}`).toString('base64'),
        Accept: 'application/json',
      },
    })
    const raw = (await res.text()).slice(0, 70).replace(/\s+/g, ' ')
    // Distinguish an Apache HTML error page from a JSON API error.
    const kind = /^\s*<!DOCTYPE|^\s*<html/i.test(raw) ? 'HTML (Apache)' : 'JSON'
    console.log(`${name} HTTP ${res.status}  ${kind.padEnd(14)} ${raw}`)
  } catch (e) {
    console.log(`${name} request failed: ${e.message}`)
  }
}
