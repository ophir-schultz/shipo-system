// Read-only: which clients have a Zenventory legacy SecureKey stored?
// Prints PRESENCE AND LENGTH ONLY — never the key itself.
import { createClient } from '@supabase/supabase-js'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data, error } = await db
  .from('clients')
  .select('name, active, zenventory_secure_key, zenventory_api_key')

if (error) { console.error(error.message); process.exit(1) }

for (const c of data ?? []) {
  const sk = c.zenventory_secure_key
  const ak = c.zenventory_api_key
  console.log(
    `${(c.name ?? '?').padEnd(24)} active=${String(c.active).padEnd(5)}` +
    ` secure_key=${sk ? `SET (${String(sk).length} chars)` : 'null'}` +
    `  api_key=${ak ? 'SET' : 'null'}`
  )
}
