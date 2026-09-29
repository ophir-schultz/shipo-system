// Read-only: list every table PostgREST exposes, and row-count anything
// that looks zone-related. Finds a zone map living under a name we didn't expect.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

const spec = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
}).then(r => r.json())

const tables = Object.keys(spec.definitions ?? spec.components?.schemas ?? {})
console.log(`tables exposed (${tables.length}):`)
console.log('  ' + tables.join('\n  '))

const interesting = tables.filter(t => /zone|rate|zip|matrix|chart/i.test(t))
console.log(`\nrow counts for zone/rate-ish tables:`)
for (const t of interesting) {
  const res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  })
  const range = res.headers.get('content-range') ?? '?'
  const sample = await res.json().catch(() => null)
  const cols = Array.isArray(sample) && sample[0] ? Object.keys(sample[0]).join(', ') : '(no rows)'
  console.log(`  ${t.padEnd(26)} count=${range.split('/')[1] ?? '?'}`)
  console.log(`    columns: ${cols}`)
}
